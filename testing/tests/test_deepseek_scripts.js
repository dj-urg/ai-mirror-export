/**
 * Behaviour tests for the DeepSeek content script, page-context script and
 * the extractor's text rules.
 *
 * The scripts run in a vm sandbox (helpers/platform_vm_harness.js) against
 * synthetic payloads. Covered: the refresh at export and the capture record
 * sent with it, passive captures that must not degrade a stored chat (error
 * replies, empty sessions, cache deltas), the signing-secret check, which
 * requests the page hooks may capture, and how `text` is built from
 * fragments.
 */
import {
  loadContent, loadInject, jsonResponse, deferred, sleep, ORIGIN
} from './helpers/platform_vm_harness.js';
import { extractConversationMessages } from '../../platforms/deepseek/extractor.js';

let passed = 0;
let failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { passed++; } else { failed++; console.error('FAIL:', name, detail); }
}

const TYPE = 'DEEPSEEK_CONVERSATION_DATA';
const SOURCE = 'deepseek-exporter-inject';
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PATH = '/api/v0/chat/history_messages';
const URL_FOR = id => `${PATH}?chat_session_id=${id}`;

const msg = (n, text = `message ${n}`) => ({
  message_id: n,
  parent_id: n > 1 ? n - 1 : null,
  role: n % 2 ? 'USER' : 'ASSISTANT',
  fragments: [{ id: n * 10, type: n % 2 ? 'REQUEST' : 'RESPONSE', content: text }]
});
const session = (title = 'Synthetic chat') => ({ id: ID, title });
const history = (ns, sess = session()) => ({
  code: 0,
  msg: '',
  data: { biz_code: 0, biz_data: { ...(sess ? { chat_session: sess } : {}), chat_messages: ns.map(n => msg(n)) } }
});
const stamped = body => ({ ...body, _captured_conversation_id: ID });
const exportMsg = id => ({ type: 'EXPORT_CONVERSATION', platform: 'deepseek', conversationId: id });
const bizOf = payload => payload.data.biz_data;
const ids = payload => bizOf(payload).chat_messages.map(m => m.message_id).join(',');
const offline = async () => jsonResponse({}, { ok: false });

// --- Export refreshes a stale cache -----------------------------------------
{
  let server = history([1, 2]);
  const seen = [];
  const h = loadContent('deepseek', {
    pathname: '/',
    localStorage: { userToken: JSON.stringify({ value: 'synthetic-token' }) },
    fetchImpl: async (url, init) => { seen.push({ url, init }); return jsonResponse(server); }
  });
  await h.postSigned(TYPE, SOURCE, stamped(history([1, 2])));
  server = history([1, 2, 3, 4]);
  const res = await h.runtimeMessage(exportMsg(ID));
  const out = h.sentOfType(TYPE)[0];
  assert('export succeeds', res && res.success === true);
  assert('export forwards the refreshed chat', out && ids(out.payload) === '1,2,3,4');
  assert('capture.refresh = ok', out.capture.refresh === 'ok');
  assert('capture.source = export_refresh', out.capture.source === 'export_refresh');
  assert('capture.captured_at is ISO', !Number.isNaN(Date.parse(out.capture.captured_at)));
  assert('capture.complete is null (unknown)', out.capture.complete === null);
  assert('capture.flags is empty', out.capture.flags.length === 0);
  assert('refresh hits only the history endpoint', seen.length === 1 && seen[0].url === URL_FOR(ID));
  assert('token never leaves in the forwarded message', !JSON.stringify(out).includes('synthetic-token'));
}

// --- Refresh failure falls back to the cache and says so ---------------------
for (const [label, reply] of [
  ['HTTP error', jsonResponse({}, { ok: false })],
  ['error code', jsonResponse({ code: 40003, msg: 'INVALID_TOKEN', data: null })],
  ['biz error', jsonResponse({ code: 0, data: { biz_code: 5, biz_data: { chat_messages: [msg(9)] } } })],
  ['empty session', jsonResponse(history([]))]
]) {
  const h = loadContent('deepseek', { pathname: '/', fetchImpl: async () => reply });
  await h.postSigned(TYPE, SOURCE, stamped(history([1, 2])));
  const res = await h.runtimeMessage(exportMsg(ID));
  const out = h.sentOfType(TYPE)[0];
  assert(`${label}: export still succeeds`, res && res.success === true);
  assert(`${label}: cached copy forwarded`, out && ids(out.payload) === '1,2');
  assert(`${label}: capture.refresh = failed`, out.capture.refresh === 'failed');
  assert(`${label}: flag refresh_failed`, out.capture.flags.includes('refresh_failed'));
  assert(`${label}: source stays passive`, out.capture.source === 'passive');
}
{
  const h = loadContent('deepseek', { pathname: '/', fetchImpl: offline });
  const none = await h.runtimeMessage(exportMsg(OTHER));
  assert('no cache and no refresh = error', none && none.success === false);
  assert('nothing forwarded on error', h.sentOfType(TYPE).length === 0);
}

