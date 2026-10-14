/**
 * Golden-output test for the ChatGPT extractor.
 *
 * Runs the real extractor against the synthetic `mapping`-format fixture and
 * pins the invariants a schema or extraction change could silently regress.
 * Byte-level output is covered by test_background_golden.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractChatGPTConversation, detectApiFormat } from '../../platforms/chatgpt/extractor.js';
import { canonicalHeaders, SCHEMA_VERSIONS, EXTRACTOR_VERSION, countRows } from '../../utils/manifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'data', 'synthetic', 'chatgpt_golden_v1.json');

let passed = 0;
let failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { passed++; } else { failed++; console.error('FAIL:', name, detail); }
}

const data = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const result = extractChatGPTConversation(data, {
  donorId: 'golden-donor',
  donorIdType: 'persistent',
  downloadTime: '2026-01-01T00:00:00.000Z'
});

// Format detection
assert('api_format is mapping', result.apiFormat === 'mapping', result.apiFormat);
assert('detectApiFormat matches', detectApiFormat(data) === result.apiFormat);

// Metadata CSV has provenance columns
const metaHeader = result.metadataCSV.split('\n')[0];
assert('metadata has schema_version column', metaHeader.startsWith('schema_version,extractor_version,api_format'));
assert('metadata.conversation_id matches fixture', result.metadata.conversation_id === data.conversation_id);
assert('metadata.title matches fixture', result.metadata.title === data.title);

// Messages CSV: the fixture yields a system row, one user turn and one
// assistant turn. The hidden user_editable_context node is not a message.
const msgHeader = result.messagesCSV.split(/\r\n/)[0];
assert('messages has schema_version first', msgHeader.startsWith('schema_version,extractor_version'));
assert('messages row count matches extracted', countRows(result.messagesCSV) === result.messages.length);
assert('three message rows (system, user, assistant)', result.messages.length === 3, String(result.messages.length));
assert('roles in order', result.messages.map(m => m.author_role).join(',') === 'system,user,assistant',
  result.messages.map(m => m.author_role).join(','));
assert('model slug carried through', result.messages[2].model_slug === 'gpt-4o', result.messages[2].model_slug);

// Canonical CSV
const canonLines = result.messagesCanonicalCSV.split(/\r\n/);
assert('canonical header is exactly canonicalHeaders()', canonLines[0] === canonicalHeaders().join(','));
assert('canonical row count matches messages', countRows(result.messagesCanonicalCSV) === result.messages.length);
assert('canonical row embeds chatgpt platform', (canonLines[1] || '').includes(',chatgpt,'));

// Donor context (user profile + custom instructions) is extracted
assert('donor context user_profile captured',
  typeof result.donorContext?.user_profile === 'string' && result.donorContext.user_profile.length > 0);
assert('donor context user_instructions captured',
  typeof result.donorContext?.user_instructions === 'string' && result.donorContext.user_instructions.length > 0);

// Message URLs come from content_references / safe_urls metadata, which the
// fixture does not carry, so the list is present but empty.
assert('messageUrls is an array', Array.isArray(result.messageUrls));
assert('no message URLs without content_references', result.messageUrls.length === 0,
  String(result.messageUrls.length));

// Provenance values
assert('extractor_version non-empty', EXTRACTOR_VERSION.length > 0);
assert('schema_version for messages is known', typeof SCHEMA_VERSIONS.chatgpt_messages === 'string');
assert('orphan count is a number', typeof result.orphanCount === 'number');
assert('metadata.num_messages equals extracted messages length',
  result.metadata.num_messages === result.messages.length,
  `${result.metadata.num_messages} vs ${result.messages.length}`);

console.log(`\nChatGPT golden test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
