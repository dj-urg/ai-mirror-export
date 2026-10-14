/**
 * Golden-output test for the Claude extractor.
 *
 * Runs the real extractor against a synthetic fixture and pins the
 * invariants a schema or extraction change could silently regress.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractClaudeConversation } from '../../platforms/claude/extractor.js';
import { canonicalHeaders, SCHEMA_VERSIONS, EXTRACTOR_VERSION, countRows } from '../../utils/manifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'data', 'synthetic', 'claude_golden_v1.json');

let passed = 0;
let failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { passed++; } else { failed++; console.error('FAIL:', name, detail); }
}

const data = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const result = extractClaudeConversation(data, {
  donorId: 'golden-donor',
  donorIdType: 'persistent',
  downloadTime: '2026-01-01T00:00:00.000Z'
});

// Metadata
assert('metadata.conversation_id matches fixture', result.metadata.conversation_id === data.uuid);
assert('metadata.num_messages = 2', result.metadata.num_messages === 2);
assert('metadata.num_user_messages = 1', result.metadata.num_user_messages === 1);
assert('metadata.num_assistant_messages = 1', result.metadata.num_assistant_messages === 1);

// Messages (one row per content block; fixture has 1 block per message)
assert('messages length = 2', result.messages.length === 2);
assert('messages row count matches CSV', countRows(result.messagesCSV) === result.messages.length);
assert('first message is human', result.messages[0].sender === 'human');
assert('second message is assistant', result.messages[1].sender === 'assistant');

// Provenance columns in CSVs
const metaHeader = result.metadataCSV.split('\n')[0];
assert('metadata CSV begins with schema_version,extractor_version',
  metaHeader.startsWith('schema_version,extractor_version'));
const msgHeader = result.messagesCSV.split(/\r\n/)[0];
assert('messages CSV begins with schema_version,extractor_version',
  msgHeader.startsWith('schema_version,extractor_version'));

// Canonical CSV
const canonLines = result.messagesCanonicalCSV.split(/\r\n/);
assert('canonical header is canonicalHeaders()', canonLines[0] === canonicalHeaders().join(','));
assert('canonical row count matches messages',
  countRows(result.messagesCanonicalCSV) === result.messages.length);
assert('canonical row embeds claude platform', (canonLines[1] || '').includes(',claude,'));

// Schema version registered
assert('schema_version for claude_messages is known',
  typeof SCHEMA_VERSIONS.claude_messages === 'string');
assert('extractor_version non-empty', EXTRACTOR_VERSION.length > 0);

// Branched fixture: a regenerated answer (br-3 replaces br-2, same parent),
// thinking summaries and thinking_mode. All branches are exported;
// on_visible_path marks the chain from current_leaf_message_uuid.
const FIXTURE2 = path.join(__dirname, '..', 'data', 'synthetic', 'claude_branch_golden_v1.json');
const data2 = JSON.parse(fs.readFileSync(FIXTURE2, 'utf8'));
const result2 = extractClaudeConversation(data2, {
  donorId: 'golden-donor',
  donorIdType: 'persistent',
  downloadTime: '2026-01-01T00:00:00.000Z'
});
const byMsg = (id) => result2.messages.filter(r => r.message_id === id);
assert('branch: every message exported (4 block rows)', result2.messages.length === 4, String(result2.messages.length));
assert('branch: br-1 on visible path', byMsg('br-1').every(r => r.on_visible_path === true));
assert('branch: br-2 (replaced answer) off visible path', byMsg('br-2').every(r => r.on_visible_path === false));
assert('branch: br-3 on visible path', byMsg('br-3').every(r => r.on_visible_path === true));
assert('branch: thinking_mode exported', byMsg('br-3')[0].thinking_mode === 'auto');
const thinkRow = byMsg('br-3').find(r => r.content_type === 'thinking');
assert('branch: thinking_summary joins summaries', thinkRow && thinkRow.thinking_summary === 'Recalling the CSV RFC.\n\nChecking the number is 4180.', thinkRow && thinkRow.thinking_summary);
assert('branch: hidden thinking text is empty', thinkRow && thinkRow.text === '');
const textRow = byMsg('br-3').find(r => r.content_type === 'text');
assert('branch: text block has no summary', textRow && textRow.thinking_summary === '');
const canon2 = result2.messagesCanonicalCSV.split(/\r\n/);
const br3 = canon2.find(l => l.includes(',br-3,'));
assert('branch: canonical text is the text block only',
  br3 && br3.includes(',assistant,RFC 4180 describes the CSV format.,RFC 4180 describes the CSV format.,2026'), br3 && br3.slice(0, 200));
assert('branch: canonical json carries thinking_summary + on_visible_path', br3 && br3.includes('""thinking_summary"":""Recalling') && br3.includes('""on_visible_path"":true'));
const br2 = canon2.find(l => l.includes(',br-2,'));
assert('branch: canonical marks br-2 off path', br2 && br2.includes('""on_visible_path"":false'));

// Rich fixture: canonical text excludes thinking and tool results.
const FIXTURE3 = path.join(__dirname, '..', 'data', 'synthetic', 'claude_rich_golden_v1.json');
const result3 = extractClaudeConversation(JSON.parse(fs.readFileSync(FIXTURE3, 'utf8')), {
  donorId: 'golden-donor', donorIdType: 'persistent', downloadTime: '2026-01-01T00:00:00.000Z'
});
const rich2 = result3.messagesCanonicalCSV.split(/\r\n/).find(l => l.includes(',rich-2,'));
assert('rich: canonical text has the answer only',
  rich2 && rich2.includes(',assistant,"The report shows ten percent growth, in line with the sector.","The report shows'), rich2 && rich2.slice(0, 200));
assert('rich: tool_result_text in canonical json', rich2 && rich2.includes('""tool_result_text"":""Search found'));
assert('no leaf: every message visible',
  extractClaudeConversation({ uuid: 'x', chat_messages: [{ uuid: 'a', sender: 'human', content: [{ type: 'text', text: 'hi' }] }] }, {}).messages[0].on_visible_path === true);

console.log(`\nClaude golden test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
