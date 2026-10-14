/**
 * Tests for utils/pii.js
 *
 * Run with: node testing/tests/test_pii.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scrubText,
  scrubRow,
  scrubRows,
  countRedactions,
  PII_RULESET_VERSION,
  PII_SCRUB_OPTION_KEYS,
  classifyColumn,
  scrubCell,
  scrubJsonText,
  scrubRowDeep
} from '../../utils/pii.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(msg);
  }
}

function assertEq(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures.push(`${msg}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
    failed++;
  } else {
    passed++;
  }
}

function assertIncludes(hay, needle, msg) {
  if (typeof hay === 'string' && hay.includes(needle)) {
    passed++;
  } else {
    failed++;
    failures.push(`${msg}\n  expected to include: ${needle}\n  in: ${JSON.stringify(hay)}`);
  }
}

function assertNotIncludes(hay, needle, msg) {
  if (typeof hay === 'string' && !hay.includes(needle)) {
    passed++;
  } else {
    failed++;
    failures.push(`${msg}\n  expected NOT to include: ${needle}\n  in: ${JSON.stringify(hay)}`);
  }
}

// --- scrubText: each PII type -------------------------------------------
assertIncludes(scrubText('Contact me at jane.doe@example.com please'),
  '<REDACTED:EMAIL>', 'email scrubbed');
assertNotIncludes(scrubText('Contact me at jane.doe@example.com please'),
  'jane.doe@example.com', 'email removed');

assertIncludes(scrubText('Call +1 (415) 555-1234 tomorrow'),
  '<REDACTED:PHONE>', 'intl phone scrubbed');
assertIncludes(scrubText('Call 415-555-1234 today'),
  '<REDACTED:PHONE>', 'NANP phone scrubbed');

// URLs — only when stripUrls
const withUrlNoStrip = scrubText('See https://example.com/path?x=1 for info');
assertNotIncludes(withUrlNoStrip, '<REDACTED:URL>', 'URL kept when stripUrls=false');
const withUrlStrip = scrubText('See https://example.com/path?x=1 for info', { stripUrls: true });
assertIncludes(withUrlStrip, '<REDACTED:URL>', 'URL scrubbed when stripUrls=true');

// Credit card
assertIncludes(scrubText('Card: 4111 1111 1111 1111 exp 12/30'),
  '<REDACTED:CC>', 'CC with spaces scrubbed');
assertIncludes(scrubText('Card 4111-1111-1111-1111 ok'),
  '<REDACTED:CC>', 'CC with dashes scrubbed');
// 12 digits should NOT be CC
assertNotIncludes(scrubText('ref 123456789012 end'),
  '<REDACTED:CC>', 'twelve-digit run is not CC');

// SSN
assertIncludes(scrubText('SSN 123-45-6789 here'),
  '<REDACTED:SSN>', 'SSN scrubbed');

// IPv4
assertIncludes(scrubText('server at 192.168.1.1 responded'),
  '<REDACTED:IP>', 'IPv4 scrubbed');
// Out-of-range octets not matched
assertNotIncludes(scrubText('build 999.999.999.999 was invalid'),
  '<REDACTED:IP>', 'invalid IPv4 skipped');

// JWT
const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMxMjMiLCJuYW1lIjoiSmFuZSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
assertIncludes(scrubText(`token ${jwt} end`), '<REDACTED:JWT>', 'JWT scrubbed');

// Long token (32+)
assertIncludes(scrubText('key=abcdef0123456789abcdef0123456789abcdef and more'),
  '<REDACTED:TOKEN>', 'long alphanumeric token scrubbed');
// Short token (<32) left alone
assertNotIncludes(scrubText('word shortstuff123 end'),
  '<REDACTED:TOKEN>', 'short string not scrubbed as token');

// Names (case-insensitive, word-bounded)
const nameOut = scrubText('Hello Jane and jane and Janet', { names: ['Jane'] });
assertIncludes(nameOut, '<REDACTED:NAME>', 'name scrubbed');
assertNotIncludes(nameOut, 'Hello Jane', 'original name removed');
assertIncludes(nameOut, 'Janet', 'word-bounded: Janet preserved');

// Order: email must win over token
const mixOut = scrubText('mail jane.doe@example.com and token abcdef0123456789abcdef0123456789abcdef');
assertIncludes(mixOut, '<REDACTED:EMAIL>', 'email beats token order');
assertIncludes(mixOut, '<REDACTED:TOKEN>', 'token still scrubbed after email');

// --- scrubText: null/undefined/non-string/empty ------------------------
assertEq(scrubText(null), null, 'null passthrough');
assertEq(scrubText(undefined), undefined, 'undefined passthrough');
assertEq(scrubText(''), '', 'empty string passthrough');
assertEq(scrubText(42), 42, 'number passthrough');
assertEq(scrubText({ a: 1 }), { a: 1 }, 'object passthrough');

// --- scrubRow -----------------------------------------------------------
const row = {
  id: 'row-1',
  text: 'Email me at a@b.co',
  other: 'Email me at a@b.co',
  role: 'user'
};
const scrubbedRow = scrubRow(row, ['text']);
assertIncludes(scrubbedRow.text, '<REDACTED:EMAIL>', 'scrubRow scrubs target column');
assertEq(scrubbedRow.other, 'Email me at a@b.co', 'scrubRow leaves non-target column alone');
assertEq(scrubbedRow.role, 'user', 'scrubRow preserves other fields');
assertEq(scrubbedRow.id, 'row-1', 'scrubRow preserves id');
// Original not mutated
assertEq(row.text, 'Email me at a@b.co', 'scrubRow does not mutate original');

// Missing column: tolerate
const scrubbedMissing = scrubRow({ a: 'x' }, ['nope']);
assertEq(scrubbedMissing, { a: 'x' }, 'scrubRow tolerates missing column');

// Non-object: passthrough
assertEq(scrubRow(null, ['text']), null, 'scrubRow(null) passthrough');
assertEq(scrubRow(undefined, ['text']), undefined, 'scrubRow(undefined) passthrough');

// --- scrubRows ----------------------------------------------------------
const rows = [
  { text: 'ping a@b.co', keep: 'x@y.co' },
  { text: 'no pii here', keep: 'z@z.co' }
];
const scrubbed = scrubRows(rows, ['text']);
assertIncludes(scrubbed[0].text, '<REDACTED:EMAIL>', 'scrubRows row 0 scrubbed');
assertEq(scrubbed[1].text, 'no pii here', 'scrubRows row 1 untouched text');
assertEq(scrubbed[0].keep, 'x@y.co', 'scrubRows leaves non-target col');
assertEq(rows[0].text, 'ping a@b.co', 'scrubRows does not mutate originals');
assertEq(scrubRows(null, ['text']), null, 'scrubRows(null) passthrough');
assertEq(scrubRows([], ['text']), [], 'scrubRows([]) empty');

// --- countRedactions ----------------------------------------------------
const original = 'Hi, mail jane@x.com and 192.168.0.1.';
const scrubbedStr = scrubText(original);
const counts = countRedactions(original, scrubbedStr);
assertEq(counts.total, 2, 'countRedactions total = 2');
assertEq(counts.byType.EMAIL, 1, 'countRedactions EMAIL = 1');
assertEq(counts.byType.IP, 1, 'countRedactions IP = 1');

// When pre-existing markers appear in original, don't double count.
const pre = 'already <REDACTED:EMAIL> here, and jane@x.com';
const preS = scrubText(pre);
const preC = countRedactions(pre, preS);
assertEq(preC.total, 1, 'countRedactions ignores pre-existing markers');
assertEq(preC.byType.EMAIL, 1, 'countRedactions only counts newly added');

// Empty / non-string inputs
assertEq(countRedactions('', ''), { total: 0, byType: {} }, 'countRedactions empty');
assertEq(countRedactions(null, null), { total: 0, byType: {} }, 'countRedactions null');

// --- Column classification + deep scrubbing ------------------------------
// Every column emitted by the golden exports must be classified explicitly
// (structural / url / json / text); an unclassified column would be scrubbed
// as text, which is safe for privacy but must be a conscious choice.
{
  const goldenDir = path.join(__dirname, '..', 'data', 'synthetic', 'golden');
  const unknown = [];
  let columnsSeen = 0;
  for (const scenario of fs.readdirSync(goldenDir)) {
    const platform = scenario.startsWith('google') ? 'google_search' : scenario.split('__')[0].replace(/_rich|_meta|_search|_reasoning|_salted$/, '');
    const dir = path.join(goldenDir, scenario);
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.csv')) continue;
      const header = fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/)[0].replace(/^\uFEFF/, '');
      for (const col of header.split(',')) {
        columnsSeen++;
        if (classifyColumn(col, platform) === 'unknown') unknown.push(`${scenario}/${file}:${col}`);
      }
    }
  }
  assert(columnsSeen > 100, 'classification: goldens enumerate columns');
  assertEq(unknown, [], 'classification: every golden column is classified');
}
assertEq(classifyColumn('text'), 'text', 'classify text');
assertEq(classifyColumn('message_id'), 'structural', 'classify message_id');
assertEq(classifyColumn('num_anything'), 'structural', 'classify num_ prefix');
assertEq(classifyColumn('raw_block_json'), 'json', 'classify *_json');
assertEq(classifyColumn('url_clean'), 'url', 'classify url_clean');
assertEq(classifyColumn('conversation_id'), 'structural', 'classify conversation_id (default)');
assertEq(classifyColumn('conversation_id', 'google_search'), 'text', 'classify conversation_id on google');
assertEq(classifyColumn('made_up_column'), 'unknown', 'classify unknown');

// scrubCell: structural untouched, text scrubbed, unknown scrubbed as text
assertEq(scrubCell('message_id', 'a@b.co').value, 'a@b.co', 'scrubCell leaves structural');
assertEq(scrubCell('text', 'mail a@b.co').value, 'mail <REDACTED:EMAIL>', 'scrubCell scrubs text');
assertEq(scrubCell('text', 'mail a@b.co').counts, { total: 1, byType: { EMAIL: 1 } }, 'scrubCell counts');
assertEq(scrubCell('made_up_column', 'mail a@b.co').value, 'mail <REDACTED:EMAIL>', 'scrubCell scrubs unknown as text');
assertEq(scrubCell('text', 42).value, 42, 'scrubCell leaves non-strings');

// URL columns: credentials always removed; whole value only with stripUrls
assertEq(scrubCell('url', 'https://example.org/a?x=1').value, 'https://example.org/a?x=1', 'url column kept');
assertEq(scrubCell('url', 'https://user:pw@example.org/a').value, '<REDACTED:URL>', 'url column credentials removed');
assertEq(scrubCell('url', 'https://example.org/a', { stripUrls: true }).value, '<REDACTED:URL>', 'url column stripped on option');
assertEq(scrubCell('url', 'https://example.org/' + 'a'.repeat(40)).value, 'https://example.org/' + 'a'.repeat(40),
  'url column: long path segment is not a token');

// JSON columns: valid after scrubbing; ids, timestamps and URLs preserved
{
  const raw = JSON.stringify({
    uuid: '12345678-1234-1234-1234-123456789abc',
    parent_message_uuid: '12345678-1234-1234-1234-123456789abd',
    created_at: '2026-01-01T00:00:00.000Z',
    inserted_at: 1767225600,
    url: 'https://example.org/' + 'b'.repeat(40),
    text: 'write to a@b.co or call 555-123-4567',
    nested: { items: [{ id: 'x'.repeat(40), note: 'ip 10.0.0.1' }] },
    flag: true,
    n: null
  });
  const r = scrubJsonText(raw);
  let parsed = null;
  try { parsed = JSON.parse(r.value); } catch { /* fails below */ }
  assert(parsed !== null, 'json: still parses');
  assertEq(parsed.uuid, '12345678-1234-1234-1234-123456789abc', 'json: uuid value preserved');
  assertEq(parsed.parent_message_uuid, '12345678-1234-1234-1234-123456789abd', 'json: id key preserved');
  assertEq(parsed.created_at, '2026-01-01T00:00:00.000Z', 'json: timestamp preserved');
  assertEq(parsed.inserted_at, 1767225600, 'json: numbers untouched');
  assertEq(parsed.url, 'https://example.org/' + 'b'.repeat(40), 'json: url key preserved');
  assertEq(parsed.text, 'write to <REDACTED:EMAIL> or call <REDACTED:PHONE>', 'json: prose scrubbed');
  assertEq(parsed.nested.items[0].id, 'x'.repeat(40), 'json: nested id key preserved');
  assertEq(parsed.nested.items[0].note, 'ip <REDACTED:IP>', 'json: nested prose scrubbed');
  assertEq(parsed.flag, true, 'json: booleans untouched');
  assertEq(parsed.n, null, 'json: null untouched');
  assertEq(r.counts, { total: 3, byType: { EMAIL: 1, PHONE: 1, IP: 1 } }, 'json: counts');
  assertEq(scrubJsonText('').value, '', 'json: empty passthrough');
  assertEq(scrubJsonText('not json a@b.co').value, 'not json <REDACTED:EMAIL>', 'json: unparseable falls back to text');
}

