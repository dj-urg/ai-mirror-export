/**
 * Behaviour tests for the Grok content script and page-context script.
 *
 * Both run in a vm sandbox (helpers/platform_vm_harness.js) against
 * synthetic payloads. Covered: the refresh at export, the capture record
 * sent with it, passive captures that must not degrade a stored
 * conversation, cache eviction, the signing-secret check, and which
 * requests the page hooks may capture.
 */
import {
  loadContent, loadInject, jsonResponse, deferred, sleep, ORIGIN
} from './helpers/platform_vm_harness.js';

let passed = 0;
let failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { passed++; } else { failed++; console.error('FAIL:', name, detail); }
}

const TYPE = 'GROK_CONVERSATION_DATA';
const SOURCE = 'grok-exporter-inject';
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PATH = `/rest/app-chat/conversations/${ID}`;

const resp = (n, text = `message ${n}`) => ({ responseId: `r${n}`, sender: n % 2 ? 'human' : 'ASSISTANT', message: text });
const conv = (...ns) => ({ responses: ns.map(n => resp(n)) });
const exportMsg = id => ({ type: 'EXPORT_CONVERSATION', platform: 'grok', conversationId: id });
const ids = payload => payload.responses.map(r => r.responseId).join(',');

// --- Export refreshes a stale cache -----------------------------------------
{
  let server = conv(1, 2);
  const h = loadContent('grok', { pathname: '/', fetchImpl: async () => jsonResponse(server) });
  await h.postSigned(TYPE, SOURCE, { ...conv(1, 2), _captured_conversation_id: ID });
  server = conv(1, 2, 3, 4);
  const res = await h.runtimeMessage(exportMsg(ID));
  const out = h.sentOfType(TYPE)[0];
  assert('export succeeds', res && res.success === true);
  assert('export forwards the refreshed conversation', out && ids(out.payload) === 'r1,r2,r3,r4', out && ids(out.payload));
  assert('refreshed payload is stamped with the id', out.payload._captured_conversation_id === ID);
  assert('capture.refresh = ok', out.capture.refresh === 'ok');
  assert('capture.source = export_refresh', out.capture.source === 'export_refresh');
  assert('capture.captured_at is ISO', !Number.isNaN(Date.parse(out.capture.captured_at)) && out.capture.captured_at.endsWith('Z'));
  assert('capture.flags is empty', Array.isArray(out.capture.flags) && out.capture.flags.length === 0);
  assert('capture.complete is null (unknown)', out.capture.complete === null);
  assert('id hint still sent', out.conversationId === ID);
}

// --- Refresh failure falls back to the cache and says so ---------------------
{
  const h = loadContent('grok', { pathname: '/', fetchImpl: async () => jsonResponse({}, { ok: false }) });
  await h.postSigned(TYPE, SOURCE, { ...conv(1, 2), _captured_conversation_id: ID });
  const res = await h.runtimeMessage(exportMsg(ID));
  const out = h.sentOfType(TYPE)[0];
  assert('export with failed refresh still succeeds', res && res.success === true);
  assert('cached copy forwarded', out && ids(out.payload) === 'r1,r2');
  assert('capture.refresh = failed', out.capture.refresh === 'failed');
  assert('capture.flags has refresh_failed', out.capture.flags.includes('refresh_failed'));
  assert('capture.source stays passive', out.capture.source === 'passive');

  const none = await h.runtimeMessage(exportMsg(OTHER));
  assert('no cache and no refresh = error', none && none.success === false);
}

// --- A paging cursor marks the capture incomplete ----------------------------
{
  const h = loadContent('grok', { pathname: '/', fetchImpl: async () => jsonResponse({ ...conv(1, 2), nextPageToken: 'abc' }) });
  await h.runtimeMessage(exportMsg(ID));
  const out = h.sentOfType(TYPE)[0];
  assert('cursor => complete false', out.capture.complete === false && out.capture.flags.includes('cursor_present'));
}

