/**
 * Behaviour tests for the Mistral content script, page-context script and
 * the extractor's message ordering.
 *
 * The scripts run in a vm sandbox (helpers/platform_vm_harness.js) against
 * synthetic payloads. Covered: the refresh at export and the capture record
 * sent with it, following the message list's cursor, passive captures that
 * must not degrade a stored chat (one page of a longer list, a missing chat
 * record), cache eviction, the signing-secret check, which requests the
 * page hooks may capture, and the order of exported messages.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadContent, loadInject, jsonResponse, deferred, sleep, ORIGIN
} from './helpers/platform_vm_harness.js';
import { extractConversationMessages } from '../../platforms/mistral/extractor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { passed++; } else { failed++; console.error('FAIL:', name, detail); }
}

const TYPE = 'MISTRAL_CONVERSATION_DATA';
const SOURCE = 'mistral-exporter-inject';
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const msg = (n, content = `message ${n}`) => ({
  id: `m${n}`,
  chatId: ID,
  role: n % 2 ? 'user' : 'assistant',
  content,
  turn: n - 1,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString()
});
// The API lists messages newest first.
const list = ns => ns.map(n => msg(n));
const chat = (title = 'Synthetic chat') => ({ id: ID, title });
const trpc = json => [{ result: { data: { json } } }];
const exportMsg = id => ({ type: 'EXPORT_CONVERSATION', platform: 'mistral', conversationId: id });
const ids = payload => payload.messages.map(m => m.id).join(',');
const offline = async () => jsonResponse({}, { ok: false });

/** Split a tRPC URL the content script requested into procedure + input. */
function parseCall(url) {
  const u = new URL(url, ORIGIN);
  return {
    procedure: u.pathname.replace('/api/trpc/', ''),
    input: JSON.parse(u.searchParams.get('input'))['0'].json
  };
}

/** A fake server: `messages(input)` and `chatById(input)` return the json or null for an error. */
function server({ messages, chatById = () => chat() }) {
  const calls = [];
  const fetchImpl = async url => {
    const call = parseCall(url);
    calls.push(call);
    const json = call.procedure === 'message.all' ? messages(call.input) : chatById(call.input);
    return json ? jsonResponse(trpc(json)) : jsonResponse({}, { ok: false });
  };
  return { calls, fetchImpl };
}

const passiveChat = (h, c = chat()) => h.postSigned(TYPE, SOURCE, { chatId: ID, kind: 'chat', chat: c });
const passiveMessages = (h, messages, partial = false, chatId = ID) =>
  h.postSigned(TYPE, SOURCE, { chatId, kind: 'messages', messages, partial });

// --- Export refreshes a stale cache -----------------------------------------
{
  const s = server({ messages: () => ({ items: list([4, 3, 2, 1]) }), chatById: () => chat('Renamed') });
  const h = loadContent('mistral', { pathname: '/', fetchImpl: s.fetchImpl });
  await passiveChat(h);
  await passiveMessages(h, list([2, 1]));
  const res = await h.runtimeMessage(exportMsg(ID));
  const out = h.sentOfType(TYPE)[0];
  assert('export succeeds', res && res.success === true);
  assert('export forwards the refreshed list', out && ids(out.payload) === 'm4,m3,m2,m1');
  assert('export forwards the refreshed chat record', out.payload.chat.title === 'Renamed');
  assert('payload is stamped with the chat id', out.payload._captured_conversation_id === ID);
  assert('capture.refresh = ok', out.capture.refresh === 'ok');
  assert('capture.source = export_refresh', out.capture.source === 'export_refresh');
  assert('capture.complete = true', out.capture.complete === true);
  assert('capture.captured_at is ISO', !Number.isNaN(Date.parse(out.capture.captured_at)));
  assert('capture.flags is empty', out.capture.flags.length === 0);
  assert('refresh uses only the two tRPC reads',
    s.calls.length === 2 && s.calls.every(c => c.procedure === 'chat.byId' || c.procedure === 'message.all'));
}

