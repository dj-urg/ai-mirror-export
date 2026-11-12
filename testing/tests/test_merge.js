/**
 * Tests for the merge page's pure modules: utils/csv_parse.js,
 * utils/zip_read.js and utils/merge.js. Node ESM.
 *
 * Inputs are the golden export bundles under testing/data/synthetic/golden/,
 * zipped exactly the way background.js zips them (BOM + CSV, plus manifest).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildZip } from '../../utils/zip.js';
import { readZip } from '../../utils/zip_read.js';
import { parseCSV, CsvParseError } from '../../utils/csv_parse.js';
import { escapeCSVField } from '../../utils/csv.js';
import { sha256Hex } from '../../utils/manifest.js';
import {
  collectBundles, checkBundle, mergeBundles, schemaFromFilename,
  STATUS, CANONICAL_OUTPUT, PROVENANCE_HEADERS
} from '../../utils/merge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(__dirname, '..', 'data', 'synthetic', 'golden');
const enc = new TextEncoder();

let passed = 0;
let failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL:', name, detail); }
}

/** Golden case dir -> {name, bytes} ZIP input, as the extension writes it. */
function goldenZip(caseName, mutate = null) {
  const dir = join(GOLDEN, caseName);
  const zipName = readFileSync(join(dir, 'ZIP_NAME.txt'), 'utf8').trim();
  const entries = readdirSync(dir)
    .filter(f => f !== 'ZIP_NAME.txt')
    .sort()
    .map(f => {
      let content = readFileSync(join(dir, f), 'utf8');
      if (mutate) content = mutate(f, content);
      return { name: f, content };
    });
  return { name: zipName, bytes: buildZip(entries) };
}

async function checkAll(inputs) {
  const { bundles, ignored } = await collectBundles(inputs);
  const checked = [];
  for (const b of bundles) checked.push(await checkBundle(b));
  return { checked, ignored };
}

/** A DEFLATE ZIP like macOS Archive Utility would write. */
async function deflateZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, content } of entries) {
    const nameBytes = enc.encode(name);
    const raw = enc.encode(content);
    const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const comp = new Uint8Array(await new Response(stream).arrayBuffer());
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(8, 8, true);
    lh.setUint32(18, comp.length, true); lh.setUint32(22, raw.length, true);
    lh.setUint16(26, nameBytes.length, true);
    parts.push(new Uint8Array(lh.buffer), nameBytes, comp);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(10, 8, true);
    ch.setUint32(20, comp.length, true); ch.setUint32(24, raw.length, true);
    ch.setUint16(28, nameBytes.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), nameBytes);
    offset += 30 + nameBytes.length + comp.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true); eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true); eocd.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of all) { out.set(p, pos); pos += p.length; }
  return out;
}

const scrubOffCases = readdirSync(GOLDEN).filter(c => c.endsWith('__scrub_off')).sort();

