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

import { buildZip, crc32 } from '../../utils/zip.js';
import { readZip } from '../../utils/zip_read.js';
import { parseCSV, CsvParseError } from '../../utils/csv_parse.js';
import { escapeCSVField } from '../../utils/csv.js';
import { sha256Hex } from '../../utils/manifest.js';
import {
  collectBundles, checkBundle, mergeBundles, pickLatest, selectForMerge, schemaFromFilename,
  STATUS, SUPERSEDED, CANONICAL_OUTPUT, FOURCAT_OUTPUT, PROVENANCE_HEADERS
} from '../../utils/merge.js';
import {
  SOURCES_OUTPUT, SOURCES_COUNT_OUTPUT, SOURCES_HEADERS, domainOf, buildSourcesOutputs, messageKey
} from '../../utils/merge_sources.js';

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
    lh.setUint32(14, crc32(raw), true);
    lh.setUint32(18, comp.length, true); lh.setUint32(22, raw.length, true);
    lh.setUint16(26, nameBytes.length, true);
    parts.push(new Uint8Array(lh.buffer), nameBytes, comp);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(10, 8, true);
    ch.setUint32(16, crc32(raw), true);
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
  const derived = new Set([`${FOURCAT_OUTPUT}.csv`, `${SOURCES_OUTPUT}.csv`, `${SOURCES_COUNT_OUTPUT}.csv`]);
  for (const f of files.filter(f => f.name.endsWith('.csv') && !derived.has(f.name))) {
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

  // --- 4CAT copy: canonical rows without platform_specific_json ------------
  {
    const canon = parseCSV(byName[`${CANONICAL_OUTPUT}.csv`].replace(/^\uFEFF/, ''));
    // --- all_sources_canonical + sources_by_domain ---------------------------
    const src = parseCSV(byName[`${SOURCES_OUTPUT}.csv`].replace(/^\uFEFF/, ''));
    assert('sources: shared header', src.headers.join() === SOURCES_HEADERS.join());
    let expectedSources = 0;
    for (const b of checked) for (const f of b.files) if (/_sources$/.test(f.schema)) expectedSources += f.rows.length;
    assert('sources: one row per source row from every platform', src.rows.length === expectedSources,
      `${src.rows.length} vs ${expectedSources}`);
    const srcPlatforms = new Set(src.rows.map(r => r[1]));
    assert('sources: platform filled for files without a platform column',
      srcPlatforms.has('chatgpt') || srcPlatforms.has('perplexity'), [...srcPlatforms].join());
    const canonIds = new Set(parseCSV(byName[`${CANONICAL_OUTPUT}.csv`].replace(/^\uFEFF/, ''))
      .rows.map(r => `${r[1]}\u0000${r[2]}\u0000${r[3]}`));
    const linkable = src.rows.filter(r => r[3] !== '');
    const unlinked = linkable.filter(r => !canonIds.has(`${r[1]}\u0000${r[2]}\u0000${r[3]}`));
    assert('sources: message_id joins to all_messages_canonical', linkable.length > 0 && unlinked.length === 0,
      JSON.stringify(unlinked.slice(0, 3).map(r => r.slice(1, 4))));
    const col = Object.fromEntries(SOURCES_HEADERS.map((h, i) => [h, i]));
    assert('sources: domain derived from url_clean',
      src.rows.every(r => r[col.domain] === domainOf(r[col.url_clean] || r[col.url])));
    const canonTable = parseCSV(byName[`${CANONICAL_OUTPUT}.csv`].replace(/^\uFEFF/, ''));
    const ci = Object.fromEntries(canonTable.headers.map((h, i) => [h, i]));
    const times = new Map(canonTable.rows.map(r =>
      [[r[ci.donor_id], r[ci.platform], r[ci.conversation_id], r[ci.message_id]].join('\u0000'), r[ci.created_at_iso]]));
    const wrongTime = src.rows.filter(r => r[col.created_at_iso] !==
      (r[col.message_id] ? times.get([r[col.donor_id], r[col.platform], r[col.conversation_id], r[col.message_id]].join('\u0000')) ?? '' : ''));
    assert('sources: created_at_iso copied from the citing message', wrongTime.length === 0 &&
      src.rows.some(r => r[col.created_at_iso] !== ''), JSON.stringify(wrongTime.slice(0, 2)));
    const counts = parseCSV(byName[`${SOURCES_COUNT_OUTPUT}.csv`].replace(/^\uFEFF/, ''));
    const allRows = counts.rows.filter(r => r[0] === 'all');
    assert('counts: all-platform citations add up', allRows.reduce((n, r) => n + Number(r[2]), 0) === src.rows.length);
    assert('counts: per-platform citations add up',
      counts.rows.filter(r => r[0] !== 'all').reduce((n, r) => n + Number(r[2]), 0) === src.rows.length);
    assert('domainOf strips www and lowercases', domainOf('https://WWW.Example.org/a?b=1') === 'example.org' &&
      domainOf('not a url') === '');

    const four = parseCSV(byName[`${FOURCAT_OUTPUT}.csv`].replace(/^\uFEFF/, ''));
    const drop = canon.headers.indexOf('platform_specific_json');
    const strip = (r) => r.filter((_v, i) => i !== drop).join('\u0000');
    assert('4CAT copy is second output', files[1].name === `${FOURCAT_OUTPUT}.csv`);
    assert('4CAT copy drops only platform_specific_json',
      JSON.stringify(four.headers) === JSON.stringify(canon.headers.filter(h => h !== 'platform_specific_json')));
    assert('4CAT copy has every canonical row, cells unchanged',
      JSON.stringify(four.rows.map(r => r.join('\u0000')).sort()) === JSON.stringify(canon.rows.map(strip).sort()));
    assert('4CAT copy: first data row has no quote', !four.rows[0].some(v => v.includes('"')));
    assert('4CAT copy: report names it', byName['MERGE_REPORT.txt'].includes(`${FOURCAT_OUTPUT}.csv: `) &&
      report.outputs.some(o => o.name === `${FOURCAT_OUTPUT}.csv` && o.rows === canon.rows.length));
  }

  // --- sources: time of the citing message when a search is exported twice -
  {
    const headers = ['donor_id', 'download_time', 'mode', 'conversation_id', 'turn_index', 'url', 'url_clean', 'title'];
    const file = (dl) => ({ schema: 'google_sources', headers, filename: `google_sources_${dl}.csv`, sha256: dl,
      rows: [['d1', dl, 'ai_overview', 'tides', '', 'https://example.org/a', 'https://example.org/a', 'A']] });
    const times = new Map();
    const key = ['d1', 'google_ai_overview', 'tides', '0'];
    times.set(messageKey(...key, 'DL1'), 'T1');
    times.set(messageKey(...key, 'DL2'), 'T2');
    times.set(messageKey(...key), null);          // the two exports disagree
    const out = parseCSV(buildSourcesOutputs([file('DL1'), file('DL2'), file('DL3')], times).sources.content);
    const t = out.headers.indexOf('created_at_iso');
    assert('sources: same search exported twice gets each export\'s own time',
      out.rows[0][t] === 'T1' && out.rows[1][t] === 'T2', out.rows.map(r => r[t]).join());
    assert('sources: no time when exports disagree and none matches', out.rows[2][t] === '');
  }

  // --- changed file excluded by default, included on request ---------------
  const edited = goldenZip('claude__scrub_off', (f, c) =>
    f.includes('_messages_canonical_') ? c.replace('Explain idempotence', 'Explain IDEMPOTENCE') : c);
  const { checked: c2 } = await checkAll([edited, goldenZip('grok__scrub_off')]);
  const editedChecked = c2.find(b => b.label === edited.name);
  assert('edited export flagged changed', editedChecked.status === STATUS.CHANGED &&
    editedChecked.problems.some(p => p.includes('changed after it was exported')));
  const m2 = await mergeBundles(c2);
  const editedInput = m2.report.inputs.find(i => i.label === edited.name);
  assert('changed excluded by default', m2.report.conversations === 1 &&
    !editedInput.merged && /include anyway/.test(editedInput.not_merged_because) &&
    editedInput.files.every(f => !f.merged));
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
  assert('canonical with renamed column is not merged at all, per file',
    !m2c.report.outputs.some(o => o.schema === 'grok_messages_canonical') &&
    m2c.report.inputs[0].merged &&
    m2c.report.inputs[0].files.filter(f => !f.merged).length === 1);

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

  await runHardening();

  console.log(`[test_merge] ${passed} passed, ${failed} failed`);
  if (failed > 0) throw new Error(`test_merge: ${failed} failure(s)`);
}

