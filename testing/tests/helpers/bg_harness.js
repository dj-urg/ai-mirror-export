/**
 * Node harness that drives the real `background.js` end to end.
 *
 * It installs a minimal mock of the WebExtension `browser.*` API, imports
 * background.js once (ES modules are cached per process), and then lets a
 * test deliver a `<PLATFORM>_CONVERSATION_DATA` message exactly as a content
 * script would. The ZIP that background hands to `browser.downloads.download`
 * is captured and unpacked so tests can compare every entry byte for byte.
 *
 * Determinism: while a scenario runs, `Date` is replaced by a frozen clock and
 * the donor id comes from the mocked storage, so two runs of the same fixture
 * produce identical bytes. The clock is restored after every run.
 *
 * Only synthetic fixtures may be fed through this harness.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveObjectURL } from 'node:buffer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
export const SYNTHETIC_DIR = path.join(REPO_ROOT, 'testing', 'data', 'synthetic');

export const FROZEN_TIME_MS = Date.parse('2026-04-13T12:00:00.000Z');
export const FROZEN_ISO = '2026-04-13T12:00:00.000Z';

const DEFAULT_SETTINGS = Object.freeze({
  consent_given: true,
  consent_version: '1',
  pii_scrub_enabled: false,
  include_donor_context: true,
  study_salt: '',
  donor_id: '00000000-0000-4000-8000-00000000d0e0',
  donor_id_created: '2026-01-01T00:00:00.000Z'
});

// --- singleton state shared by every scenario in this process -------------
const listeners = [];
let currentSettings = { ...DEFAULT_SETTINGS };
let currentSender = null;
let pending = null; // { resolve, reject, downloads: [], broadcasts: [] }
let imported = false;
let listenerCalls = 0;

const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(FROZEN_TIME_MS);
    else super(...args);
  }
  static now() { return FROZEN_TIME_MS; }
}

function storageGet(keys) {
  const src = currentSettings;
  const out = {};
  let list;
  if (keys == null) list = Object.keys(src);
  else if (typeof keys === 'string') list = [keys];
  else if (Array.isArray(keys)) list = keys;
  else list = Object.keys(keys);
  for (const k of list) if (k in src) out[k] = src[k];
  return Promise.resolve(out);
}

function installBrowserMock() {
  const storageArea = {
    get: storageGet,
    set: async (obj) => { Object.assign(currentSettings, obj || {}); },
    remove: async () => {},
    clear: async () => {}
  };
  const noopEvent = { addListener: () => {}, removeListener: () => {}, hasListener: () => false };
  globalThis.browser = {
    runtime: {
      id: 'ai-chat-exporter@harness',
      getURL: (p) => p,
      onMessage: { addListener: (fn) => { listeners.push(fn); }, removeListener: () => {}, hasListener: () => false },
      sendMessage: async (msg) => {
        if (pending && msg && msg.type === 'EXPORT_RESULT') {
          pending.broadcasts.push(msg.detail);
          // A non-success outcome ends the scenario; success arrives after
          // the download has already been captured.
          pending.settle();
        }
      }
    },
    storage: { local: storageArea, session: storageArea, onChanged: noopEvent },
    tabs: {
      query: async () => [],
      get: async (id) => ({ id, url: currentSender ? currentSender.tab.url : '' }),
      sendMessage: async () => ({}),
      onUpdated: noopEvent,
      onActivated: noopEvent,
      onRemoved: noopEvent
    },
    downloads: {
      download: async ({ url, filename }) => {
        const blob = resolveObjectURL(url);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (pending) pending.downloads.push({ filename, bytes });
        return 1;
      },
      show: async () => {}
    },
    scripting: {
      registerContentScripts: async () => {},
      unregisterContentScripts: async () => {},
      getRegisteredContentScripts: async () => [],
      executeScript: async () => []
    },
    action: {
      setIcon: async () => {},
      setTitle: async () => {},
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {}
    }
  };
  if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
  if (typeof globalThis.addEventListener !== 'function') globalThis.addEventListener = () => {};
}

async function withSilencedConsole(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  console.log = console.warn = console.error = console.info = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
}

/**
 * Import background.js once with the mock installed. Safe to call repeatedly.
 */
export async function loadBackground() {
  if (imported) return;
  installBrowserMock();
  await withSilencedConsole(() => import(pathToFileURL(path.join(REPO_ROOT, 'background.js')).href));
  if (listeners.length === 0) throw new Error('[bg_harness] background.js registered no onMessage listener');
  imported = true;
}

/**
 * Deliver one conversation payload to background.js and capture the result.
 *
 * @param {object} opts
 * @param {string} opts.messageType   e.g. 'CLAUDE_CONVERSATION_DATA'
 * @param {object} opts.payload       the synthetic conversation payload
 * @param {string} opts.senderUrl     tab URL of the (mocked) content script
 * @param {object} [opts.settings]    overrides for browser.storage.local
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{filename: string|null, entries: Map<string, Uint8Array>, broadcasts: object[]}>}
 */