// --- Refresh failure falls back to the cache and says so ---------------------
{
  const h = loadContent('mistral', { pathname: '/', fetchImpl: offline });
  await passiveMessages(h, list([2, 1]));
  const res = await h.runtimeMessage(exportMsg(ID));
  const out = h.sentOfType(TYPE)[0];
  assert('failed refresh: export still succeeds', res && res.success === true);
  assert('failed refresh: cached list forwarded', out && ids(out.payload) === 'm2,m1');
  assert('failed refresh: capture.refresh = failed', out.capture.refresh === 'failed');
  assert('failed refresh: flag refresh_failed', out.capture.flags.includes('refresh_failed'));
  assert('failed refresh: source stays passive', out.capture.source === 'passive');
  assert('failed refresh: completeness unknown', out.capture.complete === null);
  assert('missing chat record is flagged',
    out.payload.chat === null && out.capture.flags.includes('chat_metadata_missing'));

  const none = await h.runtimeMessage(exportMsg(OTHER));
  assert('no cache and no refresh = error', none && none.success === false);
  assert('nothing forwarded on error', h.sentOfType(TYPE).length === 1);
}
{
  // A reply without an `items` array and an empty list are both failed reads.
  for (const [label, json] of [['no items array', { error: 'synthetic' }], ['empty list', { items: [] }]]) {
    const s = server({ messages: () => json });
    const h = loadContent('mistral', { pathname: '/', fetchImpl: s.fetchImpl });
    await passiveMessages(h, list([2, 1]));
    await h.runtimeMessage(exportMsg(ID));
    const out = h.sentOfType(TYPE)[0];
    assert(`${label}: cached list kept`, out && ids(out.payload) === 'm2,m1');
    assert(`${label}: capture.refresh = failed`, out.capture.refresh === 'failed');
  }
}

// --- The message list's cursor is followed ----------------------------------
{
  const pages = {
    first: { items: list([6, 5]), nextCursor: 'c1' },
    c1: { items: list([4, 3]), nextCursor: 'c2' },
    c2: { items: list([2, 1]), nextCursor: null }
  };
  const s = server({ messages: input => pages[input.cursor === undefined ? 'first' : input.cursor] });
  const h = loadContent('mistral', { pathname: '/', fetchImpl: s.fetchImpl });
  await h.runtimeMessage(exportMsg(ID));
  const out = h.sentOfType(TYPE)[0];
  const messageCalls = s.calls.filter(c => c.procedure === 'message.all');
  assert('all pages are fetched', out && ids(out.payload) === 'm6,m5,m4,m3,m2,m1', out && ids(out.payload));
  assert('one request per page, same procedure', messageCalls.length === 3);
  assert('each request carries the chat id', messageCalls.every(c => c.input.chatId === ID));
  assert('cursor is passed back', messageCalls[1].input.cursor === 'c1' && messageCalls[2].input.cursor === 'c2');
  assert('paged list is complete', out.capture.complete === true && out.capture.flags.length === 0);
}
{
  // A later page fails: what was read is exported and marked incomplete.
  const s = server({ messages: input => (input.cursor === undefined ? { items: list([4, 3]), nextCursor: 'c1' } : null) });
  const h = loadContent('mistral', { pathname: '/', fetchImpl: s.fetchImpl });
  await h.runtimeMessage(exportMsg(ID));
  const out = h.sentOfType(TYPE)[0];
  assert('failed page: first page exported', out && ids(out.payload) === 'm4,m3');
  assert('failed page: capture.complete = false', out.capture.complete === false);
  assert('failed page: flag pagination_incomplete', out.capture.flags.includes('pagination_incomplete'));
  assert('failed page: refresh itself is ok', out.capture.refresh === 'ok');
}
{
  // A cursor that repeats must not loop forever or duplicate messages.
  const s = server({ messages: input => (input.cursor === undefined
    ? { items: list([4, 3]), nextCursor: 'same' }
    : { items: list([3, 2]), nextCursor: 'same' }) });
  const h = loadContent('mistral', { pathname: '/', fetchImpl: s.fetchImpl });
  await h.runtimeMessage(exportMsg(ID));
  const out = h.sentOfType(TYPE)[0];
  assert('repeating cursor: stops', s.calls.filter(c => c.procedure === 'message.all').length === 2);
  assert('repeating cursor: no duplicate messages', ids(out.payload) === 'm4,m3,m2');
  assert('repeating cursor: marked incomplete', out.capture.complete === false);
}

// --- A failed chat.byId does not wipe the stored chat record -----------------
{
  const s = server({ messages: () => ({ items: list([2, 1]) }), chatById: () => null });
  const h = loadContent('mistral', { pathname: '/', fetchImpl: s.fetchImpl });
  await passiveChat(h, chat('Kept title'));
  await h.runtimeMessage(exportMsg(ID));
  const out = h.sentOfType(TYPE)[0];
  assert('stored chat record survives a failed chat.byId', out.payload.chat && out.payload.chat.title === 'Kept title');
  assert('no chat_metadata_missing flag then', !out.capture.flags.includes('chat_metadata_missing'));
  assert('messages still refreshed', out.capture.refresh === 'ok' && ids(out.payload) === 'm2,m1');
}

