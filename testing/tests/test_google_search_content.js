/**
 * Behaviour test for the Google Search (AI Overview / AI Mode) content script.
 *
 * Runs platforms/google_search/content.js in a vm sandbox against a small
 * hand-built fake DOM (synthetic pages, no captured data) and checks that
 * the capture is read from the page without any request, that an export
 * reflects the page as it is at export time, the block-aware text
 * extraction and its cleaning, the export-only re-fetch, and the `capture`
 * provenance sent next to the payload.
 *
 * The fake DOM has no layout, so the script's computed-style block
 * detection is not exercised here, and the MutationObserver is a stub that
 * the test fires by hand (see docs/manual-tests.md for the real-browser
 * checks).
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'platforms', 'google_search', 'content.js'), 'utf8');

let passed = 0;
let failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { passed++; } else { failed++; console.error('FAIL:', name, detail); }
}

// --- Minimal fake DOM -------------------------------------------------------

class FakeText {
  constructor(value) { this.nodeType = 3; this.nodeValue = value; this.parentElement = null; }
  get textContent() { return this.nodeValue; }
}

class FakeElement {
  constructor(tag, attrs = {}, children = []) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.id = attrs.id || '';
    this.parentElement = null;
    this.childNodes = [];
    for (const child of children) this.append(child);
  }
  append(child) {
    const node = typeof child === 'string' ? new FakeText(child) : child;
    node.parentElement = this;
    this.childNodes.push(node);
    return node;
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  * descendants() {
    for (const child of this.childNodes) {
      if (child.nodeType !== 1) continue;
      yield child;
      yield* child.descendants();
    }
  }
  querySelectorAll(selector) {
    const tests = selector.split(',').map((s) => compileSelector(s.trim()));
    return [...this.descendants()].filter((el) => tests.some((test) => test(el)));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

/** `tag`, `[attr]`, `[attr="v"]`, `[attr*="v" i]` and `tag[attr…]` only. */
function compileSelector(selector) {
  const match = selector.match(/^([a-z0-9]*)((?:\[[^\]]+\])*)$/i);
  if (!match) throw new Error(`fake DOM: unsupported selector ${selector}`);
  const tag = match[1].toUpperCase();
  const conditions = [...match[2].matchAll(/\[([a-z-]+)(?:(\*?=)"([^"]*)"(\s+i)?)?\]/gi)]
    .map(([, name, op, value, insensitive]) => (el) => {
      const actual = el.getAttribute(name);
      if (actual === null) return false;
      if (!op) return true;
      const a = insensitive ? actual.toLowerCase() : actual;
      const v = insensitive ? value.toLowerCase() : value;
      return op === '*=' ? a.includes(v) : a === v;
    });
  return (el) => (!tag || el.tagName === tag) && conditions.every((c) => c(el));
}

const h = (tag, attrs, ...children) => new FakeElement(tag, attrs || {}, children);

// --- Sandbox ----------------------------------------------------------------

/**
 * Load content.js on a fake search page. `page.body` can be swapped or
 * mutated afterwards to simulate Google rendering more of the answer;
 * `page.serverBody` is what a re-fetch of the page would return.
 */
function load({ href, body, serverBody = null, fetchStatus = 200 }) {
  const listeners = [];
  const sent = [];
  const calls = { fetch: 0 };
  let clock = 0;
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length) super(...args); else super(RealDate.now() + clock);
    }
    static now() { return RealDate.now() + clock; }
  }

  const page = { body, serverBody, fetchStatus };
  const timers = new Map();
  let timerId = 0;
  const observers = [];
  const makeDocument = (getBody) => ({
    readyState: 'complete',
    get body() { return getBody(); },
    get documentElement() { return getBody(); },
    addEventListener() {},
    querySelectorAll: (sel) => getBody().querySelectorAll(sel),
    querySelector: (sel) => getBody().querySelector(sel)
  });

  const sandbox = {
    window: { location: { href } },
    document: makeDocument(() => page.body),
    URL, URLSearchParams, console,
    Date: FakeDate,
    // Timers do not run on their own (the AI Mode retries and the cleanup
    // interval would only keep the process alive); `rendered()` runs the
    // MutationObserver's debounce timer by hand.
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: () => 0,
    MutationObserver: class {
      constructor(callback) { observers.push(callback); }
      observe() {}
    },
    fetch: async () => {
      calls.fetch++;
      if (page.fetchStatus === 'network-error') throw new Error('offline');
      return { ok: page.fetchStatus === 200, status: page.fetchStatus, text: async () => '<html></html>' };
    },
    DOMParser: class {
      parseFromString() { return makeDocument(() => page.serverBody || h('body', null)); }
    },
    browser: {
      runtime: {
        id: 'ext',
        sendMessage: async (m) => { sent.push(m); },
        onMessage: { addListener: (fn) => listeners.push(fn) }
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);

  const send = (message, sender = { id: 'ext' }) => new Promise((resolve) => {
    if (listeners[0](message, sender, resolve) !== true) resolve(undefined);
  });
  const poll = () => send({ type: 'GET_CAPTURED_CONVERSATIONS' });
  const exportNow = async (conversationId) => {
    sent.length = 0;
    const response = await send({ type: 'EXPORT_CONVERSATION', platform: 'google_search', conversationId });
    const data = sent.find((m) => m.type === 'GOOGLE_SEARCH_AI_OVERVIEW_DATA');
    return { response, payload: data ? data.payload : null, capture: data ? data.capture : null };
  };
  /** Google rendered `newBody`: fire the observer and its 800 ms debounce. */
  const rendered = (newBody) => {
    page.body = newBody;
    observers.forEach((callback) => callback([]));
    for (const [id, timer] of [...timers]) {
      if (timer.delay !== 800) continue;
      timers.delete(id);
      timer.fn();
    }
  };
  return { page, sandbox, send, sent, calls, poll, exportNow, rendered, tick: (ms) => { clock += ms; } };
}

const SEARCH_URL = 'https://www.google.com/search?q=csv+format&sca_esv=abc123&sxsrf=TOKEN&ei=xyz&ved=0ahUKE&sclient=gws-wiz#fpstate=1';
const AI_MODE_URL = 'https://www.google.com/search?q=csv+format&udm=50&sei=SESSION&ved=0ahUKE';

const P1 = 'CSV stands for comma-separated values, a plain-text format for tables.';
const P2 = 'Each line is one record and commas separate the fields.';

/** A search page whose overview sits in the structural summary container. */
function overviewPage(paragraphs, { extras = [], sources = true } = {}) {
  return h('body', null,
    h('nav', null, 'All Images Videos'),
    h('div', { id: 'search' },
      h('div', null,
        h('div', { 'data-attrid': 'SrpGenSumSummary' },
          h('h2', null, 'AI Overview'),
          ...paragraphs.map((p) => (typeof p === 'string' ? h('p', null, p) : p)),
          ...extras),
        // Source chips are siblings of the summary, not inside it.
        ...(sources ? [h('div', null,
          h('a', { href: 'https://www.rfc-editor.org/rfc/rfc4180' }, 'RFC 4180'),
          h('a', { href: '/url?q=https://example.org/csv&sa=U' }, 'CSV guide'),
          h('a', { href: 'https://support.google.com/websearch' }, 'Learn more'),
          h('a', { href: '#top' }, 'Top'))] : []))));
}

// --- 1. Passive capture from the DOM, no request ----------------------------
{
  const sim = load({ href: SEARCH_URL, body: overviewPage([P1, P2]) });
  assert('page load makes no request', sim.calls.fetch === 0, String(sim.calls.fetch));
  const ready = sim.sent.find((m) => m.type === 'CONVERSATION_READY');
  assert('CONVERSATION_READY sent for the overview', !!ready && ready.mode === 'ai_overview' && ready.conversationId === 'csv format::ai_overview', JSON.stringify(ready));

  const status = await sim.poll();
  assert('popup poll lists the capture', status.conversationIds.length === 1 && status.conversationIds[0] === 'csv format::ai_overview');
  assert('overview title names the query', status.conversations[0].title === 'AI Overview — csv format', status.conversations[0].title);
  assert('poll reports an overview for this page', status.noOverviewForThisPage === false);

  sim.tick(5000);
  const { response, payload, capture } = await sim.exportNow('csv format::ai_overview');
  assert('export succeeds', response && response.success === true);
  assert('blocks are joined with newlines, label heading dropped', payload.ai_overview_text === `${P1}\n${P2}`, JSON.stringify(payload.ai_overview_text));
  assert('query carried', payload.query === 'csv format');
  assert('tracking parameters stripped from source_page_url', payload.source_page_url === 'https://www.google.com/search?q=csv+format', payload.source_page_url);
  assert('external sources kept, Google links dropped',
    payload.sources.map((s) => s.url).join('|') === 'https://www.rfc-editor.org/rfc/rfc4180|https://example.org/csv',
    JSON.stringify(payload.sources));
  assert('structural selector recorded in telemetry', payload.extraction_telemetry.selector_index === 0 && payload.extraction_telemetry.used_heading_fallback === false);
  assert('capture marks a confirmed DOM read',
    capture.source === 'dom' && capture.refresh === 'ok' && capture.complete === true && capture.flags.length === 0,
    JSON.stringify(capture));
  assert('capture time is the payload capture time', capture.captured_at === payload.captured_at && !Number.isNaN(Date.parse(capture.captured_at)));
  assert('whole flow made no request', sim.calls.fetch === 0);
}

// --- 2. Export reflects an overview that kept streaming after load ----------
{
  const sim = load({ href: SEARCH_URL, body: overviewPage([P1]) });
  const first = await sim.exportNow();
  assert('first render exported as it is', first.payload.ai_overview_text === P1);
  assert('a capture that just changed is flagged in_flight', first.capture.flags.includes('in_flight') && first.capture.complete === false, JSON.stringify(first.capture));

  // More of the answer renders, and the observer has not fired yet.
  sim.page.body = overviewPage([P1, P2]);
  const grown = await sim.exportNow();
  assert('export re-reads the page and gets the longer answer', grown.payload.ai_overview_text === `${P1}\n${P2}`, grown.payload.ai_overview_text);
  assert('a change first seen at export is flagged in_flight', grown.capture.flags.includes('in_flight'));

  // Collapsed again (or a partial re-render): the longest version is kept.
  sim.rendered(overviewPage([P1]));
  sim.tick(5000);
  const collapsed = await sim.exportNow();
  assert('a shorter re-read does not replace the full answer', collapsed.payload.ai_overview_text === `${P1}\n${P2}`, collapsed.payload.ai_overview_text);
  assert('settled capture is complete', collapsed.capture.complete === true && !collapsed.capture.flags.includes('in_flight'), JSON.stringify(collapsed.capture));

  // The overview disappears from the DOM: the earlier capture is exported,
  // marked as not confirmed at export time.
  sim.page.body = h('body', null, h('div', { id: 'search' }, 'Ten blue links'));
  const gone = await sim.exportNow();
  assert('earlier capture exported when the re-read finds nothing', gone.payload.ai_overview_text === `${P1}\n${P2}`);
  assert('failed re-read is marked', gone.capture.refresh === 'failed' && gone.capture.flags.includes('refresh_failed') && gone.capture.complete === null, JSON.stringify(gone.capture));
  assert('a stored DOM capture never triggers a re-fetch', sim.calls.fetch === 0, String(sim.calls.fetch));
}

// --- 3. Block-aware extraction and cleaning ---------------------------------
{
  const tail = 'Dial the country code +31';
  const body = overviewPage([
    h('div', null, 'Start with the basics.', h('span', { 'aria-hidden': 'true' }, 'HIDDEN-ARIA')),
    h('ul', null, h('li', null, 'First point'), h('li', null, 'Second ', h('b', null, 'bold'), ' point')),
    h('p', null, 'Line one', h('br', null), 'line two'),
    h('p', null, 'Send feedback to your team after each release, then reload results weekly.'),
    h('div', { hidden: '' }, 'HIDDEN-ATTR'),
    h('div', { style: 'color: red; display: none' }, 'HIDDEN-STYLE'),
    h('style', null, '.x{color:red}'),
    h('script', null, 'var leaked = 1;'),
    h('p', null, tail)
  ], {
    extras: [
      h('div', null, h('span', null, '+3')),
      h('div', null, 'Shared 2 files'),
      h('div', { role: 'button' }, 'Send feedback'),
      h('div', null, 'Reload results')
    ]
  });
  const sim = load({ href: SEARCH_URL, body });
  sim.tick(5000);
  const { payload, capture } = await sim.exportNow();
  const expected = [
    'Start with the basics.',
    'First point',
    'Second bold point',
    'Line one',
    'line two',
    'Send feedback to your team after each release, then reload results weekly.',
    tail
  ].join('\n');
  assert('text is extracted block by block', payload.ai_overview_text === expected, JSON.stringify(payload.ai_overview_text));
  assert('hidden, style and script nodes are skipped', !/HIDDEN|leaked|color:red/.test(payload.ai_overview_text));
  assert('a sentence mentioning UI words is not truncated', payload.ai_overview_text.includes('then reload results weekly.'));
  assert('answer text ending in +<digits> is kept', payload.ai_overview_text.endsWith(tail));
  assert('skipped hidden text is flagged', capture.flags.includes('hidden_text_skipped'), JSON.stringify(capture.flags));
}

// --- 4. No overview in the DOM: no request until the user exports -----------
{
  const sim = load({
    href: SEARCH_URL,
    body: h('body', null, h('div', { id: 'search' }, 'Ten blue links')),
    serverBody: overviewPage([P1, P2])
  });
  const status = await sim.poll();
  await sim.poll();
  assert('load and popup polls make no request', sim.calls.fetch === 0, String(sim.calls.fetch));
  assert('poll reports no overview', status.noOverviewForThisPage === true && status.conversationIds.length === 0);

  const refetched = await sim.exportNow();
  assert('export re-fetches once', sim.calls.fetch === 1, String(sim.calls.fetch));
  assert('re-fetched overview exported', !!refetched.payload && refetched.payload.ai_overview_text === `${P1}\n${P2}`);
  assert('re-fetched capture is marked as such',
    refetched.capture.source === 'refetch' && refetched.capture.flags.includes('refetched_variant') && refetched.capture.complete === null,
    JSON.stringify(refetched.capture));

  await sim.exportNow();
  assert('a second export does not re-fetch again', sim.calls.fetch === 1, String(sim.calls.fetch));

  // The overview now renders in the page: the DOM version wins.
  const shown = 'What the user actually saw on screen, which differs from the server variant.';
  sim.rendered(overviewPage([shown]));
  sim.tick(5000);
  const fromDom = await sim.exportNow();
  assert('a DOM capture replaces the re-fetched variant', fromDom.payload.ai_overview_text === shown && fromDom.capture.source === 'dom', JSON.stringify(fromDom.capture));
  assert('still only one request', sim.calls.fetch === 1);
}

// --- 5. Re-fetch failures ---------------------------------------------------
{
  const sim = load({
    href: SEARCH_URL,
    body: h('body', null, h('div', { id: 'search' }, 'Ten blue links')),
    fetchStatus: 'network-error'
  });
  const failed1 = await sim.exportNow();
  assert('failed re-fetch reports an export error', failed1.payload === null && failed1.response.success === false);
  await sim.exportNow();
  assert('a failed request may be retried by the next export', sim.calls.fetch === 2, String(sim.calls.fetch));

  // The request works but the server HTML has no overview: do not ask again.
  sim.page.fetchStatus = 200;
  const none = await sim.exportNow();
  await sim.exportNow();
  assert('no overview on the server either: error, and no further requests', none.response.success === false && sim.calls.fetch === 3, String(sim.calls.fetch));
}

// --- 6. Heading heuristic is flagged ----------------------------------------
{
  const body = h('body', null,
    h('div', { id: 'search' },
      h('div', null,
        h('div', null, h('span', null, 'AI Overview')),
        h('p', null, P1), h('p', null, P2),
        h('p', null, 'CSV files can be opened in any spreadsheet program or text editor without conversion.'))));
  const sim = load({ href: SEARCH_URL, body });
  sim.tick(5000);
  const { payload, capture } = await sim.exportNow();
  assert('heading fallback finds the overview', !!payload && payload.ai_overview_text.startsWith(P1), payload && payload.ai_overview_text);
  assert('inline label is not part of the text', !payload.ai_overview_text.includes('AI Overview'));
  assert('heuristic root is flagged and completeness unknown',
    capture.flags.includes('heuristic_root') && capture.complete === null && payload.extraction_telemetry.used_heading_fallback === true,
    JSON.stringify(capture));
}

// --- 7. AI Mode -------------------------------------------------------------
{
  const A1 = 'CSV is a plain-text table format.';
  const A2 = 'Quote any field that contains a comma.';
  const aiModePage = (turns) => h('body', null,
    h('nav', null, 'AI Mode All Images'),
    h('div', { id: 'main' },
      h('h2', null, 'Share public link'),
      ...turns,
      h('footer', null, 'Privacy Terms'),
      h('textarea', null, 'Ask anything')));
  const turn1 = [
    h('div', null, h('h2', null, 'You said: what is csv')),
    h('div', null,
      h('h2', null, 'AI Mode reply for what is csv'),
      h('p', null, A1),
      h('p', null, 'It is widely supported. ', h('a', { href: 'https://www.rfc-editor.org/rfc/rfc4180' }, 'RFC 4180')),
      h('div', null, 'Send feedback'))
  ];
  const sim = load({ href: AI_MODE_URL, body: aiModePage(turn1) });
  assert('AI Mode load makes no request', sim.calls.fetch === 0);
  const ready = sim.sent.find((m) => m.type === 'CONVERSATION_READY');
  assert('CONVERSATION_READY is sent for AI Mode', !!ready && ready.mode === 'ai_mode' && ready.turnCount === 2 && ready.conversationId === 'csv format::ai_mode', JSON.stringify(ready));

  const status = await sim.poll();
  assert('AI Mode title is not "undefined"', status.conversations[0].title === 'AI Mode — what is csv', status.conversations[0].title);

  // A follow-up is asked; its answer has not rendered yet.
  sim.rendered(aiModePage([...turn1, h('div', null, h('h2', null, 'You said: and quoting?'))]));
  sim.tick(5000);
  const pending = await sim.exportNow();
  assert('unanswered last turn is flagged in_flight', pending.capture.flags.includes('in_flight') && pending.capture.complete === false, JSON.stringify(pending.capture));
  assert('unanswered prompt is exported', pending.payload.turns.map((t) => t.role).join(',') === 'user,assistant,user');

  sim.rendered(aiModePage([...turn1,
    h('div', null, h('h2', null, 'You said: and quoting?')),
    h('div', null, h('h2', null, 'AI Mode reply for and quoting?'),
      h('p', null, A2, h('a', { href: 'https://example.org/quoting' }, h('span', { 'aria-hidden': 'true' }, 'icon'))))]));
  sim.tick(5000);
  const { payload, capture } = await sim.exportNow();
  assert('export has the turns present at export time',
    payload.turns.map((t) => `${t.role}:${t.text}`).join('|')
      === `user:what is csv|assistant:${A1}\nIt is widely supported. RFC 4180|user:and quoting?|assistant:${A2}`,
    JSON.stringify(payload.turns.map((t) => t.text)));
  assert('page chrome after the last turn is not captured', !/Privacy|Ask anything|Send feedback/.test(payload.turns[3].text + payload.turns[1].text));
  assert('sources stay with their turn',
    payload.turns[1].sources.length === 1 && payload.turns[1].sources[0].url === 'https://www.rfc-editor.org/rfc/rfc4180'
      && payload.turns[3].sources.length === 1 && payload.turns[3].sources[0].url === 'https://example.org/quoting',
    JSON.stringify(payload.turns.map((t) => t.sources)));
  assert('AI Mode payload shape', payload.mode === 'ai_mode' && payload.conversation_id === 'csv format' && payload.conversation_title === 'what is csv');
  assert('AI Mode url keeps q and udm only', payload.source_page_url === 'https://www.google.com/search?q=csv+format&udm=50', payload.source_page_url);
  assert('every turn stamped with the capture time', payload.turns.every((t) => t.captured_at === payload.captured_at));
  assert('answered conversation is complete', capture.source === 'dom' && capture.refresh === 'ok' && capture.complete === true, JSON.stringify(capture));
  assert('AI Mode is never re-fetched', sim.calls.fetch === 0);
}

// --- 8. AI Mode without turn headings (unlisted interface language) ---------
{
  const body = h('body', null,
    h('div', { id: 'main' },
      h('h2', null, 'Hai chiesto: cos’è un csv'),
      h('div', { 'data-attrid': 'SrpGenSumSummary' }, h('p', null, P1), h('p', null, P2))));
  const sim = load({ href: AI_MODE_URL, body });
  sim.tick(5000);
  const { payload, capture } = await sim.exportNow();
  assert('structural container is used when no turn heading matches',
    !!payload && payload.turns.length === 2 && payload.turns[0].text === 'csv format' && payload.turns[1].text === `${P1}\n${P2}`,
    JSON.stringify(payload && payload.turns));
  assert('fallback is flagged and incomplete',
    capture.flags.includes('heuristic_root') && capture.flags.includes('no_turn_markers') && capture.complete === false,
    JSON.stringify(capture));

  const empty = load({ href: AI_MODE_URL, body: h('body', null, h('div', { id: 'main' }, 'Loading')) });
  const none = await empty.exportNow();
  assert('AI Mode with nothing rendered fails without a request', none.response.success === false && empty.calls.fetch === 0);
}

// --- 9. Not a search page, and foreign senders ------------------------------
{
  const sim = load({ href: 'https://www.google.com/maps?q=csv', body: overviewPage([P1, P2]) });
  const status = await sim.poll();
  assert('non-search pages capture nothing', status.conversationIds.length === 0 && status.noOverviewForThisPage === false);

  const search = load({ href: SEARCH_URL, body: overviewPage([P1, P2]) });
  search.sent.length = 0;
  const response = await search.send({ type: 'EXPORT_CONVERSATION', platform: 'google_search' }, { id: 'someone-else' });
  assert('foreign sender gets no response', response === undefined);
  assert('foreign sender triggers no export', !search.sent.some((m) => m.type === 'GOOGLE_SEARCH_AI_OVERVIEW_DATA'));
}

console.log(`\nGoogle Search content-script test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
