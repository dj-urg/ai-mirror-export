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

await expectOutcome('chatgpt id without a mapping',
  { messageType: 'CHATGPT_CONVERSATION_DATA', payload: { conversation_id: 'c' }, senderUrl: 'https://chatgpt.com/c/c' },
  'empty_export', 'EMPTY');
await expectOutcome('chatgpt empty mapping',
  { messageType: 'CHATGPT_CONVERSATION_DATA', payload: { conversation_id: 'c', mapping: {} }, senderUrl: 'https://chatgpt.com/c/c' },
  'empty_export', 'EMPTY');
await expectOutcome('chatgpt mapping with no exportable message',
  { messageType: 'CHATGPT_CONVERSATION_DATA',
    payload: { conversation_id: 'c', current_node: 'root', mapping: { root: { id: 'root', message: null, parent: null, children: [] } } },
    senderUrl: 'https://chatgpt.com/c/c' },
  'empty_export', 'EMPTY');
await expectOutcome('message without a payload',
  { messageType: 'CLAUDE_CONVERSATION_DATA', payload: null, senderUrl: 'https://claude.ai/chat/x' },
  'invalid_data', 'NOT_OBJECT');

// Sender/type validation: a rejected export is reported, never left hanging.
const claudePayload = { uuid: 'x', chat_messages: [{ uuid: 'm', sender: 'human', content: [{ type: 'text', text: 'hi' }] }] };
await expectOutcome('platform/origin mismatch',
  { messageType: 'CLAUDE_CONVERSATION_DATA', payload: claudePayload, senderUrl: 'https://chatgpt.com/c/x' },
  'invalid_data', 'SENDER_REJECTED');
await expectOutcome('subframe sender',
  { messageType: 'CLAUDE_CONVERSATION_DATA', payload: claudePayload, senderUrl: 'https://claude.ai/chat/x', sender: { frameId: 3 } },
  'invalid_data', 'SENDER_REJECTED');
await expectOutcome('non-https sender',
  { messageType: 'CLAUDE_CONVERSATION_DATA', payload: claudePayload, senderUrl: 'http://claude.ai/chat/x' },
  'invalid_data', 'SENDER_REJECTED');
await expectOutcome('look-alike host',
  { messageType: 'CLAUDE_CONVERSATION_DATA', payload: claudePayload, senderUrl: 'https://claude.ai.example.com/chat/x' },
  'invalid_data', 'SENDER_REJECTED');

// Every result names the tab it came from.
{
  const r = await runExport({ messageType: 'CLAUDE_CONVERSATION_DATA', payload: { uuid: 'x', chat_messages: [] }, senderUrl: 'https://claude.ai/chat/x' });
  assert('results carry the sender tab id', r.broadcasts.length > 0 && r.broadcasts.every(b => b.tabId === 1), JSON.stringify(r.broadcasts));
}

// Download completion: success only once the browser reports the file written.
{
  const base = { messageType: 'CLAUDE_CONVERSATION_DATA', payload: claudePayload, senderUrl: 'https://claude.ai/chat/x' };
  const ok = await runExport(base);
  const okDetail = ok.broadcasts.find(b => b.outcome === 'success') || {};
  assert('complete download: success', okDetail.outcome === 'success' && okDetail.downloadConfirmed === true, JSON.stringify(ok.broadcasts));
  assert('complete download: id and tab passed on', okDetail.downloadId === 1 && okDetail.tabId === 1);
  assert('complete download: no listener left behind', ok.downloadListenersLeft === 0, String(ok.downloadListenersLeft));

  const late = await runExport({ ...base, download: 'late' });
  const lateDetail = late.broadcasts.find(b => b.outcome === 'success') || {};
  assert('late completion event: success, confirmed', lateDetail.downloadConfirmed === true, JSON.stringify(late.broadcasts));
  assert('late completion event: no listener left behind', late.downloadListenersLeft === 0);

  const bad = await runExport({ ...base, download: 'interrupted' });
  const badDetail = bad.broadcasts.find(b => b.outcome === 'download_failed') || {};
  assert('interrupted download: reported as download_failed', badDetail.code === 'DOWNLOAD_INTERRUPTED', JSON.stringify(bad.broadcasts));
  assert('interrupted download: no success broadcast', !bad.broadcasts.some(b => b.outcome === 'success'));
  assert('interrupted download: reason is plain text', typeof badDetail.reason === 'string' && badDetail.reason.length > 0);
}

// Capture provenance: sanitised, written to the manifest, passed to the popup.
{
  const r = await runExport({
    messageType: 'CLAUDE_CONVERSATION_DATA', payload: claudePayload, senderUrl: 'https://claude.ai/chat/x',
    capture: {
      captured_at: '2026-04-13T11:59:00.000Z', source: 'export_refresh', refresh: 'failed', complete: false,
      flags: ['refresh_failed', 'Not A Flag', 'refresh_failed', 42, 'x'.repeat(41)],
      note: 'jane@example.com', nested: { a: 1 }
    }
  });
  const expected = { captured_at: '2026-04-13T11:59:00.000Z', source: 'export_refresh', refresh: 'failed', complete: false, flags: ['refresh_failed'] };
  const manifestName = [...r.entries.keys()].find(n => n.endsWith('.json'));
  const manifest = JSON.parse(new TextDecoder().decode(r.entries.get(manifestName)));
  assert('capture: written to manifest telemetry, known fields only',
    JSON.stringify(manifest.telemetry.capture) === JSON.stringify(expected), JSON.stringify(manifest.telemetry.capture));
  const detail = r.broadcasts.find(b => b.outcome === 'success') || {};
  assert('capture: passed to the popup with the result', JSON.stringify(detail.capture) === JSON.stringify(expected), JSON.stringify(detail.capture));
  assert('manifest: checksum basis stated', manifest.checksum_basis === 'utf8_without_bom');

  const junk = await runExport({
    messageType: 'CLAUDE_CONVERSATION_DATA', payload: claudePayload, senderUrl: 'https://claude.ai/chat/x',
    capture: { captured_at: 'yesterday-ish', source: 'telepathy', refresh: 7, complete: 'yes', flags: 'refresh_failed' }
  });
  const junkManifest = JSON.parse(new TextDecoder().decode(junk.entries.get([...junk.entries.keys()].find(n => n.endsWith('.json')))));
  assert('capture: unknown values become null / empty',
    JSON.stringify(junkManifest.telemetry.capture) === JSON.stringify({ captured_at: null, source: null, refresh: null, complete: null, flags: [] }),
    JSON.stringify(junkManifest.telemetry.capture));

  const none = await runExport({ messageType: 'CLAUDE_CONVERSATION_DATA', payload: claudePayload, senderUrl: 'https://claude.ai/chat/x' });
  const noneManifest = JSON.parse(new TextDecoder().decode(none.entries.get([...none.entries.keys()].find(n => n.endsWith('.json')))));
  assert('capture: null when the content script sent none', noneManifest.telemetry.capture === null);
}

console.log(`\nBackground outcome tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