// --- Export never returns a fetch that started before it ---------------------
{
  const calls = [];
  const h = loadContent('mistral', {
    pathname: `/chat/${ID}`,
    fetchImpl: url => {
      if (parseCall(url).procedure !== 'message.all' || calls.length >= 2) return Promise.reject(new Error('offline'));
      const d = deferred();
      calls.push(d);
      return d.promise;
    }
  });
  await sleep(0);
  assert('page load starts one list fetch', calls.length === 1);
  const exporting = h.runtimeMessage(exportMsg(ID));
  await sleep(0);
  assert('export starts its own list fetch', calls.length === 2);
  calls[1].resolve(jsonResponse(trpc({ items: list([3, 2, 1]) })));
  await exporting;
  calls[0].resolve(jsonResponse(trpc({ items: list([1]) })));
  await sleep(10);
  assert('export forwards its own result', ids(h.sentOfType(TYPE)[0].payload) === 'm3,m2,m1');
  await h.runtimeMessage(exportMsg(ID));
  assert('older fetch does not overwrite newer result', ids(h.sentOfType(TYPE)[1].payload) === 'm3,m2,m1');
}

// --- Passive captures do not degrade a stored list ---------------------------
{
  const h = loadContent('mistral', { pathname: '/', fetchImpl: offline });
  const current = async () => {
    await h.runtimeMessage(exportMsg(ID));
    return h.sentOfType(TYPE).at(-1);
  };
  await passiveMessages(h, list([4, 3, 2, 1]));

  // An older page of the same list, with one edited message.
  await passiveMessages(h, [msg(2, 'edited'), msg(1)], true);
  let out = await current();
  assert('a page does not replace the list', ids(out.payload) === 'm4,m3,m2,m1', ids(out.payload));
  assert('a page updates the messages it carries', out.payload.messages[2].content === 'edited');
  assert('merge is flagged', out.capture.flags.includes('passive_merged'));

  // A whole-list reply that is shorter than what is stored.
  await passiveMessages(h, list([1]));
  assert('a shorter list does not replace the stored one', ids((await current()).payload) === 'm4,m3,m2,m1');

  // A page with a new message.
  await passiveMessages(h, list([5]), true);
  out = await current();
  assert('a page adds its new messages', out.payload.messages.length === 5 && ids(out.payload).includes('m5'));

  // A whole list that contains everything stored replaces it.
  await passiveMessages(h, list([6, 5, 4, 3, 2, 1]));
  out = await current();
  assert('superset replaces', ids(out.payload) === 'm6,m5,m4,m3,m2,m1');
  assert('superset clears merge flag', !out.capture.flags.includes('passive_merged'));

  // A chat record with `chat: null` or no chat at all changes nothing.
  await passiveChat(h, chat('Title'));
  await h.postSigned(TYPE, SOURCE, { chatId: ID, kind: 'chat', chat: null });
  out = await current();
  assert('null chat record does not overwrite', out.payload.chat && out.payload.chat.title === 'Title');
}
{
  // Lists without message ids: only a whole list that is not smaller replaces.
  const bare = n => ({ role: 'user', content: `message ${n}` });
  const h = loadContent('mistral', { pathname: '/', fetchImpl: offline });
  const count = async () => {
    await h.runtimeMessage(exportMsg(ID));
    return h.sentOfType(TYPE).at(-1).payload.messages.length;
  };
  await passiveMessages(h, [bare(3), bare(2), bare(1)]);
  await passiveMessages(h, [bare(1)]);
  assert('id-less smaller list is ignored', await count() === 3);
  await passiveMessages(h, [bare(5), bare(4), bare(3), bare(2)], true);
  assert('id-less page is ignored', await count() === 3);
  await passiveMessages(h, [bare(4), bare(3), bare(2), bare(1)]);
  assert('id-less whole list that is not smaller replaces', await count() === 4);
}
{
  // The first capture for a chat is one page: stored, and flagged as such.
  const h = loadContent('mistral', { pathname: '/', fetchImpl: offline });
  await passiveMessages(h, list([4, 3]), true);
  await h.runtimeMessage(exportMsg(ID));
  const out = h.sentOfType(TYPE)[0];
  assert('lone page is exportable', out && ids(out.payload) === 'm4,m3');
  assert('lone page is flagged partial_page', out.capture.flags.includes('partial_page'));
}

