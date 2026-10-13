/**
 * Tests for platforms/perplexity/extractor.js
 *
 * Covers:
 * - Metadata extraction
 * - Message row structure (user prompt + assistant answer per turn)
 * - Parent/child chain across turns
 * - Reasoning + code block separation
 * - Source extraction with UTM stripping
 * - Canonical CSV platform tag
 * - Shape tolerance (missing fields, alternate field names)
 */

import { extractPerplexityConversation } from '../../platforms/perplexity/extractor.js';

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) passed++;
  else { failed++; failures.push(msg); }
}

function assertEq(actual, expected, msg) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed++;
  else {
    failed++;
    failures.push(`${msg}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(hay, needle, msg) {
  if (typeof hay === 'string' && hay.includes(needle)) passed++;
  else {
    failed++;
    failures.push(`${msg}\n  expected to include: ${needle}\n  in: ${(hay || '').slice(0, 200)}...`);
  }
}

function assertNotIncludes(hay, needle, msg) {
  if (typeof hay === 'string' && !hay.includes(needle)) passed++;
  else { failed++; failures.push(`${msg}\n  unexpected substring: ${needle}`); }
}

// ---------------------------------------------------------------------------
// Baseline payload
// ---------------------------------------------------------------------------

const baseline = {
  uuid: '037acdeb-a0eb-476e-9a05-dcae08e12a6b',
  title: 'What is a content script?',
  created_at: '2026-10-13T10:00:00Z',
  updated_at: '2026-10-13T10:05:30Z',
  page_count: 1,
  entries: [
    {
      uuid: 'e1',
      query_str: 'What is a content script?',
      status: 'COMPLETED',
      display_model: 'sonar',
      created_at: '2026-10-13T10:00:00Z',
      updated_at: '2026-10-13T10:00:12Z',
      blocks: [
        { markdown_block: { answer: 'A content script runs in the page.', progress: 'DONE' } },
        { web_result_block: {
            web_results: [
              { url: 'https://a.example/foo?utm_source=x', title: 'A', snippet: 'alpha', domain: 'a.example' },
              { url: 'https://b.example/bar', title: 'B', snippet: 'beta', domain: 'b.example' }
            ]
          }
        }
      ]
    },
    {
      backend_uuid: 'e2',
      query: 'And isolated vs MAIN world?',
      status: 'COMPLETED',
      display_model: 'sonar-reasoning',
      created_at: '2026-10-13T10:04:00Z',
      updated_at: '2026-10-13T10:05:30Z',
      blocks: [
        { reasoning_block: { content: 'Thinking out loud.' } },
        { markdown_block: { answer: 'Two separate JS realms, shared DOM.' } },
        { code_block: { code: 'addEventListener("message", e => {});', language: 'javascript' } }
      ]
    }
  ]
};

const out = extractPerplexityConversation(baseline, {
  donorId: 'donor-abc',
  donorIdType: 'persistent',
  downloadTime: '2026-10-13T10:06:00Z'
});

// --- metadata ---
assertEq(out.metadata.conversation_id, '037acdeb-a0eb-476e-9a05-dcae08e12a6b', 'metadata.conversation_id');
assertEq(out.metadata.title, 'What is a content script?', 'metadata.title');
assertEq(out.metadata.num_turns, 2, 'metadata.num_turns');
assertEq(out.metadata.num_sources, 2, 'metadata.num_sources');
assertEq(out.metadata.page_count, 1, 'metadata.page_count');

// --- messages ---
assertEq(out.messages.length, 4, 'two turns -> four message rows');
assertEq(out.messages[0].role, 'user', 'row 0 is user');
assertEq(out.messages[1].role, 'assistant', 'row 1 is assistant');
assertEq(out.messages[0].text, 'What is a content script?', 'user prompt text');
assertEq(out.messages[1].text, 'A content script runs in the page.', 'assistant answer text');
assertEq(out.messages[1].model_identifier, 'sonar', 'assistant model');
assertEq(out.messages[1].source_count, 2, 'source_count on assistant row');

// Parent/child chain across turns
assertEq(out.messages[0].parent_id, '', 'first user row has no parent');
assertEq(out.messages[1].parent_id, 'e1:user', 'first assistant parent is first user');
assertEq(out.messages[2].parent_id, 'e1:assistant', 'second user parent is previous assistant');
assertEq(out.messages[3].parent_id, 'e2:user', 'second assistant parent is second user');

// Reasoning + code captured on second assistant row
assertEq(out.messages[3].code_text, 'addEventListener("message", e => {});', 'code_text captured');
assertEq(out.messages[3].reasoning_text, 'Thinking out loud.', 'reasoning_text captured');

// --- sources ---
assertEq(out.sources.length, 2, 'two sources');
assertEq(out.sources[0].url_clean, 'https://a.example/foo', 'UTM stripped');
assertEq(out.sources[0].source_block_type, 'web_result_block', 'source block type');
assertEq(out.sources[1].title, 'B', 'second source title');

// --- CSV output format ---
assertIncludes(out.metadataCSV, 'schema_version,extractor_version,donor_id', 'metadata header present');
assertIncludes(out.messagesCSV, '037acdeb-a0eb-476e-9a05-dcae08e12a6b', 'conversation_id in messages CSV');
assertIncludes(out.messagesCanonicalCSV, 'perplexity', 'canonical CSV tags platform');
assertIncludes(out.messagesCanonicalCSV, 'donor_id,platform,conversation_id', 'canonical header shape');
assertIncludes(out.sourcesCSV, 'https://a.example/foo', 'clean url present in sources CSV');

// ---------------------------------------------------------------------------
// Shape tolerance
// ---------------------------------------------------------------------------

const minimal = {
  uuid: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
  entries: [
    { query_str: 'Hello', blocks: [{ text_block: { text: 'Hi.' } }] }
  ]
};
const outMinimal = extractPerplexityConversation(minimal, {
  donorId: 'd', donorIdType: 'persistent', downloadTime: '2026-10-13T00:00:00Z'
});
assertEq(outMinimal.messages.length, 2, 'minimal payload still produces user+assistant rows');
assertEq(outMinimal.messages[1].text, 'Hi.', 'text_block answer extracted');
assertEq(outMinimal.sources.length, 0, 'no sources on minimal payload');

// Alternate top-level entry container
const altEntries = {
  backend_uuid: 'bb',
  entries: [], // intentionally empty
  data: [
    { uuid: 'z1', prompt: 'alt-prompt', blocks: [{ markdown_block: { content: 'alt-answer' } }] }
  ]
};
// The merged content.js payload only ever ships `entries`, so the extractor
// specifically reads entries. Confirm that the shape it DOES handle doesn't
// crash when entries is empty, and that the extractor doesn't accidentally
// pick up data[] (we only normalize entries at the extractor layer).
const outAlt = extractPerplexityConversation(altEntries, { donorId: 'd' });
assertEq(outAlt.messages.length, 0, 'empty entries -> no messages');

// Non-object payload
try {
  extractPerplexityConversation(null);
  failed++;
  failures.push('expected throw for null payload');
} catch (_) {
  passed++;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\nPerplexity extractor tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
