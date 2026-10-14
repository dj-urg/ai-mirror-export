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

// Branched fixture: u1 has two assistant children; current_node points at the
// regenerated one. Every branch is exported; on_visible_path marks the chain
// from current_node to the root.
const FIXTURE2 = path.join(__dirname, '..', 'data', 'synthetic', 'chatgpt_branch_golden_v1.json');
const result2 = extractChatGPTConversation(JSON.parse(fs.readFileSync(FIXTURE2, 'utf8')), {
  donorId: 'golden-donor', donorIdType: 'persistent', downloadTime: '2026-01-01T00:00:00.000Z'
});
const byId = (id) => result2.messages.find(m => m.node_id === id);
assert('branch: all three messages exported', result2.messages.length === 3, String(result2.messages.length));
assert('branch: u1 on visible path', byId('u1').on_visible_path === true);
assert('branch: a1 (replaced) off visible path', byId('a1').on_visible_path === false);
assert('branch: a1b on visible path', byId('a1b').on_visible_path === true);
assert('branch: messages header ends with on_visible_path', result2.messagesCSV.split(/\r\n/)[0].endsWith(',on_visible_path'));
const canonA1 = result2.messagesCanonicalCSV.split(/\r\n/).find(l => l.includes(',a1,'));
assert('branch: canonical json carries on_visible_path false', canonA1 && canonA1.includes('""on_visible_path"":false'));
assert('no current_node: every message visible', result.messages.every(m => m.on_visible_path === true));
assert('messages-array format: every message visible',
  extractChatGPTConversation({ conversation_id: 'x', messages: [{ id: 'm1', author: { role: 'user' }, content: { content_type: 'text', parts: ['hi'] } }] }, {})
    .messages[0].on_visible_path === true);

console.log(`\nChatGPT golden test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