// --- Updating a stored chat does not evict anything --------------------------
{
  const h = loadContent('mistral', { pathname: '/', fetchImpl: offline });
  const stored = async () => (await h.runtimeMessage({ type: 'GET_CAPTURED_CONVERSATIONS' })).conversationIds;
  for (let i = 0; i < 50; i++) {
    await passiveMessages(h, [{ id: `x${i}`, role: 'user', content: 'hi' }], false, `chat-${i}`);
  }
  assert('cache holds 50 chats', (await stored()).length === 50);
  await h.postSigned(TYPE, SOURCE, { chatId: 'chat-0', kind: 'chat', chat: { id: 'chat-0', title: 'Patched' } });
  await passiveMessages(h, [{ id: 'x49b', role: 'assistant', content: 'yo' }], true, 'chat-49');
  let now = await stored();
  assert('patching stored chats evicts nothing', now.length === 50 && now.includes('chat-0') && now.includes('chat-49'));
  await passiveMessages(h, [{ id: 'y', role: 'user', content: 'hi' }], false, 'chat-new');
  now = await stored();
  assert('a new chat evicts exactly one', now.length === 50 && now.includes('chat-new'));
}

// --- Signing secret ----------------------------------------------------------
for (const [label, secret, key] of [
  ['null secret', null, 'null'],
  ['malformed secret', 'short', 'short'],
  ['wrong key', undefined, 'cd'.repeat(32)]
]) {
  const h = loadContent('mistral', secret === undefined ? { pathname: '/' } : { pathname: '/', secret });
  await h.postSigned(TYPE, SOURCE, { chatId: ID, kind: 'messages', messages: list([1]) }, { key });
  const res = await h.runtimeMessage({ type: 'GET_CAPTURED_CONVERSATIONS' });
  assert(`${label}: message rejected`, res.conversationIds.length === 0);
}

