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

async function expectOutcome(name, opts, outcome) {
  const r = await runExport(opts);
  assert(`${name}: no ZIP downloaded`, r.filename === null, r.filename);
  const outcomes = r.broadcasts.map(b => b.outcome);
  assert(`${name}: broadcasts ${outcome}`, outcomes.includes(outcome), outcomes.join(',') || '(none)');
  const detail = r.broadcasts.find(b => b.outcome === outcome) || {};
  assert(`${name}: platform set`, typeof detail.platform === 'string' && detail.platform.length > 0);
  assert(`${name}: reason is plain text`, typeof detail.reason === 'string' && detail.reason.length > 0, detail.reason);
}

await expectOutcome('claude empty chat',
  { messageType: 'CLAUDE_CONVERSATION_DATA', payload: { uuid: 'x', chat_messages: [] }, senderUrl: 'https://claude.ai/chat/x' },
  'empty_export');
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
  'invalid_data');
await expectOutcome('claude missing chat_messages',
  { messageType: 'CLAUDE_CONVERSATION_DATA', payload: { uuid: 'x' }, senderUrl: 'https://claude.ai/chat/x' },
  'invalid_data');

// Sender/type validation: nothing happens at all for a mismatched origin.
const mismatch = await runExport({
  messageType: 'CLAUDE_CONVERSATION_DATA', payload: { uuid: 'x', chat_messages: [{ uuid: 'm', sender: 'human', content: [{ type: 'text', text: 'hi' }] }] },
  senderUrl: 'https://chatgpt.com/c/x', timeoutMs: 1500
}).catch(err => ({ timedOut: true, message: err.message }));
assert('platform/origin mismatch is dropped silently', mismatch.timedOut === true, JSON.stringify(mismatch).slice(0, 120));

console.log(`\nBackground outcome tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