// scrubRowDeep: every cell, order preserved, counts aggregated
{
  const row = { message_id: 'm-1', text: 'a@b.co', raw_json: '{"text":"b@c.co","id":"' + 'q'.repeat(40) + '"}', url: 'https://e.org', n: 3 };
  const r = scrubRowDeep(row);
  assertEq(Object.keys(r.row), ['message_id', 'text', 'raw_json', 'url', 'n'], 'rowDeep: key order');
  assertEq(r.row.message_id, 'm-1', 'rowDeep: structural kept');
  assertEq(r.row.text, '<REDACTED:EMAIL>', 'rowDeep: text scrubbed');
  assertEq(JSON.parse(r.row.raw_json), { text: '<REDACTED:EMAIL>', id: 'q'.repeat(40) }, 'rowDeep: json scrubbed structurally');
  assertEq(r.row.url, 'https://e.org', 'rowDeep: url kept');
  assertEq(r.counts, { total: 2, byType: { EMAIL: 2 } }, 'rowDeep: counts');
}

// --- Ruleset version + exposed option keys -----------------------------
assert(typeof PII_RULESET_VERSION === 'string' && PII_RULESET_VERSION.length > 0,
  'PII_RULESET_VERSION is a non-empty string');
assert(/^\d+\.\d+\.\d+$/.test(PII_RULESET_VERSION),
  'PII_RULESET_VERSION is semver-shaped');
assert(Array.isArray(PII_SCRUB_OPTION_KEYS) && PII_SCRUB_OPTION_KEYS.includes('URL'),
  'PII_SCRUB_OPTION_KEYS exposes URL toggle');
assert(Object.isFrozen(PII_SCRUB_OPTION_KEYS),
  'PII_SCRUB_OPTION_KEYS is frozen so callers cannot mutate it');

// --- Report -------------------------------------------------------------
console.log(`\nPII tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
