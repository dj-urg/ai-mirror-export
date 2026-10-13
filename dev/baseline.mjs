#!/usr/bin/env node
/*
 * Baseline capture + comparison for the preview harness.
 *
 * Usage:
 *   node dev/baseline.mjs --label before
 *   node dev/baseline.mjs --label after
 *   node dev/baseline.mjs --compare before after
 *
 * Captures every (state × theme) combination from the harness, saves a PNG
 * and an axe-core violations JSON per combination under
 * dev/baselines/<label>/.
 *
 * Firefox engine only — the extension targets Firefox and the popup depends
 * on Firefox-specific CSS (`-moz-system-ui`, Firefox form-control rendering,
 * `color-scheme`). Testing anywhere else is false confidence.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { firefox } from 'playwright';
// We inject axe-core directly into the popup iframe rather than running
// @axe-core/playwright on the whole page, because the harness chrome
// (sidebar, stage) would otherwise show up as its own a11y issues and
// drown out the real popup results.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BASELINES_DIR = path.join(REPO_ROOT, 'dev/baselines');

const STATES = [
  'supported_ready_chatgpt',
  'supported_ready_claude',
  'supported_ready_copilot',
  'supported_ready_google_overview',
  'supported_ready_google_ai_mode_capturing',
  'supported_loading_data',
  'loading_tab_navigating',
  'error_unsupported',
  'error_no_conversation_id',
  'error_content_script_not_loaded',
  'error_no_data_google',
  'auth_failed_claude',
  'consent_first_run'
];

const THEMES = ['light', 'dark'];

const PORT = Number(process.env.HARNESS_PORT) || 8766;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml'
};

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--label')      args.label = argv[++i];
    else if (a === '--compare') args.compare = [argv[++i], argv[++i]];
    else if (a === '--port')  args.port = Number(argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
    else args._.push(a);
  }
  return args;
}

async function startServer(port = PORT) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      let p = decodeURIComponent(url.pathname);
      if (p.endsWith('/')) p += 'index.html';
      const abs = path.join(REPO_ROOT, p);
      // Prevent path escape outside the repo.
      if (!abs.startsWith(REPO_ROOT + path.sep) && abs !== REPO_ROOT) {
        res.writeHead(403); res.end(); return;
      }
      const data = await fs.readFile(abs);
      const ext = path.extname(abs).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(data);
    } catch (e) {
      res.writeHead(404);
      res.end(String(e.message || e));
    }
  });
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, resolve);
  });
  return server;
}

/*
 * Playwright + axe-playwright descend into same-origin iframes by default,
 * which is what we want: the harness chrome is a single page, the popup
 * runs inside <iframe id="popupFrame"> via srcdoc with allow-same-origin.
 * We exclude the harness chrome so axe only reports on popup content.
 */
let _axeSource = null;
async function getAxeSource() {
  if (!_axeSource) {
    _axeSource = await fs.readFile(
      path.join(REPO_ROOT, 'node_modules/axe-core/axe.min.js'),
      'utf8'
    );
  }
  return _axeSource;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function captureOne(page, state, theme, outDir) {
  // Emulate the real `prefers-color-scheme` so the @media (prefers-color-scheme: dark)
  // branch in popup.css fires exactly as it would in production Firefox.
  // The harness also mirrors the theme via `data-force-color-scheme` for
  // interactive dev; either path produces the same palette.
  await page.emulateMedia({ colorScheme: theme });

  // One atomic setState + one reload, with an awaitable ready-signal.
  await page.evaluate(
    ({ state, theme }) => window.__harness.setState(state, theme),
    { state, theme }
  );
  await withTimeout(
    page.evaluate(() => window.__harnessReady),
    8000, `${state}/${theme} ready`
  ).catch((e) => console.log(`  [warn] ${e.message}`));

  const name = `${state}_${theme}`;
  const pngPath = path.join(outDir, `${name}.png`);
  const jsonPath = path.join(outDir, `${name}.axe.json`);

  // Resolve the popup iframe's Frame handle. page.mainFrame() is the harness;
  // any other frame is the popup. Retry a few times in case the srcdoc swap
  // hasn't attached a new frame yet.
  let popupFrame = null;
  for (let i = 0; i < 10 && !popupFrame; i++) {
    popupFrame = page.frames().find((f) => f !== page.mainFrame() && !f.isDetached());
    if (!popupFrame) await page.waitForTimeout(100);
  }

  let axeResults = { violations: [], passes: [], incomplete: [], inapplicable: [] };
  if (!popupFrame) {
    axeResults.error = 'popup iframe not found';
  } else {
    try {
      const axeSource = await getAxeSource();
      await withTimeout(popupFrame.addScriptTag({ content: axeSource }), 5000, 'addScriptTag');
      axeResults = await withTimeout(
        popupFrame.evaluate(() => window.axe.run(document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }
        })),
        10000, 'axe.run'
      );
    } catch (e) {
      axeResults.error = String(e.message || e);
    }
  }

  // Shoot the iframe only.
  try {
    const iframeHandle = await page.$('#popupFrame');
    if (iframeHandle) {
      await withTimeout(iframeHandle.screenshot({ path: pngPath }), 5000, 'screenshot');
    }
  } catch (e) {
    console.log(`  [warn] screenshot failed: ${e.message}`);
  }

  const slim = {
    state,
    theme,
    url: page.url(),
    violations: (axeResults.violations || []).map((v) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      help: v.help,
      helpUrl: v.helpUrl,
      tags: v.tags,
      nodes: v.nodes.map((n) => ({
        target: n.target,
        html: n.html?.slice(0, 300),
        failureSummary: n.failureSummary
      }))
    })),
    passCount: (axeResults.passes || []).length,
    incompleteCount: (axeResults.incomplete || []).length,
    error: axeResults.error
  };
  await fs.writeFile(jsonPath, JSON.stringify(slim, null, 2));

  const count = slim.violations.length;
  const impactCounts = slim.violations.reduce((acc, v) => {
    acc[v.impact || 'minor'] = (acc[v.impact || 'minor'] || 0) + 1;
    return acc;
  }, {});
  const impactStr = ['critical', 'serious', 'moderate', 'minor']
    .filter((k) => impactCounts[k])
    .map((k) => `${k.slice(0, 1).toUpperCase()}${impactCounts[k]}`)
    .join(' ');
  console.log(`  ${name.padEnd(55)} violations=${String(count).padStart(2)}  ${impactStr}`);
  return count;
}