async function run() {
  // --- csv_parse -----------------------------------------------------------
  let roundTrips = 0;
  for (const c of readdirSync(GOLDEN)) {
    for (const f of readdirSync(join(GOLDEN, c)).filter(f => f.endsWith('.csv'))) {
      const text = readFileSync(join(GOLDEN, c, f), 'utf8').replace(/^﻿/, '');
      const { headers, rows } = parseCSV(text);
      const rebuilt = [headers, ...rows].map(r => r.map(escapeCSVField).join(',')).join('\r\n') + '\r\n';
      if (rebuilt === text) roundTrips++;
      else assert(`round trip ${c}/${f}`, false);
    }
  }
  assert('every golden CSV round-trips byte for byte', roundTrips > 50, `got ${roundTrips}`);

  const tricky = 'a,b\r\n"x, ""y""\r\nz",\'=1\r\n';
  const t = parseCSV(tricky);
  assert('parse quotes and embedded newline', t.rows[0][0] === 'x, "y"\r\nz' && t.rows[0][1] === "'=1");
  const throws = (s) => { try { parseCSV(s); return false; } catch (e) { return e instanceof CsvParseError; } };
  assert('unterminated quote throws', throws('a\r\n"oops\r\n'));
  assert('ragged row throws', throws('a,b\r\n1\r\n'));
  assert('text after closing quote throws', throws('a\r\n"x"y\r\n'));

  // --- zip_read --------------------------------------------------------------
  const stored = await readZip(buildZip([{ name: 'a.csv', content: 'h\r\nü\r\n' }, { name: 'dir/b.txt', content: 'b' }]));
  assert('read STORE zip', stored.length === 2 && new TextDecoder().decode(stored[0].bytes) === 'h\r\nü\r\n');
  const deflated = await readZip(await deflateZip([{ name: 'x.csv', content: 'hello,'.repeat(200) }]));
  assert('read DEFLATE zip', new TextDecoder().decode(deflated[0].bytes) === 'hello,'.repeat(200));
  let notZip = false;
  try { await readZip(enc.encode('definitely not a zip file at all')); } catch (_e) { notZip = true; }
  assert('non-zip rejected', notZip);

  assert('schemaFromFilename picks longest match',
    schemaFromFilename('claude_messages_canonical_abc_2026.csv') === 'claude_messages_canonical' &&
    schemaFromFilename('m365_copilot_sources_x.csv') === 'm365_copilot_sources');

  // --- every platform verifies and merges -----------------------------------
  const allInputs = scrubOffCases.map(c => goldenZip(c));
  const { checked } = await checkAll(allInputs);
  const notOk = checked.filter(b => b.status !== STATUS.OK);
  assert('all golden exports verify', notOk.length === 0, JSON.stringify(notOk.map(b => [b.label, b.problems])));

  const { files, report } = await mergeBundles(checked, { mergedAt: '2026-01-01T00:00:00.000Z' });
  const byName = Object.fromEntries(files.map(f => [f.name, f.content]));
  assert('canonical output first', files[0].name === `${CANONICAL_OUTPUT}.csv`);
  assert('report + manifest included', 'merge_manifest.json' in byName && 'MERGE_REPORT.txt' in byName);

  // Each merged row equals its source row byte for byte, plus provenance.
  const sourceLines = new Map();  // sha -> Set(lines)
  for (const b of checked) for (const f of b.files) {
    sourceLines.set(f.sha256, new Set(f.rows.map(r => r.map(escapeCSVField).join(','))));
  }
  let rowsChecked = 0;
  let rowsBad = 0;
  let expectedCanonical = 0;
  for (const b of checked) for (const f of b.files) if (f.schema.endsWith('_canonical')) expectedCanonical += f.rows.length;
  for (const f of files.filter(f => f.name.endsWith('.csv'))) {
    const { headers, rows } = parseCSV(f.content);
    assert(`${f.name} ends with provenance columns`, headers.slice(-2).join() === PROVENANCE_HEADERS.join());
    for (const r of rows) {
      const sha = r[r.length - 1];
      const line = r.slice(0, -2).map(escapeCSVField).join(',');
      rowsChecked++;
      if (!sourceLines.get(sha)?.has(line)) rowsBad++;
    }
    if (f.name === `${CANONICAL_OUTPUT}.csv`) {
      assert('canonical combines every platform', rows.length === expectedCanonical, `${rows.length} vs ${expectedCanonical}`);
    }
  }
  assert('every merged row is an unchanged source row', rowsChecked > 0 && rowsBad === 0, `${rowsBad}/${rowsChecked}`);
  for (const o of report.outputs) {
    assert(`output sha recorded for ${o.name}`, o.sha256 === await sha256Hex(byName[o.name].replace(/^﻿/, '')));
  }

  // --- changed file excluded by default, included on request ---------------
  const edited = goldenZip('claude__scrub_off', (f, c) =>
    f.includes('_messages_canonical_') ? c.replace('Explain idempotence', 'Explain IDEMPOTENCE') : c);
  const { checked: c2 } = await checkAll([edited, goldenZip('grok__scrub_off')]);
  assert('edited export flagged changed', c2[0].status === STATUS.CHANGED &&
    c2[0].problems.some(p => p.includes('changed after it was exported')));
  const m2 = await mergeBundles(c2);
  assert('changed excluded by default', m2.report.conversations === 1 &&
    !m2.report.inputs[0].merged && /include anyway/.test(m2.report.inputs[0].not_merged_because));
  const m2b = await mergeBundles(c2, { includeChanged: true });
  assert('changed included on request', m2b.report.conversations === 2);
  const reportTxt = m2b.files.find(f => f.name === 'MERGE_REPORT.txt').content;
  assert('report lists included changed file', reportTxt.includes('Included although changed'));

  const renamed = goldenZip('grok__scrub_off', (f, c) =>
    f.includes('_messages_canonical_') ? c.replace('platform', 'plaform') : c);
  const m2c = await mergeBundles((await checkAll([renamed])).checked, { includeChanged: true });
  assert('canonical with renamed column warned, not combined',
    m2c.report.warnings.some(w => w.includes('shared layout')) &&
    !m2c.report.outputs.some(o => o.name === `${CANONICAL_OUTPUT}.csv`));

  // --- outdated version never merged ---------------------------------------
  const old = goldenZip('grok__scrub_off', (f, c) => f.endsWith('.json') ? c.replace('"extractor_version": "3.1.0"', '"extractor_version": "3.0.0"') : c);
  const { checked: c3 } = await checkAll([old]);
  assert('older version flagged outdated', c3[0].status === STATUS.OUTDATED);
  assert('outdated not merged even with includeChanged', (await mergeBundles(c3, { includeChanged: true })).report.conversations === 0);

  // --- re-export of same conversation: newest wins ---------------------------
  const newer = goldenZip('grok__scrub_off', (f, c) => f.endsWith('.json')
    ? c.replace(/"download_time": "[^"]+"/, '"download_time": "2099-01-01T00:00:00.000Z"') : c);
  newer.name = 'grok_newer.zip';
  const { checked: c4 } = await checkAll([goldenZip('grok__scrub_off'), newer]);
  const m4 = await mergeBundles(c4);
  assert('older duplicate superseded', m4.report.superseded_exports === 1 &&
    m4.report.inputs.find(i => i.label === 'grok_newer.zip').merged);

  // --- scrub mix warning; merged ZIP refused; loose files ---------------------
  const { checked: c5 } = await checkAll([goldenZip('grok__scrub_off'), goldenZip('claude__scrub_on')]);
  assert('scrub mix warns', (await mergeBundles(c5)).report.warnings.some(w => w.includes('scrubbing')));

  const mergedZip = { name: 'merged.zip', bytes: buildZip(m4.files) };
  const { checked: c6 } = await checkAll([mergedZip]);
  assert('zip bundle source is the zip', c6[0].sources.length === 1 && c6[0].sources[0] === 'merged.zip');
  assert('merged zip refused', c6[0].status === STATUS.INVALID && /already a merged/.test(c6[0].problems[0]));

  const dir = join(GOLDEN, 'mistral__scrub_off');
  const loose = readdirSync(dir).filter(f => f !== 'ZIP_NAME.txt')
    .map(f => ({ name: `folder/${f}`, bytes: new Uint8Array(readFileSync(join(dir, f))) }));
  const { checked: c7 } = await checkAll(loose);
  assert('unzipped folder verifies', c7.length === 1 && c7[0].status === STATUS.OK, JSON.stringify(c7.map(b => b.problems)));
  assert('loose bundle lists every source file', c7[0].sources.length === loose.length);
  const lonely = loose.filter(f => f.name.endsWith('.csv')).slice(0, 1);
  const { checked: c8 } = await checkAll(lonely);
  assert('CSV without manifest is unverified', c8[0].status === STATUS.CHANGED && c8[0].platform === 'mistral');
  const { ignored } = await collectBundles([{ name: 'notes.docx', bytes: enc.encode('x') }]);
  assert('other files ignored with reason', ignored.length === 1);

  console.log(`[test_merge] ${passed} passed, ${failed} failed`);
  if (failed > 0) throw new Error(`test_merge: ${failed} failure(s)`);
}

await run();