// --- Export never returns a fetch that started before it ---------------------
{
  const calls = [];
  const h = loadContent('deepseek', {
    pathname: `/a/chat/s/${ID}`,
    fetchImpl: () => {
      if (calls.length >= 2) return Promise.reject(new Error('offline'));
      const d = deferred();
      calls.push(d);
      return d.promise;
    }
  });
  await sleep(0);
  assert('page load starts one fetch', calls.length === 1);
  const exporting = h.runtimeMessage(exportMsg(ID));
  await sleep(0);
  assert('export starts its own fetch', calls.length === 2);
  calls[1].resolve(jsonResponse(history([1, 2, 3])));
  await exporting;
  calls[0].resolve(jsonResponse(history([1])));
  await sleep(10);
  assert('export forwards its own result', ids(h.sentOfType(TYPE)[0].payload) === '1,2,3');
  await h.runtimeMessage(exportMsg(ID));
  assert('older fetch does not overwrite newer result', ids(h.sentOfType(TYPE)[1].payload) === '1,2,3');
}

// --- Passive captures do not degrade a stored chat ---------------------------
{
  const h = loadContent('deepseek', { pathname: '/', fetchImpl: offline });
  const current = async () => {
    await h.runtimeMessage(exportMsg(ID));
    return h.sentOfType(TYPE).at(-1);
  };
  await h.postSigned(TYPE, SOURCE, stamped(history([1, 2, 3, 4])));

  await h.postSigned(TYPE, SOURCE, stamped({ code: 40003, msg: 'INVALID_TOKEN', data: { biz_data: { chat_messages: [msg(9)] } } }));
  assert('error-code reply is not stored', ids((await current()).payload) === '1,2,3,4');

  await h.postSigned(TYPE, SOURCE, stamped({ code: 0, data: { biz_code: 7, biz_data: { chat_messages: [msg(9)] } } }));
  assert('biz-error reply is not stored', ids((await current()).payload) === '1,2,3,4');

  await h.postSigned(TYPE, SOURCE, stamped(history([])));
  assert('empty session is not stored', ids((await current()).payload) === '1,2,3,4');

  // A cache delta: no session record, one edited and one new message.
  const delta = history([], null);
  delta.data.biz_data.chat_messages = [msg(4, 'edited'), msg(5)];
  await h.postSigned(TYPE, SOURCE, stamped(delta));
  let out = await current();
  assert('delta is merged, not swapped in', ids(out.payload) === '1,2,3,4,5', ids(out.payload));
  assert('delta updates the message it carries', bizOf(out.payload).chat_messages[3].fragments[0].content === 'edited');
  assert('delta keeps the session record', bizOf(out.payload).chat_session.title === 'Synthetic chat');
  assert('merge is flagged', out.capture.flags.includes('passive_merged'));

  // A full reply with a new title replaces everything.
  await h.postSigned(TYPE, SOURCE, stamped(history([1, 2, 3, 4, 5, 6], session('Renamed'))));
  out = await current();
  assert('superset replaces', ids(out.payload) === '1,2,3,4,5,6');
  assert('superset brings its session', bizOf(out.payload).chat_session.title === 'Renamed');
  assert('superset clears merge flag', !out.capture.flags.includes('passive_merged'));

  // A superset without a session record keeps the stored one.
  await h.postSigned(TYPE, SOURCE, stamped(history([1, 2, 3, 4, 5, 6, 7], null)));
  out = await current();
  assert('superset without session keeps the stored session',
    ids(out.payload) === '1,2,3,4,5,6,7' && bizOf(out.payload).chat_session.title === 'Renamed');
}

// --- Signing secret ----------------------------------------------------------
for (const [label, secret, key] of [
  ['null secret', null, 'null'],
  ['malformed secret', 'short', 'short'],
  ['wrong key', undefined, 'cd'.repeat(32)]
]) {
  const h = loadContent('deepseek', secret === undefined ? { pathname: '/' } : { pathname: '/', secret });
  await h.postSigned(TYPE, SOURCE, stamped(history([1])), { key });
  const list = await h.runtimeMessage({ type: 'GET_CAPTURED_CONVERSATIONS' });
  assert(`${label}: message rejected`, list.conversationIds.length === 0);
}