async function capture(label) {
  if (!label) throw new Error('Pass --label <name>');
  const outDir = path.join(BASELINES_DIR, label);
  await fs.mkdir(outDir, { recursive: true });

  const server = await startServer();
  const browser = await firefox.launch();
  const context = await browser.newContext({
    viewport: { width: 1200, height: 900 },
    deviceScaleFactor: 2
  });
  const page = await context.newPage();

  const forwardConsole = (msg) => {
    if (msg.type() === 'error') console.log(`  [page error] ${msg.text().slice(0, 160)}`);
  };
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message.slice(0, 160)}`));
  page.on('console', forwardConsole);

  try {
    await page.goto(`http://localhost:${PORT}/dev/harness.html`, { waitUntil: 'load' });
    console.log(`Capturing ${STATES.length} states × ${THEMES.length} themes → dev/baselines/${label}/`);

    let total = 0;
    for (const state of STATES) {
      for (const theme of THEMES) {
        total += await captureOne(page, state, theme, outDir);
      }
    }
    console.log(`\nTotal axe violations: ${total}`);
    console.log(`Saved to dev/baselines/${label}/`);
  } finally {
    await browser.close();
    server.close();
  }
}

async function compare(before, after) {
  if (!before || !after) throw new Error('Pass --compare <before> <after>');
  const beforeDir = path.join(BASELINES_DIR, before);
  const afterDir  = path.join(BASELINES_DIR, after);

  async function loadResults(dir) {
    const files = (await fs.readdir(dir).catch(() => []))
      .filter((f) => f.endsWith('.axe.json'));
    const out = new Map();
    for (const f of files) {
      const data = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
      out.set(f.replace('.axe.json', ''), data);
    }
    return out;
  }

  const b = await loadResults(beforeDir);
  const a = await loadResults(afterDir);

  if (b.size === 0) console.log(`(no results found in dev/baselines/${before}/)`);
  if (a.size === 0) console.log(`(no results found in dev/baselines/${after}/)`);

  const keys = new Set([...b.keys(), ...a.keys()]);
  const rows = [];
  let bTotal = 0, aTotal = 0;

  for (const k of [...keys].sort()) {
    const bn = b.get(k)?.violations?.length ?? '-';
    const an = a.get(k)?.violations?.length ?? '-';
    if (typeof bn === 'number') bTotal += bn;
    if (typeof an === 'number') aTotal += an;
    const delta = (typeof bn === 'number' && typeof an === 'number') ? (an - bn) : '-';
    rows.push({ state: k, before: bn, after: an, delta });
  }

  const w = Math.max(...rows.map((r) => r.state.length), 'state'.length);
  const header = `${'state'.padEnd(w)}  ${'before'.padStart(6)}  ${'after'.padStart(6)}  ${'delta'.padStart(5)}`;
  console.log(`\n${header}`);
  console.log('-'.repeat(header.length));
  for (const r of rows) {
    const mark = typeof r.delta === 'number'
      ? (r.delta < 0 ? ' [better]' : (r.delta > 0 ? ' [WORSE]' : ''))
      : '';
    console.log(`${r.state.padEnd(w)}  ${String(r.before).padStart(6)}  ${String(r.after).padStart(6)}  ${String(r.delta).padStart(5)}${mark}`);
  }
  console.log('-'.repeat(header.length));
  console.log(`${'totals'.padEnd(w)}  ${String(bTotal).padStart(6)}  ${String(aTotal).padStart(6)}  ${String(aTotal - bTotal).padStart(5)}`);
}

function printHelp() {
  console.log(`Usage:
  node dev/baseline.mjs --label <name>              Capture to dev/baselines/<name>/
  node dev/baseline.mjs --compare <before> <after>  Print axe violation delta
  node dev/baseline.mjs --port <port>               Override harness port (default 8766)`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help || (!args.label && !args.compare)) {
  printHelp();
  process.exit(args.help ? 0 : 1);
}

try {
  if (args.compare) {
    await compare(args.compare[0], args.compare[1]);
  } else {
    await capture(args.label);
  }
} catch (err) {
  console.error(`baseline.mjs: ${err.message}`);
  process.exit(1);
}