export async function runExport({ messageType, payload, senderUrl, settings = {}, timeoutMs = 8000 }) {
  await loadBackground();
  if (pending) throw new Error('[bg_harness] runExport is not re-entrant');

  currentSettings = { ...DEFAULT_SETTINGS, ...settings };
  currentSender = { tab: { id: 1, url: senderUrl }, frameId: 0, id: 'ai-chat-exporter@harness' };

  const result = { downloads: [], broadcasts: [] };
  let settled = false;
  let timer;
  const done = new Promise((resolve, reject) => {
    result.settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Give background's own `.then` a microtask or two to finish.
      setTimeout(resolve, 10);
    };
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`[bg_harness] no EXPORT_RESULT within ${timeoutMs} ms for ${messageType}`));
    }, timeoutMs);
  });
  pending = result;

  globalThis.Date = FrozenDate;
  try {
    listenerCalls++;
    const ret = await withSilencedConsole(async () => {
      // Deep-clone so background cannot mutate the caller's fixture.
      const cloned = JSON.parse(JSON.stringify(payload));
      return listeners[0]({ type: messageType, payload: cloned }, currentSender, () => {});
    });
    if (ret === true) throw new Error('[bg_harness] listener unexpectedly returned true');
    await done;
  } finally {
    globalThis.Date = RealDate;
    pending = null;
  }

  const download = result.downloads[0] || null;
  return {
    filename: download ? download.filename : null,
    entries: download ? readZip(download.bytes) : new Map(),
    broadcasts: result.broadcasts,
    listenerCalls
  };
}

/**
 * Minimal reader for the STORE-only ZIPs that utils/zip.js writes.
 * @param {Uint8Array} bytes
 * @returns {Map<string, Uint8Array>} entry name → raw bytes
 */
export function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = new Map();
  let pos = 0;
  const decoder = new TextDecoder();
  while (pos + 30 <= bytes.length && view.getUint32(pos, true) === 0x04034b50) {
    const method = view.getUint16(pos + 8, true);
    const compressedSize = view.getUint32(pos + 18, true);
    const nameLen = view.getUint16(pos + 26, true);
    const extraLen = view.getUint16(pos + 28, true);
    const name = decoder.decode(bytes.subarray(pos + 30, pos + 30 + nameLen));
    if (method !== 0) throw new Error(`[bg_harness] unexpected compression method ${method} for ${name}`);
    const start = pos + 30 + nameLen + extraLen;
    entries.set(name, bytes.subarray(start, start + compressedSize));
    pos = start + compressedSize;
  }
  if (entries.size === 0) throw new Error('[bg_harness] no local file headers found in ZIP');
  return entries;
}

export function utf8(bytes) {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
}

export function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(SYNTHETIC_DIR, name), 'utf8'));
}

/**
 * The platform scenarios every end-to-end test iterates over. Keep this the
 * single source of truth: the golden test and the PII sweep both use it.
 */
export const PLATFORM_SCENARIOS = Object.freeze([
  { id: 'chatgpt', platform: 'chatgpt', messageType: 'CHATGPT_CONVERSATION_DATA',
    fixture: 'chatgpt_golden_v1.json', senderUrl: 'https://chatgpt.com/c/00000000-0000-4000-8000-0000000000c1' },
  { id: 'chatgpt_meta', platform: 'chatgpt', messageType: 'CHATGPT_CONVERSATION_DATA',
    fixture: 'chatgpt_meta_golden_v1.json', senderUrl: 'https://chatgpt.com/c/00000000-0000-4000-8000-0000000000c2' },
  { id: 'claude', platform: 'claude', messageType: 'CLAUDE_CONVERSATION_DATA',
    fixture: 'claude_golden_v1.json', senderUrl: 'https://claude.ai/chat/11111111-2222-3333-4444-555555555555' },
  { id: 'copilot', platform: 'copilot', messageType: 'COPILOT_CONVERSATION_DATA',
    fixture: 'copilot_golden_v1.json', senderUrl: 'https://copilot.microsoft.com/chats/cop-synthetic-0001' },
  { id: 'm365_copilot', platform: 'm365_copilot', messageType: 'M365_COPILOT_CONVERSATION_DATA',
    fixture: 'm365_copilot_golden_v1.json', senderUrl: 'https://m365.cloud.microsoft/chat/' },
  { id: 'perplexity', platform: 'perplexity', messageType: 'PERPLEXITY_CONVERSATION_DATA',
    fixture: 'perplexity_golden_v1.json', senderUrl: 'https://www.perplexity.ai/search/aaaaaaaa-bbbb-cccc-dddd-000000000001' },
  { id: 'grok', platform: 'grok', messageType: 'GROK_CONVERSATION_DATA',
    fixture: 'grok_golden_v1.json', senderUrl: 'https://grok.com/c/grok-golden-0001' },
  { id: 'deepseek', platform: 'deepseek', messageType: 'DEEPSEEK_CONVERSATION_DATA',
    fixture: 'deepseek_golden_v1.json', senderUrl: 'https://chat.deepseek.com/a/chat/s/deepseek-golden-0001' },
  { id: 'mistral', platform: 'mistral', messageType: 'MISTRAL_CONVERSATION_DATA',
    fixture: 'mistral_golden_v1.json', senderUrl: 'https://chat.mistral.ai/chat/mistral-golden-0001' },
  { id: 'google_overview', platform: 'google_search', messageType: 'GOOGLE_SEARCH_AI_OVERVIEW_DATA',
    fixture: 'google_overview_golden_v1.json', senderUrl: 'https://www.google.com/search?q=how+do+tides+work' },
  { id: 'google_ai_mode', platform: 'google_search', messageType: 'GOOGLE_SEARCH_AI_OVERVIEW_DATA',
    fixture: 'google_ai_mode_golden_v1.json', senderUrl: 'https://www.google.com/search?q=explain+plate+tectonics&udm=50' }
]);
