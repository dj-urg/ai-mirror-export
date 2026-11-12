/**
 * Perplexity capture path: inject.js (fetch hook) + content.js, run together
 * in a fake page, plus the extractor's answer-block handling. Synthetic
 * responses only.
 *
 * Covers: entry order across pages, id-less entries, has_more reaching the
 * capture record, URL matching (same origin, exact path), a second
 * evaluation of inject.js, the secret guard, duplicate answer blocks and the
 * chunks fallback.
 */

import assert from 'node:assert/strict';
import { makeWorld, jsonResponse } from './helpers/page_world.js';
import { extractPerplexityConversation } from '../../platforms/perplexity/extractor.js';

const MSG = 'PERPLEXITY_CONVERSATION_DATA';
const SOURCE = 'perplexity-exporter-inject';
const THREAD = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const threadUrl = (world, uuid = THREAD, tail = '') => `${world.origin}/rest/thread/${uuid}${tail}`;
const entry = (n, extra = {}) => ({
  uuid: `e${n}`, query_str: `question ${n}`, created_at: `2026-01-01T00:00:0${n}Z`,
  blocks: [{ markdown_block: { answer: `answer ${n}` } }], ...extra
});

async function pageFetch(world, request, body, responseUrl) {
  world.sb.fetchImpl = async () => jsonResponse(body, { url: responseUrl });
  await world.sb.fetch(request);
  await world.settle();
}
const listIds = async world => (await world.ask({ type: 'GET_CAPTURED_CONVERSATIONS' })).conversationIds;
const exportOf = async (world, conversationId = THREAD) => {
  const before = world.exports().length;
  const response = await world.ask({ type: 'EXPORT_CONVERSATION', platform: 'perplexity', conversationId });
  return { response, message: world.exports()[before] };
};

