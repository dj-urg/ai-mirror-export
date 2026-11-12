/**
 * Behaviour test for the Gemini content script.
 *
 * Runs platforms/gemini/content.js in a vm sandbox against a fake
 * `hNvQHb` batchexecute endpoint (synthetic turns, no captured data) and
 * checks the raw-turn decoding, pagination, citation flattening, that an
 * export reflects the conversation as it is at export time rather than the
 * copy cached at page load, and the `capture` provenance sent next to the
 * payload (failed refresh, unanswered last turn, repeated cursor).
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'platforms', 'gemini', 'content.js'), 'utf8');

let passed = 0;
let failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { passed++; } else { failed++; console.error('FAIL:', name, detail); }
}

// --- Fake Gemini ------------------------------------------------------------

/** One raw history turn in Gemini's array layout (see content.js decodeTurn). */
function turn(n, { user, answer, refs = [], parentId = '', candidates = null, selected = null }) {
  const t3 = [];
  t3[0] = candidates || [[`rc_${n}`, answer ? [answer] : [], [null, refs]]];
  if (selected) t3[3] = selected;
  t3[21] = 'gemini-2.5-pro';
  return [
    ['c_abc', `r_${n}`],
    ['c_abc', parentId, parentId ? `rc_${n - 1}` : ''],
    [[user]],
    t3,
    [1767225600 + n * 10, 0]
  ];
}

function rpcBody(turns, cursor) {
  const line = JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify([turns, cursor]), null, null, null, 'generic']]);
  return `)]}'\n\n${line.length}\n${line}\n`;
}

/**
 * Load content.js with a mocked page and `browser.*`. `server(cursor)`
 * returns `{ turns, cursor }` or `{ status }` for an HTTP error, or a
 * promise of one to keep the request in flight.
 */
