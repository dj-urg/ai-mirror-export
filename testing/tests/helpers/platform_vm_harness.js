/**
 * Node harness that runs a platform's real `content.js` or `inject.js` in a
 * `vm` context with just enough of the browser mocked to drive them.
 *
 * Used by the Grok / DeepSeek / Mistral script tests. The content harness
 * lets a test deliver signed page messages and runtime messages and see what
 * the script forwards to the background; the inject harness lets a test call
 * the hooked `fetch` / `XMLHttpRequest` and see what gets posted to the
 * content script.
 *
 * Only synthetic data may be fed through this harness.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

export const ORIGIN = 'https://chat.example.test';
export const TEST_SECRET = 'ab'.repeat(32);

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A promise plus its resolve/reject, for fetches a test completes by hand. */
export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Minimal same-origin JSON response. */
export function jsonResponse(body, { ok = true, url = '', type = 'basic', contentType = 'application/json' } = {}) {
  const res = {
    ok,
    status: ok ? 200 : 500,
    type,
    url,
    headers: { get: name => (name.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => JSON.parse(JSON.stringify(body)),
    text: async () => JSON.stringify(body),
    clone: () => res
  };
  return res;
}

/**
 * Load platforms/<platform>/content.js.
 *   pathname   page path (decides whether the script fetches on load)
 *   fetchImpl  (url, init) => Promise<response>
 *   secret     value of the secret attribute; null = inject.js never wrote it
 */
export function loadContent(platform, { pathname = '/', fetchImpl, secret = TEST_SECRET, localStorage = {} } = {}) {
  const listeners = { message: [], runtime: [] };
  const sent = [];
  const fetchCalls = [];
  const win = {
    location: { pathname, origin: ORIGIN, href: ORIGIN + pathname },
    addEventListener: (type, cb) => { (listeners[type] ||= []).push(cb); },
    localStorage: { getItem: k => (k in localStorage ? localStorage[k] : null) }
  };
  let attr = secret;
  const ctx = {
    window: win,
    document: {
      documentElement: { getAttribute: () => attr, removeAttribute: () => { attr = null; } },
      readyState: 'complete',
      addEventListener() {}
    },
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval: () => 0,
    setTimeout,
    clearTimeout,
    AbortController,
    console,
    TextEncoder,
    crypto: crypto.webcrypto,
    encodeURIComponent,
    fetch: (url, init) => {
      fetchCalls.push(String(url));
      return fetchImpl ? fetchImpl(String(url), init) : Promise.reject(new Error('no network in tests'));
    },
    browser: {
      runtime: {
        id: 'ext-id',
        sendMessage: async m => { sent.push(m); },
        onMessage: { addListener: cb => listeners.runtime.push(cb) }
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, 'platforms', platform, 'content.js'), 'utf8'), ctx);

  /** Deliver a page message signed the way inject.js signs it. */
  async function postSigned(type, source, payload, { key = secret } = {}) {
    const data = {
      type,
      payload,
      source,
      platform,
      timestamp: Date.now(),
      nonce: crypto.randomBytes(16).toString('hex')
    };
    const signature = crypto.createHmac('sha256', String(key)).update(JSON.stringify(data)).digest('hex');
    for (const cb of listeners.message) {
      await cb({ source: win, origin: ORIGIN, data: { ...data, signature } });
    }
  }

  /** Deliver a runtime message from the extension; resolves with the response. */
  function runtimeMessage(message) {
    return new Promise(resolve => {
      for (const cb of listeners.runtime) cb(message, { id: 'ext-id' }, resolve);
    });
  }

  /** Messages of the given type that the script sent to the background. */
  const sentOfType = type => sent.filter(m => m.type === type);

  return { sent, sentOfType, fetchCalls, postSigned, runtimeMessage, win };
}

/**
 * Load shared/message-security.js and platforms/<platform>/inject.js.
 *   nativeFetch  (input, init) => Promise<response>; stands in for the
 *                browser's own fetch that the script wraps
 */
export function loadInject(platform, { nativeFetch } = {}) {
  const posted = [];
  class FakeXHR {
    constructor() { this.listeners = {}; this.status = 0; this.responseURL = ''; this.responseText = ''; }
    open() {}
    send() {}
    addEventListener(type, cb) { this.listeners[type] = cb; }
  }
  const win = {
    location: { origin: ORIGIN, href: ORIGIN + '/', pathname: '/' },
    postMessage: m => posted.push(m),
    crypto: crypto.webcrypto,
    // message-security.js reads these off its global at load.
    TextEncoder,
    Uint8Array,
    Uint32Array,
    fetch: (...args) => nativeFetch(...args)
  };
  const ctx = {
    window: win,
    self: win,
    module: undefined,
    document: { documentElement: { setAttribute() {} } },
    XMLHttpRequest: FakeXHR,
    Request,
    URL,
    crypto: crypto.webcrypto,
    console,
    TextEncoder,
    setTimeout
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, 'shared', 'message-security.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, 'platforms', platform, 'inject.js'), 'utf8'), ctx);

  /** Run an XHR through the hooked open/send and fire its load event. */
  async function runXhr({ method = 'GET', url, responseURL, body, status = 200 }) {
    const xhr = new FakeXHR();
    xhr.open(method, url);
    xhr.send();
    xhr.status = status;
    xhr.responseURL = responseURL === undefined ? new URL(url, ORIGIN + '/').href : responseURL;
    xhr.responseText = JSON.stringify(body);
    if (xhr.listeners.load) xhr.listeners.load();
    await sleep(20);
  }

  return { win, posted, FakeXHR, runXhr };
}
