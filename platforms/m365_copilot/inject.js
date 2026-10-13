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
 * Frames are deduped per (requestId, author, messageType) keeping the longest
 * `text` observed, which collapses incremental streaming updates into one row
 * per final message without us having to track per-provider streaming styles.
 */

(function () {
  'use strict';

  const PLATFORM = 'M365Copilot';
  const MESSAGE_TYPE = 'M365_COPILOT_CONVERSATION_DATA';
  const SOURCE_ID = 'm365-copilot-exporter-inject';

  const IS_PRODUCTION = true;
  const DEBUG_MODE = false;

  // Max raw bytes a single socket may buffer before we drop its capture. Keeps
  // a runaway stream from blowing out memory on the page.
  const MAX_BUFFER_BYTES = 50 * 1024 * 1024;

  // How long to wait after the last incoming frame before flushing the
  // accumulated conversation to the content script. The authoritative flush
  // happens on type:2 and type:3 frames (end-of-turn); this debounce is only
  // for pushing in-progress snapshots so the popup can show progress.
  const FLUSH_DEBOUNCE_MS = 500;

  // If no incoming frames arrive for this long after a turn starts, treat the
  // stream as complete even without explicit type:3 / turnState signals. This
  // is the safety net for cases where the completion frame is missed or
  // dropped — the user can still export rather than being stuck forever.
  const IDLE_COMPLETION_MS = 5000;

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
   * Capture state for one Chathub socket. We index messages by a stable key so
   * repeated streaming deltas collapse to one final row.
   */
  function makeSocketCapture(url) {
    return {
      url,
      conversationId: extractConversationIdFromUrl(url),
      // Rolling buffer of raw incoming bytes until we see record separators.
      incomingBuffer: '',
      incomingBytes: 0,
      // Dedup keyed strictly by messageId (or synthetic key below).
      messages: new Map(),
      metadata: {
        session_id: '',
        source: '',
        first_frame_at: null,
        last_frame_at: null
      },
      // Flips true when we see the SignalR `type: 3` completion frame, a
      // `turnState: "Completed"` marker (on item or any message), or when the
      // socket goes idle for IDLE_COMPLETION_MS after streaming started.
      // Content.js uses this to decide whether to allow Export.
      // Resets to false when a new outgoing `type: 4` chat invocation starts.
      isComplete: false,
      flushTimer: null,
      idleTimer: null
    };
  }

  function armIdleCompletion(cap) {
    if (cap.idleTimer) clearTimeout(cap.idleTimer);
    cap.idleTimer = setTimeout(() => {
      cap.idleTimer = null;
      if (!cap.isComplete) {
        cap.isComplete = true;
        logDebug('Marked complete via idle timeout');
        flushCapture(cap);
      }
    }, IDLE_COMPLETION_MS);
  }

  const captures = new WeakMap();
  // Parallel array of captures so the diagnostic snapshot can enumerate them.
  // The WeakMap keeps us GC-safe; this array is a weak list we prune on close.
  const allCaptures = [];

  /**
   * Each M365 Copilot message carries a stable `messageId`. We dedupe strictly
   * on that so streaming updates to the same message collapse to one row and
   * the N `suggestedResponses` (which share requestId + author) don't collide.
   * Messages lacking a messageId fall back to a composite key.
   */
  function keyForMessage(m) {
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
    return `fallback::${rid}::${author}::${type}`;
  }

  /**
   * Merge a message into the capture, keeping the longest observed `text`
   * (streaming updates ship incremental snapshots) and the richest arrays.
   */
  function mergeMessage(cap, m) {
    if (!m || typeof m !== 'object') return;
    const key = keyForMessage(m);
    const existing = cap.messages.get(key);
    if (!existing) {
      cap.messages.set(key, { ...m });
      return;
    }
    const existingText = typeof existing.text === 'string' ? existing.text : '';
    const incomingText = typeof m.text === 'string' ? m.text : '';
    if (incomingText.length >= existingText.length) {
      existing.text = incomingText;
    }
    for (const field of ['sourceAttributions', 'suggestedResponses', 'adaptiveCards']) {
      if (Array.isArray(m[field])) {
        if (!Array.isArray(existing[field]) || m[field].length > existing[field].length) {
          existing[field] = m[field];
        }
      }
    }
    for (const field of [
      'spokenText', 'messageType', 'createdAt', 'timestamp',
      'contentOrigin', 'turnState', 'responseIdentifier', 'offense',
      'requestId', 'inputMethod', 'turnCount'
    ]) {
      if (m[field] !== undefined && (existing[field] === undefined || existing[field] === '' || existing[field] === 'Unknown')) {
        existing[field] = m[field];
      }
    }
  }

  function scheduleFlush(ws, cap) {
    if (cap.flushTimer) clearTimeout(cap.flushTimer);
    cap.flushTimer = setTimeout(() => flushCapture(cap), FLUSH_DEBOUNCE_MS);
  }

  async function flushCapture(cap) {
    cap.flushTimer = null;
    if (!cap.conversationId) {
      logDebug('Skipping flush: no conversationId on this socket');
      return;
    }
    if (cap.messages.size === 0) {
      logDebug('Skipping flush: no messages captured yet');
      return;
    }

    const results = Array.from(cap.messages.values());
    const payload = {
      conversationId: cap.conversationId,
      results,
      isComplete: cap.isComplete,
      metadata: {
        ...cap.metadata,
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
        conversationId: cap.conversationId,
        messageCount: results.length
      });
    } catch (e) {
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

  function handleIncomingFrame(ws, cap, frame) {
    cap.metadata.last_frame_at = new Date().toISOString();
    if (!cap.metadata.first_frame_at) cap.metadata.first_frame_at = cap.metadata.last_frame_at;

    // type: 6 = Ping — skip. Also skip handshake responses (no .type).
    if (!frame || frame.type === 6) return;

    // Completion frame marks end of a chat turn — flush immediately so the
    // user gets fresh data without the debounce delay. Mark isComplete so
    // the popup unlocks the Export button.
    if (frame.type === 3) {
      cap.isComplete = true;
      if (cap.flushTimer) { clearTimeout(cap.flushTimer); cap.flushTimer = null; }
      flushCapture(cap);
      return;
    }

    // The authoritative final payload is `type: 2` with `item.{messages,
    // conversationId, defaultChatName}`. Prefer its conversationId over the
    // one we parsed from the socket URL, capture the chat title, and treat
    // `turnState: "Completed"` as a completion signal in case type:3 is
    // delayed or lost.
    if (frame.type === 2 && frame.item && typeof frame.item === 'object') {
      if (typeof frame.item.conversationId === 'string' && frame.item.conversationId) {
        cap.conversationId = frame.item.conversationId;
      }
      if (typeof frame.item.defaultChatName === 'string' && frame.item.defaultChatName) {
        cap.metadata.default_chat_name = frame.item.defaultChatName;
      }
      if (frame.item.result && typeof frame.item.result.value === 'string') {
        cap.metadata.last_result = frame.item.result.value;
      }
      if (frame.item.turnState === 'Completed') {
        cap.isComplete = true;
      }
    }

    // Also pull suggestedResponses onto the capture as standalone messages so
    // researchers see what Copilot proposed. They nest under each bot message
    // but share the same requestId; emit them as separate rows for CSV grain.
    const messages = extractMessagesFromFrame(frame);
    for (const m of messages) {
      mergeMessage(cap, m);
      // A per-message turnState of "Completed" on a bot reply is as strong a
      // completion signal as the item-level one — treat it the same.
      if (m && m.author === 'bot' && m.turnState === 'Completed') {
        cap.isComplete = true;
      }
      if (Array.isArray(m.suggestedResponses)) {
        for (const s of m.suggestedResponses) mergeMessage(cap, s);
      }
    }
    if (messages.length > 0) {
      scheduleFlush(ws, cap);
      // Any incoming activity re-arms the idle completion timer so quick
      // responses don't get prematurely marked complete during a slow pause.
      armIdleCompletion(cap);
    }
  }

  function handleOutgoingFrame(ws, cap, frame) {
    const prompt = extractOutgoingPrompt(frame);
    if (prompt) {
      // A new chat invocation starts a fresh turn — un-mark completion so the
      // popup locks Export again until this turn finishes streaming. Arm the
      // idle-completion safety net so even if the end-of-turn signal is lost
      // we eventually unlock Export.
      cap.isComplete = false;
      armIdleCompletion(cap);
      mergeMessage(cap, prompt);
      // Pick up session metadata from the invocation envelope the first time
      // we see one; useful for the exported CSV.
      const env = Array.isArray(frame.arguments) ? frame.arguments[0] : null;
      if (env) {
        if (!cap.metadata.session_id && typeof env.sessionId === 'string') {
          cap.metadata.session_id = env.sessionId;
        }
        if (!cap.metadata.source && typeof env.source === 'string') {
          cap.metadata.source = env.source;
        }
      }
      scheduleFlush(ws, cap);
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
    captures.set(ws, cap);
    allCaptures.push(cap);
    logDebug('Instrumented Chathub socket', { conversationId: cap.conversationId });

    ws.addEventListener('message', e => {
      // Chathub frames are text. Binary frames (if any) are ignored — we only
      // know how to parse SignalR JSON.
      if (typeof e.data !== 'string') return;
      cap.incomingBuffer += e.data;
      cap.incomingBytes += e.data.length;
      if (cap.incomingBytes > MAX_BUFFER_BYTES) {
        logWarn('Incoming buffer exceeded limit, dropping socket capture');
        cap.incomingBuffer = '';
        return;
      }
      cap.incomingBuffer = parseFrames(cap.incomingBuffer, frame => handleIncomingFrame(ws, cap, frame));
    });

    ws.addEventListener('close', () => {
      // Final flush on close in case the stream ended without an idle gap.
      flushCapture(cap);
    });

    const originalSend = ws.send.bind(ws);
    ws.send = function (data) {
      try {
        if (typeof data === 'string') {
          parseFrames(data, frame => handleOutgoingFrame(ws, cap, frame));
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

  // Diagnostic snapshot exposed to the page console. Read-only summary of
  // every instrumented socket's current capture state. Use from DevTools:
  //   window.__m365CopilotDebug()
  // Returns conversationId, isComplete, message counts, metadata — nothing
  // that would leak the access_token or raw frames.
  try {
    Object.defineProperty(window, '__m365CopilotDebug', {
      value: () => {
        const out = allCaptures.map(c => ({
          conversationId: c.conversationId,
          isComplete: c.isComplete,
          messageCount: c.messages.size,
          messageTypes: Array.from(c.messages.values())
            .map(m => `${m.author || '?'}:${m.messageType || '-'}`)
            .reduce((acc, k) => { acc[k] = (acc[k] || 0) + 1; return acc; }, {}),
          hasFlushTimer: Boolean(c.flushTimer),
          hasIdleTimer: Boolean(c.idleTimer),
          firstFrameAt: c.metadata.first_frame_at,
          lastFrameAt: c.metadata.last_frame_at,
          chatTitle: c.metadata.default_chat_name || null
        }));
        return {
          note: 'Live capture state. For raw frames, re-run the shadow-capture snippet.',
          sockets: out.length ? out : '(no Chathub sockets instrumented in this page lifetime)'
        };
      },
      writable: false,
      configurable: false
    });
  } catch { /* page may have already defined something; ignore */ }

})();
