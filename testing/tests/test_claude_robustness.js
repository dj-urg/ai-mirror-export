/**
 * Robustness tests for the Claude platform scripts (synthetic data only).
 *
 * 1. Extractor: a null message or content block is skipped instead of
 *    aborting the export.
 * 2. inject.js (in a vm sandbox with a fake page): only Claude's own
 *    same-origin conversation GET is captured and signed.
 * 3. content.js (in a vm sandbox with a fake page and `browser.*`): an
 *    export reflects the conversation as it is at export time, a failed
 *    refresh is reported in `capture`, and messages are rejected while no
 *    signing secret is known.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { extractClaudeConversation } from '../../platforms/claude/extractor.js';
import { parseCSV } from '../../utils/csv_parse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SECURITY_SRC = read('shared/message-security.js');
const INJECT_SRC = read('platforms/claude/inject.js');
const CONTENT_SRC = read('platforms/claude/content.js');

let passed = 0;
let failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { passed++; } else { failed++; console.error('FAIL:', name, detail); }
}

const ORIGIN = 'https://claude.ai';
const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const CONV = '11111111-2222-4333-8444-555555555555';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function message(n, sender, text) {
  return {
    uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    parent_message_uuid: n > 1 ? `00000000-0000-4000-8000-${String(n - 1).padStart(12, '0')}` : '',
    index: n - 1,
    sender,
    created_at: '2026-01-01T10:00:00.000000Z',
    updated_at: '2026-01-01T10:00:00.000000Z',
    content: [{ type: 'text', text }]
  };
}

function conversation(count) {
  const chat_messages = [];
  for (let n = 1; n <= count; n++) {
    chat_messages.push(message(n, n % 2 ? 'human' : 'assistant', `message ${n}`));
  }
  return {
    uuid: CONV,
    name: 'Synthetic chat',
    created_at: '2026-01-01T10:00:00.000000Z',
    updated_at: '2026-01-01T10:00:00.000000Z',
    current_leaf_message_uuid: chat_messages[chat_messages.length - 1].uuid,
    chat_messages
  };
}

// --- 1. Extractor: null messages and blocks ---------------------------------
{
  const opts = { donorId: 'donor', donorIdType: 'raw', downloadTime: '2026-01-02T00:00:00.000Z' };
  const clean = conversation(2);
  const dirty = conversation(2);
  dirty.chat_messages.splice(1, 0, null, 'not a message', 7);
  dirty.chat_messages[0].content = [null, { type: 'text', text: 'message 1' }, 'stray'];

  let result = null;
  let error = null;
  try { result = extractClaudeConversation(dirty, opts); } catch (e) { error = e; }
  assert('extractor does not throw on null messages and blocks', error === null, error && error.stack);

  if (result) {
    const rows = parseCSV(result.messagesCSV.replace(/^﻿/, '')).rows;
    assert('one row per valid block', rows.length === 2, `rows=${rows.length}`);
    const headers = parseCSV(result.messagesCSV).headers;
    const col = (name) => headers.indexOf(name);
    assert('valid block keeps its original block_index', rows[0][col('block_index')] === '1', rows[0][col('block_index')]);
    assert('text survives', rows[0][col('text')] === 'message 1' && rows[1][col('text')] === 'message 2');

    const meta = parseCSV(result.metadataCSV);
    assert('num_messages counts valid messages only',
      meta.rows[0][meta.headers.indexOf('num_messages')] === '2');

    const canonical = parseCSV(result.messagesCanonicalCSV);
    assert('canonical has one row per valid message', canonical.rows.length === 2, `rows=${canonical.rows.length}`);
  }

  // A message whose blocks are all unusable still gets its (empty) row.
  const hollow = conversation(1);
  hollow.chat_messages[0].content = [null];
  const hollowRows = parseCSV(extractClaudeConversation(hollow, opts).messagesCSV).rows;
  assert('message with only null blocks keeps one row', hollowRows.length === 1, `rows=${hollowRows.length}`);

  // Valid input is unaffected by the guards.
  const a = extractClaudeConversation(clean, opts);
  const b = extractClaudeConversation(JSON.parse(JSON.stringify(clean)), opts);
  assert('valid input output is stable', a.messagesCSV === b.messagesCSV && a.messagesCSV.includes('message 2'));
}

// --- Fake page shared by the inject and content tests -----------------------

/** Minimal XMLHttpRequest: open() throws on a non-instance, like the real one. */
function makeXhrClass(respond) {
  class FakeXHR {
    constructor() { this._listeners = {}; this.status = 0; this.responseText = ''; this.responseURL = ''; }
    open(method, url) {
      if (!(this instanceof FakeXHR)) throw new TypeError('Illegal invocation');
      this._url = String(url);
    }
    send() {
      const res = respond(this._url);
      this.status = res.status;
      this.responseText = res.body;
      this.responseURL = res.url;
      (this._listeners.load || []).forEach((fn) => fn());
    }
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  }
  return FakeXHR;
}

