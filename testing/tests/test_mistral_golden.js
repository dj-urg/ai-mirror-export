/**
 * Golden-output test for the Mistral extractor.
 *
 * Mistral's API returns newest-first; the extractor reverses to oldest-first,
 * so the fixture carries messages in newest-first order to exercise that path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractMistralConversation } from '../../platforms/mistral/extractor.js';
import { canonicalHeaders, SCHEMA_VERSIONS, EXTRACTOR_VERSION, countRows } from '../../utils/manifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'data', 'synthetic', 'mistral_golden_v1.json');

let passed = 0;
let failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { passed++; } else { failed++; console.error('FAIL:', name, detail); }
}

const data = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const result = extractMistralConversation(data, {
  donorId: 'golden-donor',
  donorIdType: 'persistent',
  downloadTime: '2026-01-01T00:00:00.000Z'
});

// Metadata
assert('metadata.conversation_id matches stamped id',
  result.metadata.conversation_id === data._captured_conversation_id);
assert('metadata.num_messages = 2', result.metadata.num_messages === 2);

// Messages — order reversed from fixture (fixture is newest-first)
assert('messages length = 2', result.messages.length === 2);
assert('messages row count matches CSV', countRows(result.messagesCSV) === result.messages.length);
assert('first row is user (reverse applied)', result.messages[0].role === 'user');
assert('second row is assistant (reverse applied)', result.messages[1].role === 'assistant');

// Canonical CSV
const canonLines = result.messagesCanonicalCSV.split(/\r\n/);
assert('canonical header is canonicalHeaders()', canonLines[0] === canonicalHeaders().join(','));
assert('canonical row count matches messages',
  countRows(result.messagesCanonicalCSV) === result.messages.length);
assert('canonical row embeds mistral platform', (canonLines[1] || '').includes(',mistral,'));

// Provenance
assert('schema_version for mistral_messages is known',
  typeof SCHEMA_VERSIONS.mistral_messages === 'string');
assert('schema_version for mistral_messages_canonical is known',
  typeof SCHEMA_VERSIONS.mistral_messages_canonical === 'string');
assert('extractor_version non-empty', EXTRACTOR_VERSION.length > 0);

console.log(`\nMistral golden test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
