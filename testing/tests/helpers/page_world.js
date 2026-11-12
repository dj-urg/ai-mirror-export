/**
 * Fake page for running one platform's inject.js and content.js together in
 * Node (vm), the way they run in a tab: inject hooks fetch / WebSocket, signs
 * what it captures, posts it to the window, content verifies it and answers
 * the popup's runtime messages.
 *
 * Nothing here touches the network. fetch is whatever the test sets as
 * `world.sb.fetchImpl`; WebSocket is a stub whose frames the test dispatches.
 * Time is virtual: `advance(ms)` runs the timers that fall due.
 */

import vm from 'node:vm';
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ORIGIN = 'https://example.test';
const EXTENSION_ID = 'test-extension';

/** A fetch Response stand-in carrying JSON. */
export function jsonResponse(body, { url = '', status = 200, contentType = 'application/json' } = {}) {
  const text = JSON.stringify(body);
  const make = () => ({
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: name => (name.toLowerCase() === 'content-type' ? contentType : null) },
    clone: make,
    json: async () => JSON.parse(text)
  });
  return make();
}

/**
 * @param {string} platformDir - directory under platforms/
 * @param {object} [options]
 * @param {boolean} [options.skipInject] - load content.js only (no secret is ever written)
 * @param {string} [options.pageSecret] - attribute value a page script planted before content.js ran
 */
export function makeWorld(platformDir, { skipInject = false, pageSecret = null } = {}) {
  const windowListeners = {};
  const attrs = new Map();
  const runtimeListeners = [];
  const sentToBackground = [];
  const sockets = [];
  const timers = [];
  let now = 1_800_000_000_000;
  let timerId = 1;

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.listeners = {};
      sockets.push(this);
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    send(data) { this.sent.push(data); }
    /** Deliver a frame as the browser would (isTrusted) unless told otherwise. */
    receive(data, { isTrusted = true } = {}) {
      for (const fn of this.listeners.message || []) fn({ type: 'message', data, isTrusted });
    }
    close() {
      for (const fn of this.listeners.close || []) fn({ type: 'close', isTrusted: true });
    }
  }

  const sb = {
    console,
    crypto: webcrypto,
    TextEncoder,
    URL,
    structuredClone,
    __now: () => now,
    setTimeout: (fn, ms = 0) => { const id = timerId++; timers.push({ id, at: now + ms, fn }); return id; },
    clearTimeout: id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    setInterval: () => 0,
    location: { origin: ORIGIN, href: `${ORIGIN}/chat` },
    addEventListener: (type, fn) => { (windowListeners[type] ||= []).push(fn); },
    postMessage: data => {
      const clone = structuredClone(data);
      queueMicrotask(() => {
        for (const fn of windowListeners.message || []) fn({ source: sb.__self, origin: ORIGIN, data: clone });
      });
    },
    document: {
      documentElement: {
        setAttribute: (k, v) => attrs.set(k, String(v)),
        getAttribute: k => (attrs.has(k) ? attrs.get(k) : null),
        removeAttribute: k => attrs.delete(k)
      }
    },
    MutationObserver: class { observe() {} disconnect() {} },
    Request: class Request { constructor(url) { this.url = String(url); } },
    XMLHttpRequest: class { open() {} send() {} },
    WebSocket: FakeWebSocket,
    fetchImpl: null,
    browser: {
      runtime: {
        id: EXTENSION_ID,
        sendMessage: async message => { sentToBackground.push(structuredClone(message)); },
        onMessage: { addListener: fn => runtimeListeners.push(fn) }
      }
    }
  };
  sb.fetch = (...args) => sb.fetchImpl(...args);
  sb.window = sb;
  vm.createContext(sb);
  sb.__self = vm.runInContext('globalThis', sb);
  // Virtual clock for `new Date()` and `Date.now()` inside the page.
  vm.runInContext(`
    globalThis.Date = class extends Date {
      constructor(...a) { if (a.length === 0) super(__now()); else super(...a); }
      static now() { return __now(); }
    };
  `, sb);

  const run = file => vm.runInContext(fs.readFileSync(join(REPO, file), 'utf8'), sb, { filename: file });
  run('shared/message-security.js');
  if (!skipInject) run(`platforms/${platformDir}/inject.js`);
  if (pageSecret !== null) {
    for (const key of [...attrs.keys()]) attrs.delete(key);
    attrs.set(`data-${platformDir.replace('_', '-')}-exporter-secret`, pageSecret);
  }
  run(`platforms/${platformDir}/content.js`);

  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); };

  return {
    sb,
    origin: ORIGIN,
    sockets,
    sentToBackground,
    settle,
    /** Evaluate another file in the same page (e.g. inject.js a second time). */
    run,
    /** Messages forwarded to background for export (not status pings). */
    exports: () => sentToBackground.filter(m => m.type !== 'CONVERSATION_READY'),
    /** Move the virtual clock forward, running timers that fall due. */
    advance: async ms => {
      const target = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        if (!timers.length || timers[0].at > target) break;
        const t = timers.shift();
        now = t.at;
        t.fn();
        await settle();
      }
      now = target;
      await settle();
    },
    /** Send a runtime message the way the popup does; resolves with the response. */
    ask: async message => {
      let response;
      for (const fn of runtimeListeners) fn(message, { id: EXTENSION_ID }, value => { response = structuredClone(value); });
      await settle();
      return response;
    },
    /** Post a window message as a page script would. */
    postFromPage: async data => {
      sb.postMessage(data);
      await settle();
    }
  };
}
