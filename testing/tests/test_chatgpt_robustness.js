/**
 * Robustness tests for the ChatGPT extractor.
 *
 * Hand-written payloads with the kinds of damage a real export can carry: a
 * tree with a cycle or a dangling child, null nodes and parts, timestamps in
 * unexpected units or types, and content types the extractor has no special
 * case for. None of them may throw, hang, or lose a turn's text silently.
 */
import {
  extractChatGPTConversation,
  countOrphanedNodes
} from '../../platforms/chatgpt/extractor.js';
import { countRows } from '../../utils/manifest.js';

let passed = 0;
let failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { passed++; } else { failed++; console.error('FAIL:', name, detail); }
}

const OPTIONS = { donorId: 'd', donorIdType: 'persistent', downloadTime: '2026-01-01T00:00:00.000Z' };
const CONV_ID = '00000000-0000-4000-8000-0000000000f1';

function textMessage(id, role, text, extra = {}) {
  return {
    id,
    author: { role },
    create_time: 1767225600,
    content: { content_type: 'text', parts: [text] },
    metadata: {},
    ...extra
  };
}

function conversation(mapping, extra = {}) {
  return { conversation_id: CONV_ID, title: 'Synthetic', create_time: 1767225600, update_time: 1767225700, mapping, ...extra };
}

function extract(data) {
  return extractChatGPTConversation(data, OPTIONS);
}

function rowFor(result, id) {
  return result.messages.find(m => m.node_id === id);
}

// ---------------------------------------------------------------------------
// Malformed trees
// ---------------------------------------------------------------------------

{
  // root -> a -> b -> a (cycle). Must terminate and export each node once.
  const result = extract(conversation({
    root: { id: 'root', message: null, parent: null, children: ['a'] },
    a: { id: 'a', message: textMessage('a', 'user', 'Question'), parent: 'root', children: ['b'] },
    b: { id: 'b', message: textMessage('b', 'assistant', 'Answer'), parent: 'a', children: ['a'] }
  }, { current_node: 'b' }));
  assert('cycle: terminates with one row per message', result.messages.length === 2, String(result.messages.length));
  assert('cycle: depth is the first visit', rowFor(result, 'a').turn_number === 1 && rowFor(result, 'b').turn_number === 2);
  assert('cycle: visible path is still computed', result.messages.every(m => m.on_visible_path === true));
}

{
  // A node that lists itself as its own child and parent.
  const result = extract(conversation({
    root: { id: 'root', message: textMessage('root', 'user', 'Loop'), parent: null, children: ['root'] }
  }));
  assert('self-loop: terminates', result.messages.length === 1);
}

{
  // `a` lists a child that is not in the mapping.
  const result = extract(conversation({
    root: { id: 'root', message: null, parent: null, children: ['a'] },
    a: { id: 'a', message: textMessage('a', 'user', 'Question'), parent: 'root', children: ['gone', 'b'] },
    b: { id: 'b', message: textMessage('b', 'assistant', 'Answer'), parent: 'a', children: [] }
  }));
  assert('missing child: both real messages exported', result.messages.length === 2);
  assert('missing child: sibling after the gap keeps its depth', rowFor(result, 'b').turn_number === 2);
}

{
  // A null node, a node with a non-array `children`, a node whose message is
  // not an object.
  const data = conversation({
    root: { id: 'root', message: null, parent: null, children: ['a', 'hole', 'odd'] },
    a: { id: 'a', message: textMessage('a', 'user', 'Question'), parent: 'root', children: 'not-an-array' },
    hole: null,
    odd: { id: 'odd', message: 'not-an-object', parent: 'root', children: [] }
  });
  const result = extract(data);
  assert('null node: export survives', result.messages.length === 1 && result.messages[0].text === 'Question');
  assert('null node: counted as orphaned, not dropped silently', countOrphanedNodes(data) === 1, String(countOrphanedNodes(data)));
}

