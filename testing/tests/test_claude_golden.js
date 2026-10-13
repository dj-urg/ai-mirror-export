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

console.log(`\nClaude golden test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