// --- inject.js: which requests are captured ----------------------------------
{
  const body = history([1, 2]);
  const forged = history([9]);
  const run = async (input, init, response) => {
    const h = loadInject('deepseek', { nativeFetch: async () => response });
    await h.win.fetch(input, init);
    await sleep(20);
    return h.posted;
  };
  const own = (p, b = body) => jsonResponse(b, { url: ORIGIN + p });

  let posted = await run(URL_FOR(ID), undefined, own(URL_FOR(ID)));
  assert('own GET is captured', posted.length === 1 && posted[0].payload._captured_conversation_id === ID);

  posted = await run(new Request(ORIGIN + URL_FOR(ID)), undefined, own(URL_FOR(ID)));
  assert('Request object is captured', posted.length === 1);

  posted = await run(URL_FOR(ID), { method: 'POST' }, own(URL_FOR(ID)));
  assert('POST is not captured', posted.length === 0);

  posted = await run(`${PATH}/extra?chat_session_id=${ID}`, undefined, own(`${PATH}/extra?chat_session_id=${ID}`));
  assert('longer path is not captured', posted.length === 0);

  posted = await run(`/proxy${URL_FOR(ID)}`, undefined, own(`/proxy${URL_FOR(ID)}`));
  assert('path as a suffix is not captured', posted.length === 0);

  posted = await run(`/x?next=${PATH}&chat_session_id=${ID}`, undefined, own(`/x?next=${PATH}&chat_session_id=${ID}`));
  assert('path in the query string is not captured', posted.length === 0);

  posted = await run(`https://evil.example${URL_FOR(ID)}`, undefined,
    jsonResponse(forged, { url: `https://evil.example${URL_FOR(ID)}`, type: 'cors' }));
  assert('cross-origin URL is not captured', posted.length === 0);

  posted = await run({ url: URL_FOR(ID), toString: () => '/attacker-controlled' }, undefined,
    jsonResponse(forged, { url: `${ORIGIN}/attacker-controlled` }));
  assert('request look-alike is not captured', posted.length === 0);

  posted = await run(URL_FOR(ID), undefined, jsonResponse(forged, { url: `${ORIGIN}/elsewhere` }));
  assert('redirected response is not captured', posted.length === 0);
}
{
  const h = loadInject('deepseek', { nativeFetch: async () => jsonResponse({}) });
  await h.runXhr({ url: URL_FOR(ID), body: history([1, 2]) });
  assert('own XHR GET is captured', h.posted.length === 1 && h.posted[0].payload._captured_conversation_id === ID);

  h.posted.length = 0;
  await h.runXhr({ method: 'POST', url: URL_FOR(ID), body: history([1]) });
  assert('XHR POST is not captured', h.posted.length === 0);

  await h.runXhr({ url: URL_FOR(ID), responseURL: `${ORIGIN}/elsewhere`, body: history([1]) });
  assert('XHR redirected elsewhere is not captured', h.posted.length === 0);

  let cb = null;
  const fake = {
    __deepseekExporterUrl: URL_FOR(ID),
    addEventListener: (_, f) => { cb = f; },
    status: 200,
    responseURL: ORIGIN + URL_FOR(ID),
    responseText: JSON.stringify(history([9]))
  };
  try { h.FakeXHR.prototype.send.call(fake); } catch (_) { /* a real send would throw here */ }
  if (cb) cb();
  await sleep(20);
  assert('fake XHR receiver is not captured', h.posted.length === 0);
}

// --- Extractor: how `text` is built ------------------------------------------
{
  const rows = extractConversationMessages({
    _captured_conversation_id: ID,
    data: {
      biz_data: {
        chat_session: session(),
        chat_messages: [
          { message_id: 1, role: 'USER', fragments: [
            { type: 'REQUEST', content: 'first part' },
            { type: 'FILE', content: 'synthetic.txt' },
            { type: 'REQUEST', content: 'second part' }
          ] },
          { message_id: 2, role: 'ASSISTANT', fragments: [
            { type: 'THINK', content: 'private reasoning' },
            { type: 'TOOL_SEARCH', content: 'searching' }
          ] },
          { message_id: 3, role: 'ASSISTANT', fragments: [
            { type: 'THINK', content: 'more reasoning' },
            { type: 'RESPONSE', content: 'answer A' },
            { type: 'RESPONSE', content: 'answer B' }
          ] },
          { message_id: 4, role: 'USER', content: 'top-level prompt' },
          { message_id: 5, role: 'ASSISTANT', content: 'top-level answer', fragments: [] },
          { message_id: 6, role: 'ASSISTANT', content: 'ignored', fragments: [{ type: 'RESPONSE', content: 'from fragment' }] }
        ]
      }
    }
  });
  assert('all REQUEST fragments are joined', rows[0].text === 'first part\nsecond part', JSON.stringify(rows[0].text));
  assert('assistant turn without a response has empty text', rows[1].text === '' && rows[1].text_cleaned === '');
  assert('its reasoning stays in thinking_text', rows[1].thinking_text === 'private reasoning');
  assert('response fragments are joined, reasoning excluded', rows[2].text === 'answer A\nanswer B');
  assert('user turn without fragments uses top-level content', rows[3].text === 'top-level prompt');
  assert('assistant turn without fragments uses top-level content', rows[4].text === 'top-level answer');
  assert('fragments win over top-level content', rows[5].text === 'from fragment');
}

console.log(`\nDeepSeek scripts test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