class FakeResponse {
  constructor(url, body, { status = 200, type = 'basic', contentType = 'application/json' } = {}) {
    this.url = url; this._body = body; this.status = status; this.ok = status >= 200 && status < 300;
    this.type = type;
    this.headers = { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) };
  }
  clone() { return this; }
  async json() { return JSON.parse(this._body); }
}

class FakeRequest {
  constructor(url, init = {}) { this.url = new URL(url, `${ORIGIN}/`).href; this.method = init.method || 'GET'; }
}

/**
 * Load message-security.js + inject.js into a fake MAIN world. `network(url)`
 * answers every native fetch; posted (signed) messages are collected.
 */
function loadInject(network) {
  const posted = [];
  const attrs = {};
  const window = {
    crypto: globalThis.crypto, TextEncoder, Uint8Array, Uint32Array,
    location: { origin: ORIGIN, href: `${ORIGIN}/chat/${CONV}` },
    postMessage: (msg, origin) => posted.push({ msg, origin }),
    fetch: async (input) => network(input)
  };
  const XHR = makeXhrClass((url) => {
    const res = network(url);
    return { status: res.status, body: res._body, url: res.url };
  });
  const sandbox = {
    window, crypto: globalThis.crypto, TextEncoder, URL, Request: FakeRequest,
    XMLHttpRequest: XHR,
    document: { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } },
    console, JSON, Array, Date, Promise, Object, Error, TypeError, Set, WeakMap, String, Uint8Array, Uint32Array
  };
  vm.createContext(sandbox);
  vm.runInContext(SECURITY_SRC, sandbox, { filename: 'message-security.js' });
  vm.runInContext(INJECT_SRC, sandbox, { filename: 'inject.js' });
  return { window, posted, XHR, secret: attrs['data-claude-exporter-secret'] };
}

// --- 2. inject.js: what gets captured and signed ----------------------------
{
  const body = JSON.stringify(conversation(2));
  const convPath = `/api/organizations/${ORG_A}/chat_conversations/${CONV}`;

  // The fake network serves the conversation body for whatever is requested
  // and reports the URL that was really fetched.
  const network = (input) => {
    if (input instanceof FakeRequest) return new FakeResponse(input.url, body);
    if (typeof input === 'string' || input instanceof URL) {
      const resolved = new URL(String(input), `${ORIGIN}/`);
      return new FakeResponse(resolved.href, body, { type: resolved.origin === ORIGIN ? 'basic' : 'cors' });
    }
    // A plain object is stringified by the real fetch.
    return new FakeResponse(String(input), body);
  };

  const captured = async (doFetch) => {
    const page = loadInject(network);
    await doFetch(page);
    await settle();
    return page.posted.length;
  };
  const viaFetch = (...args) => captured((page) => page.window.fetch(...args));

  assert('secret is 64 hex characters', /^[0-9a-f]{64}$/.test(loadInject(network).secret || ''));

  assert('captures the conversation GET (relative URL)',
    await viaFetch(`${convPath}?tree=True&rendering_mode=messages`) === 1);
  assert('captures the conversation GET (absolute URL)', await viaFetch(`${ORIGIN}${convPath}`) === 1);
  assert('captures the conversation GET (URL object)', await viaFetch(new URL(`${ORIGIN}${convPath}`)) === 1);
  assert('captures the conversation GET (Request)', await viaFetch(new FakeRequest(convPath)) === 1);

  assert('ignores sub-resource /completion', await viaFetch(`${convPath}/completion`) === 0);
  assert('ignores sub-resource /latest', await viaFetch(`${convPath}/latest`) === 0);
  assert('ignores sub-resource /title', await viaFetch(`${convPath}/title`) === 0);
  assert('ignores non-GET (init)', await viaFetch(convPath, { method: 'PUT' }) === 0);
  assert('ignores non-GET (Request)', await viaFetch(new FakeRequest(convPath, { method: 'POST' })) === 0);
  assert('ignores another origin', await viaFetch(`https://evil.example${convPath}`) === 0);
  assert('ignores the path inside a fragment',
    await viaFetch(`blob:${ORIGIN}/2f0c#${convPath}`) === 0);
  assert('ignores the path inside a query string', await viaFetch(`/other?next=${convPath}`) === 0);
  assert('ignores an object that only claims a conversation .url',
    await viaFetch({ url: convPath, toString() { return 'data:application/json,{}'; } }) === 0);

  // A redirect elsewhere: request URL matches, response URL does not.
  const redirected = loadInject(() => new FakeResponse(`${ORIGIN}/login`, body));
  await redirected.window.fetch(convPath);
  await settle();
  assert('ignores a response that came from another URL', redirected.posted.length === 0);

  // XHR: real instance captured; look-alike object passed to send() is not.
  assert('captures the conversation GET over XHR', await captured(async (page) => {
    const xhr = new page.XHR();
    xhr.open('GET', convPath);
    xhr.send();
  }) === 1);
  assert('ignores XHR sub-resource', await captured(async (page) => {
    const xhr = new page.XHR();
    xhr.open('GET', `${convPath}/latest`);
    xhr.send();
  }) === 0);
  assert('ignores XHR POST', await captured(async (page) => {
    const xhr = new page.XHR();
    xhr.open('POST', convPath);
    xhr.send();
  }) === 0);
  assert('ignores send() on an object that never went through open()', await captured(async (page) => {
    const fake = {
      __claudeExporterUrl: convPath, status: 200, responseText: body, responseURL: `${ORIGIN}${convPath}`,
      addEventListener(type, fn) { fn(); }
    };
    try { page.XHR.prototype.send.call(fake); } catch (_) { /* the native send rejects it */ }
  }) === 0);

  // Messages are posted to the page's own origin only.
  const page = loadInject(network);
  await page.window.fetch(convPath);
  await settle();
  assert('posts to the page origin', page.posted[0] && page.posted[0].origin === ORIGIN);
}