// --- Export never returns a fetch that started before it ---------------------
{
  const calls = [];
  const h = loadContent('grok', {
    pathname: `/c/${ID}`,
    // The first two requests are completed by hand; after that the network is down.
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
  calls[1].resolve(jsonResponse(conv(1, 2, 3)));
  await exporting;
  calls[0].resolve(jsonResponse(conv(1)));
  await sleep(10);
  const out = h.sentOfType(TYPE)[0];
  assert('export forwards its own result', ids(out.payload) === 'r1,r2,r3');
  // The older fetch resolved last; it must not have replaced the newer copy.
  const again = loadContentProbe(h);
  assert('older fetch does not overwrite newer result', (await again) === 'r1,r2,r3');
}

/** Export with the network down: shows what is in the cache. */
async function loadContentProbe(h) {
  const before = h.sentOfType(TYPE).length;
  await h.runtimeMessage(exportMsg(ID));
  const out = h.sentOfType(TYPE)[before];
  return out ? ids(out.payload) : null;
}

// --- Passive captures do not degrade a stored conversation -------------------
{
  const h = loadContent('grok', { pathname: '/', fetchImpl: async () => jsonResponse({}, { ok: false }) });
  const stamped = body => ({ ...body, _captured_conversation_id: ID });
  await h.postSigned(TYPE, SOURCE, stamped({ conversation: { title: 'Synthetic title' }, responses: conv(1, 2, 3, 4).responses }));

  // A partial view (two of the four, one edited, one new).
  await h.postSigned(TYPE, SOURCE, stamped({ responses: [resp(4, 'edited'), resp(5)] }));
  await h.runtimeMessage(exportMsg(ID));
  let out = h.sentOfType(TYPE).at(-1);
  assert('partial capture is merged, not swapped in', ids(out.payload) === 'r1,r2,r3,r4,r5', ids(out.payload));
  assert('merged capture takes the newer copy', out.payload.responses[3].message === 'edited');
  assert('merge keeps conversation metadata', out.payload.conversation && out.payload.conversation.title === 'Synthetic title');
  assert('merge is flagged', out.capture.flags.includes('passive_merged'));

  // A superset replaces the stored list and clears the flag.
  await h.postSigned(TYPE, SOURCE, stamped(conv(1, 2, 3, 4, 5, 6)));
  await h.runtimeMessage(exportMsg(ID));
  out = h.sentOfType(TYPE).at(-1);
  assert('superset capture replaces', ids(out.payload) === 'r1,r2,r3,r4,r5,r6');
  assert('superset keeps metadata it lacks', out.payload.conversation.title === 'Synthetic title');
  assert('superset clears merge flag', !out.capture.flags.includes('passive_merged'));
}
{
  // Without ids: a smaller list never replaces a larger one.
  const h = loadContent('grok', { pathname: '/', fetchImpl: async () => jsonResponse({}, { ok: false }) });
  const noId = n => ({ responses: Array.from({ length: n }, (_, i) => ({ sender: 'human', message: `m${i}` })), _captured_conversation_id: ID });
  await h.postSigned(TYPE, SOURCE, noId(3));
  await h.postSigned(TYPE, SOURCE, noId(1));
  await h.runtimeMessage(exportMsg(ID));
  assert('smaller id-less capture is ignored', h.sentOfType(TYPE).at(-1).payload.responses.length === 3);
  await h.postSigned(TYPE, SOURCE, noId(4));
  await h.runtimeMessage(exportMsg(ID));
  assert('larger id-less capture replaces', h.sentOfType(TYPE).at(-1).payload.responses.length === 4);
}

// --- Updating a stored conversation evicts nothing ---------------------------
{
  const h = loadContent('grok', { pathname: '/' });
  const idFor = i => `conv-${String(i).padStart(2, '0')}`;
  for (let i = 0; i < 50; i++) {
    await h.postSigned(TYPE, SOURCE, { ...conv(1), _captured_conversation_id: idFor(i) });
  }
  await h.postSigned(TYPE, SOURCE, { ...conv(1, 2), _captured_conversation_id: idFor(49) });
  let list = await h.runtimeMessage({ type: 'GET_CAPTURED_CONVERSATIONS' });
  assert('update keeps all 50', list.conversationIds.length === 50 && list.conversationIds.includes(idFor(0)));
  await h.postSigned(TYPE, SOURCE, { ...conv(1), _captured_conversation_id: 'conv-new' });
  list = await h.runtimeMessage({ type: 'GET_CAPTURED_CONVERSATIONS' });
  assert('a new id still evicts one', list.conversationIds.length === 50 && list.conversationIds.includes('conv-new'));
}

// --- Signing secret ----------------------------------------------------------
{
  // inject.js never wrote the secret. HMAC with a null key is computable by
  // anyone (the key encodes as the text "null"), so nothing may be accepted.
  const h = loadContent('grok', { pathname: '/', secret: null });
  await h.postSigned(TYPE, SOURCE, { ...conv(1), _captured_conversation_id: ID }, { key: 'null' });
  const list = await h.runtimeMessage({ type: 'GET_CAPTURED_CONVERSATIONS' });
  assert('null secret: message rejected', list.conversationIds.length === 0);
}
{
  const h = loadContent('grok', { pathname: '/', secret: 'short' });
  await h.postSigned(TYPE, SOURCE, { ...conv(1), _captured_conversation_id: ID });
  const list = await h.runtimeMessage({ type: 'GET_CAPTURED_CONVERSATIONS' });
  assert('malformed secret: message rejected', list.conversationIds.length === 0);
}
{
  const h = loadContent('grok', { pathname: '/' });
  await h.postSigned(TYPE, SOURCE, { ...conv(1), _captured_conversation_id: ID }, { key: 'cd'.repeat(32) });
  const list = await h.runtimeMessage({ type: 'GET_CAPTURED_CONVERSATIONS' });
  assert('wrong key: message rejected', list.conversationIds.length === 0);
}

// --- inject.js: which requests are captured ----------------------------------
{
  const body = conv(1, 2);
  const forged = { responses: [{ responseId: 'x', sender: 'human', message: 'FORGED' }] };
  // The fake native fetch answers every request; `url`/`type` describe what
  // the browser would really have fetched.
  const run = async (input, init, response) => {
    const h = loadInject('grok', { nativeFetch: async () => response });
    await h.win.fetch(input, init);
    await sleep(20);
    return h.posted;
  };
  const own = (p, b = body) => jsonResponse(b, { url: ORIGIN + p });

  let posted = await run(PATH, undefined, own(PATH));
  assert('own GET is captured', posted.length === 1 && posted[0].payload._captured_conversation_id === ID);
  assert('captured message is signed', typeof posted[0].signature === 'string' && posted[0].signature.length === 64);

  posted = await run(`${PATH}/responses?includeThreads=true`, undefined, own(`${PATH}/responses?includeThreads=true`));
  assert('own GET of /responses is captured', posted.length === 1);

  posted = await run(new Request(ORIGIN + PATH), undefined, own(PATH));
  assert('Request object is captured', posted.length === 1);

  posted = await run(PATH, { method: 'POST' }, own(PATH));
  assert('POST is not captured', posted.length === 0);

  posted = await run(`${PATH}/load-responses`, undefined, own(`${PATH}/load-responses`));
  assert('other sub-resource is not captured', posted.length === 0);

  posted = await run(`/x?u=${PATH}`, undefined, own(`/x?u=${PATH}`));
  assert('path in the query string is not captured', posted.length === 0);

  posted = await run(`/proxy${PATH}`, undefined, own(`/proxy${PATH}`));
  assert('path as a suffix is not captured', posted.length === 0);

  posted = await run(`https://evil.example${PATH}`, undefined,
    jsonResponse(forged, { url: `https://evil.example${PATH}`, type: 'cors' }));
  assert('cross-origin URL is not captured', posted.length === 0);

  // An object that looks like a request but is fetched as something else.
  posted = await run({ url: PATH, toString: () => '/attacker-controlled' }, undefined,
    jsonResponse(forged, { url: `${ORIGIN}/attacker-controlled` }));
  assert('request look-alike is not captured', posted.length === 0);

  // The response URL has the last word (redirect to another resource).
  posted = await run(PATH, undefined, jsonResponse(forged, { url: `${ORIGIN}/elsewhere` }));
  assert('redirected response is not captured', posted.length === 0);

  posted = await run(PATH, undefined, jsonResponse(forged, { url: ORIGIN + PATH, type: 'opaque' }));
  assert('non-basic response is not captured', posted.length === 0);
}
{
  const h = loadInject('grok', { nativeFetch: async () => jsonResponse({}) });
  await h.runXhr({ url: PATH, body: conv(1, 2) });
  assert('own XHR GET is captured', h.posted.length === 1 && h.posted[0].payload._captured_conversation_id === ID);

  h.posted.length = 0;
  await h.runXhr({ method: 'POST', url: PATH, body: conv(1) });
  assert('XHR POST is not captured', h.posted.length === 0);

  await h.runXhr({ url: PATH, responseURL: `${ORIGIN}/elsewhere`, body: conv(1) });
  assert('XHR redirected elsewhere is not captured', h.posted.length === 0);

  await h.runXhr({ url: `https://evil.example${PATH}`, body: conv(1) });
  assert('cross-origin XHR is not captured', h.posted.length === 0);

  // A fake receiver carrying the old expando fields must not be honoured.
  let cb = null;
  const fake = {
    __grokExporterUrl: PATH,
    __grokExporterMethod: 'GET',
    addEventListener: (_, f) => { cb = f; },
    status: 200,
    responseURL: ORIGIN + PATH,
    responseText: JSON.stringify(conv(1))
  };
  try { h.FakeXHR.prototype.send.call(fake); } catch (_) { /* a real send would throw here */ }
  if (cb) cb();
  await sleep(20);
  assert('fake XHR receiver is not captured', h.posted.length === 0);
}

console.log(`\nGrok scripts test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
