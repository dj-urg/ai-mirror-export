/**
 * Golden-output test for the Gemini extractor.
 *
 * The fixture mirrors what content.js assembles from the `hNvQHb` history
 * RPC: messages oldest-first, one row per turn part, with the assistant's
 * selected candidate and its citations (one per reference, located in the
 * answer by content.js). The extractor must keep that order, carry the
 * candidate ids through, and write one sources row per citation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractGeminiConversation } from '../../platforms/gemini/extractor.js';
import { canonicalHeaders, SCHEMA_VERSIONS, EXTRACTOR_VERSION, countRows } from '../../utils/manifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'data', 'synthetic', 'gemini_golden_v1.json');

let passed = 0;
let failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { passed++; } else { failed++; console.error('FAIL:', name, detail); }
}

const data = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const result = extractGeminiConversation(data, {
  donorId: 'golden-donor',
  donorIdType: 'persistent',
  downloadTime: '2026-01-01T00:00:00.000Z'
});

// Metadata
assert('metadata.conversation_id matches stamped id',
  result.metadata.conversation_id === data._captured_conversation_id);
assert('metadata.num_messages = 4', result.metadata.num_messages === 4);
assert('metadata.num_user_messages = 2', result.metadata.num_user_messages === 2);
assert('metadata.num_assistant_messages = 2', result.metadata.num_assistant_messages === 2);
assert('metadata.num_messages_with_citations = 2', result.metadata.num_messages_with_citations === 2);
assert('metadata.num_cited_sources counts every citation', result.metadata.num_cited_sources === 3,
  String(result.metadata.num_cited_sources));
assert('metadata.model comes from the conversation', result.metadata.model === 'gemini-2.5-pro');
assert('metadata.source_path is preserved', result.metadata.source_path === '/app/gemini-golden-0001');

// Messages — fixture order is already oldest-first.
assert('messages length = 4', result.messages.length === 4);
assert('messages row count matches CSV', countRows(result.messagesCSV) === result.messages.length);
assert('roles alternate user/assistant',
  result.messages.map(m => m.role).join(',') === 'user,assistant,user,assistant',
  result.messages.map(m => m.role).join(','));
assert('turn_index increments per turn',
  result.messages.map(m => m.turn_index).join(',') === '0,0,1,1',
  result.messages.map(m => m.turn_index).join(','));
assert('assistant carries candidate_id',
  result.messages[1].candidate_id === 'rc_synthetic0001');
assert('assistant parent_candidate_id is preserved',
  result.messages[1].parent_candidate_id === 'rc_parent0001');
assert('second user message points at the first answer',
  result.messages[2].parent_message_id === 'r_synthetic0001');

// Sources — one row per citation; an unlocated passage gets empty offsets.
assert('sources length = 3 (one per citation)', result.sources.length === 3,
  String(result.sources.length));
assert('all sources are citation rows', result.sources.every(s => s.source_list === 'citation'));
const answer2 = result.messages[3].text;
assert('offsets locate the cited passage in the answer',
  answer2.slice(result.sources[1].start_index, result.sources[1].end_index) === result.sources[1].snippet,
  `${result.sources[1].start_index}-${result.sources[1].end_index}`);
assert("Gemini's raw span pairs kept in raw_json",
  JSON.parse(result.sources[1].raw_json).raw_spans.length === 2);
assert('unlocated passage keeps empty offsets',
  result.sources[2].start_index === '' && result.sources[2].end_index === '');
assert('url_clean strips utm parameters',
  result.sources[2].url_clean === 'https://example.org/csv-guide', result.sources[2].url_clean);
assert('snippet is carried', result.sources[0].snippet.length > 0);

// Canonical CSV
const canonLines = result.messagesCanonicalCSV.split(/\r\n/);
assert('canonical header is canonicalHeaders()', canonLines[0] === canonicalHeaders().join(','));
assert('canonical row count matches messages',
  countRows(result.messagesCanonicalCSV) === result.messages.length);
assert('canonical row embeds gemini platform', (canonLines[1] || '').includes(',gemini,'));
assert('canonical embeds candidate_id in platform_specific_json',
  result.messagesCanonicalCSV.includes('rc_synthetic0001'));

// Provenance
assert('schema_version for gemini_metadata is known',
  typeof SCHEMA_VERSIONS.gemini_metadata === 'string');
assert('schema_version for gemini_messages is known',
  typeof SCHEMA_VERSIONS.gemini_messages === 'string');
assert('schema_version for gemini_sources is known',
  typeof SCHEMA_VERSIONS.gemini_sources === 'string');
assert('schema_version for gemini_messages_canonical is known',
  typeof SCHEMA_VERSIONS.gemini_messages_canonical === 'string');
assert('extractor_version non-empty', EXTRACTOR_VERSION.length > 0);

// Defensive: a conversation with only a user prompt still exports it, and a
// title-less conversation gets a title derived from that prompt.
const sparse = extractGeminiConversation({
  conversation: { id: 'c_sparse' },
  messages: [{
    message_id: 'user-1', role: 'user', turn_index: 0,
    text: '  Explain\nCSV quoting.  ', created_at: '2026-01-01T00:00:00.000Z'
  }]
}, { donorId: 'd', donorIdType: 'persistent', downloadTime: '2026-01-01T00:00:00.000Z' });
assert('sparse conversation exports the user prompt',
  sparse.messages.length === 1 && sparse.messages[0].role === 'user');
assert('sparse conversation derives a single-line title',
  sparse.metadata.title === 'Explain CSV quoting.', sparse.metadata.title);
assert('sparse conversation has no sources rows', sparse.sources.length === 0);

console.log(`\nGemini golden test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