// --- 3. content.js: export refresh, capture info, secret guard --------------

/**
 * Load content.js with a mocked page and `browser.*`.
 * `server` is mutable: { orgs: [...], conversations: { [orgId]: payload | status } }.
 */
function loadContent(server, { secret = 'a'.repeat(64), pathname = `/chat/${CONV}` } = {}) {
  const runtimeListeners = [];
  const windowListeners = [];
  const sent = [];
  const calls = { organizations: 0, conversation: 0, urls: [] };
  const attrs = secret === null ? {} : { 'data-claude-exporter-secret': secret };
  const observers = [];

  const window = {
    location: { pathname, origin: ORIGIN },
    addEventListener: (type, fn) => { if (type === 'message') windowListeners.push(fn); }
  };
  const documentElement = {
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    removeAttribute: (k) => { delete attrs[k]; },
    setAttribute: (k, v) => { attrs[k] = v; observers.forEach((o) => o.connected && o.fn()); }
  };
  class FakeObserver {
    constructor(fn) { this.fn = fn; this.connected = false; observers.push(this); }
    observe() { this.connected = true; }
    disconnect() { this.connected = false; }
  }
  const json = (status, value) => ({ status, ok: status >= 200 && status < 300, json: async () => value });

  const sandbox = {
    window,
    document: { readyState: 'complete', documentElement, addEventListener() {} },
    MutationObserver: FakeObserver,
    crypto: globalThis.crypto, TextEncoder, AbortController, console,
    setTimeout, clearTimeout, setInterval: () => 0,
    fetch: async (url) => {
      calls.urls.push(url);
      if (server.offline) throw new TypeError('NetworkError');
      if (url === '/api/organizations') {
        calls.organizations++;
        if (typeof server.orgs === 'number') return json(server.orgs, null);
        return json(200, server.orgs.map((uuid) => ({ uuid })));
      }
      const m = url.match(/^\/api\/organizations\/([^/]+)\/chat_conversations\/([^/?]+)\?tree=True/);
      if (!m) return json(404, null);
      calls.conversation++;
      const entry = server.conversations[decodeURIComponent(m[1])];
      if (entry === undefined) return json(404, null);
      if (typeof entry === 'number') return json(entry, null);
      return json(200, JSON.parse(JSON.stringify(entry)));
    },
    browser: {
      runtime: {
        id: 'ext',
        sendMessage: async (m) => { sent.push(m); },
        onMessage: { addListener: (fn) => runtimeListeners.push(fn) }
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(CONTENT_SRC, sandbox, { filename: 'content.js' });

  const send = (msg, sender = { id: 'ext' }) => new Promise((resolve) => {
    if (runtimeListeners[0](msg, sender, resolve) !== true) resolve(undefined);
  });
  const exportConversation = async (conversationId = CONV) => {
    sent.length = 0;
    const response = await send({ type: 'EXPORT_CONVERSATION', platform: 'claude', conversationId });
    const data = sent.find((m) => m.type === 'CLAUDE_CONVERSATION_DATA') || null;
    return { response, data };
  };
  const list = async () => (await send({ type: 'GET_CAPTURED_CONVERSATIONS' })).conversationIds;
  /** Deliver a page message the way window.postMessage would. */
  const postFromPage = async (data, overrides = {}) => {
    await Promise.all(windowListeners.map((fn) => fn({ source: window, origin: ORIGIN, data, ...overrides })));
  };
  return { send, sent, calls, exportConversation, list, postFromPage, documentElement, sandbox };
}

/** Sign a payload the way inject.js does (message-security.js in a vm). */
const securityWindow = { crypto: globalThis.crypto, TextEncoder, Uint8Array, Uint32Array };
vm.runInContext(SECURITY_SRC, vm.createContext({
  window: securityWindow, JSON, Array, Date, Promise, Object, Error, TypeError
}), { filename: 'message-security.js' });
const signed = (payload, secret) => securityWindow.MessageSecurity.createSignedMessage(
  payload, 'CLAUDE_CONVERSATION_DATA', 'claude-exporter-inject', 'claude', secret);

const CAPTURE_KEYS = ['captured_at', 'complete', 'flags', 'refresh', 'source'];

// 3a. Stale cache + successful refresh: the export carries the fresh data.
{
  const server = { orgs: [ORG_A], conversations: { [ORG_A]: conversation(1) } };
  const page = loadContent(server);
  await settle();
  assert('page-load fetch cached the conversation', (await page.list()).includes(CONV));

  server.conversations[ORG_A] = conversation(5); // the chat goes on
  const { response, data } = await page.exportConversation();
  assert('export succeeds', response && response.success === true, JSON.stringify(response));
  assert('export carries the conversation as it is now',
    data && data.payload.chat_messages.length === 5, data && String(data.payload.chat_messages.length));
  assert('capture has exactly the contract fields',
    data && JSON.stringify(Object.keys(data.capture).sort()) === JSON.stringify(CAPTURE_KEYS));
  assert('capture reports a successful export refresh',
    data && data.capture.refresh === 'ok' && data.capture.source === 'export_refresh'
      && data.capture.flags.length === 0 && data.capture.complete === null,
    data && JSON.stringify(data.capture));
  assert('captured_at is an ISO timestamp',
    data && new Date(data.capture.captured_at).toISOString() === data.capture.captured_at);
}

// 3b. Failed refresh: the cached copy is exported and flagged.
{
  const server = { orgs: [ORG_A], conversations: { [ORG_A]: conversation(2) } };
  const page = loadContent(server);
  await settle();
  const before = Date.now();
  await settle();

  server.conversations[ORG_A] = 500;
  const { response, data } = await page.exportConversation();
  assert('export with failed refresh still succeeds', response && response.success === true);
  assert('export falls back to the cached copy', data && data.payload.chat_messages.length === 2);
  assert('capture reports the failed refresh',
    data && data.capture.refresh === 'failed' && data.capture.flags.includes('refresh_failed')
      && data.capture.source === 'active',
    data && JSON.stringify(data.capture));
  assert('captured_at is the time of the cached copy, not of the export',
    data && Date.parse(data.capture.captured_at) <= before, data && data.capture.captured_at);

  server.offline = true;
  const offline = await page.exportConversation();
  assert('network error at export also falls back, flagged',
    offline.data && offline.data.capture.refresh === 'failed' && offline.data.payload.chat_messages.length === 2);
}

// 3c. Nothing cached and the fetch fails: a visible error, nothing forwarded.
{
  const server = { orgs: [ORG_A], conversations: {} };
  const page = loadContent(server);
  await settle();
  const { response, data } = await page.exportConversation();
  assert('no data and failed fetch gives an error',
    response && response.success === false && /not found/i.test(response.error), JSON.stringify(response));
  assert('nothing is forwarded to background', data === null);

  const bad = await page.exportConversation('../../etc');
  assert('malformed conversation id is refused', bad.response && bad.response.success === false && bad.data === null);
}

// 3d. A forced export does not hand back an older request already under way.
{
  const server = { orgs: [ORG_A], conversations: { [ORG_A]: conversation(1) } };
  const page = loadContent(server); // page-load fetch starts, not yet settled
  const before = page.calls.conversation;
  server.conversations[ORG_A] = conversation(3);
  const { data } = await page.exportConversation();
  assert('export made its own request', page.calls.conversation >= before + 1 && page.calls.conversation >= 2,
    `conversation calls=${page.calls.conversation}`);
  assert('export after an in-flight fetch carries current data',
    data && data.payload.chat_messages.length === 3 && data.capture.source === 'export_refresh');
}

// 3e. The conversation lives in the second organisation.
{
  const server = { orgs: [ORG_A, ORG_B], conversations: { [ORG_B]: conversation(2) } };
  const page = loadContent(server);
  await settle();
  assert('conversation found in the second organisation', (await page.list()).includes(CONV));
  page.calls.urls.length = 0;
  const { data } = await page.exportConversation();
  assert('export works for the second organisation', data && data.payload.chat_messages.length === 2);
  const convCalls = page.calls.urls.filter((u) => u.includes('/chat_conversations/'));
  assert('the organisation that worked is tried first next time',
    convCalls.length === 1 && convCalls[0].includes(ORG_B), JSON.stringify(convCalls));
}

// 3f. Signed page messages: accepted with the secret, rejected without one.
{
  const secret = 'c'.repeat(64);
  const server = { orgs: 500, conversations: {} }; // active fetch never succeeds
  const page = loadContent(server, { secret });
  await settle();
  assert('secret attribute is removed after reading',
    page.documentElement.getAttribute('data-claude-exporter-secret') === null);

  await page.postFromPage(await signed(conversation(4), secret));
  assert('validly signed capture is stored', (await page.list()).includes(CONV));

  // A smaller copy (current branch only) does not replace the fuller one.
  await page.postFromPage(await signed(conversation(2), secret));
  const { data } = await page.exportConversation();
  assert('smaller passive copy does not replace the fuller one',
    data && data.payload.chat_messages.length === 4, data && String(data.payload.chat_messages.length));
  assert('passive fallback is described as such',
    data && data.capture.source === 'passive' && data.capture.refresh === 'failed');

  await page.postFromPage(await signed(conversation(6), secret));
  assert('larger passive copy replaces it',
    (await page.exportConversation()).data.payload.chat_messages.length === 6);

  const wrong = loadContent(server, { secret });
  await wrong.postFromPage(await signed(conversation(2), 'd'.repeat(64)));
  assert('message signed with another secret is rejected', (await wrong.list()).length === 0);

  const otherOrigin = loadContent(server, { secret });
  await otherOrigin.postFromPage(await signed(conversation(2), secret), { origin: 'https://evil.example' });
  assert('message from another origin is rejected', (await otherOrigin.list()).length === 0);
}

// 3g. No secret delivered: a message signed with the text "null" is rejected.
{
  const server = { orgs: 500, conversations: {} };
  const page = loadContent(server, { secret: null });
  await settle();
  await page.postFromPage(await signed(conversation(2), 'null'));
  assert('forged message signed with key "null" is rejected', (await page.list()).length === 0);

  // A value that is not inject.js's 64-hex secret is not adopted.
  page.documentElement.setAttribute('data-claude-exporter-secret', 'page-chosen-secret');
  await page.postFromPage(await signed(conversation(2), 'page-chosen-secret'));
  assert('a malformed secret set later is not adopted', (await page.list()).length === 0);

  // The real secret arriving late (ordering race) is still picked up.
  const late = 'e'.repeat(64);
  page.documentElement.setAttribute('data-claude-exporter-secret', late);
  await page.postFromPage(await signed(conversation(2), late));
  assert('a well-formed secret arriving late is adopted', (await page.list()).includes(CONV));
}

// 3h. Replacing a stored conversation does not evict another one.
{
  const secret = 'f'.repeat(64);
  const server = { orgs: 500, conversations: {} };
  const page = loadContent(server, { secret, pathname: '/new' });
  const idFor = (i) => `99999999-0000-4000-8000-${String(i).padStart(12, '0')}`;
  for (let i = 0; i < 50; i++) {
    await page.postFromPage(await signed({ ...conversation(1), uuid: idFor(i) }, secret));
  }
  await page.postFromPage(await signed({ ...conversation(2), uuid: idFor(49) }, secret));
  const ids = await page.list();
  assert('overwrite at the limit keeps all 50 conversations', ids.length === 50 && ids.includes(idFor(0)),
    `stored=${ids.length}`);
  await page.postFromPage(await signed({ ...conversation(1), uuid: idFor(50) }, secret));
  const after = await page.list();
  assert('a new conversation at the limit evicts the oldest', after.length === 50 && !after.includes(idFor(0)));
}

console.log(`Claude robustness test: ${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} Claude robustness assertion(s) failed`);
