/**
 * Behaviour test for the ChatGPT page-context script.
 *
 * Runs shared/message-security.js and platforms/chatgpt/inject.js in a vm
 * sandbox with a fake page `fetch`, then calls the hooked fetch the way the
 * page (or a hostile script on it) could, and checks which responses are
 * forwarded to the content script. Only ChatGPT's own same-origin GET of
 * /backend-api/conversation/{uuid} with a real conversation body may be.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const SECURITY_SRC = fs.readFileSync(path.join(ROOT, 'shared', 'message-security.js'), 'utf8');
const INJECT_SRC = fs.readFileSync(path.join(ROOT, 'platforms', 'chatgpt', 'inject.js'), 'utf8');

let passed = 0;
let failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { passed++; } else { failed++; console.error('FAIL:', name, detail); }
}

const ORIGIN = 'https://chatgpt.com';
const ID = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ID = '00000000-0000-4000-8000-0000000000b2';
const API = `${ORIGIN}/backend-api/conversation/${ID}`;

function conversationBody(id = ID) {
  return {
    conversation_id: id,
    title: 'Synthetic',
    mapping: { root: { id: 'root', message: null, parent: null, children: [] } }
  };
}

/**
 * Load the two scripts into a fresh fake page. `respond(input, init)` builds
 * the fake network answer: `{ body, url, type, ok, status, contentType }`.
 */
function load(respond) {
  const posted = [];
  const attributes = {};
  const window = {
    crypto: globalThis.crypto, TextEncoder, Uint8Array, Uint32Array,
    location: { origin: ORIGIN, href: `${ORIGIN}/c/${ID}` },
    postMessage(message, targetOrigin) { posted.push({ message, targetOrigin }); },
    fetch: async (input, init) => {
      const r = respond(input, init) || {};
      const requested = typeof input === 'string' ? input : (input && (input.url || input.href)) || '';
      const headers = { 'content-type': r.contentType ?? 'application/json', ...(r.headers || {}) };
      return {
        ok: r.ok ?? true,
        status: r.status ?? 200,
        type: r.type ?? 'basic',
        url: r.url ?? new URL(requested, `${ORIGIN}/`).href,
        headers: { get: name => headers[name.toLowerCase()] ?? null },
        clone() { return { json: async () => JSON.parse(JSON.stringify('body' in r ? r.body : conversationBody())) }; }
      };
    }
  };
  const context = vm.createContext({
    window,
    document: { documentElement: { setAttribute(name, value) { attributes[name] = value; } } },
    crypto: globalThis.crypto,
    console, Request, URL, JSON, Array, Date, Promise, Object, Error, TypeError, Uint8Array
  });
  vm.runInContext(SECURITY_SRC, context, { filename: 'message-security.js' });
  vm.runInContext(INJECT_SRC, context, { filename: 'inject.js' });
  return { window, posted, attributes };
}

/** Let the detached clone().json().then(sign + post) chain finish. */
function settle() {
  return new Promise(resolve => setTimeout(resolve, 25));
}

async function capturedFor(input, init, respond = () => ({})) {
  const page = load(respond);
  const response = await page.window.fetch(input, init);
  await settle();
  return { ...page, response };
}

// ---------------------------------------------------------------------------
// What must be captured
// ---------------------------------------------------------------------------

{
  const { posted, attributes, response, window } = await capturedFor(API);
  assert('conversation GET is forwarded once', posted.length === 1, String(posted.length));
  const sent = posted[0] || {};
  assert('posted to the page origin only', sent.targetOrigin === ORIGIN, sent.targetOrigin);
  assert('payload is the conversation', sent.message?.payload?.conversation_id === ID && !!sent.message?.payload?.mapping);
  assert('message type and source set',
    sent.message?.type === 'CHATGPT_CONVERSATION_DATA' && sent.message?.source === 'chatgpt-exporter-inject',
    JSON.stringify([sent.message?.type, sent.message?.source]));
  const secret = attributes['data-chatgpt-exporter-secret'];
  assert('secret handed over as 64 hex chars', /^[0-9a-f]{64}$/.test(secret || ''));
  const verified = await window.MessageSecurity.verifySignedMessage(
    sent.message, 'CHATGPT_CONVERSATION_DATA', 'chatgpt-exporter-inject', secret);
  assert('message verifies with the handed-over secret', verified.isValid === true, verified.error);
  assert('the page still gets its response', response.ok === true && response.url === API);
}

{
  const cases = [
    ['relative URL', `/backend-api/conversation/${ID}`, undefined],
    ['plural endpoint', `${ORIGIN}/backend-api/conversations/${ID}`, undefined],
    ['query string', `${API}?foo=1`, undefined],
    ['Request object', new Request(API), undefined],
    ['URL object', new URL(API), undefined],
    ['explicit lower-case get', API, { method: 'get' }],
    ['upper-case UUID in the path', `${ORIGIN}/backend-api/conversation/${ID.toUpperCase()}`, undefined]
  ];
  for (const [name, input, init] of cases) {
    const { posted } = await capturedFor(input, init);
    assert(`captured: ${name}`, posted.length === 1, String(posted.length));
  }
}

{
  // A service-worker-built response has type 'default'.
  const { posted } = await capturedFor(API, undefined, () => ({ type: 'default' }));
  assert('captured: service-worker response', posted.length === 1);
}