{
  // Flat messages-array format with holes.
  const result = extract({
    id: CONV_ID,
    messages: [
      textMessage('m1', 'user', 'First'),
      null,
      'junk',
      textMessage('m2', 'assistant', 'Second', { metadata: { parent_id: 'm1' } })
    ]
  });
  assert('messages array: null elements skipped', result.messages.length === 2);
  assert('messages array: index kept as turn number', result.messages[1].turn_number === 3);
  assert('messages array: parent id in the same id space as message id',
    result.messages[1].parent_id === result.messages[0].node_id);
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

{
  const result = extract(conversation({
    root: { id: 'root', message: null, parent: null, children: ['sec', 'ms', 'iso', 'isoz', 'num', 'bad', 'obj'] },
    sec: { id: 'sec', message: textMessage('sec', 'user', 's', { create_time: 1767225600.5 }), parent: 'root', children: [] },
    ms: { id: 'ms', message: textMessage('ms', 'user', 'ms', { create_time: 1767225600500 }), parent: 'root', children: [] },
    iso: { id: 'iso', message: textMessage('iso', 'user', 'iso', { create_time: '2026-01-01T00:00:00' }), parent: 'root', children: [] },
    isoz: { id: 'isoz', message: textMessage('isoz', 'user', 'isoz', { create_time: '2026-01-01T01:00:00+01:00' }), parent: 'root', children: [] },
    num: { id: 'num', message: textMessage('num', 'user', 'num', { create_time: '1767225600' }), parent: 'root', children: [] },
    bad: { id: 'bad', message: textMessage('bad', 'user', 'bad', { create_time: 'yesterday-ish' }), parent: 'root', children: [] },
    obj: { id: 'obj', message: textMessage('obj', 'user', 'obj', { create_time: { seconds: 1 } }), parent: 'root', children: [] }
  }, { create_time: '2026-01-01T00:00:00Z', update_time: 1e300 }));

  assert('seconds (fractional) -> ISO', rowFor(result, 'sec').create_time === '2026-01-01T00:00:00.500Z', rowFor(result, 'sec').create_time);
  assert('milliseconds -> same instant, not year 55840', rowFor(result, 'ms').create_time === '2026-01-01T00:00:00.500Z', rowFor(result, 'ms').create_time);
  assert('zone-less ISO string read as UTC', rowFor(result, 'iso').create_time === '2026-01-01T00:00:00.000Z', rowFor(result, 'iso').create_time);
  assert('ISO string with offset converted to UTC', rowFor(result, 'isoz').create_time === '2026-01-01T00:00:00.000Z', rowFor(result, 'isoz').create_time);
  assert('numeric string treated as Unix seconds', rowFor(result, 'num').create_time === '2026-01-01T00:00:00.000Z', rowFor(result, 'num').create_time);
  assert('unparseable string -> empty, no throw', rowFor(result, 'bad').create_time === '');
  assert('object timestamp -> empty, no throw', rowFor(result, 'obj').create_time === '');
  assert('conversation create_time as ISO string', result.metadata.create_time === '2026-01-01T00:00:00.000Z', result.metadata.create_time);
  assert('out-of-range number -> empty, no throw', result.metadata.update_time === '');
}

{
  // String pub_date in a search result used to abort the whole export.
  const result = extract(conversation({
    root: {
      id: 'root', parent: null, children: [],
      message: textMessage('root', 'assistant', 'With sources', {
        metadata: {
          search_result_groups: [
            null,
            { entries: [null, { type: 'search_result', url: 'https://example.org/a', title: 'A', pub_date: '2026-01-01T00:00:00Z' }] }
          ],
          content_references: [
            null,
            { type: 'grouped_webpages', items: [null, { url: 'https://example.org/b', title: 'B', pub_date: 1767225600 }], safe_urls: [42, 'https://example.org/b'] }
          ],
          safe_urls: [null, 'https://example.org/c']
        }
      })
    }
  }));
  assert('sources: both rows survive null neighbours', result.searchResults.length === 2, String(result.searchResults.length));
  assert('sources: string pub_date converted', result.searchResults[0].pub_date === '2026-01-01T00:00:00.000Z', result.searchResults[0].pub_date);
  assert('message urls: non-string entries skipped',
    result.messageUrls.map(u => u.url).join(',') === 'https://example.org/b,https://example.org/c',
    result.messageUrls.map(u => u.url).join(','));
}

// ---------------------------------------------------------------------------
// Content coverage
// ---------------------------------------------------------------------------

{
  const withContent = (id, role, content) => ({
    id, parent: 'root', children: [],
    message: { id, author: { role }, content, metadata: {} }
  });
  const result = extract(conversation({
    root: { id: 'root', message: null, parent: null, children: ['voiceUser', 'voiceBot', 'mixed', 'textObj', 'quote', 'browse', 'syserr', 'future', 'thoughts', 'code'] },
    voiceUser: withContent('voiceUser', 'user', {
      content_type: 'multimodal_text',
      parts: [
        { content_type: 'audio_transcription', text: 'What is the tide today?', direction: 'in' },
        { content_type: 'real_time_user_audio_video_asset_pointer', audio_asset_pointer: { asset_pointer: 'sediment://x' } }
      ]
    }),
    voiceBot: withContent('voiceBot', 'assistant', {
      content_type: 'multimodal_text',
      parts: [{ content_type: 'audio_transcription', text: 'High tide is at noon.', direction: 'out' }]
    }),
    mixed: withContent('mixed', 'user', {
      content_type: 'multimodal_text',
      parts: [null, { content_type: 'image_asset_pointer', asset_pointer: 'file-service://img1' }, 'Describe this', { content_type: 'text', text: 'please' }]
    }),
    textObj: withContent('textObj', 'assistant', { content_type: 'text', parts: ['ok', { unexpected: true }, null] }),
    quote: withContent('quote', 'tool', { content_type: 'tether_quote', url: 'https://example.org', title: 'T', text: 'Quoted passage' }),
    browse: withContent('browse', 'tool', { content_type: 'tether_browsing_display', result: 'Search results text', summary: null }),
    syserr: withContent('syserr', 'tool', { content_type: 'system_error', name: 'Err', text: 'Something failed' }),
    future: withContent('future', 'assistant', { content_type: 'some_future_type', parts: [{ content_type: 'new_part', text: 'Future text' }] }),
    thoughts: withContent('thoughts', 'assistant', { content_type: 'thoughts', thoughts: [null, { summary: 'Label', content: 'Body' }, { content: 'Only body' }] }),
    code: withContent('code', 'assistant', { content_type: 'code', language: 'json', text: '{"q":"tides"}' })
  }));

  assert('voice: user transcript exported', rowFor(result, 'voiceUser').text === 'What is the tide today?', rowFor(result, 'voiceUser').text);
  assert('voice: assistant transcript exported', rowFor(result, 'voiceBot').text === 'High tide is at noon.');
  assert('multimodal: null part does not throw, text parts joined', rowFor(result, 'mixed').text === 'Describe this\nplease', JSON.stringify(rowFor(result, 'mixed').text));
  assert('multimodal: image still detected next to a null part',
    rowFor(result, 'mixed').has_image === true && rowFor(result, 'mixed').image_ids === 'file-service://img1');
  assert('text: object part never becomes [object Object]', rowFor(result, 'textObj').text === 'ok', JSON.stringify(rowFor(result, 'textObj').text));
  assert('tether_quote text exported', rowFor(result, 'quote').text === 'Quoted passage');
  assert('tether_browsing_display result exported', rowFor(result, 'browse').text === 'Search results text');
  assert('system_error text exported', rowFor(result, 'syserr').text === 'Something failed');
  assert('unknown content type keeps its text', rowFor(result, 'future').text === 'Future text');
  assert('thoughts: summary first, null entry tolerated', rowFor(result, 'thoughts').text === '\n\nLabel\n\nOnly body', JSON.stringify(rowFor(result, 'thoughts').text));
  assert('code text unchanged', rowFor(result, 'code').text === '{"q":"tides"}');
  assert('no row contains [object Object]', !result.messagesCSV.includes('[object Object]'));
}

// ---------------------------------------------------------------------------
// Counts and ids agree with the rows
// ---------------------------------------------------------------------------

{
  const result = extract(conversation({
    root: { id: 'root', message: null, parent: null, children: ['ctx'] },
    ctx: {
      id: 'ctx', parent: 'root', children: ['u1'],
      message: {
        id: 'ctx', author: { role: 'user' },
        content: { content_type: 'user_editable_context', user_profile: 'User profile: ```Synthetic profile```', user_instructions: '```Be brief```' },
        metadata: { is_visually_hidden_from_conversation: true }
      }
    },
    u1: { id: 'u1', message: textMessage('u1', 'user', 'Question'), parent: 'ctx', children: ['a1', 'a2'] },
    a1: { id: 'a1', message: textMessage('a1', 'assistant', 'First answer'), parent: 'u1', children: [] },
    a2: { id: 'a2', message: textMessage('a2', 'assistant', 'Regenerated answer'), parent: 'u1', children: ['t1'] },
    t1: { id: 't1', message: { id: 't1', author: { role: 'tool', name: 'web' } }, parent: 'a2', children: [] }
  }, { current_node: 't1' }));

  const roles = result.messages.map(m => m.author_role);
  const count = role => roles.filter(r => r === role).length;
  assert('num_messages equals the row count', result.metadata.num_messages === result.messages.length,
    `${result.metadata.num_messages} vs ${result.messages.length}`);
  assert('num_messages equals CSV rows', countRows(result.messagesCSV) === result.metadata.num_messages);
  assert('num_user_messages excludes the hidden context node', result.metadata.num_user_messages === 1 && count('user') === 1,
    String(result.metadata.num_user_messages));
  assert('num_assistant_messages matches rows', result.metadata.num_assistant_messages === count('assistant'));
  assert('num_tool_messages matches rows (message without content)', result.metadata.num_tool_messages === 1 && count('tool') === 1);
  assert('donor context still extracted from the hidden node',
    result.donorContext.user_profile === 'Synthetic profile' && result.donorContext.user_instructions === 'Be brief');
  assert('branch: regenerated answer on the visible path, first answer off it',
    rowFor(result, 'a2').on_visible_path === true && rowFor(result, 'a1').on_visible_path === false);
}

{
  // message.id differs from the mapping key: ids must still join.
  const result = extract(conversation({
    n0: { id: 'n0', message: null, parent: null, children: ['n1'] },
    n1: {
      id: 'n1', parent: 'n0', children: ['n2'],
      message: textMessage('m1', 'user', 'Question', { metadata: { safe_urls: ['https://example.org/x'] } })
    },
    n2: { id: 'n2', message: textMessage('m2', 'assistant', 'Answer'), parent: 'n1', children: [] }
  }, { current_node: 'n2' }));
  const ids = new Set(result.messages.map(m => m.node_id));
  assert('every non-root parent_id is some row\'s message id',
    result.messages.every(m => m.parent_id === 'n0' || ids.has(m.parent_id)),
    JSON.stringify(result.messages.map(m => [m.node_id, m.parent_id])));
  assert('message url rows use the same id as the message row', ids.has(result.messageUrls[0].message_id), result.messageUrls[0].message_id);
  assert('visible path follows the same ids', result.messages.every(m => m.on_visible_path === true));
}

console.log(`\nChatGPT robustness tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
