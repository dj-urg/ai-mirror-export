/**
 * Copilot capture path: inject.js (fetch hook) + content.js, run together in
 * a fake page. Synthetic responses only.
 *
 * Covers: /history responses merged by message id, the `paged` capture flag,
 * no eviction when a held conversation is updated, URL matching (same origin,
 * exact path, real request objects only), a second evaluation of inject.js,
 * and the null-secret guard.
 */

import assert from 'node:assert/strict';
import { makeWorld, jsonResponse } from './helpers/page_world.js';

const MSG = 'COPILOT_CONVERSATION_DATA';
const SOURCE = 'copilot-exporter-inject';
const msg = (id, text, createdAt) => ({ id, author: { type: 'ai' }, content: [{ type: 'text', text }], createdAt });
const historyUrl = (world, id, query = '') => `${world.origin}/c/api/conversations/${id}/history${query}`;

/** Have the page fetch `request`, answered with `body` from `responseUrl`. */
async function pageFetch(world, request, body, responseUrl) {
  world.sb.fetchImpl = async () => jsonResponse(body, { url: responseUrl });
  await world.sb.fetch(request);
  await world.settle();
}
const listIds = async world => (await world.ask({ type: 'GET_CAPTURED_CONVERSATIONS' })).conversationIds;
const exportOf = async (world, conversationId) => {
  const before = world.exports().length;
  const response = await world.ask({ type: 'EXPORT_CONVERSATION', platform: 'copilot', conversationId });
  return { response, message: world.exports()[before] };
};

// --- Paged history -----------------------------------------------------------
{
  const world = makeWorld('copilot');
  const url = historyUrl(world, 'conv1', '?api-version=2');
  await pageFetch(world, url, { results: [msg('m3', 'three', '2026-01-01T00:00:03Z'), msg('m4', 'four (streaming)', '2026-01-01T00:00:04Z')], next: 'cursor-1' }, url);

  let { message } = await exportOf(world, 'conv1');
  assert.equal(message.capture.source, 'passive');
  assert.equal(message.capture.refresh, 'not_supported');
  assert.equal(message.capture.complete, null, 'a single response says nothing about completeness');
  assert.deepEqual(message.capture.flags, []);
  assert.match(message.capture.captured_at, /^\d{4}-\d{2}-\d{2}T/);

  // The same response again: nothing is duplicated, and it is not "paged".
  await pageFetch(world, url, { results: [msg('m3', 'three', '2026-01-01T00:00:03Z'), msg('m4', 'four', '2026-01-01T00:00:04Z')], next: 'cursor-1' }, url);
  ({ message } = await exportOf(world, 'conv1'));
  assert.deepEqual(message.payload.results.map(r => r.content[0].text), ['three', 'four'], 'a later copy replaces a message in place');
  assert.deepEqual(message.capture.flags, []);

  // An older page arrives: it is merged, not swapped in.
  await pageFetch(world, url, { results: [msg('m1', 'one', '2026-01-01T00:00:01Z'), msg('m2', 'two', '2026-01-01T00:00:02Z')] }, url);
  ({ message } = await exportOf(world, 'conv1'));
  assert.deepEqual(message.payload.results.map(r => r.id).sort(), ['m1', 'm2', 'm3', 'm4'], 'pages are merged by message id');
  assert.equal(message.payload.conversationId, 'conv1');
  assert.equal(message.payload.next, 'cursor-1', 'the pagination marker is kept');
  assert.equal(message.capture.complete, false);
  assert.deepEqual(message.capture.flags, ['paged']);
}

