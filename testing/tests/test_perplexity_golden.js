/**
 * Golden-output test for the Perplexity extractor.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPerplexityConversation } from '../../platforms/perplexity/extractor.js';
import { canonicalHeaders, SCHEMA_VERSIONS, EXTRACTOR_VERSION, countRows } from '../../utils/manifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'data', 'synthetic', 'perplexity_golden_v1.json');

let passed = 0;
let failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { passed++; } else { failed++; console.error('FAIL:', name, detail); }
}

const data = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const result = extractPerplexityConversation(data, {
  donorId: 'golden-donor',
  donorIdType: 'persistent',
  downloadTime: '2026-01-01T00:00:00.000Z'
});

// Metadata
assert('metadata.conversation_id matches fixture', result.metadata.conversation_id === data.uuid);
assert('metadata.title matches fixture', result.metadata.title === data.title);

// Messages: Perplexity emits one user row + one assistant row per entry.
assert('messages length = 2', result.messages.length === 2);
assert('messages row count matches CSV', countRows(result.messagesCSV) === result.messages.length);

// Sources: one URL in the fixture.
// Raw `url` keeps UTM params; `url_clean` strips them.
assert('sources length = 1', result.sources.length === 1);
assert('sources CSV keeps raw url with utm',
  result.sourcesCSV.includes('utm_source=test'));
assert('sources row.url_clean has no utm',
  !result.sources[0].url_clean.includes('utm_source'));

// Canonical CSV
const canonLines = result.messagesCanonicalCSV.split(/\r\n/);
assert('canonical header is canonicalHeaders()', canonLines[0] === canonicalHeaders().join(','));
assert('canonical row count matches messages',
  countRows(result.messagesCanonicalCSV) === result.messages.length);
assert('canonical row embeds perplexity platform', (canonLines[1] || '').includes(',perplexity,'));

// Provenance
assert('schema_version for perplexity_messages is known',
  typeof SCHEMA_VERSIONS.perplexity_messages === 'string');
assert('extractor_version non-empty', EXTRACTOR_VERSION.length > 0);

console.log(`\nPerplexity golden test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
