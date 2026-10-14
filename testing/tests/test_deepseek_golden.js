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

// Second fixture: search + thinking turn. Covers the 1.1.0 columns:
// `model` (the API key name; model_class/model_name were always empty),
// `cite_index` on sources, and stringified fragment ids.
const FIXTURE2 = path.join(__dirname, '..', 'data', 'synthetic', 'deepseek_search_golden_v1.json');
const data2 = JSON.parse(fs.readFileSync(FIXTURE2, 'utf8'));
const result2 = extractDeepSeekConversation(data2, {
  donorId: 'golden-donor',
  donorIdType: 'persistent',
  downloadTime: '2026-01-01T00:00:00.000Z'
});
const asst = result2.messages.find(m => m.role === 'assistant');
assert('search fixture: model column populated from `model`', asst && asst.model === 'deepseek-reasoner', asst && asst.model);
assert('search fixture: thinking_text from THINK fragment',
  asst && asst.thinking_text === 'The user wants the publication year of RFC 4180.');
assert('search fixture: text from RESPONSE fragment only',
  asst && asst.text === 'RFC 4180 was published in October 2005.', asst && asst.text);
assert('search fixture: two sources', result2.sources.length === 2, String(result2.sources.length));
assert('search fixture: cite_index carried', result2.sources.map(s => s.cite_index).join(',') === '1,2');
assert('search fixture: fragment_id is a string', typeof result2.sources[0].fragment_id === 'string' && result2.sources[0].fragment_id === '102');
assert('search fixture: url_clean strips utm', result2.sources[0].url_clean === 'https://example.org/rfc4180');
const srcHeader = result2.sourcesCSV.split(/\r\n/)[0];
assert('sources header includes cite_index', srcHeader.split(',').includes('cite_index'));
const msgHeader2 = result2.messagesCSV.split(/\r\n/)[0].split(',');
assert('messages header has model, not model_class/model_name',
  msgHeader2.includes('model') && !msgHeader2.includes('model_class') && !msgHeader2.includes('model_name'));
const canon2 = result2.messagesCanonicalCSV.split(/\r\n/);
assert('canonical model_identifier from `model`', (canon2[2] || '').includes(',deepseek-reasoner,'));
assert('deepseek_messages schema is 1.1.0', SCHEMA_VERSIONS.deepseek_messages === '1.1.0');
assert('deepseek_sources schema is 1.1.0', SCHEMA_VERSIONS.deepseek_sources === '1.1.0');

console.log(`\nDeepSeek golden test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
