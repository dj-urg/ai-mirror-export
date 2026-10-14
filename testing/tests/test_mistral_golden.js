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

// Second fixture: an assistant message with a top-level `content` string and
// a reasoning chunk. `text` must be the rendered `content` (not the chunk
// concatenation), reasoning must land only in `reasoning_text`.
const FIXTURE2 = path.join(__dirname, '..', 'data', 'synthetic', 'mistral_reasoning_golden_v1.json');
const data2 = JSON.parse(fs.readFileSync(FIXTURE2, 'utf8'));
const result2 = extractMistralConversation(data2, {
  donorId: 'golden-donor',
  donorIdType: 'persistent',
  downloadTime: '2026-01-01T00:00:00.000Z'
});
const assistant = result2.messages.find(m => m.role === 'assistant');
const user = result2.messages.find(m => m.role === 'user');
const assistantMsg = data2.messages.find(m => m.role === 'assistant');
assert('reasoning fixture: assistant text is the top-level content',
  assistant && assistant.text === assistantMsg.content, assistant && assistant.text);
assert('reasoning fixture: assistant text excludes the reasoning chunk',
  assistant && !assistant.text.includes('Let me think'));
assert('reasoning fixture: assistant text excludes the draft chunk',
  assistant && !assistant.text.includes('Draft answer'));
assert('reasoning fixture: reasoning_text holds the reasoning chunk',
  assistant && assistant.reasoning_text === 'Let me think about which RFC covers CSV.', assistant && assistant.reasoning_text);
assert('reasoning fixture: has_reasoning flag set', assistant && assistant.has_reasoning === true);
assert('reasoning fixture: user text is the prompt content',
  user && user.text === 'Which RFC defines CSV? Think it through.');
assert('reasoning fixture: model_identifier from message', assistant && assistant.model_identifier === 'magistral-medium');
const canon2 = result2.messagesCanonicalCSV;
assert('reasoning fixture: canonical text excludes reasoning', !canon2.includes('Let me think'));
assert('reasoning fixture: canonical text carries the rendered answer', canon2.includes('The final rendered answer'));

// Chunks-only fallback (no top-level content): non-reasoning text chunks are
// joined, reasoning still excluded.
const chunksOnly = extractMistralConversation({
  _captured_conversation_id: 'mistral-golden-0003',
  chat: null,
  messages: [{
    id: 'm1', role: 'assistant', turn: 0, createdAt: '2026-01-01T00:00:00.000Z',
    contentChunks: [
      { type: 'text', text: 'thinking...', _context: { type: 'reasoning' } },
      { type: 'text', text: 'Part one.' },
      { type: 'text', text: 'Part two.' }
    ]
  }]
}, { donorId: 'd', donorIdType: 'persistent', downloadTime: '2026-01-01T00:00:00.000Z' });
assert('chunks-only fallback joins non-reasoning chunks',
  chunksOnly.messages[0].text === 'Part one.\n\nPart two.', chunksOnly.messages[0].text);
assert('chunks-only fallback keeps reasoning separate',
  chunksOnly.messages[0].reasoning_text === 'thinking...');

console.log(`\nMistral golden test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
