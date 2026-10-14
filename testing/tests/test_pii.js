/**
 * Tests for utils/pii.js
 *
 * Run with: node testing/tests/test_pii.js
 */

import {
  scrubText,
  scrubRow,
  scrubRows,
  countRedactions,
  DEFAULT_SCRUB_COLUMNS,
  PII_RULESET_VERSION,
  PII_SCRUB_OPTION_KEYS
} from '../../utils/pii.js';

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

// --- DEFAULT_SCRUB_COLUMNS ----------------------------------------------
// Message-text columns scrub both the raw `text` and the derived `text_cleaned`
// column so the NLP-ready view also has secrets removed when scrub is enabled.
assertEq(DEFAULT_SCRUB_COLUMNS.chatgpt_messages, ['text', 'text_cleaned'], 'defaults: chatgpt_messages');
assertEq(DEFAULT_SCRUB_COLUMNS.chatgpt_donor_context, ['user_profile', 'user_instructions'],
  'defaults: chatgpt_donor_context');
assertEq(DEFAULT_SCRUB_COLUMNS.claude_metadata, ['conversation_name', 'summary'],
  'defaults: claude_metadata');
assertEq(DEFAULT_SCRUB_COLUMNS.claude_messages, ['text', 'text_cleaned'],
  'defaults: claude_messages');
assertEq(DEFAULT_SCRUB_COLUMNS.claude_sources, ['title', 'snippet'],
  'defaults: claude_sources');
assertEq(DEFAULT_SCRUB_COLUMNS.claude_attachments, ['file_name', 'extracted_text'],
  'defaults: claude_attachments');
assertEq(DEFAULT_SCRUB_COLUMNS.copilot_conversation, ['text', 'text_cleaned'],
  'defaults: copilot_conversation');
assertEq(DEFAULT_SCRUB_COLUMNS.google_ai_mode, ['text', 'text_cleaned', 'conversation_title', 'conversation_id'],
  'defaults: google_ai_mode');
assertEq(DEFAULT_SCRUB_COLUMNS.google_ai_overview, ['query', 'ai_overview_text', 'ai_overview_text_cleaned'],
  'defaults: google_ai_overview');
assertEq(DEFAULT_SCRUB_COLUMNS.google_sources, ['title'],
  'defaults: google_sources');

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
