/**
 * M365 Copilot capture path: inject.js (WebSocket hook) + content.js, run
 * together in a fake page. Synthetic frames only.
 *
 * Covers: one message map per conversation across sockets, completion
 * signals (type 3, turnState, idle timer), final-frame-replaces-draft,
 * the frame size cap, suggested responses, id-less prompts, untrusted
 * events, the conversation list order and the null-secret guard.
 */

import assert from 'node:assert/strict';
import { makeWorld } from './helpers/page_world.js';

const RS = '\x1e';
const MSG = 'M365_COPILOT_CONVERSATION_DATA';
const SOURCE = 'm365-copilot-exporter-inject';
const hub = id => `wss://substrate.office.com/m365Copilot/Chathub/x?ConversationId=${id}&access_token=SECRET-TOKEN`;
const frame = obj => JSON.stringify(obj) + RS;

const prompt = (text, requestId) => frame({
  type: 4, target: 'chat',
  arguments: [{ source: 'officeweb', sessionId: 's1', message: { author: 'user', text, inputMethod: 'Keyboard', ...(requestId ? { requestId } : {}) } }]
});
const update = (...messages) => frame({ type: 1, target: 'update', arguments: [{ messages }] });
const final = (conversationId, messages, extra = {}) => frame({ type: 2, item: { conversationId, messages, ...extra } });
const done = () => frame({ type: 3, invocationId: '0' });
const bot = (messageId, requestId, text, extra = {}) => ({ messageId, requestId, author: 'bot', text, ...extra });
const user = (requestId, text, extra = {}) => ({ messageId: requestId, requestId, author: 'user', text, ...extra });

function open(world, conversationId) {
  return new world.sb.WebSocket(hub(conversationId));
}
async function feed(world, ws, ...frames) {
  for (const f of frames) ws.receive(f);
  await world.advance(600); // past the flush debounce
}
const exportOf = async (world, conversationId) => {
  const before = world.exports().length;
  const response = await world.ask({ type: 'EXPORT_CONVERSATION', platform: 'm365_copilot', conversationId });
  return { response, message: world.exports()[before] };
};
const list = world => world.ask({ type: 'GET_CAPTURED_CONVERSATIONS' });

