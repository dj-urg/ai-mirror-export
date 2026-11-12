/**
 * Microsoft 365 Copilot - Page Context Script (inject.js)
 *
 * M365 Copilot (BizChat) streams conversation data over a SignalR WebSocket to
 * substrate.office.com/m365Copilot/Chathub/{oid}@{tid}. There is no REST
 * history endpoint we can hook. This script wraps window.WebSocket in the MAIN
 * world and parses SignalR 0x1E-framed JSON frames to capture both the user's
 * prompts (outgoing `type: 4` StreamInvocation to `chat`) and the model's
 * streamed responses (incoming `type: 2` StreamItem / `type: 3` Completion).
 *
 * Messages are kept per conversation (shared by every socket that carries
 * it) and deduped by messageId. Streaming updates collapse into one row per
 * message; the authoritative `type: 2` copy replaces what was streamed.
 */

(function () {
  'use strict';

  const PLATFORM = 'M365Copilot';
  const MESSAGE_TYPE = 'M365_COPILOT_CONVERSATION_DATA';
  const SOURCE_ID = 'm365-copilot-exporter-inject';

  const IS_PRODUCTION = true;
  const DEBUG_MODE = false;

  // Max size of one unparsed (incomplete) frame. Complete frames are parsed
  // and released as they arrive, so this bounds the buffer, not the amount
  // of traffic a long session may carry. Keeps a runaway frame from blowing
  // out memory on the page.
  const MAX_FRAME_CHARS = 50 * 1024 * 1024;

  // How many conversations to keep message maps for in this page.
  const MAX_TRACKED_CONVERSATIONS = 20;

  // How long to wait after the last incoming frame before flushing the
  // accumulated conversation to the content script. The authoritative flush
  // happens on type:2 and type:3 frames (end-of-turn); this debounce is only
  // for pushing in-progress snapshots so the popup can show progress.
  const FLUSH_DEBOUNCE_MS = 500;

  // If no incoming frames arrive for this long after a turn starts, treat the
  // stream as complete even without explicit type:3 / turnState signals. This
  // is the safety net for cases where the completion frame is missed or
  // dropped — the user can still export rather than being stuck forever.
  // It has to outlast the pause before the first token (grounding and search
  // can take well over 5 s). A turn completed this way is reported with
  // completionReason 'idle_timeout' so the export can be labelled.
  const IDLE_COMPLETION_MS = 30000;

  // SignalR record separator.
  const RS = '';

  const originalWebSocket = window.WebSocket;
  const originalPostMessage = window.postMessage.bind(window);
  const originalMessageSecurity = window.MessageSecurity;

  // Generate the signing secret in MAIN world at document_start, before any
  // page scripts run. Content script picks it up via data attribute and
  // immediately removes it; same handshake as the other platforms.
  const storedSecret = (() => {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
  })();
  document.documentElement.setAttribute('data-m365-copilot-exporter-secret', storedSecret);

  function redactSensitiveData(data) {
    if (!data || typeof data !== 'object') return data;
    const redacted = Array.isArray(data) ? [...data] : { ...data };
    if (typeof redacted.conversationId === 'string') {
      redacted.conversationId = redacted.conversationId.substring(0, 8) + '...';
    }
    if (typeof redacted.requestId === 'string') {
      redacted.requestId = redacted.requestId.substring(0, 8) + '...';
    }
    return redacted;
  }

  function logDebug(message, data = null) {
    if (!DEBUG_MODE) return;
    if (data) console.log(`[${PLATFORM}] [DEBUG]`, message, redactSensitiveData(data));
    else console.log(`[${PLATFORM}] [DEBUG]`, message);
  }

  function logWarn(message, data = null) {
    if (IS_PRODUCTION) return;
    if (data) console.warn(`[${PLATFORM}] [WARN]`, message, redactSensitiveData(data));
    else console.warn(`[${PLATFORM}] [WARN]`, message);
  }

  /**
   * Extract conversationId from the Chathub WebSocket URL's query string.
   * The URL also contains an access_token JWT; we never read or log it.
   */
  function extractConversationIdFromUrl(url) {
    try {
      const u = new URL(url);
      const id = u.searchParams.get('ConversationId') || u.searchParams.get('conversationId');
      if (id && /^[A-Za-z0-9._:-]{1,128}$/.test(id)) return id;
    } catch { /* fall through */ }
    return null;
  }

  /**
   * Is this URL the M365 Copilot Chathub SignalR socket?
   */
  function isChathubUrl(url) {
    if (typeof url !== 'string') return false;
    return /^wss:\/\/substrate\.office\.com\/m365Copilot\/Chathub\//i.test(url);
  }

  /**
   * Pull a plausible array of chat messages out of a parsed SignalR item.
   * BizChat/Sydney wraps the payload under `arguments[0]` for `type: 1`
   * invocations and directly under `item` for `type: 2` stream items; final
   * state can also sit under `result.value` of a `type: 3` completion. We try
   * each location and take the first array that has `author` + `text` shape.
   */
  function extractMessagesFromFrame(frame) {
    if (!frame || typeof frame !== 'object') return [];

    const candidates = [];
    if (Array.isArray(frame.arguments) && frame.arguments[0]) {
      candidates.push(frame.arguments[0]);
    }
    if (frame.item && typeof frame.item === 'object') {
      candidates.push(frame.item);
    }
    if (frame.result && typeof frame.result === 'object') {
      candidates.push(frame.result);
      if (frame.result.value && typeof frame.result.value === 'object') {
        candidates.push(frame.result.value);
      }
    }

    for (const c of candidates) {
      if (c && Array.isArray(c.messages) && c.messages.length > 0) {
        return c.messages;
      }
    }
    return [];
  }

  /**
   * Pull a chat prompt (user message) out of an outgoing `type: 4` frame
   * targeting the `chat` method. The user's text lives under
   * `arguments[0].message.{author,text,...}`. The outgoing message has no
   * `messageId`, but Sydney sets `messageId === requestId` in the final type:2
   * frame — keyForMessage() handles that collapse.
   */
  function extractOutgoingPrompt(frame) {
    if (!frame || frame.target !== 'chat') return null;
    const args = Array.isArray(frame.arguments) ? frame.arguments[0] : null;
    const msg = args && args.message;
    if (!msg || typeof msg !== 'object') return null;
    return msg;
  }

  /**
   * Capture state for one conversation. Sockets come and go (reconnects, an
   * idle close, sometimes one socket per turn), so messages are kept per
   * conversationId and shared by every socket that carries that conversation.
   * Messages are indexed by a stable key so repeated streaming updates
   * collapse to one final row.
   */
  function makeConversationCapture(conversationId) {
    return {
      conversationId,
      messages: new Map(),
      // Keys whose message came from an authoritative type:2 frame. Streaming
      // updates never overwrite these.
      finalKeys: new Set(),
      // Outgoing prompts that carried no requestId, by synthetic key, until
      // the type:2 frame delivers the server's copy of the same prompt.
      pendingPromptKeys: new Set(),
      promptCounter: 0,
      metadata: {
        session_id: '',
        source: '',
        first_frame_at: null,
        last_frame_at: null
      },
      // Flips true on the SignalR `type: 3` completion frame, on a
      // `turnState: "Completed"` marker (item or bot message), or when the
      // conversation goes idle for IDLE_COMPLETION_MS. Content.js uses this
      // to decide whether to allow Export. Resets to false when a new
      // outgoing `type: 4` chat invocation starts, and when streaming resumes
      // after an idle-only completion.
      isComplete: false,
      // How the current turn was marked complete: 'type3', 'turn_state' or
      // 'idle_timeout'. Null while the turn is open.
      completionReason: null,
      // True once the server has signalled the end of the current turn.
      // Idle completion does not set it, so late frames can re-open the turn.
      turnEnded: false,
      // Set when an oversized frame had to be dropped; the capture may be
      // missing content and the export is labelled accordingly.
      truncated: false,
      // True when something changed since the last flush.
      dirty: false,
      lastChangedAt: 0,
      flushTimer: null,
      idleTimer: null
    };
  }

  // conversationId -> capture. Bounded: the least recently changed capture is
  // dropped once the limit is reached.
  const conversations = new Map();

  function getConversationCapture(conversationId) {
    let conv = conversations.get(conversationId);
    if (conv) return conv;
    if (conversations.size >= MAX_TRACKED_CONVERSATIONS) {
      let oldestId = null;
      let oldestAt = Infinity;
      for (const [id, c] of conversations) {
        if (c.lastChangedAt < oldestAt) { oldestAt = c.lastChangedAt; oldestId = id; }
      }
      if (oldestId !== null) {
        const old = conversations.get(oldestId);
        if (old.flushTimer) clearTimeout(old.flushTimer);
        if (old.idleTimer) clearTimeout(old.idleTimer);
        conversations.delete(oldestId);
      }
    }
    conv = makeConversationCapture(conversationId);
    conversations.set(conversationId, conv);
    return conv;
  }

  /**
   * Per-socket state: the raw frame buffer and a pointer to the conversation
   * the socket carries. The socket URL is deliberately not kept (it carries
   * an access_token); only the conversationId parsed from it is.
   */
  function makeSocketCapture(url) {
    const conversationId = extractConversationIdFromUrl(url);
    return {
      // Rolling buffer of incoming text until we see record separators.
      incomingBuffer: '',
      // True while the rest of a dropped oversized frame is being skipped.
      discardingFrame: false,
      // A socket whose URL carries no id gets a detached capture that is
      // adopted into the shared map once a frame names the conversation.
      conv: conversationId ? getConversationCapture(conversationId) : makeConversationCapture(null)
    };
  }

  function markChanged(conv) {
    conv.dirty = true;
    conv.lastChangedAt = Date.now();
  }

  function markComplete(conv, reason) {
    if (!conv.isComplete || conv.completionReason !== reason) markChanged(conv);
    conv.isComplete = true;
    conv.completionReason = reason;
    if (reason !== 'idle_timeout') conv.turnEnded = true;
    if (conv.idleTimer) { clearTimeout(conv.idleTimer); conv.idleTimer = null; }
  }

  function armIdleCompletion(conv) {
    if (conv.idleTimer) clearTimeout(conv.idleTimer);
    conv.idleTimer = setTimeout(() => {
      conv.idleTimer = null;
      if (!conv.isComplete) {
        markComplete(conv, 'idle_timeout');
        logDebug('Marked complete via idle timeout');
        flushCapture(conv);
      }
    }, IDLE_COMPLETION_MS);
  }

  /**
   * Point a socket at the conversation a frame names. Messages the socket
   * collected under another (or no) id move with it, so nothing captured
   * before the id was known is lost.
   */
  function adoptConversationId(cap, conversationId) {
    const from = cap.conv;
    if (from.conversationId === conversationId) return;
    if (from.conversationId && conversations.get(from.conversationId) === from) {
      conversations.delete(from.conversationId);
    }
    if (from.flushTimer) { clearTimeout(from.flushTimer); from.flushTimer = null; }
    if (from.idleTimer) { clearTimeout(from.idleTimer); from.idleTimer = null; }
    const existing = conversations.get(conversationId);
    if (!existing) {
      from.conversationId = conversationId;
      conversations.set(conversationId, from);
      markChanged(from);
      return;
    }
    for (const [key, m] of from.messages) {
      if (!existing.messages.has(key)) existing.messages.set(key, m);
    }
    for (const key of from.finalKeys) existing.finalKeys.add(key);
    for (const key of from.pendingPromptKeys) existing.pendingPromptKeys.add(key);
    for (const field of ['session_id', 'source', 'first_frame_at']) {
      if (!existing.metadata[field] && from.metadata[field]) existing.metadata[field] = from.metadata[field];
    }
    existing.isComplete = from.isComplete;
    existing.completionReason = from.completionReason;
    existing.turnEnded = from.turnEnded;
    existing.truncated = existing.truncated || from.truncated;
    markChanged(existing);
    cap.conv = existing;
  }

  /**
   * Each M365 Copilot message carries a stable `messageId`; dedupe strictly
   * on that so streaming updates to the same message collapse to one row.
   * Messages lacking a messageId fall back to a composite key; `ordinal`
   * (the position among same-keyed id-less messages in one frame) keeps two
   * such messages from collapsing into each other.
   */
  function keyForMessage(m, ordinal = 0) {
    if (m && typeof m.messageId === 'string' && m.messageId) return m.messageId;
    // Sydney sets `messageId === requestId` for the user's prompt in the
    // authoritative type:2 frame. Outgoing type:4 frames don't carry a
    // messageId yet, so key user messages by requestId to collapse them.
    if (m && m.author === 'user' && typeof m.requestId === 'string' && m.requestId) {
      return m.requestId;
    }
    const rid = (m && m.requestId) || '';
    const author = (m && m.author) || '';
    const type = (m && m.messageType) || '';
    return `fallback::${rid}::${author}::${type}::${ordinal}`;
  }

  /**
   * Keys for all messages of one frame, in order. Id-less messages that would
   * share a fallback key are numbered by position.
   */
  function keysForMessages(messages) {
    const seen = new Map();
    return messages.map(m => {
      const base = keyForMessage(m, 0);
      if (!base.startsWith('fallback::')) return base;
      const n = seen.get(base) || 0;
      seen.set(base, n + 1);
      return keyForMessage(m, n);
    });
  }

  const SCALAR_FIELDS = [
    'spokenText', 'messageType', 'createdAt', 'timestamp',
    'contentOrigin', 'turnState', 'responseIdentifier', 'offense',
    'requestId', 'inputMethod', 'turnCount'
  ];
  const ARRAY_FIELDS = ['sourceAttributions', 'suggestedResponses', 'adaptiveCards'];

  /**
   * Merge a message into the capture.
   *
   * A message from the authoritative type:2 frame (`isFinal`) replaces what
   * was streamed before, so a draft that the model later shortened or
   * retracted is not exported in place of the final answer. Fields the final
   * copy does not carry at all are kept from earlier frames (the outgoing
   * prompt has fields the echoed prompt lacks).
   *
   * Among streaming updates the longest `text` and the richest arrays win
   * (updates ship incremental snapshots), and scalar fields take the latest
   * non-empty value.
   */
  function mergeMessage(conv, m, key, isFinal) {
    if (!m || typeof m !== 'object') return;
    const existing = conv.messages.get(key);
    if (isFinal) {
      const next = { ...m };
      if (existing) {
        for (const field of Object.keys(existing)) {
          if (next[field] === undefined) next[field] = existing[field];
        }
      }
      conv.messages.set(key, next);
      conv.finalKeys.add(key);
      markChanged(conv);
      return;
    }
    if (!existing) {
      conv.messages.set(key, { ...m });
      markChanged(conv);
      return;
    }
    if (conv.finalKeys.has(key)) return;
    const existingText = typeof existing.text === 'string' ? existing.text : '';
    const incomingText = typeof m.text === 'string' ? m.text : '';
    if (incomingText.length >= existingText.length) {
      existing.text = incomingText;
    }
    for (const field of ARRAY_FIELDS) {
      if (Array.isArray(m[field])) {
        if (!Array.isArray(existing[field]) || m[field].length >= existing[field].length) {
          existing[field] = m[field];
        }
      }
    }
    for (const field of SCALAR_FIELDS) {
      if (m[field] !== undefined && m[field] !== '') {
        existing[field] = m[field];
      }
    }
    markChanged(conv);
  }

  /**
   * Record an outgoing prompt. A prompt without a requestId gets its own
   * synthetic key so two such prompts can never overwrite each other.
   */
  function mergeOutgoingPrompt(conv, prompt) {
    // Same key the server's copy will get: messageId, which Sydney sets to
    // the requestId for a user prompt.
    const id = (typeof prompt.messageId === 'string' && prompt.messageId) ||
      (typeof prompt.requestId === 'string' && prompt.requestId);
    if (id) {
      mergeMessage(conv, prompt, id, false);
      return;
    }
    const key = `prompt::${++conv.promptCounter}`;
    conv.pendingPromptKeys.add(key);
    mergeMessage(conv, prompt, key, false);
  }

  /**
   * The type:2 frame echoes the user's prompt with the id the server gave
   * it. If that prompt was recorded under a synthetic key, move it to the
   * server's key (same position) so it is not exported twice.
   */
  function reconcilePendingPrompt(conv, m, key) {
    if (!m || m.author !== 'user' || conv.messages.has(key)) return;
    for (const pendingKey of conv.pendingPromptKeys) {
      const pending = conv.messages.get(pendingKey);
      if (!pending || pending.text !== m.text) continue;
      const reordered = new Map();
      for (const [k, v] of conv.messages) reordered.set(k === pendingKey ? key : k, v);
      conv.messages = reordered;
      conv.pendingPromptKeys.delete(pendingKey);
      return;
    }
  }

  function scheduleFlush(conv) {
    if (conv.flushTimer) clearTimeout(conv.flushTimer);
    conv.flushTimer = setTimeout(() => flushCapture(conv), FLUSH_DEBOUNCE_MS);
  }

  async function flushCapture(conv) {
    if (conv.flushTimer) { clearTimeout(conv.flushTimer); conv.flushTimer = null; }
    if (!conv.conversationId) {
      logDebug('Skipping flush: no conversationId for this capture');
      return;
    }
    if (conv.messages.size === 0) {
      logDebug('Skipping flush: no messages captured yet');
      return;
    }
    if (!conv.dirty) {
      logDebug('Skipping flush: nothing changed since the last flush');
      return;
    }
    conv.dirty = false;

    const results = Array.from(conv.messages.values());
    const payload = {
      conversationId: conv.conversationId,
      results,
      isComplete: conv.isComplete,
      completionReason: conv.completionReason,
      truncated: conv.truncated,
      metadata: {
        ...conv.metadata,
        captured_at: new Date().toISOString()
      }
    };

    if (!storedSecret) {
      logWarn('Secret key not available, cannot send message');
      return;
    }

    try {
      const signed = await originalMessageSecurity.createSignedMessage(
        payload,
        MESSAGE_TYPE,
        SOURCE_ID,
        'm365_copilot',
        storedSecret
      );
      originalPostMessage(signed, window.location.origin);
      logDebug('Flushed conversation', {
        conversationId: conv.conversationId,
        messageCount: results.length
      });
    } catch (e) {
      conv.dirty = true;
      logWarn('Failed to sign/post captured conversation', { error: e.message });
    }
  }

  /**
   * Parse the rolling buffer: split on 0x1E, hand each complete frame to the
   * supplied handler, keep the trailing incomplete fragment for next time.
   */
  function parseFrames(buffer, onFrame) {
    const parts = buffer.split(RS);
    const trailing = parts.pop(); // may be '' or a partial frame
    for (const raw of parts) {
      if (!raw) continue;
      let frame;
      try {
        frame = JSON.parse(raw);
      } catch {
        continue;
      }
      try {
        onFrame(frame);
      } catch (e) {
        logWarn('Frame handler threw', { error: e.message });
      }
    }
    return trailing;
  }

  function handleIncomingFrame(cap, frame) {
    // type: 6 = Ping — skip. Also skip handshake responses (no .type).
    if (!frame || frame.type === 6) return;

    // The authoritative final payload is `type: 2` with `item.{messages,
    // conversationId, defaultChatName}`. Prefer its conversationId over the
    // one we parsed from the socket URL.
    const isFinalFrame = frame.type === 2 && frame.item && typeof frame.item === 'object';
    if (isFinalFrame && typeof frame.item.conversationId === 'string' &&
        /^[A-Za-z0-9._:-]{1,128}$/.test(frame.item.conversationId)) {
      adoptConversationId(cap, frame.item.conversationId);
    }
    const conv = cap.conv;

    conv.metadata.last_frame_at = new Date().toISOString();
    if (!conv.metadata.first_frame_at) conv.metadata.first_frame_at = conv.metadata.last_frame_at;

    // Completion frame marks end of a chat turn — flush immediately so the
    // user gets fresh data without the debounce delay. Mark isComplete so
    // the popup unlocks the Export button.
    if (frame.type === 3) {
      markComplete(conv, 'type3');
      flushCapture(conv);
      return;
    }

    // Capture the chat title and treat `turnState: "Completed"` as a
    // completion signal in case type:3 is delayed or lost.
    let completedByTurnState = false;
    if (isFinalFrame) {
      if (typeof frame.item.defaultChatName === 'string' && frame.item.defaultChatName) {
        conv.metadata.default_chat_name = frame.item.defaultChatName;
      }
      if (frame.item.result && typeof frame.item.result.value === 'string') {
        conv.metadata.last_result = frame.item.result.value;
      }
      if (frame.item.turnState === 'Completed') completedByTurnState = true;
    }

    // `suggestedResponses` stay on the bot message that carries them (the
    // export counts them there). They are not rows of their own: a suggestion
    // is text the user never sent.
    const messages = extractMessagesFromFrame(frame).filter(m => m && typeof m === 'object');
    const keys = keysForMessages(messages);
    messages.forEach((m, i) => {
      if (isFinalFrame) reconcilePendingPrompt(conv, m, keys[i]);
      mergeMessage(conv, m, keys[i], isFinalFrame);
      // A per-message turnState of "Completed" on a bot reply is as strong a
      // completion signal as the item-level one — treat it the same.
      if (m.author === 'bot' && m.turnState === 'Completed') completedByTurnState = true;
    });

    if (completedByTurnState) {
      markComplete(conv, 'turn_state');
    } else if (!conv.turnEnded) {
      // The turn is still open: streaming has not finished, whatever the
      // idle timer concluded during an earlier pause. Lock Export again and
      // restart the idle clock. Frames without messages (progress, throttling)
      // count as activity too.
      if (conv.isComplete) {
        conv.isComplete = false;
        conv.completionReason = null;
        markChanged(conv);
      }
      armIdleCompletion(conv);
    }
    if (conv.dirty) scheduleFlush(conv);
  }

  function handleOutgoingFrame(cap, frame) {
    const prompt = extractOutgoingPrompt(frame);
    if (prompt) {
      const conv = cap.conv;
      // A new chat invocation starts a fresh turn — un-mark completion so the
      // popup locks Export again until this turn finishes streaming. Arm the
      // idle-completion safety net so even if the end-of-turn signal is lost
      // we eventually unlock Export.
      conv.isComplete = false;
      conv.completionReason = null;
      conv.turnEnded = false;
      markChanged(conv);
      armIdleCompletion(conv);
      mergeOutgoingPrompt(conv, prompt);
      // Pick up session metadata from the invocation envelope the first time
      // we see one; useful for the exported CSV.
      const env = Array.isArray(frame.arguments) ? frame.arguments[0] : null;
      if (env) {
        if (!conv.metadata.session_id && typeof env.sessionId === 'string') {
          conv.metadata.session_id = env.sessionId;
        }
        if (!conv.metadata.source && typeof env.source === 'string') {
          conv.metadata.source = env.source;
        }
      }
      scheduleFlush(conv);
    }
  }

  /**
   * Wrap a single WebSocket instance so we see both directions.
   * Called from the Proxy constructor for newly-created sockets, which covers
   * the normal case where our document_start inject runs before the page
   * opens the Chathub connection.
   */
  function instrumentSocket(ws, url) {
    const cap = makeSocketCapture(url);
    logDebug('Instrumented Chathub socket', { conversationId: cap.conv.conversationId });

    ws.addEventListener('message', e => {
      // Only frames the browser delivered from the network: a synthetic
      // event dispatched by page script is not Copilot traffic.
      if (!e.isTrusted) return;
      // Chathub frames are text. Binary frames (if any) are ignored — we only
      // know how to parse SignalR JSON.
      if (typeof e.data !== 'string') return;
      let data = e.data;
      if (cap.discardingFrame) {
        // Skip the rest of an oversized frame, up to its record separator.
        const end = data.indexOf(RS);
        if (end === -1) return;
        data = data.slice(end + 1);
        cap.discardingFrame = false;
      }
      cap.incomingBuffer = parseFrames(cap.incomingBuffer + data, frame => handleIncomingFrame(cap, frame));
      // What remains is one incomplete frame. If that alone exceeds the
      // limit, drop it (and only it) and label the capture as truncated.
      if (cap.incomingBuffer.length > MAX_FRAME_CHARS) {
        logWarn('Incoming frame exceeded limit, dropping it');
        cap.incomingBuffer = '';
        cap.discardingFrame = true;
        cap.conv.truncated = true;
        markChanged(cap.conv);
        scheduleFlush(cap.conv);
      }
    });

    ws.addEventListener('close', () => {
      // Final flush on close in case the stream ended without an idle gap.
      // A no-op when nothing changed since the last flush.
      flushCapture(cap.conv);
    });

    const originalSend = ws.send.bind(ws);
    ws.send = function (data) {
      try {
        if (typeof data === 'string') {
          parseFrames(data, frame => handleOutgoingFrame(cap, frame));
        }
      } catch (e) {
        logWarn('Error parsing outgoing frame', { error: e.message });
      }
      return originalSend(data);
    };
  }

  // Replace the global WebSocket with a Proxy that transparently instruments
  // any Chathub socket the page constructs. Non-Chathub sockets pass through
  // untouched.
  window.WebSocket = new Proxy(originalWebSocket, {
    construct(target, args) {
      const ws = new target(...args);
      const url = String(args[0] || '');
      if (isChathubUrl(url)) {
        try { instrumentSocket(ws, url); } catch (e) { logWarn('instrumentSocket failed', { error: e.message }); }
      }
      return ws;
    }
  });
  // Preserve static properties the page may read off WebSocket.
  for (const prop of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
    try { window.WebSocket[prop] = originalWebSocket[prop]; } catch { /* ignore */ }
  }

  logDebug('WebSocket interceptor installed');

})();
