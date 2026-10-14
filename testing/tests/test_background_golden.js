/**
 * End-to-end golden test: every platform, through the real background.js.
 *
 * For each synthetic fixture and each scrub mode the harness captures the ZIP
 * that background.js would download and compares every entry (CSVs and the
 * manifest) byte for byte against the files stored under
 * testing/data/synthetic/golden/<scenario>/.
 *
 * Any difference fails the test. That is the point: an export-output change
 * must be intentional, reviewed in the diff of the golden files, and land in
 * its own commit (see CLAUDE.md "Golden-output policy").
 *
 * To refresh goldens after an intentional change:
 *     UPDATE_GOLDEN=1 node testing/tests/test_background_golden.js
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  runExport, loadFixture, utf8, PLATFORM_SCENARIOS, SYNTHETIC_DIR, FROZEN_ISO
} from './helpers/bg_harness.js';
import { sha256Hex } from '../../utils/manifest.js';

const GOLDEN_DIR = path.join(SYNTHETIC_DIR, 'golden');
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const BOM = '﻿';

let passed = 0;
let failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { passed++; } else { failed++; console.error('FAIL:', name, detail); }
}

function firstDiffLine(a, b) {
  const la = a.split(/\r?\n/);
  const lb = b.split(/\r?\n/);
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n; i++) {
    if (la[i] !== lb[i]) {
      return `line ${i + 1}\n    expected: ${JSON.stringify(la[i] ?? '<EOF>').slice(0, 300)}\n    actual:   ${JSON.stringify(lb[i] ?? '<EOF>').slice(0, 300)}`;
    }
  }
  return 'identical text, differing bytes (line endings or BOM?)';
}

const MODES = [
  { id: 'scrub_off', settings: { pii_scrub_enabled: false } },
  { id: 'scrub_on', settings: { pii_scrub_enabled: true } }
];

// One extra scenario exercises the HMAC donor-id path.
const EXTRA = [
  { base: 'claude', id: 'claude_salted', settings: { pii_scrub_enabled: false, study_salt: 'synthetic-study-code' } }
];

const runs = [];
for (const s of PLATFORM_SCENARIOS) {
  for (const m of MODES) runs.push({ ...s, run: `${s.id}__${m.id}`, settings: m.settings });
}
for (const e of EXTRA) {
  const base = PLATFORM_SCENARIOS.find(s => s.id === e.base);
  runs.push({ ...base, run: e.id, settings: e.settings });
}

for (const r of runs) {
  const payload = loadFixture(r.fixture);
  let result;
  try {
    result = await runExport({
      messageType: r.messageType, payload, senderUrl: r.senderUrl, settings: r.settings
    });
  } catch (err) {
    assert(`${r.run}: export completes`, false, err.message);
    continue;
  }
  assert(`${r.run}: a ZIP was downloaded`, result.filename !== null,
    JSON.stringify(result.broadcasts));
  if (!result.filename) continue;

  const outcomes = result.broadcasts.map(b => b.outcome);
  assert(`${r.run}: broadcast success`, outcomes.includes('success'), outcomes.join(','));
  assert(`${r.run}: zip name starts with platform`, result.filename.startsWith(`${r.platform}_`), result.filename);
  assert(`${r.run}: zip name carries the frozen timestamp`,
    result.filename.endsWith('_2026-04-13T12-00-00Z.zip'), result.filename);

  // Structural invariants that hold regardless of the golden content.
  const names = [...result.entries.keys()];
  const manifestName = names.find(n => n.endsWith('.json'));
  assert(`${r.run}: exactly one manifest`, names.filter(n => n.endsWith('.json')).length === 1, names.join(','));
  const csvNames = names.filter(n => n.endsWith('.csv'));
  assert(`${r.run}: at least one CSV`, csvNames.length > 0);
  for (const n of csvNames) {
    const text = utf8(result.entries.get(n));
    assert(`${r.run}: ${n} starts with BOM`, text.startsWith(BOM));
    assert(`${r.run}: ${n} is non-empty`, text.length > BOM.length + 1);
  }
  let manifest = null;
  try { manifest = JSON.parse(utf8(result.entries.get(manifestName))); } catch { /* asserted below */ }
  assert(`${r.run}: manifest parses`, manifest !== null);
  if (manifest) {
    assert(`${r.run}: manifest.platform`, manifest.platform === r.platform, manifest.platform);
    assert(`${r.run}: manifest.download_time frozen`, manifest.download_time === FROZEN_ISO, manifest.download_time);
    assert(`${r.run}: manifest.telemetry.pii_scrub_enabled`,
      manifest.telemetry.pii_scrub_enabled === Boolean(r.settings.pii_scrub_enabled));
    const listed = manifest.files.map(f => f.filename).sort();
    assert(`${r.run}: manifest lists every CSV`, JSON.stringify(listed) === JSON.stringify([...csvNames].sort()),
      `${listed} vs ${csvNames}`);
    for (const f of manifest.files) {
      const content = utf8(result.entries.get(f.filename) || new Uint8Array());
      const body = content.startsWith(BOM) ? content.slice(1) : content;
      const digest = await sha256Hex(body);
      assert(`${r.run}: sha256 for ${f.filename}`, digest === f.sha256);
    }
  }

  // Golden comparison.
  const dir = path.join(GOLDEN_DIR, r.run);
  if (UPDATE) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const [n, bytes] of result.entries) fs.writeFileSync(path.join(dir, n), bytes);
    fs.writeFileSync(path.join(dir, 'ZIP_NAME.txt'), result.filename + '\n');
    console.log(`  updated golden: ${r.run} (${result.entries.size} entries)`);
    continue;
  }
  if (!fs.existsSync(dir)) {
    assert(`${r.run}: golden directory exists`, false, `missing ${path.relative(SYNTHETIC_DIR, dir)}; run with UPDATE_GOLDEN=1`);
    continue;
  }
  const expectedZipName = fs.readFileSync(path.join(dir, 'ZIP_NAME.txt'), 'utf8').trim();
  assert(`${r.run}: zip filename matches golden`, result.filename === expectedZipName,
    `${expectedZipName} vs ${result.filename}`);
  const goldenNames = fs.readdirSync(dir).filter(n => n !== 'ZIP_NAME.txt').sort();
  assert(`${r.run}: entry names match golden`, JSON.stringify(goldenNames) === JSON.stringify([...names].sort()),
    `\n    golden: ${goldenNames}\n    actual: ${[...names].sort()}`);
  for (const n of goldenNames) {
    if (!result.entries.has(n)) continue;
    const expected = fs.readFileSync(path.join(dir, n));
    const actual = Buffer.from(result.entries.get(n));
    const same = expected.equals(actual);
    assert(`${r.run}: ${n} byte-identical to golden`, same,
      same ? '' : `\n    ${firstDiffLine(expected.toString('utf8'), actual.toString('utf8'))}`);
  }
}

console.log(`\nBackground golden test: ${passed} passed, ${failed} failed${UPDATE ? ' (goldens updated)' : ''}`);
if (failed > 0) process.exit(1);
