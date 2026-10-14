/**
 * Non-success export outcomes: background.js must broadcast a clear
 * EXPORT_RESULT and never download anything for empty or invalid payloads.
 */
import { runExport } from './helpers/bg_harness.js';

let passed = 0;
let failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { passed++; } else { failed++; console.error('FAIL:', name, detail); }
}

async function expectOutcome(name, opts, outcome, expectedCode = null) {
  const r = await runExport(opts);
  assert(`${name}: no ZIP downloaded`, r.filename === null, r.filename);
  const outcomes = r.broadcasts.map(b => b.outcome);
  assert(`${name}: broadcasts ${outcome}`, outcomes.includes(outcome), outcomes.join(',') || '(none)');
  const detail = r.broadcasts.find(b => b.outcome === outcome) || {};
  assert(`${name}: platform set`, typeof detail.platform === 'string' && detail.platform.length > 0);
  assert(`${name}: reason is plain text`, typeof detail.reason === 'string' && detail.reason.length > 0, detail.reason);
  assert(`${name}: carries a validation code`, typeof detail.code === 'string' && /^[A-Z_]+$/.test(detail.code), detail.code);
  if (expectedCode) assert(`${name}: code is ${expectedCode}`, detail.code === expectedCode, detail.code);
}

await expectOutcome('claude empty chat',
  { messageType: 'CLAUDE_CONVERSATION_DATA', payload: { uuid: 'x', chat_messages: [] }, senderUrl: 'https://claude.ai/chat/x' },
  'empty_export', 'EMPTY');
await expectOutcome('copilot empty results',
  { messageType: 'COPILOT_CONVERSATION_DATA', payload: { conversationId: 'c', results: [] }, senderUrl: 'https://copilot.microsoft.com/chats/c' },
  'empty_export');
await expectOutcome('google overview too short',
  { messageType: 'GOOGLE_SEARCH_AI_OVERVIEW_DATA', payload: { mode: 'ai_overview', query: 'q', ai_overview_text: 'short' }, senderUrl: 'https://www.google.com/search?q=q' },
  'empty_export');
await expectOutcome('mistral empty messages',
  { messageType: 'MISTRAL_CONVERSATION_DATA', payload: { _captured_conversation_id: 'm', chat: null, messages: [] }, senderUrl: 'https://chat.mistral.ai/chat/m' },
  'empty_export');
await expectOutcome('chatgpt mapping not an object',
  { messageType: 'CHATGPT_CONVERSATION_DATA', payload: { conversation_id: 'c', mapping: [] }, senderUrl: 'https://chatgpt.com/c/c' },
  'invalid_data', 'BAD_SHAPE');
await expectOutcome('claude missing chat_messages',
  { messageType: 'CLAUDE_CONVERSATION_DATA', payload: { uuid: 'x' }, senderUrl: 'https://claude.ai/chat/x' },
  'invalid_data', 'MISSING_FIELDS');

// Grok: a payload without the stamped id is named from the id the content
// script sends alongside (derived from the page URL), never "unknown".
{
  const r = await runExport({
    messageType: 'GROK_CONVERSATION_DATA',
    payload: { responses: [{ responseId: 'r1', sender: 'human', message: 'hi', timestamp: '2026-01-01T00:00:00.000Z' }] },
    senderUrl: 'https://grok.com/c/0a1b2c3d-0000-4000-8000-000000000001',
    conversationId: '0a1b2c3d-0000-4000-8000-000000000001'
  });
  assert('grok hint: zip downloaded', r.filename !== null);
  assert('grok hint: zip named from the hinted id', r.filename === 'grok_0a1b2c3d-0000-4000-8000-000000000001_2026-04-13T12-00-00Z.zip', r.filename);
  const manifestName = [...r.entries.keys()].find(n => n.endsWith('.json'));
  const manifest = JSON.parse(new TextDecoder().decode(r.entries.get(manifestName)));
  assert('grok hint: manifest conversation_id from the hint', manifest.conversation_id === '0a1b2c3d-0000-4000-8000-000000000001', manifest.conversation_id);
  const bad = await runExport({
    messageType: 'GROK_CONVERSATION_DATA',
    payload: { responses: [{ responseId: 'r1', sender: 'human', message: 'hi', timestamp: '2026-01-01T00:00:00.000Z' }] },
    senderUrl: 'https://grok.com/c/x',
    conversationId: '../evil id'
  });
  assert('grok hint: malformed hint is ignored', bad.filename === 'grok_unknown_2026-04-13T12-00-00Z.zip', bad.filename);
}

// Sender/type validation: nothing happens at all for a mismatched origin.
const mismatch = await runExport({
  messageType: 'CLAUDE_CONVERSATION_DATA', payload: { uuid: 'x', chat_messages: [{ uuid: 'm', sender: 'human', content: [{ type: 'text', text: 'hi' }] }] },
  senderUrl: 'https://chatgpt.com/c/x', timeoutMs: 1500
}).catch(err => ({ timedOut: true, message: err.message }));
assert('platform/origin mismatch is dropped silently', mismatch.timedOut === true, JSON.stringify(mismatch).slice(0, 120));

console.log(`\nBackground outcome tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