/** Golden case dir -> [{name, content}] with an optional per-file edit. */
function goldenEntries(caseName, mutate = null) {
  const dir = join(GOLDEN, caseName);
  return readdirSync(dir).filter(f => f !== 'ZIP_NAME.txt').sort().map(f => {
    const content = readFileSync(join(dir, f), 'utf8');
    return { name: f, content: mutate ? mutate(f, content) : content };
  });
}

function mergedCsvs(result) {
  return JSON.stringify(result.files.filter(f => f.name.endsWith('.csv')));
}

/** Malformed, duplicated, conflicting and reordered input. */
async function runHardening() {
  const grok = goldenEntries('grok__scrub_off');
  const isManifest = (f) => f.endsWith('.json');
  const withManifest = (edit) => goldenZip('grok__scrub_off', (f, c) => isManifest(f) ? edit(c) : c);

  // --- duplicate CSV names inside one bundle ---------------------------------
  const csvEntry = grok.find(e => e.name.includes('_messages_canonical_'));
  const sameTwice = { name: 'dup_same.zip', bytes: buildZip([...grok, { name: `copy/${csvEntry.name}`, content: csvEntry.content }]) };
  const { checked: d1 } = await checkAll([sameTwice]);
  assert('identical duplicate dropped with a note', d1[0].status === STATUS.OK &&
    d1[0].notes.some(n => n.includes('more than once')) &&
    d1[0].files.filter(f => f.filename === csvEntry.name).length === 1, JSON.stringify(d1[0].problems));
  const differs = { name: 'dup_diff.zip', bytes: buildZip([...grok,
    { name: `copy/${csvEntry.name}`, content: csvEntry.content.replace('grok', 'grak') }]) };
  const { checked: d2 } = await checkAll([differs]);
  assert('differing duplicate cannot be used', d2[0].status === STATUS.INVALID &&
    d2[0].problems.some(p => p.includes('different contents')) &&
    !d2[0].files.some(f => f.filename === csvEntry.name));

  // --- damaged manifests never throw -----------------------------------------
  const badManifests = [
    () => 'null', () => '[]', () => '"text"', () => '{"files": {}}', () => '{"files": [null]}',
    (c) => c.replace('"files": [', '"files": [7,'),
    (c) => c.replace(/"platform": "grok"/, '"platform": {"a": 1}'),
    (c) => c.replace(/"sha256": "[0-9a-f]+"/, '"sha256": 5'),
    (c) => { const m = JSON.parse(c); m.files.push(m.files[0]); return JSON.stringify(m); }
  ];
  let damaged = 0;
  for (const edit of badManifests) {
    const { checked: bad } = await checkAll([withManifest(edit)]);
    if (bad[0].status === STATUS.INVALID && bad[0].problems.includes('The manifest file is damaged.')) damaged++;
  }
  assert('malformed manifests are reported as damaged', damaged === badManifests.length, `${damaged}/${badManifests.length}`);
  const { checked: proto } = await checkAll([withManifest(c => c.replace('"schema": "grok_metadata"', '"schema": "constructor"'))]);
  assert('schema name from Object.prototype is not a file type', proto[0].status === STATUS.INVALID &&
    proto[0].problems.some(p => p.includes('not a file type')));
  const { checked: extraKeys } = await checkAll([goldenZip('grok__scrub_off')]);
  assert('unknown manifest keys are ignored', extraKeys[0].status === STATUS.OK);
  const noCsv = { name: 'only_manifest.zip', bytes: buildZip(grok.filter(e => isManifest(e.name))) };
  assert('manifest without any CSV cannot be used', (await checkAll([noCsv])).checked[0].status === STATUS.INVALID);

  // --- output of an earlier merge is refused ---------------------------------
  const base = await mergeBundles((await checkAll([goldenZip('grok__scrub_off')])).checked);
  const mergedCsv = base.files.find(f => f.name === 'grok_messages.csv');
  const { checked: again } = await checkAll([{ name: mergedCsv.name, bytes: enc.encode(mergedCsv.content) }]);
  assert('CSV from an earlier merge refused', again[0].status === STATUS.INVALID &&
    again[0].problems.some(p => p.includes('earlier merge')));

  // --- same conversation: verified beats changed, whatever the order ----------
  const changedNewer = goldenZip('grok__scrub_off', (f, c) =>
    isManifest(f) ? c.replace(/"download_time": "[^"]+"/, '"download_time": "2099-01-01T00:00:00.000Z"')
      : f.includes('_messages_canonical_') ? c.replace('grok', 'grak') : c);
  changedNewer.name = 'a_changed_newer.zip';
  const pair = [changedNewer, goldenZip('grok__scrub_off')];
  const { checked: p1 } = await checkAll(pair);
  const changedBundle = p1.find(b => b.label === 'a_changed_newer.zip');
  assert('fixture: newer copy is changed', changedBundle.status === STATUS.CHANGED);
  assert('verified export preferred over a newer changed one',
    pickLatest(p1).get(changedBundle) === SUPERSEDED.VERIFIED &&
    pickLatest(p1.slice().reverse()).get(changedBundle) === SUPERSEDED.VERIFIED);
  assert('nothing is superseded while changed files are excluded',
    selectForMerge(p1).superseded.size === 0 &&
    selectForMerge(p1, { includeChanged: true }).superseded.has(changedBundle));
  const mp = await mergeBundles(p1, { includeChanged: true, mergedAt: 'T' });
  assert('changed copy not merged next to the verified one', mp.report.exports_merged === 1 &&
    /verified export/.test(mp.report.inputs.find(i => i.label === 'a_changed_newer.zip').not_merged_because));
  const copy = goldenZip('grok__scrub_off');
  copy.name = 'second_copy.zip';
  const { checked: p2 } = await checkAll([goldenZip('grok__scrub_off'), copy]);
  assert('same export added twice is merged once', [...pickLatest(p2).values()].join() === SUPERSEDED.COPY &&
    (await mergeBundles(p2)).report.conversations === 1);

  // --- result does not depend on input order ---------------------------------
  const many = scrubOffCases.map(c => goldenZip(c)).concat([changedNewer]);
  const forward = await mergeBundles((await checkAll(many)).checked, { includeChanged: true, mergedAt: 'T' });
  const backward = await mergeBundles((await checkAll(many.slice().reverse())).checked.reverse(), { includeChanged: true, mergedAt: 'T' });
  assert('merge output independent of input order',
    JSON.stringify(forward.files) === JSON.stringify(backward.files));

  // --- column layout: verified exports decide --------------------------------
  const swapColumns = (c) => {
    const { headers, rows } = parseCSV(c);
    const swap = (r) => [r[1], r[0], ...r.slice(2)];
    return '﻿' + [swap(headers), ...rows.map(swap)].map(r => r.map(escapeCSVField).join(',')).join('\r\n') + '\r\n';
  };
  const foreign = goldenZip('grok__scrub_off', (f, c) => f.startsWith('grok_messages_grok') ? swapColumns(c) : c);
  foreign.name = 'a_foreign_layout.zip';   // sorts before the verified export
  const verifiedOnly = await mergeBundles((await checkAll([goldenZip('claude__scrub_off')])).checked, { mergedAt: 'T' });
  const { checked: l1 } = await checkAll([foreign, goldenZip('claude__scrub_off')]);
  const ml1 = await mergeBundles(l1, { includeChanged: true, mergedAt: 'T' });
  assert('changed-only layout is merged with a warning',
    ml1.report.warnings.some(w => w.startsWith('grok_messages.csv: none of these files could be verified')));
  // A second conversation (so it is not superseded) whose messages file has swapped columns.
  // Its other files are copies of the verified export's, so nothing of it is merged.
  const foreignClaude = {
    name: 'a_foreign_claude.zip',
    bytes: buildZip(goldenEntries('claude__scrub_off', (f, c) =>
      isManifest(f) ? c.replace(/"conversation_id": "[^"]+"/, '"conversation_id": "other-conversation"')
        : /^claude_messages_(?!canonical)/.test(f) ? swapColumns(c) : c))
  };
  const { checked: l2 } = await checkAll([foreignClaude, goldenZip('claude__scrub_off')]);
  const ml2 = await mergeBundles(l2, { includeChanged: true, mergedAt: 'T' });
  const out = (m, name) => m.files.find(f => f.name === name)?.content;
  assert('export with nothing left to merge is reported as not merged',
    l2.find(b => b.label === 'a_foreign_claude.zip').status === STATUS.CHANGED && ml2.report.exports_merged === 1 &&
    /None of its files/.test(ml2.report.inputs.find(i => i.label === 'a_foreign_claude.zip').not_merged_because));
  assert('foreign layout never replaces the verified layout',
    out(ml2, 'claude_messages.csv') === out(verifiedOnly, 'claude_messages.csv') &&
    ml2.report.warnings.some(w => w.includes('columns differ from other claude_messages files')));
  const foreignFile = ml2.report.inputs.find(i => i.label === 'a_foreign_claude.zip').files.find(f => f.schema === 'claude_messages');
  assert('left-out file is recorded per file', foreignFile.merged === false && /columns differ/.test(foreignFile.not_merged_because));
  const noRequired = goldenZip('grok__scrub_off', (f, c) => f.startsWith('grok_messages_grok') ? c.replace('conversation_id', 'conversation_ib') : c);
  const mr = await mergeBundles((await checkAll([noRequired])).checked, { includeChanged: true });
  assert('file without its required columns is left out',
    mr.report.warnings.some(w => w.includes('expected columns are missing')) &&
    !mr.report.outputs.some(o => o.name === 'grok_messages.csv'));

  // --- files without a manifest ------------------------------------------------
  const looseCsvs = grok.filter(e => e.name.endsWith('.csv')).map(e => ({ name: `x/${e.name}`, bytes: enc.encode(e.content) }));
  const { checked: n1 } = await checkAll(looseCsvs);
  const mn1 = await mergeBundles(n1, { includeChanged: true });
  assert('loose CSVs of one export count as one conversation',
    n1.length === looseCsvs.length && mn1.report.conversations === 1 && mn1.report.exports_merged === looseCsvs.length,
    `${mn1.report.conversations}`);
  assert('participant read from the donor_id column', mn1.report.participants === 1);
  const { checked: n2 } = await checkAll([goldenZip('grok__scrub_off'), ...looseCsvs]);
  const mn2 = await mergeBundles(n2, { includeChanged: true, mergedAt: 'T' });
  assert('loose copy of an already merged file is not added again',
    mergedCsvs(mn2) === mergedCsvs(base) && mn2.report.conversations === 1 && mn2.report.exports_merged === 1 &&
    mn2.report.warnings.some(w => w.includes('same content')));
  const twoFolders = [...looseCsvs, ...looseCsvs.map(f => ({ name: f.name.replace('x/', 'y/'), bytes: f.bytes }))];
  const { checked: n3 } = await checkAll(twoFolders);
  assert('same loose file from two folders is kept as two rows', n3.length === twoFolders.length &&
    new Set(n3.map(b => b.label)).size === twoFolders.length);
  const dirA = grok.map(e => ({ name: `a/${e.name}`, bytes: enc.encode(e.content) }));
  const dirB = grok.map(e => ({ name: `b/${e.name}`, bytes: enc.encode(isManifest(e.name) ? e.content : e.content.replace('grok', 'grak')) }));
  const { checked: n4 } = await checkAll([...dirB, ...dirA]);
  assert('a manifest takes the CSVs from its own folder',
    n4.length === 2 && n4.filter(b => b.status === STATUS.OK).length === 1 &&
    n4.filter(b => b.status === STATUS.CHANGED).length === 1, JSON.stringify(n4.map(b => [b.status, b.problems])));

  // --- platform filter ---------------------------------------------------------
  const { checked: f1 } = await checkAll([goldenZip('grok__scrub_off'), goldenZip('claude__scrub_off')]);
  const mf = await mergeBundles(f1, { platforms: ['grok'] });
  assert('unselected platform reported as such', mf.report.conversations === 1 &&
    mf.report.inputs.find(i => i.platform === 'claude').not_merged_because === 'Platform not selected.');
  const empty = await mergeBundles(f1, { platforms: [] });
  assert('nothing selected merges nothing', empty.report.conversations === 0 && empty.report.exports_merged === 0);

  // --- zip writer limits -------------------------------------------------------
  let tooMany = null;
  try { buildZip(Array.from({ length: 0xFFFF }, (_, i) => ({ name: `${i}`, content: '' }))); } catch (e) { tooMany = e; }
  assert('buildZip refuses 65535 entries', tooMany instanceof Error && /Too many files/.test(tooMany.message));
  assert('buildZip still writes 65534 entries',
    buildZip(Array.from({ length: 0xFFFE }, (_, i) => ({ name: `${i}`, content: '' }))).length > 0);
}

await run();
