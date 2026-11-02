/**
 * Behaviour test for the Gemini content script.
 *
 * Runs platforms/gemini/content.js in a vm sandbox against a fake
 * `hNvQHb` batchexecute endpoint (synthetic turns, no captured data) and
 * checks the raw-turn decoding, pagination, citation flattening, and that an
 * export reflects the conversation as it is at export time rather than the
 * copy cached at page load.
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
function turn(n, { user, answer, refs = [], parentId = '', candidates = null }) {
  const t3 = [];
  t3[0] = candidates || [[`rc_${n}`, answer ? [answer] : [], [null, refs]]];
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
 * returns `{ turns, cursor }` or `{ status }` for an HTTP error.
 */
function load(server) {
  const listeners = [];
  const sent = [];
  const calls = { fetch: 0 };
  const sandbox = {
    window: { location: { pathname: '/app/abc', origin: 'https://gemini.google.com' } },
    document: {
      readyState: 'complete',
      title: 'CSV questions - Gemini',
      documentElement: { innerHTML: '<script>{"SNlM0e":"tok","cfb2h":"bl1","FdrFJe":"123"}</script>' },
      addEventListener() {}
    },
    performance: { getEntriesByType: () => [] },
    URLSearchParams, AbortController, console, setTimeout, clearTimeout,
    setInterval: () => 0,
    fetch: async (url, opts) => {
      calls.fetch++;
      const args = JSON.parse(JSON.parse(new URLSearchParams(opts.body).get('f.req'))[0][0][1]);
      const res = server(args[2]);
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
    return { response, payload: data ? data.payload : null };
  };
  return { send, sent, calls, exportPayload };
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
  const { payload } = await sim.exportPayload();

  assert('payload exported', !!payload);
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

// --- 2. Regenerated answers: first candidate with text ----------------------
{
  const candidates = [['rc_empty', [], [null, []]], ['rc_chosen', ['Chosen'], [null, []]], ['rc_other', ['Other'], [null, []]]];
  const sim = load(() => ({ turns: [turn(1, { user: 'Q', candidates })], cursor: null }));
  await settle();
  const { payload } = await sim.exportPayload();
  assert('first candidate with text is exported', payload.messages[1].candidate_id === 'rc_chosen' && payload.messages[1].text === 'Chosen');
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
}

// --- 5. Failed refresh falls back to the cached copy ------------------------
{
  let fail = false;
  const sim = load(() => (fail ? { status: 500 } : { turns: [turn(1, { user: 'Q1', answer: 'A1' })], cursor: null }));
  await settle();
  fail = true;
  const { response, payload } = await sim.exportPayload();
  assert('refresh was attempted', sim.calls.fetch === 2, String(sim.calls.fetch));
  assert('cached copy exported when the refresh fails', !!payload && roles(payload) === 'user:Q1|assistant:A1');
  assert('export reports success', response && response.success === true);
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

console.log(`\nGemini content-script test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