// --- inject.js: which requests are captured ----------------------------------
{
  const trpcUrl = (procs, inputs, prefix = '') => {
    const input = {};
    inputs.forEach((json, i) => { input[String(i)] = { json }; });
    return `${prefix}/api/trpc/${procs}?batch=1&input=${encodeURIComponent(JSON.stringify(input))}`;
  };
  const LIST_URL = trpcUrl('message.all', [{ chatId: ID }]);
  const listBody = trpc({ items: list([2, 1]) });
  const run = async (input, init, response) => {
    const h = loadInject('mistral', { nativeFetch: async () => response });
    await h.win.fetch(input, init);
    await sleep(20);
    return h.posted.map(m => m.payload);
  };
  const own = (url, body = listBody) => jsonResponse(body, { url: ORIGIN + url });

  let got = await run(LIST_URL, undefined, own(LIST_URL));
  assert('own message.all GET is captured',
    got.length === 1 && got[0].kind === 'messages' && got[0].chatId === ID && got[0].messages.length === 2);
  assert('whole list is not marked partial', got[0].partial === false);

  got = await run(new Request(ORIGIN + LIST_URL), undefined, own(LIST_URL));
  assert('Request object is captured', got.length === 1);

  // A batch: only the two procedures of interest are forwarded, by position.
  const batchUrl = trpcUrl('settings.get,chat.byId,message.all', [{}, { id: ID }, { chatId: ID }]);
  got = await run(batchUrl, undefined, own(batchUrl, [
    { result: { data: { json: { theme: 'dark' } } } },
    { result: { data: { json: chat('Batched') } } },
    { result: { data: { json: { items: list([1]) } } } }
  ]));
  assert('batch yields chat + messages', got.length === 2 && got[0].kind === 'chat' && got[1].kind === 'messages');
  assert('batch chat record is the right entry', got[0].chat.title === 'Batched' && got[0].chatId === ID);

  got = await run(LIST_URL, undefined, own(LIST_URL, trpc({ items: list([4, 3]), nextCursor: 'c1' })));
  assert('reply with nextCursor is marked partial', got.length === 1 && got[0].partial === true);

  const cursorUrl = trpcUrl('message.all', [{ chatId: ID, cursor: 'c1' }]);
  got = await run(cursorUrl, undefined, own(cursorUrl));
  assert('request with a cursor is marked partial', got.length === 1 && got[0].partial === true);

  got = await run(LIST_URL, undefined, own(LIST_URL, trpc({ message: 'synthetic error' })));
  assert('reply without items is not forwarded', got.length === 0);

  got = await run(LIST_URL, undefined, own(LIST_URL, [{ error: { json: { message: 'synthetic' } } }]));
  assert('tRPC error entry is not forwarded', got.length === 0);

  got = await run(LIST_URL, { method: 'POST' }, own(LIST_URL));
  assert('POST is not captured', got.length === 0);

  const suffix = trpcUrl('message.all', [{ chatId: ID }], '/proxy');
  got = await run(suffix, undefined, own(suffix));
  assert('path as a suffix is not captured', got.length === 0);

  const deeper = LIST_URL.replace('message.all', 'message.all/extra');
  got = await run(deeper, undefined, own(deeper));
  assert('longer path is not captured', got.length === 0);

  const inQuery = `/x?next=${LIST_URL}`;
  got = await run(inQuery, undefined, own(inQuery));
  assert('path in the query string is not captured', got.length === 0);

  got = await run(`https://evil.example${LIST_URL}`, undefined,
    jsonResponse(listBody, { url: `https://evil.example${LIST_URL}`, type: 'cors' }));
  assert('cross-origin URL is not captured', got.length === 0);

  got = await run({ url: LIST_URL, toString: () => '/attacker-controlled' }, undefined,
    jsonResponse(listBody, { url: `${ORIGIN}/attacker-controlled` }));
  assert('request look-alike is not captured', got.length === 0);

  got = await run(LIST_URL, undefined, jsonResponse(listBody, { url: `${ORIGIN}/elsewhere` }));
  assert('redirected response is not captured', got.length === 0);

  got = await run(LIST_URL, undefined, jsonResponse(listBody, { url: ORIGIN + LIST_URL, contentType: 'text/html' }));
  assert('non-JSON response is not captured', got.length === 0);

  // XHR path.
  const h = loadInject('mistral', { nativeFetch: async () => jsonResponse({}) });
  await h.runXhr({ url: LIST_URL, body: listBody });
  assert('own XHR GET is captured', h.posted.length === 1 && h.posted[0].payload.chatId === ID);
  h.posted.length = 0;
  await h.runXhr({ method: 'POST', url: LIST_URL, body: listBody });
  assert('XHR POST is not captured', h.posted.length === 0);
  await h.runXhr({ url: LIST_URL, responseURL: `${ORIGIN}/elsewhere`, body: listBody });
  assert('XHR redirected elsewhere is not captured', h.posted.length === 0);
  await h.runXhr({ url: `https://evil.example${LIST_URL}`, body: listBody });
  assert('cross-origin XHR is not captured', h.posted.length === 0);
}

// --- Extractor: message order -------------------------------------------------
{
  const order = messages => extractConversationMessages({ _captured_conversation_id: ID, chat: null, messages })
    .map(r => r.message_id).join(',');

  assert('newest-first list is reversed', order(list([4, 3, 2, 1])) === 'm1,m2,m3,m4');
  assert('a merged (shuffled) list is put in time order', order(list([5, 2, 4, 1, 3])) === 'm1,m2,m3,m4,m5');

  const sameTime = [3, 2, 1].map(n => ({ ...msg(n), createdAt: '2026-01-01T00:00:00.000Z' }));
  assert('equal timestamps fall back to turn', order([sameTime[1], sameTime[0], sameTime[2]]) === 'm1,m2,m3');

  const noTurn = sameTime.map(m => ({ ...m, turn: undefined }));
  assert('equal timestamps without turn keep reversed order', order(noTurn) === 'm1,m2,m3');

  const missing = list([5, 2, 4]);
  delete missing[1].createdAt;
  assert('a missing timestamp keeps the reversed order', order(missing) === 'm4,m2,m5');

  const unparseable = list([5, 2, 4]);
  unparseable[0].createdAt = 'not a date';
  assert('an unparseable timestamp keeps the reversed order', order(unparseable) === 'm4,m2,m5');

  // The synthetic golden fixture is newest-first with timestamps: its order
  // is the plain reversal, as before.
  const fixture = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'data', 'synthetic', 'mistral_golden_v1.json'), 'utf8'));
  const expected = [...fixture.messages].reverse().map(m => m.id).join(',');
  assert('golden fixture order is unchanged',
    extractConversationMessages(fixture).map(r => r.message_id).join(',') === expected);
}

console.log(`\nMistral scripts test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