{
  // Flat `messages` format.
  const { posted } = await capturedFor(API, undefined, () => ({ body: { id: ID, messages: [] } }));
  assert('captured: messages-array body', posted.length === 1);
}

// ---------------------------------------------------------------------------
// What must not be captured
// ---------------------------------------------------------------------------

{
  // The address only contains the API path; what was fetched is something else.
  const lookalikes = [
    ['blob: URL with the path in its fragment', `blob:${ORIGIN}/3f1c#/backend-api/conversation/${ID}`],
    ['data: URL', `data:application/json,{}#/backend-api/conversation/${ID}`],
    ['same-origin page with the path in its fragment', `${ORIGIN}/share/x#/backend-api/conversation/${ID}`],
    ['same-origin page with the path in its query', `${ORIGIN}/share/x?next=/backend-api/conversation/${ID}`],
    ['path prefix before the API path', `${ORIGIN}/files/backend-api/conversation/${ID}`],
    ['cross-origin host', `https://evil.example/backend-api/conversation/${ID}`],
    ['look-alike host', `https://chatgpt.com.evil.example/backend-api/conversation/${ID}`],
    ['http scheme', `http://chatgpt.com/backend-api/conversation/${ID}`],
    ['sub-resource', `${API}/textdocs`],
    ['conversation list', `${ORIGIN}/backend-api/conversations?offset=0`],
    ['non-UUID id', `${ORIGIN}/backend-api/conversation/not-a-uuid`]
  ];
  for (const [name, url] of lookalikes) {
    // The fake network echoes the requested URL and always answers with a
    // well-formed conversation, so only the URL check can reject it.
    const { posted } = await capturedFor(url, undefined, () => ({ url, type: url.startsWith(ORIGIN) || url.startsWith('blob:') ? 'basic' : 'cors' }));
    assert(`not captured: ${name}`, posted.length === 0, String(posted.length));
  }
}

{
  // Cross-origin content must be rejected on the URL even if the response
  // type were to claim same-origin.
  const url = `https://evil.example/backend-api/conversation/${ID}`;
  const { posted } = await capturedFor(url, undefined, () => ({ url, type: 'basic' }));
  assert('not captured: cross-origin URL with a basic response type', posted.length === 0);
}

{
  // The request names the API, but the response came from elsewhere.
  const { posted } = await capturedFor(API, undefined, () => ({ url: `${ORIGIN}/auth/login`, type: 'basic' }));
  assert('not captured: redirected away from the endpoint', posted.length === 0);
  const cors = await capturedFor(API, undefined, () => ({ type: 'cors' }));
  assert('not captured: cors response type', cors.posted.length === 0);
  const opaque = await capturedFor(API, undefined, () => ({ type: 'opaque' }));
  assert('not captured: opaque response type', opaque.posted.length === 0);
}

{
  // fetch() would request String(object), not object.url.
  const fake = { url: API, toString() { return `${ORIGIN}/somewhere-else`; } };
  const { posted } = await capturedFor(fake, undefined, () => ({ url: '' }));
  assert('not captured: plain object with a url property', posted.length === 0);
}

{
  const post = await capturedFor(API, { method: 'POST' });
  assert('not captured: POST via init', post.posted.length === 0);
  const patch = await capturedFor(API, { method: 'patch' });
  assert('not captured: PATCH via init', patch.posted.length === 0);
  const request = await capturedFor(new Request(API, { method: 'POST', body: '{}' }));
  assert('not captured: POST via Request', request.posted.length === 0);
  const del = await capturedFor(new Request(API, { method: 'DELETE' }));
  assert('not captured: DELETE via Request', del.posted.length === 0);
}

{
  const bodies = [
    ['id-only body (would wipe a stored conversation)', { conversation_id: ID }],
    ['mapping is null', { conversation_id: ID, mapping: null }],
    ['mapping is an array', { conversation_id: ID, mapping: [] }],
    ['messages is not an array', { conversation_id: ID, messages: 'none' }],
    ['body names another conversation', conversationBody(OTHER_ID)],
    ['body is an array', [conversationBody()]],
    ['body is null', null]
  ];
  for (const [name, body] of bodies) {
    const { posted } = await capturedFor(API, undefined, () => ({ body }));
    assert(`not captured: ${name}`, posted.length === 0, String(posted.length));
  }
}

{
  const notOk = await capturedFor(API, undefined, () => ({ ok: false, status: 404 }));
  assert('not captured: error status', notOk.posted.length === 0);
  const html = await capturedFor(API, undefined, () => ({ contentType: 'text/html' }));
  assert('not captured: non-JSON content type', html.posted.length === 0);
  const huge = await capturedFor(API, undefined, () => ({ headers: { 'content-length': String(200 * 1024 * 1024) } }));
  assert('not captured: over the size limit', huge.posted.length === 0);
}

{
  // A failing network call must surface to the page unchanged.
  const page = load(() => { throw new TypeError('NetworkError'); });
  let thrown = null;
  try { await page.window.fetch(API); } catch (e) { thrown = e; }
  assert('network errors propagate to the page', thrown instanceof TypeError && thrown.message === 'NetworkError');
  assert('nothing posted after a network error', page.posted.length === 0);
}

console.log(`\nChatGPT inject tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
