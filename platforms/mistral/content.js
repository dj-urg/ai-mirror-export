/**
 * Mistral (Le Chat / Vibe) Platform - Content Script
 *
 * - Reads the signing secret written by inject.js (MAIN world).
 * - Listens for conversation data via window.postMessage.
 * - Mistral splits conversation state across two tRPC procedures:
 *     chat.byId    → the chat record (title, timestamps, modelConfig, ...)
 *     message.all  → the array of message items
 *   Each arrives independently, so we merge them per chatId before storing.
 * - Stores conversations in memory for the popup to export on demand.
 * - Forwards export requests to the background for CSV generation.
 */

(function () {
  'use strict';

  const PLATFORM = 'Mistral';
  const MESSAGE_TYPE = 'MISTRAL_CONVERSATION_DATA';
  const SOURCE_ID = 'mistral-exporter-inject';

  const IS_PRODUCTION = true;
  const DEBUG_MODE = false;

  const MAX_STORED_CONVERSATIONS = 50;
  const MAX_CONVERSATION_AGE_MS = 3600000; // 1 hour
  const CLEANUP_INTERVAL_MS = 300000; // 5 minutes

  // `capturedConversations` is keyed by chatId and holds a merged record:
  //   { chatId, chat, messages, mergedAt }
  // where `chat` is the chat.byId payload (nullable until it arrives) and
  // `messages` is the array returned by message.all (nullable until it
  // arrives). Export is unlocked once `messages` is present, matching the
  // other platforms where messages are the minimum viable payload.
  const capturedConversations = new Map();
  const conversationTimestamps = new Map();

  // ==========================================================================
  // SECRET BRIDGE — XRay-wrapper-safe attribute read.
  // ==========================================================================
  const _ATTR = 'data-mistral-exporter-secret';
  let SECRET_KEY = document.documentElement.getAttribute(_ATTR) || null;
  if (SECRET_KEY) {
    document.documentElement.removeAttribute(_ATTR);
  } else {
    const _secretObserver = new MutationObserver(() => {
      const s = document.documentElement.getAttribute(_ATTR);
      if (s) {
        SECRET_KEY = s;
        document.documentElement.removeAttribute(_ATTR);
        _secretObserver.disconnect();
      }
    });
    _secretObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [_ATTR]
    });
  }

  // ==========================================================================
  // LOGGING
  // ==========================================================================

  function redactSensitiveData(data) {
    if (!data || typeof data !== 'object') return data;
    const redacted = Array.isArray(data) ? [...data] : { ...data };
    if (redacted.chatId && typeof redacted.chatId === 'string') {
      redacted.chatId = redacted.chatId.substring(0, 8) + '...';
    }
    if (redacted.conversationId && typeof redacted.conversationId === 'string') {
      redacted.conversationId = redacted.conversationId.substring(0, 8) + '...';
    }
    if (redacted.id && typeof redacted.id === 'string' && redacted.id.length > 16) {
      redacted.id = redacted.id.substring(0, 8) + '...';
    }
    return redacted;
  }

  function logDebug(message, data = null) {
    if (!DEBUG_MODE) return;
    if (data) console.log(`[${PLATFORM}] [DEBUG]`, message, redactSensitiveData(data));
    else console.log(`[${PLATFORM}] [DEBUG]`, message);
  }

  function logInfo(message, data = null) {
    if (IS_PRODUCTION) return;
    if (data) console.log(`[${PLATFORM}]`, message, redactSensitiveData(data));
    else console.log(`[${PLATFORM}]`, message);
  }

  function logWarn(message, data = null) {
    if (IS_PRODUCTION) return;
    if (data) console.warn(`[${PLATFORM}] [WARN]`, message, redactSensitiveData(data));
    else console.warn(`[${PLATFORM}] [WARN]`, message);
  }

  // ==========================================================================
  // MEMORY MANAGEMENT
  // ==========================================================================

  function evictOldestIfFull() {
    if (capturedConversations.size < MAX_STORED_CONVERSATIONS) return;
    let oldestId = null;
    let oldestTime = Infinity;
    for (const [id, ts] of conversationTimestamps.entries()) {
      if (ts < oldestTime) { oldestTime = ts; oldestId = id; }
    }
    if (oldestId) {
      capturedConversations.delete(oldestId);
      conversationTimestamps.delete(oldestId);
      logDebug('Memory limit reached. Evicted oldest conversation', { chatId: oldestId });
    }
  }

  function mergeCapture(chatId, patch) {
    evictOldestIfFull();
    const existing = capturedConversations.get(chatId) || { chatId, chat: null, messages: null };
    const merged = {
      chatId,
      chat: patch.chat !== undefined ? patch.chat : existing.chat,
      messages: patch.messages !== undefined ? patch.messages : existing.messages,
      mergedAt: Date.now()
    };
    capturedConversations.set(chatId, merged);
    conversationTimestamps.set(chatId, merged.mergedAt);
    return merged;
  }

  function cleanupOldConversations() {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, ts] of conversationTimestamps.entries()) {
      if (now - ts > MAX_CONVERSATION_AGE_MS) {
        capturedConversations.delete(id);
        conversationTimestamps.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logDebug(`Cleaned up ${cleaned} old conversation(s)`, { remaining: capturedConversations.size });
    }
  }
  setInterval(cleanupOldConversations, CLEANUP_INTERVAL_MS);

  // ==========================================================================
  // ACTIVE FETCH — fast path for when the popup opens right after navigating
  // to a chat and the passive intercept has not seen the request yet, or when
  // the user has only one of the two pieces (chat.byId arrived but
  // message.all did not, or vice versa).
  // ==========================================================================

  let activeFetchInFlight = null;

  // Mistral exposes conversations under two URL shapes:
  //   /chat/<uuid>  — regular chat
  //   /work/<uuid>  — the "Vibe" / work product surface
  // Both resolve to the same chatId server-side, so match either.
  function extractConversationIdFromPath() {
    const m = window.location.pathname.match(
      /\/(?:chat|work)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
    );
    return m ? m[1] : null;
  }

  function isConversationComplete(record) {
    return !!(record && Array.isArray(record.messages) && record.messages.length > 0);
  }

  async function fetchTrpc(procedure, input) {
    const body = { "0": { "json": input } };
    const url = `/api/trpc/${procedure}?batch=1&input=${encodeURIComponent(JSON.stringify(body))}`;
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw new Error(`${procedure} ${resp.status}`);
    const data = await resp.json();
    const json = Array.isArray(data) && data[0] && data[0].result && data[0].result.data
      ? data[0].result.data.json
      : null;
    return json;
  }

  async function activelyFetchAndStore(chatId) {
    if (!chatId) return null;
    const existing = capturedConversations.get(chatId);
    if (isConversationComplete(existing) && existing.chat) return existing;
    if (activeFetchInFlight) {
      try { await activeFetchInFlight; } catch (_) {}
      const after = capturedConversations.get(chatId);
      if (isConversationComplete(after) && after.chat) return after;
    }
    activeFetchInFlight = (async () => {
      try {
        // Fire both requests in parallel: chat.byId and message.all.
        const [chat, messagesPayload] = await Promise.all([
          fetchTrpc('chat.byId', { id: chatId }).catch(() => null),
          fetchTrpc('message.all', { chatId }).catch(() => null)
        ]);
        const messages = messagesPayload && Array.isArray(messagesPayload.items)
          ? messagesPayload.items
          : null;
        if (!messages) return null;
        const merged = mergeCapture(chatId, { chat, messages });
        logDebug('Actively fetched conversation', {
          chatId,
          messageCount: messages.length,
          hasChatMeta: !!chat
        });
        browser.runtime.sendMessage({
          type: 'CONVERSATION_READY',
          platform: 'mistral',
          conversationId: chatId
        }).catch(() => { /* popup may not be open */ });
        return merged;
      } catch (e) {
        logWarn('Active fetch failed', { error: e.message });
        return null;
      }
    })();
    try {
      return await activeFetchInFlight;
    } finally {
      activeFetchInFlight = null;
    }
  }

  function kickoffIfOnChatPage() {
    const chatId = extractConversationIdFromPath();
    if (chatId) activelyFetchAndStore(chatId).catch(() => {});
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', kickoffIfOnChatPage, { once: true });
  } else {
    kickoffIfOnChatPage();
  }

  // SPA navigation: Mistral swaps conversations without a full page reload.
  let _lastPath = window.location.pathname;
  setInterval(() => {
    if (window.location.pathname !== _lastPath) {
      _lastPath = window.location.pathname;
      kickoffIfOnChatPage();
    }
  }, 1500);

  // ==========================================================================
  // SIGNED MESSAGE VERIFICATION
  // ==========================================================================

  // Replay protection: each signed message carries a random nonce; accept a
  // nonce once within the 30 s timestamp window and remember it until the
  // window has passed.
  const seenNonces = new Map();
  function isReplayedNonce(nonce) {
    const now = Date.now();
    for (const [n, ts] of seenNonces) {
      if (now - ts > 30000) seenNonces.delete(n);
    }
    if (typeof nonce !== 'string' || !nonce || seenNonces.has(nonce)) return true;
    seenNonces.set(nonce, now);
    return false;
  }

  async function verifySignature(message, signature, secret) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sigBuf = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
    const expected = Array.from(new Uint8Array(sigBuf), b => b.toString(16).padStart(2, '0')).join('');
    if (signature.length !== expected.length) return false;
    let result = 0;
    for (let i = 0; i < signature.length; i++) {
      result |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return result === 0;
  }

  window.addEventListener('message', async event => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    if (!event.data || event.data.type !== MESSAGE_TYPE) return;

    if (event.data.source !== SOURCE_ID) {
      logWarn('Message source mismatch', { source: event.data.source });
      return;
    }
    if (!event.data.signature || !event.data.timestamp || !event.data.nonce) {
      logWarn('Message missing security fields');
      return;
    }
    const age = Date.now() - event.data.timestamp;
    if (age < 0 || age > 30000) {
      logWarn('Message timestamp out of valid range');
      return;
    }

    const { signature, ...messageData } = event.data;
    const messageString = JSON.stringify(messageData);
    const isValid = await verifySignature(messageString, signature, SECRET_KEY);
    if (!isValid) {
      logWarn('Invalid message signature');
      return;
    }
    if (isReplayedNonce(event.data.nonce)) {
      logWarn('Replayed message nonce');
      return;
    }

    const partial = event.data.payload;
    if (!partial || typeof partial !== 'object') {
      logWarn('Received message without a usable payload');
      return;
    }

    const chatId = typeof partial.chatId === 'string' ? partial.chatId : null;
    if (!chatId || !/^[A-Za-z0-9._:-]{1,128}$/.test(chatId)) {
      logWarn('Received payload with missing or malformed chatId');
      return;
    }

    const patch = {};
    if (partial.kind === 'chat' && partial.chat && typeof partial.chat === 'object') {
      patch.chat = partial.chat;
    } else if (partial.kind === 'messages' && Array.isArray(partial.messages)) {
      patch.messages = partial.messages;
    } else {
      return;
    }

    const merged = mergeCapture(chatId, patch);
    logDebug('Stored conversation partial', {
      chatId,
      kind: partial.kind,
      messageCount: Array.isArray(merged.messages) ? merged.messages.length : 0,
      hasChatMeta: !!merged.chat
    });

    // Only notify when the record is actually exportable (has messages).
    if (isConversationComplete(merged)) {
      browser.runtime.sendMessage({
        type: 'CONVERSATION_READY',
        platform: 'mistral',
        conversationId: chatId
      }).catch(() => { /* popup might not be open */ });
    }
  });

  // ==========================================================================
  // POPUP / BACKGROUND MESSAGES
  // ==========================================================================

  function titleForRecord(record) {
    const chat = record && record.chat;
    if (!chat || typeof chat !== 'object') return 'Untitled Conversation';
    return chat.userTitle || chat.generatedTitle || chat.title || 'Untitled Conversation';
  }

  function assemblePayload(record) {
    // The payload shipped to the background script bundles both halves plus
    // the stamped chatId that downstream code uses for filenames + manifest.
    const payload = {
      _captured_conversation_id: record.chatId,
      chat: record.chat || null,
      messages: Array.isArray(record.messages) ? record.messages : []
    };
    return payload;
  }

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!sender || sender.id !== browser.runtime.id) {
      logWarn('Message from unauthorized sender', { senderId: sender?.id });
      return;
    }
    if (!message || typeof message.type !== 'string') {
      logWarn('Invalid message structure');
      return;
    }

    if (message.type === 'GET_CAPTURED_CONVERSATIONS') {
      const urlConvId = extractConversationIdFromPath();
      const existing = urlConvId ? capturedConversations.get(urlConvId) : null;
      const needActive = urlConvId && !isConversationComplete(existing);

      const respond = () => {
        const conversations = Array.from(capturedConversations.entries())
          // Only surface records that have at least the message list — a bare
          // chat.byId with no messages is not exportable.
          .filter(([, data]) => isConversationComplete(data))
          .map(([id, data]) => ({
            id,
            title: titleForRecord(data)
          }));
        sendResponse({
          success: true,
          conversations,
          conversationIds: conversations.map(c => c.id),
          platform: 'mistral'
        });
      };

      if (needActive) {
        activelyFetchAndStore(urlConvId).finally(respond);
        return true;
      }
      respond();
      return false;
    }

    if (message.type === 'EXPORT_CONVERSATION' && message.platform === 'mistral') {
      const conversationId = message.conversationId;

      const forward = (data) => {
        browser.runtime.sendMessage({
          type: MESSAGE_TYPE,
          payload: data,
          platform: 'mistral'
        }).then(() => sendResponse({ success: true }))
          .catch(error => sendResponse({ success: false, error: error.message }));
      };

      const existing = capturedConversations.get(conversationId);
      if (!isConversationComplete(existing)) {
        activelyFetchAndStore(conversationId).then(data => {
          if (!isConversationComplete(data)) {
            sendResponse({
              success: false,
              error: 'Conversation not found. Please reload the page and try again.'
            });
            return;
          }
          forward(assemblePayload(data));
        });
        return true;
      }
      forward(assemblePayload(existing));
      return true;
    }

    return false;
  });

  logInfo('Content script loaded');

})();