// --- Two sockets, one conversation ------------------------------------------
{
  const world = makeWorld('m365_copilot');
  const ws1 = open(world, 'conv-a');
  ws1.send(prompt('first question', 'r1'));
  await feed(world, ws1, update(bot('b1', 'r1', 'first ans')),
    final('conv-a', [user('r1', 'first question'), bot('b1', 'r1', 'first answer')]), done());

  const ws2 = open(world, 'conv-a');
  ws2.send(prompt('second question', 'r2'));
  await feed(world, ws2,
    final('conv-a', [user('r2', 'second question'), bot('b2', 'r2', 'second answer')]), done());

  const readyBefore = world.sentToBackground.length;
  ws1.close();
  await world.advance(600);
  assert.equal(world.sentToBackground.length, readyBefore, 'closing an old socket with nothing new must not flush');

  const { response, message } = await exportOf(world, 'conv-a');
  assert.equal(response.success, true);
  assert.deepEqual(message.payload.results.map(m => m.text),
    ['first question', 'first answer', 'second question', 'second answer'],
    'both sockets contribute to one conversation, in order');
  assert.deepEqual(message.capture, {
    captured_at: message.payload.metadata.captured_at,
    source: 'websocket', refresh: 'not_supported', complete: true, flags: []
  });
  assert.match(message.capture.captured_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(message.payload.completionReason, 'type3');
  // The prompt keeps the field only the outgoing frame carried.
  assert.equal(message.payload.results[0].inputMethod, 'Keyboard');
  assert.ok(!JSON.stringify(message).includes('SECRET-TOKEN'), 'the socket URL token never leaves inject.js');
}

// --- Idle completion ---------------------------------------------------------
{
  const world = makeWorld('m365_copilot');
  const ws = open(world, 'conv-idle');
  ws.send(prompt('slow question', 'r1'));
  await world.advance(6000);
  assert.equal((await exportOf(world, 'conv-idle')).response.success, false,
    'a 6 s pause before the first token is not the end of the turn');

  await world.advance(20000);
  await feed(world, ws, update(bot('b1', 'r1', 'partial')));
  await world.advance(20000);
  assert.equal((await exportOf(world, 'conv-idle')).response.success, false,
    'an incoming frame restarts the idle clock');

  await world.advance(11000);
  let result = await exportOf(world, 'conv-idle');
  assert.equal(result.response.success, true, 'the idle fallback eventually unlocks export');
  assert.equal(result.message.payload.completionReason, 'idle_timeout');
  assert.equal(result.message.capture.complete, false);
  assert.deepEqual(result.message.capture.flags, ['idle_timeout']);

  // Streaming resumes: the turn was not over after all.
  await feed(world, ws, update(bot('b1', 'r1', 'partial, continued')));
  assert.equal((await exportOf(world, 'conv-idle')).response.success, false,
    'a mid-stream frame after an idle completion locks export again');

  await feed(world, ws, done());
  result = await exportOf(world, 'conv-idle');
  assert.equal(result.response.success, true);
  assert.equal(result.message.capture.complete, true);
  assert.deepEqual(result.message.capture.flags, []);
  assert.equal(result.message.payload.results[1].text, 'partial, continued');

  // A late frame after the server ended the turn does not re-open it.
  await feed(world, ws, update(bot('b1', 'r1', 'partial, continued')));
  assert.equal((await exportOf(world, 'conv-idle')).response.success, true);
}

// --- turnState completes a turn without type 3 -------------------------------
{
  const world = makeWorld('m365_copilot');
  const ws = open(world, 'conv-ts');
  ws.send(prompt('q', 'r1'));
  await feed(world, ws, final('conv-ts', [user('r1', 'q'), bot('b1', 'r1', 'a')], { turnState: 'Completed' }));
  const { message } = await exportOf(world, 'conv-ts');
  assert.equal(message.payload.completionReason, 'turn_state');
  assert.equal(message.capture.complete, true);
}

// --- Draft vs final ----------------------------------------------------------
{
  const world = makeWorld('m365_copilot');
  const ws = open(world, 'conv-draft');
  ws.send(prompt('q', 'r1'));
  await feed(world, ws,
    update(bot('b1', 'r1', 'short', { turnState: 'Streaming' })),
    update(bot('b1', 'r1', 'a long draft the model later withdrew entirely', { turnState: 'Streaming', contentOrigin: 'draft' })),
    update(bot('b1', 'r1', 'a long', { turnState: 'Streaming2' })));
  await world.advance(31000);
  let { message } = await exportOf(world, 'conv-draft');
  assert.equal(message.payload.results[1].text, 'a long draft the model later withdrew entirely',
    'among streaming updates the longest text wins');
  assert.equal(message.payload.results[1].turnState, 'Streaming2', 'scalar fields take the latest value');

  await feed(world, ws,
    final('conv-draft', [user('r1', 'q'), bot('b1', 'r1', 'Final answer.', { turnState: 'Completed' })]),
    update(bot('b1', 'r1', 'a long draft the model later withdrew entirely, again')),
    done());
  ({ message } = await exportOf(world, 'conv-draft'));
  const answer = message.payload.results[1];
  assert.equal(answer.text, 'Final answer.', 'the authoritative copy replaces a longer draft and is not overwritten');
  assert.equal(answer.turnState, 'Completed');
  assert.equal(answer.contentOrigin, 'draft', 'fields the final copy lacks are kept');
  assert.deepEqual(Object.keys(answer).sort(),
    ['author', 'contentOrigin', 'messageId', 'requestId', 'text', 'turnState'],
    'no bookkeeping fields on exported messages (they are written to raw_json)');
}

// --- Suggested responses and id-less prompts ---------------------------------
{
  const world = makeWorld('m365_copilot');
  const ws = open(world, 'conv-sugg');
  ws.send(prompt('first prompt'));   // no requestId
  await feed(world, ws, final('conv-sugg', [
    { messageId: 'u1', requestId: 'u1', author: 'user', text: 'first prompt' },
    bot('b1', 'u1', 'answer one', {
      suggestedResponses: [
        { author: 'user', text: 'Tell me more', messageType: 'Suggestion' },
        { author: 'user', text: 'Thanks', messageType: 'Suggestion' }
      ]
    })
  ]), done());
  ws.send(prompt('second prompt'));  // no requestId either
  ws.send(prompt('third prompt'));
  await feed(world, ws, update(
    { author: 'bot', text: 'id-less one' },
    { author: 'bot', text: 'id-less two' }
  ), done());

  const { message } = await exportOf(world, 'conv-sugg');
  assert.deepEqual(message.payload.results.map(m => m.text),
    ['first prompt', 'answer one', 'second prompt', 'third prompt', 'id-less one', 'id-less two'],
    'suggestions are not rows; id-less prompts and messages never overwrite each other');
  assert.equal(message.payload.results[0].messageId, 'u1', 'the server copy replaced the id-less prompt in place');
  assert.equal(message.payload.results[1].suggestedResponses.length, 2, 'suggestions stay on their message');
}

// --- Frame size cap ----------------------------------------------------------
{
  const world = makeWorld('m365_copilot');
  const ws = open(world, 'conv-cap');
  ws.send(prompt('q', 'r1'));
  // More traffic than the cap, in complete frames: nothing is dropped.
  const big = 'x'.repeat(1024 * 1024);
  for (let i = 0; i < 52; i++) ws.receive(update(bot('b1', 'r1', big + i)));
  await feed(world, ws, final('conv-cap', [user('r1', 'q'), bot('b1', 'r1', 'ok')]), done());
  let { message } = await exportOf(world, 'conv-cap');
  assert.equal(message.payload.truncated, false, 'a long session is not a truncated one');
  assert.equal(message.capture.complete, true);

  // One frame larger than the cap is dropped, and only that frame.
  ws.send(prompt('q2', 'r2'));
  ws.receive('{"type":1,"filler":"' + 'y'.repeat(50 * 1024 * 1024));
  ws.receive('still the oversized frame"}' + RS + final('conv-cap', [user('r2', 'q2'), bot('b2', 'r2', 'after')]));
  await feed(world, ws, done());
  ({ message } = await exportOf(world, 'conv-cap'));
  assert.deepEqual(message.payload.results.map(m => m.text), ['q', 'ok', 'q2', 'after'],
    'capture continues after an oversized frame');
  assert.equal(message.capture.complete, false);
  assert.deepEqual(message.capture.flags, ['truncated']);
}

// --- Untrusted events, id from the frame, list order -------------------------
{
  const world = makeWorld('m365_copilot');
  const ws = open(world, 'conv-old');
  ws.send(prompt('old q', 'r1'));
  await feed(world, ws, final('conv-old', [user('r1', 'old q'), bot('b1', 'r1', 'old a')]), done());

  ws.receive(final('conv-old', [bot('forged', 'r1', 'page-injected text')]), { isTrusted: false });
  await world.advance(600);

  // A socket whose URL has no id takes it from the type:2 frame.
  const anon = new world.sb.WebSocket('wss://substrate.office.com/m365Copilot/Chathub/x?access_token=SECRET-TOKEN');
  anon.send(prompt('new q', 'r9'));
  await feed(world, anon, final('conv-new', [user('r9', 'new q'), bot('b9', 'r9', 'new a')]), done());

  // The older conversation is updated last.
  ws.send(prompt('old q2', 'r2'));
  await feed(world, ws, final('conv-old', [user('r2', 'old q2'), bot('b2', 'r2', 'old a2')]), done());

  const listing = await list(world);
  assert.deepEqual(listing.conversations.map(c => c.id), ['conv-new', 'conv-old'],
    'the list ends with the most recently updated conversation');
  assert.ok(listing.conversations.every(c => typeof c.lastUpdated === 'number' && c.lastUpdated > 0));
  assert.ok(listing.conversations[1].lastUpdated > listing.conversations[0].lastUpdated);

  const fallback = await exportOf(world, undefined);
  assert.equal(fallback.message.payload.conversationId, 'conv-old', 'no id passed: the most recently updated one');
  assert.deepEqual(fallback.message.payload.results.map(m => m.text), ['old q', 'old a', 'old q2', 'old a2'],
    'a synthetic (untrusted) message event is ignored');
  const chosen = await exportOf(world, 'conv-new');
  assert.deepEqual(chosen.message.payload.results.map(m => m.text), ['new q', 'new a'], 'the id the popup passes is the one exported');

  // Non-Chathub sockets are left alone.
  const other = new world.sb.WebSocket('wss://example.test/Chathub/?ConversationId=conv-x');
  assert.equal(other.listeners.message, undefined);
}

// --- Secret handling ---------------------------------------------------------
for (const options of [{ skipInject: true }, { skipInject: true, pageSecret: 'page-chosen-secret' }]) {
  const world = makeWorld('m365_copilot', options);
  const payload = { conversationId: 'conv-forged', isComplete: true, results: [{ author: 'user', text: 'forged' }] };
  for (const secret of ['null', 'undefined', 'page-chosen-secret']) {
    await world.postFromPage(await world.sb.MessageSecurity.createSignedMessage(payload, MSG, SOURCE, 'm365_copilot', secret));
  }
  assert.equal(world.sentToBackground.length, 0, 'no secret (or a page-supplied one): nothing is accepted');
  assert.deepEqual((await list(world)).conversations, []);
}

console.log('✓ M365 Copilot capture tests passed');