function load(server) {
  const listeners = [];
  const sent = [];
  const intervals = [];
  const calls = { fetch: 0, configReads: 0 };
  const sandbox = {
    window: { location: { pathname: '/app/abc', origin: 'https://gemini.google.com' } },
    document: {
      readyState: 'complete',
      title: 'CSV questions - Gemini',
      documentElement: {
        get innerHTML() {
          calls.configReads++;
          return '<script>{"SNlM0e":"tok","cfb2h":"bl1","FdrFJe":"123"}</script>';
        }
      },
      addEventListener() {}
    },
    performance: { getEntriesByType: () => [] },
    URLSearchParams, AbortController, console, setTimeout, clearTimeout,
    setInterval: (fn) => { intervals.push(fn); return 0; },
    fetch: async (url, opts) => {
      calls.fetch++;
      const args = JSON.parse(JSON.parse(new URLSearchParams(opts.body).get('f.req'))[0][0][1]);
      const res = await server(args[2]);
      if (res.status) return { status: res.status, ok: false, text: async () => '' };
      return { status: 200, ok: true, text: async () => rpcBody(res.turns, res.cursor) };
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
  const exportPayload = async () => {
    sent.length = 0;
    const response = await send({ type: 'EXPORT_CONVERSATION', platform: 'gemini' });
    const data = sent.find((m) => m.type === 'GEMINI_CONVERSATION_DATA');
    return { response, payload: data ? data.payload : null, capture: data ? data.capture : null };
  };
  /** Run the script's interval callbacks once (path poll, cleanup). */
  const tickIntervals = () => intervals.forEach((fn) => fn());
  return { sandbox, send, sent, calls, exportPayload, tickIntervals };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const roles = (p) => p.messages.map((m) => `${m.role}:${m.text}`).join('|');

// --- 1. Decoding, pagination, ordering --------------------------------------
{
  // Raw answer has leading whitespace and an en dash before the cited
  // passage. Gemini lists the passage's position twice, as observed on real
  // data: UTF-8 byte offsets [12, 33] first, then character offsets [10, 31],
  // both relative to the untrimmed text.
  const answer = '\n Intro \u2013 RFC 4180 defines CSV. More text.';
  const refs = [
    [['RFC 4180 defines CSV.', null, null, [[12, 33], [10, 31]]], [1], [['https://www.rfc-editor.org/rfc/rfc4180#:~:text=CSV', 'RFC 4180']], 'spp_1'],
    [['Not in the answer.', null, null, []], [1], [['https://example.org/guide', 'Guide']], 'spp_2'],
    [['No URL.', null, null, [[0, 3]]], [1], [], 'spp_3']
  ];
  const t1 = turn(1, { user: 'Q1', answer, refs });
  const t2 = turn(2, { user: 'Q2', answer: 'A2', parentId: 'r_1' });
  const t3 = turn(3, { user: 'Q3', answer: 'A3', parentId: 'r_2' });
  // Newest-first, two pages that overlap on t2.
  const sim = load((cursor) => (cursor ? { turns: [t2, t1], cursor: null } : { turns: [t3, t2], cursor: 'next' }));
  await settle();
  const { payload, capture } = await sim.exportPayload();

  assert('payload exported', !!payload);
  assert('capture marks a fresh, complete export',
    capture && capture.source === 'export_refresh' && capture.refresh === 'ok' && capture.complete === true && capture.flags.length === 0,
    JSON.stringify(capture));
  assert('capture time is an ISO timestamp', capture && !Number.isNaN(Date.parse(capture.captured_at)) && /^\d{4}-\d\d-\d\dT/.test(capture.captured_at));
  assert('turns oldest-first, overlap deduped', roles(payload) === 'user:Q1|assistant:Intro \u2013 RFC 4180 defines CSV. More text.|user:Q2|assistant:A2|user:Q3|assistant:A3', roles(payload));
  assert('conversation id normalized to c_<id>', payload._captured_conversation_id === 'c_abc');
  assert('title strips the "- Gemini" suffix', payload.conversation.title === 'CSV questions', payload.conversation.title);
  assert('model taken from the answer', payload.conversation.model === 'gemini-2.5-pro');
  const a1 = payload.messages[1];
  assert('assistant message id is the response id', a1.message_id === 'r_1');
  assert('assistant parent is its user prompt', a1.parent_message_id === 'user-r_1');
  assert('candidate id carried', a1.candidate_id === 'rc_1');
  assert('second prompt points at the first answer', payload.messages[2].parent_message_id === 'r_1');
  assert('one row per reference, url-less ref skipped', a1.citations.length === 2, String(a1.citations.length));
  assert('text-fragment suffix stripped from url', a1.citations[0].url === 'https://www.rfc-editor.org/rfc/rfc4180');
  const c0 = a1.citations[0];
  assert('byte and character pairs collapse to one character span',
    c0.start_index === 8 && c0.end_index === 29 && a1.text.slice(c0.start_index, c0.end_index) === 'RFC 4180 defines CSV.',
    `${c0.start_index}-${c0.end_index}`);
  assert("Gemini's own pairs kept in raw_spans", JSON.stringify(c0.raw_spans) === '[[12,33],[10,31]]', JSON.stringify(c0.raw_spans));
  assert('passage not in the answer has empty offsets', a1.citations[1].start_index === '' && a1.citations[1].ref_index === 1);
}

// --- 2. Regenerated answers: the selected candidate, else the first with text
{
  const candidates = [['rc_empty', [], [null, []]], ['rc_chosen', ['Chosen'], [null, []]], ['rc_other', ['Other'], [null, []]]];
  const sim = load(() => ({ turns: [turn(1, { user: 'Q', candidates })], cursor: null }));
  await settle();
  const { payload } = await sim.exportPayload();
  assert('first candidate with text is exported', payload.messages[1].candidate_id === 'rc_chosen' && payload.messages[1].text === 'Chosen');

  const named = load(() => ({ turns: [turn(1, { user: 'Q', candidates, selected: 'rc_other' })], cursor: null }));
  await settle();
  const picked = await named.exportPayload();
  assert('candidate named as selected is exported', picked.payload.messages[1].candidate_id === 'rc_other' && picked.payload.messages[1].text === 'Other', JSON.stringify(picked.payload.messages[1]));

  const unknown = load(() => ({ turns: [turn(1, { user: 'Q', candidates, selected: 'rc_gone' })], cursor: null }));
  await settle();
  const fallback = await unknown.exportPayload();
  assert('unknown selected id falls back to the first with text', fallback.payload.messages[1].candidate_id === 'rc_chosen');

  const emptyNamed = load(() => ({ turns: [turn(1, { user: 'Q', candidates, selected: 'rc_empty' })], cursor: null }));
  await settle();
  const fallback2 = await emptyNamed.exportPayload();
  assert('selected candidate without text falls back to the first with text', fallback2.payload.messages[1].candidate_id === 'rc_chosen');
}

// --- 3. Export reflects turns added after page load -------------------------
{
  let turns = [turn(1, { user: 'Q1', answer: 'A1' })];
  const sim = load(() => ({ turns, cursor: null }));
  await settle(); // page-load prefetch caches one turn
  turns = [turn(2, { user: 'Q2', answer: 'A2', parentId: 'r_1' }), ...turns];
  const { payload } = await sim.exportPayload();
  assert('export includes the turn sent after page load', roles(payload) === 'user:Q1|assistant:A1|user:Q2|assistant:A2', roles(payload));
}

// --- 4. New chat cached mid-answer ------------------------------------------
{
  let turns = [turn(1, { user: 'Q1', answer: '' })];
  const sim = load(() => ({ turns, cursor: null }));
  await settle(); // prefetch lands while the answer is still streaming
  turns = [turn(1, { user: 'Q1', answer: 'A1' })];
  const { payload } = await sim.exportPayload();
  assert('export includes the finished answer', roles(payload) === 'user:Q1|assistant:A1', roles(payload));

  // Exported while the answer is still empty: the row is kept and flagged.
  const pending = load(() => ({ turns: [turn(1, { user: 'Q1', answer: '' })], cursor: null }));
  await settle();
  const early = await pending.exportPayload();
  assert('unanswered turn keeps both rows', roles(early.payload) === 'user:Q1|assistant:', roles(early.payload));
  assert('unanswered last turn is flagged in_flight', early.capture.flags.includes('in_flight') && early.capture.complete === false, JSON.stringify(early.capture));
}

// --- 5. Failed refresh falls back to the cached copy ------------------------
{
  let fail = false;
  const sim = load(() => (fail ? { status: 500 } : { turns: [turn(1, { user: 'Q1', answer: 'A1' })], cursor: null }));
  await settle();
  fail = true;
  const { response, payload, capture } = await sim.exportPayload();
  assert('refresh was attempted', sim.calls.fetch === 2, String(sim.calls.fetch));
  assert('cached copy exported when the refresh fails', !!payload && roles(payload) === 'user:Q1|assistant:A1');
  assert('export reports success', response && response.success === true);
  assert('stale copy is marked, not passed off as fresh',
    capture.refresh === 'failed' && capture.source === 'active' && capture.complete === null && capture.flags.includes('refresh_failed'),
    JSON.stringify(capture));
  assert('capture time is when the cached copy was fetched', !Number.isNaN(Date.parse(capture.captured_at)));
}

// --- 6. Nothing cached and the fetch fails ----------------------------------
{
  const sim = load(() => ({ status: 500 }));
  await settle();
  const { response, payload } = await sim.exportPayload();
  assert('no payload forwarded', payload === null);
  assert('export reports failure', response && response.success === false);
}

// --- 7. Messages from other senders are ignored -----------------------------
{
  const sim = load(() => ({ turns: [turn(1, { user: 'Q1', answer: 'A1' })], cursor: null }));
  await settle();
  sim.sent.length = 0;
  const response = await sim.send({ type: 'EXPORT_CONVERSATION', platform: 'gemini' }, { id: 'someone-else' });
  assert('foreign sender gets no response', response === undefined);
  assert('foreign sender triggers no export', !sim.sent.some((m) => m.type === 'GEMINI_CONVERSATION_DATA'));
}

// --- 8. Export does not reuse a fetch that started before the click ---------
{
  let turns = [turn(1, { user: 'Q1', answer: 'A1' })];
  let release = null;
  let hold = true;
  const sim = load(() => {
    const snapshot = { turns, cursor: null };
    if (!hold) return snapshot;
    hold = false;
    return new Promise((resolve) => { release = () => resolve(snapshot); });
  });
  await settle(); // page-load fetch is in flight, holding the one-turn history
  turns = [turn(2, { user: 'Q2', answer: 'A2', parentId: 'r_1' }), ...turns];
  const pendingExport = sim.exportPayload();
  await settle();
  release();
  const { payload, capture } = await pendingExport;
  assert('export made its own request', sim.calls.fetch === 2, String(sim.calls.fetch));
  assert('export has the turn the in-flight fetch missed', roles(payload) === 'user:Q1|assistant:A1|user:Q2|assistant:A2', roles(payload));
  assert('export is marked fresh', capture.refresh === 'ok' && capture.source === 'export_refresh');
}

// --- 9. Turns without text, and turns in an unknown layout ------------------
{
  const imageAnswer = turn(2, { user: 'Draw a cat', parentId: 'r_1', candidates: [['rc_2', [], [null, []]]] });
  const attachmentPrompt = turn(3, { user: '', answer: 'It is a spreadsheet.', parentId: 'r_2' });
  const sim = load(() => ({ turns: [turn(4, { user: 'Q4', answer: 'A4', parentId: 'r_3' }), attachmentPrompt, imageAnswer, turn(1, { user: 'Q1', answer: 'A1' })], cursor: null }));
  await settle();
  const { payload, capture } = await sim.exportPayload();
  assert('image-only answer and attachment-only prompt keep their rows',
    roles(payload) === 'user:Q1|assistant:A1|user:Draw a cat|assistant:|user:|assistant:It is a spreadsheet.|user:Q4|assistant:A4',
    roles(payload));
  assert('text-less answer keeps its ids', payload.messages[3].message_id === 'r_2' && payload.messages[3].candidate_id === 'rc_2');
  assert('text-less rows in the middle do not flag the export', capture.complete === true && capture.flags.length === 0, JSON.stringify(capture));

  // One turn with neither a prompt nor an answer slot: skipped and flagged.
  const odd = [['c_abc', 'r_9'], ['c_abc', ''], null, null, [1767225700, 0]];
  const drift = load(() => ({ turns: [odd, turn(1, { user: 'Q1', answer: 'A1' })], cursor: null }));
  await settle();
  const partial = await drift.exportPayload();
  assert('known turns still exported', roles(partial.payload) === 'user:Q1|assistant:A1');
  assert('undecoded turn is flagged, export incomplete', partial.capture.flags.includes('undecoded_turns') && partial.capture.complete === false, JSON.stringify(partial.capture));

  // Every turn unknown: fail instead of exporting nothing as a success.
  const broken = load(() => ({ turns: [odd], cursor: null }));
  await settle();
  const none = await broken.exportPayload();
  assert('all-unknown layout fails the export', none.payload === null && none.response.success === false);
}

// --- 10. Missing timestamp, repeated cursor, several URLs per citation ------
{
  const noTime = turn(1, { user: 'Q1', answer: 'A1' });
  noTime[4] = [null, 0];
  const sim = load(() => ({ turns: [noTime], cursor: null }));
  await settle();
  const { payload } = await sim.exportPayload();
  assert('missing timestamp is empty, not 1970', payload.messages[0].created_at === '' && payload.conversation.created_at === '', JSON.stringify(payload.messages[0].created_at));

  const timed = load(() => ({ turns: [turn(1, { user: 'Q1', answer: 'A1' })], cursor: null }));
  await settle();
  const withTime = await timed.exportPayload();
  assert('real timestamp still converted', withTime.payload.messages[0].created_at === '2026-01-01T00:00:10.000Z', withTime.payload.messages[0].created_at);

  const looping = load(() => ({ turns: [turn(1, { user: 'Q1', answer: 'A1' })], cursor: 'same' }));
  await settle();
  const looped = await looping.exportPayload();
  assert('repeated cursor still exports the turns once', roles(looped.payload) === 'user:Q1|assistant:A1', roles(looped.payload));
  assert('repeated cursor is flagged, export incomplete', looped.capture.flags.includes('cursor_repeated') && looped.capture.complete === false, JSON.stringify(looped.capture));

  const refs = [[['Fact.', null, null, [[0, 5]]], [1], [['https://a.example/x', 'A'], ['https://b.example/y#:~:text=Fact', 'B']], 'spp_1']];
  const multi = load(() => ({ turns: [turn(1, { user: 'Q1', answer: 'Fact. More.', refs })], cursor: null }));
  await settle();
  const cited = await multi.exportPayload();
  const rows = cited.payload.messages[1].citations;
  assert('one citation row per URL of a reference',
    rows.length === 2 && rows[0].url === 'https://a.example/x' && rows[1].url === 'https://b.example/y'
      && rows[1].title === 'B' && rows[0].ref_index === 0 && rows[1].ref_index === 0
      && rows[0].source_index === 0 && rows[1].source_index === 1 && rows[1].start_index === 0 && rows[1].end_index === 5,
    JSON.stringify(rows));
}

// --- 11. Popup polls back off, and the page config is parsed once -----------
{
  const failing = load(() => ({ status: 500 }));
  await settle(); // page-load fetch fails
  for (let i = 0; i < 5; i++) await failing.send({ type: 'GET_CAPTURED_CONVERSATIONS' });
  assert('polls after a failure do not re-request', failing.calls.fetch === 1, String(failing.calls.fetch));
  await failing.exportPayload();
  assert('an export still tries during the backoff', failing.calls.fetch === 2, String(failing.calls.fetch));

  const empty = load(() => ({ turns: [], cursor: null }));
  await settle();
  for (let i = 0; i < 5; i++) await empty.send({ type: 'GET_CAPTURED_CONVERSATIONS' });
  assert('polls on an empty new chat do not re-request at once', empty.calls.fetch === 1, String(empty.calls.fetch));

  const sim = load(() => ({ turns: [turn(1, { user: 'Q1', answer: 'A1' })], cursor: null }));
  await settle();
  await sim.exportPayload();
  await sim.exportPayload();
  assert('three fetches were made', sim.calls.fetch === 3, String(sim.calls.fetch));
  assert('page HTML serialised once for the request tokens', sim.calls.configReads === 1, String(sim.calls.configReads));
  const status = await sim.send({ type: 'GET_CAPTURED_CONVERSATIONS' });
  assert('poll lists the conversation without a request', status.conversationIds[0] === 'c_abc' && sim.calls.fetch === 3);
}

// --- 12. Tab title left over from the previous conversation -----------------
{
  const sim = load(() => ({ turns: [turn(1, { user: 'What is a CSV file?', answer: 'A1' })], cursor: null }));
  await settle();
  sim.tickIntervals(); // poll sees the title while still on /app/abc
  // In-app navigation: the path changes first, the title lags behind.
  sim.sandbox.window.location.pathname = '/app/def';
  sim.tickIntervals();
  await settle();
  const stale = await sim.exportPayload();
  assert('new conversation exported', stale.payload._captured_conversation_id === 'c_def');
  assert("previous conversation's tab title is not used", stale.payload.conversation.title === '', stale.payload.conversation.title);
  const status = await sim.send({ type: 'GET_CAPTURED_CONVERSATIONS' });
  const listed = status.conversations.find((c) => c.id === 'c_def');
  assert('popup falls back to the first prompt', listed && listed.title === 'What is a CSV file?', listed && listed.title);

  sim.sandbox.document.title = 'File formats - Gemini';
  const fresh = await sim.exportPayload();
  assert('updated tab title is used', fresh.payload.conversation.title === 'File formats', fresh.payload.conversation.title);
}

console.log(`\nGemini content-script test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