// --- Updating a held conversation evicts nothing -----------------------------
{
  const world = makeWorld('copilot');
  for (let i = 0; i < 50; i++) {
    const url = historyUrl(world, `c${i}`);
    await pageFetch(world, url, { results: [msg(`m${i}`, 'x', '2026-01-01T00:00:00Z')] }, url);
    await world.advance(10);
  }
  const first = historyUrl(world, 'c0');
  // c0 is refreshed (now the newest), then c1 is refreshed: all 50 stay.
  await pageFetch(world, first, { results: [msg('m0', 'x2', '2026-01-01T00:00:00Z')] }, first);
  await pageFetch(world, historyUrl(world, 'c1'), { results: [msg('m1', 'x2', '2026-01-01T00:00:00Z')] }, historyUrl(world, 'c1'));
  assert.equal((await listIds(world)).length, 50, 'an overwrite does not evict');
  // A 51st conversation evicts exactly the least recently updated one.
  await world.advance(10);
  await pageFetch(world, historyUrl(world, 'c50'), { results: [msg('m50', 'x', '2026-01-01T00:00:00Z')] }, historyUrl(world, 'c50'));
  const ids = await listIds(world);
  assert.equal(ids.length, 50);
  assert.ok(!ids.includes('c2') && ids.includes('c0') && ids.includes('c1') && ids.includes('c50'));
}

// --- URL matching ------------------------------------------------------------
{
  const world = makeWorld('copilot');
  const body = { results: [msg('m1', 'attacker text', '2026-01-01T00:00:00Z')] };
  const good = historyUrl(world, 'victim');
  const rejected = [
    // Another origin whose path matches.
    ['https://evil.test/c/api/conversations/victim/history', 'https://evil.test/c/api/conversations/victim/history'],
    // The pattern only in the query or fragment.
    [`${world.origin}/other?x=/c/api/conversations/victim/history`, `${world.origin}/other?x=/c/api/conversations/victim/history`],
    ['data:application/json,{}#/c/api/conversations/victim/history', ''],
    // A sub-resource.
    [`${good}/extra`, `${good}/extra`],
    // A plain object posing as a request.
    [{ url: good }, ''],
    [{ toString: () => good }, ''],
    // A matching argument, but the browser says the response came from elsewhere.
    [good, 'https://evil.test/c/api/conversations/victim/history']
  ];
  for (const [request, responseUrl] of rejected) {
    await pageFetch(world, request, body, responseUrl);
  }
  assert.deepEqual(await listIds(world), [], 'no signed message for a URL that is not a same-origin history request');

  // Real request shapes are still captured.
  await pageFetch(world, new world.sb.Request(historyUrl(world, 'a')), body, '');
  await pageFetch(world, new URL(historyUrl(world, 'b')), body, '');
  await pageFetch(world, '/c/api/conversations/c/history?api-version=2', body, '');
  assert.deepEqual(await listIds(world), ['a', 'b', 'c']);
}

// --- inject.js evaluated twice -----------------------------------------------
{
  const world = makeWorld('copilot');
  const hooked = world.sb.fetch;
  world.run('platforms/copilot/inject.js');
  assert.equal(world.sb.fetch, hooked, 'a second evaluation does not wrap fetch again');
  const url = historyUrl(world, 'conv1');
  await pageFetch(world, url, { results: [msg('m1', 'one', '2026-01-01T00:00:01Z')] }, url);
  assert.deepEqual(await listIds(world), ['conv1'], 'and does not replace the signing secret');
  assert.equal(world.sentToBackground.length, 1, 'one capture, one notification');
}

// --- Secret handling ---------------------------------------------------------
for (const options of [{ skipInject: true }, { skipInject: true, pageSecret: 'page-chosen-secret' }]) {
  const world = makeWorld('copilot', options);
  const payload = { conversationId: 'forged', results: [msg('m1', 'forged', '2026-01-01T00:00:00Z')] };
  for (const secret of ['null', 'undefined', 'page-chosen-secret']) {
    await world.postFromPage(await world.sb.MessageSecurity.createSignedMessage(payload, MSG, SOURCE, 'copilot', secret));
  }
  assert.equal(world.sentToBackground.length, 0, 'no secret (or a page-supplied one): nothing is accepted');
  assert.deepEqual(await listIds(world), []);
}

console.log('✓ Copilot capture tests passed');
