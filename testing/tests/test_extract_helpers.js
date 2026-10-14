/**
 * utils/extract_helpers.js: the helpers every extractor shares.
 */
import { stripUtmParams, toJsonCell, normalizeRole } from '../../utils/extract_helpers.js';

let passed = 0;
let failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { passed++; } else { failed++; console.error('FAIL:', name, detail); }
}

assert('stripUtm: removes the five utm params',
  stripUtmParams('https://e.org/a?utm_source=x&q=1&utm_medium=m&utm_campaign=c&utm_term=t&utm_content=k') === 'https://e.org/a?q=1');
assert('stripUtm: keeps other params and order', stripUtmParams('https://e.org/a?b=2&a=1') === 'https://e.org/a?b=2&a=1');
assert('stripUtm: non-URL passes through', stripUtmParams('not a url') === 'not a url');
assert('stripUtm: empty -> empty', stripUtmParams('') === '' && stripUtmParams(null) === '');
assert('toJsonCell: null/undefined -> empty', toJsonCell(null) === '' && toJsonCell(undefined) === '');
assert('toJsonCell: object -> compact JSON', toJsonCell({ a: [1, 'x'] }) === '{"a":[1,"x"]}');
const circular = {}; circular.self = circular;
assert('toJsonCell: unserialisable -> empty', toJsonCell(circular) === '');
assert('normalizeRole: human/user', normalizeRole('human') === 'user' && normalizeRole('USER') === 'user');
assert('normalizeRole: assistant/bot/ai', normalizeRole('ASSISTANT') === 'assistant' && normalizeRole('bot') === 'assistant' && normalizeRole('ai') === 'assistant');
assert('normalizeRole: system', normalizeRole('System') === 'system');
assert('normalizeRole: unknown lower-cased', normalizeRole('Tool') === 'tool');
assert('normalizeRole: empty', normalizeRole('') === '' && normalizeRole(null) === '');

console.log(`\nExtract helper tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