// --- Pages arrive newest first -----------------------------------------------
{
  const world = makeWorld('perplexity');
  const url = threadUrl(world);
  await pageFetch(world, `${url}?limit=2`, { title: 'T', entries: [entry(3), entry(4)], has_more: true, next_cursor: 'c1', read_write_token: 'TOKEN' }, `${url}?limit=2`);

  let { message } = await exportOf(world);
  assert.equal(message.capture.complete, false);
  assert.deepEqual(message.capture.flags, ['has_more'], 'an unfinished pagination is reported');
  assert.equal(message.capture.source, 'passive');
  assert.equal(message.capture.refresh, 'not_supported');
  assert.match(message.capture.captured_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(!JSON.stringify(message).includes('TOKEN'), 'thread tokens are stripped');

  await pageFetch(world, `${url}?cursor=c1`, { entries: [entry(1), entry(2)], has_more: false }, `${url}?cursor=c1`);
  // The newest page again, with an entry updated.
  await pageFetch(world, `${url}?limit=2`, { entries: [entry(3), entry(4, { status: 'COMPLETED' })] }, `${url}?limit=2`);

  ({ message } = await exportOf(world));
  assert.deepEqual(message.payload.entries.map(e => e.uuid), ['e1', 'e2', 'e3', 'e4'], 'entries are exported in conversation order');
  assert.equal(message.payload.entries[3].status, 'COMPLETED', 'a later copy of an entry replaces the earlier one');
  assert.equal(message.payload.page_count, 3);
  assert.equal(message.capture.complete, true, 'a page without has_more keeps the last known answer');
  assert.deepEqual(message.capture.flags, []);

  // The export goes through the extractor in the same order.
  const out = extractPerplexityConversation(message.payload);
  assert.deepEqual(out.messages.filter(m => m.role === 'user').map(m => m.text),
    ['question 1', 'question 2', 'question 3', 'question 4']);
}

// --- Entries without ids, and without timestamps -----------------------------
{
  const world = makeWorld('perplexity');
  const url = threadUrl(world);
  const idless = n => ({ query_str: `q${n}`, created_at: `2026-01-01T00:00:0${n}Z`, blocks: [] });
  await pageFetch(world, url, { entries: [idless(1), idless(2)] }, url);
  await pageFetch(world, url, { entries: [idless(1), idless(2), idless(3)] }, url);
  let { message } = await exportOf(world);
  assert.deepEqual(message.payload.entries.map(e => e.query_str), ['q1', 'q2', 'q3'], 'a repeated page does not duplicate id-less entries');
  assert.equal(message.capture.complete, null, 'has_more never reported: completeness unknown');

  // No usable timestamps: arrival order is kept, nothing is dropped.
  const other = threadUrl(world, OTHER);
  await pageFetch(world, other, { entries: [{ uuid: 'b', query_str: 'second' }, { uuid: 'a', query_str: 'first', created_at: 'not a date' }] }, other);
  ({ message } = await exportOf(world, OTHER));
  assert.deepEqual(message.payload.entries.map(e => e.uuid), ['b', 'a']);
}

// --- URL matching ------------------------------------------------------------
{
  const world = makeWorld('perplexity');
  const body = { entries: [entry(1)] };
  const good = threadUrl(world);
  const rejected = [
    [`https://evil.test/rest/thread/${THREAD}`, `https://evil.test/rest/thread/${THREAD}`],
    [`${world.origin}/other?x=/rest/thread/${THREAD}`, `${world.origin}/other?x=/rest/thread/${THREAD}`],
    [`data:application/json,{}#/rest/thread/${THREAD}`, ''],
    // Sub-resources of a thread are not the thread.
    [`${good}/export`, `${good}/export`],
    [`${good}/share?x=1`, `${good}/share?x=1`],
    [{ url: good }, ''],
    [{ toString: () => good }, ''],
    [good, `https://evil.test/rest/thread/${THREAD}`]
  ];
  for (const [request, responseUrl] of rejected) {
    await pageFetch(world, request, body, responseUrl);
  }
  assert.deepEqual(await listIds(world), [], 'only a same-origin /rest/thread/<uuid> request is captured');

  await pageFetch(world, new world.sb.Request(`${good}?limit=10`), body, '');
  assert.deepEqual(await listIds(world), [THREAD]);
}

// --- inject.js evaluated twice (manifest + scripting API) --------------------
{
  const world = makeWorld('perplexity');
  const hooked = world.sb.fetch;
  world.run('platforms/perplexity/inject.js');
  world.run('platforms/perplexity/content.js');
  assert.equal(world.sb.fetch, hooked, 'a second evaluation does not wrap fetch again');
  const url = threadUrl(world);
  await pageFetch(world, url, { entries: [entry(1)] }, url);
  assert.deepEqual(await listIds(world), [THREAD]);
  await exportOf(world);
  assert.equal(world.exports().length, 1, 'one export, not one per evaluation');
}

// --- Secret handling ---------------------------------------------------------
for (const options of [{ skipInject: true }, { skipInject: true, pageSecret: 'page-chosen-secret' }]) {
  const world = makeWorld('perplexity', options);
  const payload = { __thread_uuid: THREAD, entries: [entry(1)] };
  for (const secret of ['null', 'undefined', 'page-chosen-secret']) {
    await world.postFromPage(await world.sb.MessageSecurity.createSignedMessage(payload, MSG, SOURCE, 'perplexity', secret));
  }
  assert.equal(world.sentToBackground.length, 0, 'no secret (or a page-supplied one): nothing is accepted');
}

// --- Extractor: repeated answer blocks, chunks fallback ----------------------
{
  const answerOf = blocks => extractPerplexityConversation({
    uuid: THREAD, entries: [{ uuid: 'e1', query_str: 'q', blocks }]
  }).messages[1].text;

  assert.equal(answerOf([
    { intended_usage: 'ask_text', markdown_block: { answer: 'The answer.' } },
    { intended_usage: 'ask_text_0_markdown', markdown_block: { answer: 'The answer.' } }
  ]), 'The answer.', 'the same whole answer in two blocks is exported once');

  assert.equal(answerOf([
    { markdown_block: { answer: 'Part one.' } },
    { markdown_block: { answer: 'Part two.' } }
  ]), 'Part one.\n\nPart two.', 'different answer blocks are still joined');

  assert.equal(answerOf([
    { markdown_block: { answer: null, chunks: ['Stream', 'ed ', 'answer.'] } }
  ]), 'Streamed answer.', 'chunks are used when answer is null');

  assert.equal(answerOf([
    { markdown_block: { answer: 'Final.', chunks: ['Fin', 'al', '.'] } }
  ]), 'Final.', 'answer wins over chunks when present');
}

console.log('✓ Perplexity capture tests passed');
