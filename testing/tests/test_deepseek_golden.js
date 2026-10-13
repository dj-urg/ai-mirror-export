/**
 * Golden-output test for the DeepSeek extractor.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractDeepSeekConversation } from '../../platforms/deepseek/extractor.js';
import { canonicalHeaders, SCHEMA_VERSIONS, EXTRACTOR_VERSION, countRows } from '../../utils/manifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'data', 'synthetic', 'deepseek_golden_v1.json');

let passed = 0;
let failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { passed++; } else { failed++; console.error('FAIL:', name, detail); }
}

const data = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const session = data.data.biz_data.chat_session;
const result = extractDeepSeekConversation(data, {
  donorId: 'golden-donor',
  donorIdType: 'persistent',
  downloadTime: '2026-01-01T00:00:00.000Z'
});

// Metadata
assert('metadata.conversation_id matches session id',
  result.metadata.conversation_id === session.id);
assert('metadata.title matches fixture', result.metadata.title === session.title);
assert('metadata.num_messages = 2', result.metadata.num_messages === 2);
assert('metadata.num_user_messages = 1', result.metadata.num_user_messages === 1);
assert('metadata.num_assistant_messages = 1', result.metadata.num_assistant_messages === 1);

// Messages
assert('messages length = 2', result.messages.length === 2);
assert('messages row count matches CSV', countRows(result.messagesCSV) === result.messages.length);
assert('turn_index 0 is user', result.messages[0].role === 'user');
assert('turn_index 1 is assistant', result.messages[1].role === 'assistant');

// Canonical CSV
const canonLines = result.messagesCanonicalCSV.split(/\r\n/);
assert('canonical header is canonicalHeaders()', canonLines[0] === canonicalHeaders().join(','));
assert('canonical row count matches messages',
  countRows(result.messagesCanonicalCSV) === result.messages.length);
assert('canonical row embeds deepseek platform', (canonLines[1] || '').includes(',deepseek,'));

// Provenance
assert('schema_version for deepseek_messages is known',
  typeof SCHEMA_VERSIONS.deepseek_messages === 'string');
assert('extractor_version non-empty', EXTRACTOR_VERSION.length > 0);

console.log(`\nDeepSeek golden test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
