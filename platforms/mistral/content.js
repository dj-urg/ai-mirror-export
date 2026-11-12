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
  //   { chatId, chat, messages, mergedAt, messagesAt, source, complete, flags, seq }
  // where `chat` is the chat.byId payload (nullable until it arrives) and
  // `messages` is the array returned by message.all (nullable until it
  // arrives). Export is unlocked once `messages` is present, matching the
  // other platforms where messages are the minimum viable payload.
  // `messagesAt` / `source` / `complete` / `flags` describe how and when the
  // message list was captured; they are sent with the export as `capture`.
  const capturedConversations = new Map();
  const conversationTimestamps = new Map();

  // The signing secret is 32 random bytes, hex-encoded by inject.js.
  const SECRET_RE = /^[0-9a-f]{64}$/;
  const EXPORT_REFRESH_TIMEOUT_MS = 15000;
  // Upper bound on message.all pages followed in one fetch.
  const MAX_MESSAGE_PAGES = 50;

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

  function itemId(m) {
    return m && typeof m.id === 'string' && m.id ? m.id : null;
  }

  /**
   * Decide what a passively captured message list does to the stored one.
   * A capture must not degrade what is stored: one page of a longer list is
   * merged by message id; without ids it only replaces the stored list when
   * it is a whole list and not smaller.
   * Returns { messages, flags } or null when the stored list must stay.
   */
  function reconcilePassiveMessages(oldList, newList, partial) {
    if (!Array.isArray(oldList)) return { messages: newList, flags: partial ? ['partial_page'] : [] };
    if (oldList.every(itemId) && newList.every(itemId)) {
      const incomingIds = new Set(newList.map(itemId));
      if (!partial && oldList.every(m => incomingIds.has(itemId(m)))) {
        return { messages: newList, flags: [] };
      }
      // Keep what is stored, take the newer copy of the messages the capture
      // has, add the ones that are new. The extractor orders by createdAt,
      // so the position of the added ones does not matter.
      const byId = new Map(newList.map(m => [itemId(m), m]));
      const oldIds = new Set(oldList.map(itemId));
      const added = newList.filter(m => !oldIds.has(itemId(m)));
      if (added.length === 0 && newList.length === 0) return null;
      return {
        messages: added.concat(oldList.map(m => byId.get(itemId(m)) || m)),
        flags: ['passive_merged']
      };
    }
    if (!partial && newList.length >= oldList.length) return { messages: newList, flags: [] };
    return null;
  }

  /**
   * Store one half (or both) of a conversation.
   *   patch.chat      chat.byId record; null/undefined never overwrites a stored one
   *   patch.messages  message list; `info` says where it came from:
   *                   { source, complete, flags, seq, partial }
   * Active fetches replace the stored list; passive captures are reconciled.
   * Returns the stored record, or null when nothing was stored.
   */
  function mergeCapture(chatId, patch, info = {}) {
    const existing = capturedConversations.get(chatId);
    const now = Date.now();
    const merged = existing
      ? { ...existing }
      : { chatId, chat: null, messages: null, messagesAt: null, source: null, complete: null, flags: [], seq: 0 };

    if (patch.chat && typeof patch.chat === 'object') merged.chat = patch.chat;

    if (Array.isArray(patch.messages)) {
      let next = { messages: patch.messages, flags: info.flags || [] };
      if (info.source === 'passive') {
        next = reconcilePassiveMessages(merged.messages, patch.messages, info.partial === true);
      }
      if (next) {
        merged.messages = next.messages;
        merged.messagesAt = now;
        merged.source = info.source;
        merged.flags = next.flags;
        merged.complete = info.source === 'passive' ? null : info.complete;
        if (typeof info.seq === 'number') merged.seq = info.seq;
      } else if (!patch.chat) {
        return null;
      }
    }

    // Only a new id can push the cache over its limit; patching a stored
    // record must not evict anything (least of all the record itself).
    if (!existing) evictOldestIfFull();
    merged.mergedAt = now;
    capturedConversations.set(chatId, merged);
    conversationTimestamps.set(chatId, now);
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

  // One in-flight fetch per chat. `fetchSeq` orders fetches by start time so
  // a slow, older fetch can never overwrite the result of a newer one.
  const fetchesInFlight = new Map(); // chatId -> promise
  let fetchSeq = 0;

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

  async function fetchTrpc(procedure, input, signal) {
    const body = { "0": { "json": input } };
    const url = `/api/trpc/${procedure}?batch=1&input=${encodeURIComponent(JSON.stringify(body))}`;
    const resp = await fetch(url, { credentials: 'include', signal });
    if (!resp.ok) throw new Error(`${procedure} ${resp.status}`);
    const data = await resp.json();
    const json = Array.isArray(data) && data[0] && data[0].result && data[0].result.data
      ? data[0].result.data.json
      : null;
    return json;
  }

  /**
   * Fetch the message list, following `nextCursor` on the same procedure
   * until the list is exhausted. Resolves to { items, complete, paged }, or
   * null when the first page could not be read. `complete` is false when a
   * later page failed or the page limit was hit.
   */
  async function fetchAllMessages(chatId, signal) {
    const items = [];
    const seenIds = new Set();
    const seenCursors = new Set();
    let cursor;
    let complete = true;
    for (let page = 0; ; page++) {
      let payload = null;
      try {
        payload = await fetchTrpc('message.all', cursor === undefined ? { chatId } : { chatId, cursor }, signal);
      } catch (_) {
        payload = null;
      }
      if (!payload || !Array.isArray(payload.items)) {
        if (page === 0) return null;
        complete = false;
        break;
      }
      for (const item of payload.items) {
        const id = itemId(item);
        if (id && seenIds.has(id)) continue;
        if (id) seenIds.add(id);
        items.push(item);
      }
      const next = payload.nextCursor;
      if (next === undefined || next === null || next === '') break;
      const key = JSON.stringify(next);
      if (page + 1 >= MAX_MESSAGE_PAGES || seenCursors.has(key)) {
        complete = false;
        break;
      }
      seenCursors.add(key);
      cursor = next;
    }
    return { items, complete, paged: seenCursors.size > 0 || !complete };
  }

  /**
   * Fetch both halves from Mistral's own endpoints and store them.
   * Resolves to the stored record, or null when the message list could not
   * be read.
   */
  async function fetchAndStore(chatId, source, signal) {
    const seq = ++fetchSeq;
    try {
      // Fire both requests in parallel: chat.byId and message.all.
      const [chat, result] = await Promise.all([
        fetchTrpc('chat.byId', { id: chatId }, signal).catch(() => null),
        fetchAllMessages(chatId, signal)
      ]);
      if (!result) return null;
      const stored = capturedConversations.get(chatId);
      // A newer fetch has already stored its result: keep that one.
      if (stored && stored.seq > seq) return stored;
      // An empty list where messages are stored is treated as a failed read,
      // not as the new truth.
      if (result.items.length === 0 && isConversationComplete(stored)) return null;

      const flags = [];
      if (!result.complete) flags.push('pagination_incomplete');
      const merged = mergeCapture(chatId, { chat, messages: result.items }, {
        source,
        complete: result.complete,
        flags,
        seq
      });
      logDebug('Actively fetched conversation', {
        chatId,
        messageCount: result.items.length,
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
  }

  // Background fetch (page load, SPA navigation, popup open): serves the
  // stored record when both halves are there and joins a fetch already
  // under way.
  async function activelyFetchAndStore(chatId) {
    if (!chatId) return null;
    const existing = capturedConversations.get(chatId);
    if (isConversationComplete(existing) && existing.chat) return existing;
    let pending = fetchesInFlight.get(chatId);
    if (!pending) {
      pending = fetchAndStore(chatId, 'active').finally(() => {
        if (fetchesInFlight.get(chatId) === pending) fetchesInFlight.delete(chatId);
      });
      fetchesInFlight.set(chatId, pending);
    }
    return pending;
  }

  // Refresh at export: always a new request, never the result of a fetch
  // that started before the export was asked for. Resolves to null on
  // failure or timeout; the caller then falls back to the stored record.
  async function refreshForExport(chatId) {
    if (!chatId) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXPORT_REFRESH_TIMEOUT_MS);
    try {
      return await fetchAndStore(chatId, 'export_refresh', controller.signal);
    } finally {
      clearTimeout(timer);
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

    // No secret (inject.js did not run or its attribute was tampered with):
    // nothing can be verified, so nothing is accepted.
    if (typeof SECRET_KEY !== 'string' || !SECRET_RE.test(SECRET_KEY)) {
      logWarn('Signing secret missing or malformed, message ignored');
      return;
    }
    if (typeof event.data.signature !== 'string') return;

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

    const merged = mergeCapture(chatId, patch, { source: 'passive', partial: partial.partial === true });
    if (!merged) {
      logDebug('Passive capture smaller than the stored copy, kept the stored copy', { chatId });
      return;
    }
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

      const forward = (record, refresh) => {
        const flags = Array.isArray(record.flags) ? record.flags.slice() : [];
        if (refresh === 'failed') flags.push('refresh_failed');
        if (!record.chat) flags.push('chat_metadata_missing');
        browser.runtime.sendMessage({
          type: MESSAGE_TYPE,
          payload: assemblePayload(record),
          platform: 'mistral',
          capture: {
            captured_at: new Date(record.messagesAt || record.mergedAt).toISOString(),
            source: record.source || 'passive',
            refresh,
            complete: typeof record.complete === 'boolean' ? record.complete : null,
            flags
          }
        }).then(() => sendResponse({ success: true }))
          .catch(error => sendResponse({ success: false, error: error.message }));
      };

      // Always refresh before exporting so the ZIP reflects the latest state
      // of the chat; fall back to the stored record if the refresh fails,
      // and say so in the capture record.
      refreshForExport(conversationId).then(fresh => {
        if (isConversationComplete(fresh)) {
          forward(fresh, 'ok');
          return;
        }
        const cached = capturedConversations.get(conversationId);
        if (!isConversationComplete(cached)) {
          sendResponse({
            success: false,
            error: 'Conversation not found. Please reload the page and try again.'
          });
          return;
        }
        forward(cached, 'failed');
      });
      return true;
    }

    return false;
  });

  logInfo('Content script loaded');

})();
