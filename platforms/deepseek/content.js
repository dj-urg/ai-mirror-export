/**
 * DeepSeek Platform - Content Script
 *
 * - Reads the signing secret written by inject.js (MAIN world).
 * - Listens for conversation data via window.postMessage.
 * - Stores conversations in memory for the popup to export on demand.
 * - Forwards export requests to the background for CSV generation.
 */

(function () {
  'use strict';

  const PLATFORM = 'DeepSeek';
  const MESSAGE_TYPE = 'DEEPSEEK_CONVERSATION_DATA';
  const SOURCE_ID = 'deepseek-exporter-inject';

  const IS_PRODUCTION = true;
  const DEBUG_MODE = false;

  const MAX_STORED_CONVERSATIONS = 50;
  const MAX_CONVERSATION_AGE_MS = 3600000; // 1 hour
  const CLEANUP_INTERVAL_MS = 300000; // 5 minutes

  const capturedConversations = new Map();
  const conversationTimestamps = new Map();
  // Per conversation: when the stored payload was captured and how
  // ({ capturedAt, source, flags, seq }). Sent with the export as `capture`
  // so the manifest can say how fresh and how complete the data is.
  const captureInfo = new Map();

  // The signing secret is 32 random bytes, hex-encoded by inject.js.
  const SECRET_RE = /^[0-9a-f]{64}$/;
  const EXPORT_REFRESH_TIMEOUT_MS = 15000;

  // ==========================================================================
  // SECRET BRIDGE — XRay-wrapper-safe attribute read.
  // ==========================================================================
  const _ATTR = 'data-deepseek-exporter-secret';
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
    if (redacted.chat_session_id && typeof redacted.chat_session_id === 'string') {
      redacted.chat_session_id = redacted.chat_session_id.substring(0, 8) + '...';
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
  // SHAPE CHECK
  // ==========================================================================

  function hasConversationShape(data) {
    if (!data || typeof data !== 'object') return false;
    const biz = data.data && data.data.biz_data ? data.data.biz_data : (data.biz_data || null);
    if (biz && Array.isArray(biz.chat_messages)) return true;
    if (Array.isArray(data.chat_messages)) return true;
    return false;
  }

  function bizOf(data) {
    return data.data && data.data.biz_data ? data.data.biz_data : (data.biz_data || data);
  }

  /**
   * Checks every payload must pass before it is stored, whether it was
   * fetched here or captured from the page. Returns a short reason when the
   * payload is not usable, or null when it is.
   */
  function rejectReason(data) {
    // DeepSeek signals auth / lookup failures via `code` / `biz_code` while
    // still returning HTTP 200. Treat anything non-zero as a miss.
    if (typeof data?.code === 'number' && data.code !== 0) return 'error_code';
    if (typeof data?.data?.biz_code === 'number' && data.data.biz_code !== 0) return 'biz_error';
    if (!hasConversationShape(data)) return 'unexpected_shape';
    const biz = bizOf(data);
    // Do not store an empty session: on a brand-new chat the first message
    // may not be persisted server-side yet. Skipping it lets the
    // SPA-navigation retry or the next refresh pick up the real messages
    // once they land.
    if (biz.chat_messages.length === 0 || (biz.chat_session && biz.chat_session.is_empty === true)) {
      return 'empty_session';
    }
    return null;
  }

  // --------------------------------------------------------------------------
  // Passive captures must not degrade what is already stored: the history
  // endpoint can answer with only part of a chat (a cache delta). A passive
  // capture is merged by message_id; without ids it only replaces the stored
  // copy when it is not smaller. Active fetches (and the refresh at export)
  // replace the stored copy outright.
  // --------------------------------------------------------------------------

  function msgId(m) {
    const id = m && m.message_id;
    return (typeof id === 'number' || (typeof id === 'string' && id)) ? String(id) : null;
  }

  // Copy of `data` with the message list (and, if given, the session) replaced.
  function withBiz(data, messages, session) {
    const patch = biz => {
      const next = { ...biz, chat_messages: messages };
      if (session) next.chat_session = session;
      return next;
    };
    if (data.data && data.data.biz_data) return { ...data, data: { ...data.data, biz_data: patch(data.data.biz_data) } };
    if (data.biz_data) return { ...data, biz_data: patch(data.biz_data) };
    return patch(data);
  }

  /**
   * Decide what a passive capture does to the stored copy.
   * Returns { data, flags } or null when the stored copy must stay as it is.
   */
  function reconcilePassive(existing, incoming) {
    if (!existing) return { data: incoming, flags: [] };
    const oldBiz = bizOf(existing);
    const newBiz = bizOf(incoming);
    const oldList = oldBiz.chat_messages;
    const newList = newBiz.chat_messages;
    const newSession = newBiz.chat_session && typeof newBiz.chat_session === 'object' ? newBiz.chat_session : null;
    const oldSession = oldBiz.chat_session && typeof oldBiz.chat_session === 'object' ? oldBiz.chat_session : null;

    if (oldList.every(msgId) && newList.every(msgId)) {
      const incomingIds = new Set(newList.map(msgId));
      if (oldList.every(m => incomingIds.has(msgId(m)))) {
        // Everything stored is in the capture: take it, keeping the session
        // record if this reply left it out.
        return { data: newSession || !oldSession ? incoming : withBiz(incoming, newList, oldSession), flags: [] };
      }
      // The capture misses messages that are stored: keep those, take the
      // newer copy of the ones it has, append the ones that are new.
      const byId = new Map(newList.map(m => [msgId(m), m]));
      const oldIds = new Set(oldList.map(msgId));
      const merged = oldList.map(m => byId.get(msgId(m)) || m)
        .concat(newList.filter(m => !oldIds.has(msgId(m))));
      return { data: withBiz(existing, merged, newSession), flags: ['passive_merged'] };
    }
    if (newList.length >= oldList.length) {
      return { data: newSession || !oldSession ? incoming : withBiz(incoming, newList, oldSession), flags: [] };
    }
    return null;
  }

  // ==========================================================================
  // MEMORY MANAGEMENT (mirror of Grok/Claude/ChatGPT)
  // ==========================================================================

  function storeConversation(id, data, source, { flags = [], seq = 0 } = {}) {
    // Only a new id can push the cache over its limit; an update of a stored
    // conversation must not evict anything.
    if (!capturedConversations.has(id) && capturedConversations.size >= MAX_STORED_CONVERSATIONS) {
      let oldestId = null;
      let oldestTime = Infinity;
      for (const [convId, timestamp] of conversationTimestamps.entries()) {
        if (timestamp < oldestTime) {
          oldestTime = timestamp;
          oldestId = convId;
        }
      }
      if (oldestId) {
        capturedConversations.delete(oldestId);
        conversationTimestamps.delete(oldestId);
        captureInfo.delete(oldestId);
        logDebug('Memory limit reached. Evicted oldest conversation', { conversationId: oldestId });
      }
    }
    const now = Date.now();
    capturedConversations.set(id, data);
    conversationTimestamps.set(id, now);
    captureInfo.set(id, { capturedAt: now, source, flags, seq });
  }

  function cleanupOldConversations() {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, ts] of conversationTimestamps.entries()) {
      if (now - ts > MAX_CONVERSATION_AGE_MS) {
        capturedConversations.delete(id);
        conversationTimestamps.delete(id);
        captureInfo.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logDebug(`Cleaned up ${cleaned} old conversation(s)`, { remaining: capturedConversations.size });
    }
  }
  setInterval(cleanupOldConversations, CLEANUP_INTERVAL_MS);

  // ==========================================================================
  // AUTH TOKEN BRIDGE
  //
  // DeepSeek authenticates its own history request with a Bearer token that
  // the site stores in localStorage under `userToken` (a JSON blob
  // `{"value":"<token>",...}`; the raw string is accepted as a fallback).
  // Session cookies alone are rejected with INVALID_TOKEN. The token is read
  // from the page's own storage, attached to one same-origin request to
  // DeepSeek's own endpoint, and never stored, logged or exported.
  // ==========================================================================

  function readUserToken() {
    try {
      const raw = window.localStorage.getItem('userToken');
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.value === 'string' && parsed.value) return parsed.value;
      } catch (_) {
        // Not JSON: fall through and use the raw string.
      }
      return typeof raw === 'string' && raw.length > 0 ? raw : null;
    } catch (_) {
      // localStorage can be blocked in some privacy modes. The passive
      // intercept path still works because DeepSeek's own code attaches the
      // token to its own requests.
      return null;
    }
  }

  // ==========================================================================
  // ACTIVE FETCH
  //
  // Two code paths rely on this:
  //   1. Popup open and export: GET_CAPTURED_CONVERSATIONS and
  //      EXPORT_CONVERSATION pass `force: true` so the export reflects the
  //      latest state. DeepSeek streams replies via `/api/v0/chat/completion`
  //      and keeps state in React; it never re-requests `history_messages`
  //      for a chat that is already open, so without a forced refresh a
  //      brand-new chat would export empty or stale.
  //   2. SPA navigation: when the URL flips to another session id we re-fetch
  //      after a short beat so the server has persisted the first message.
  // ==========================================================================

  // One in-flight fetch per conversation. `fetchSeq` orders fetches by start
  // time so a slow, older fetch can never overwrite the result of a newer one.
  const fetchesInFlight = new Map(); // conversation id -> promise of the latest fetch
  let fetchSeq = 0;

  // The popup polls GET_CAPTURED_CONVERSATIONS every 2 s while it is open.
  // A forced refresh must not turn that into a history request every 2 s:
  // force at most once per conversation per interval; otherwise the cached
  // copy is served (or fetched once if nothing is cached yet).
  const FORCE_REFRESH_INTERVAL_MS = 30000;
  const lastForcedAt = new Map(); // conversation id -> timestamp of the last forced refresh

  function shouldForceRefresh(convId) {
    const now = Date.now();
    const last = lastForcedAt.get(convId) || 0;
    if (now - last < FORCE_REFRESH_INTERVAL_MS) return false;
    lastForcedAt.set(convId, now);
    return true;
  }

  // DeepSeek's router is `/a/:agentId/s/:sessionId`. The agent id is usually
  // `chat` but other agents exist, so any slug is accepted.
  function extractConversationIdFromPath() {
    const m = window.location.pathname.match(
      /\/a\/[^/]+\/s\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
    );
    return m ? m[1] : null;
  }

  /**
   * Request the chat history from DeepSeek's own endpoint and store it.
   * Resolves to the stored payload, or null when the request failed or the
   * reply was not a usable conversation.
   */
  async function fetchAndStore(convId, source, signal) {
    const seq = ++fetchSeq;
    try {
      const token = readUserToken();
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const url = `/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(convId)}`;
      const resp = await fetch(url, { credentials: 'include', headers, signal });
      if (!resp.ok) {
        logWarn('Active fetch failed', { error: `${url} ${resp.status}` });
        return null;
      }
      const ctype = resp.headers.get('content-type') || '';
      if (!ctype.toLowerCase().includes('application/json')) {
        logWarn('Active fetch returned non-JSON', { contentType: ctype });
        return null;
      }
      const data = await resp.json();
      const reason = rejectReason(data);
      if (reason) {
        logWarn('Active fetch returned an unusable reply', { reason });
        return null;
      }
      // A newer fetch has already stored its result: keep that one.
      const stored = captureInfo.get(convId);
      if (stored && stored.seq > seq) return capturedConversations.get(convId);

      // Stamp the URL id in case the response omits chat_session.id.
      try { data._captured_conversation_id = convId; } catch (_) {}
      storeConversation(convId, data, source, { seq });
      logDebug('Actively fetched conversation', {
        conversationId: convId,
        messageCount: bizOf(data).chat_messages.length,
        source
      });
      browser.runtime.sendMessage({
        type: 'CONVERSATION_READY',
        platform: 'deepseek',
        conversationId: convId
      }).catch(() => { /* popup may not be open */ });
      return data;
    } catch (e) {
      logWarn('Active fetch threw', { error: e.message });
      return null;
    }
  }

  // Without `force` the cached copy is served and a fetch already under way
  // is joined. With `force` a new request is always made, so the result is
  // never older than the moment it was asked for.
  async function activelyFetchAndStore(convId, { force = false, source = 'active', signal } = {}) {
    if (!convId) return null;
    if (!force) {
      if (capturedConversations.has(convId)) return capturedConversations.get(convId);
      if (fetchesInFlight.has(convId)) return fetchesInFlight.get(convId);
    }
    const pending = fetchAndStore(convId, source, signal).finally(() => {
      if (fetchesInFlight.get(convId) === pending) fetchesInFlight.delete(convId);
    });
    fetchesInFlight.set(convId, pending);
    return pending;
  }

  // Refresh at export, bounded so a hung request cannot hang the export.
  // Resolves to null on failure or timeout; the caller then falls back to
  // the cached copy and reports that.
  async function refreshForExport(convId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXPORT_REFRESH_TIMEOUT_MS);
    try {
      return await activelyFetchAndStore(convId, {
        force: true,
        source: 'export_refresh',
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }

  function kickoffIfOnChatPage(opts = {}) {
    const convId = extractConversationIdFromPath();
    if (convId) activelyFetchAndStore(convId, opts).catch(() => {});
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => kickoffIfOnChatPage(), { once: true });
  } else {
    kickoffIfOnChatPage();
  }

  // SPA navigation: DeepSeek swaps conversations without a full page reload.
  // A 1 s pathname poll plus `popstate` covers it. (Wrapping
  // history.pushState from a content script would only patch the content
  // script's own view of `history`, not the page's, so it is not done.)
  let _lastPath = window.location.pathname;
  function onPathMaybeChanged() {
    const now = window.location.pathname;
    if (now === _lastPath) return;
    _lastPath = now;
    // Short delay so the server has persisted the first message of a
    // brand-new chat before its history is requested; force so messages
    // that arrived later overwrite anything cached under this id.
    setTimeout(() => kickoffIfOnChatPage({ force: true }), 800);
  }
  setInterval(onPathMaybeChanged, 1000);
  window.addEventListener('popstate', onPathMaybeChanged);

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

    // Same checks as the active fetch: an error reply or an empty session
    // must not replace a stored conversation.
    const conversationData = event.data.payload;
    const reason = conversationData ? rejectReason(conversationData) : 'no_payload';
    if (reason) {
      logWarn('Received message without a usable conversation', { reason });
      return;
    }

    const biz = bizOf(conversationData);

    const rawId =
      conversationData._captured_conversation_id ||
      (biz.chat_session && biz.chat_session.id) ||
      null;

    if (typeof rawId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(rawId)) {
      logWarn('Received conversation data with missing or malformed id');
      return;
    }
    const conversationId = rawId;

    const reconciled = reconcilePassive(capturedConversations.get(conversationId), conversationData);
    if (!reconciled) {
      logDebug('Passive capture smaller than the stored copy, kept the stored copy', { conversationId });
      return;
    }
    try { reconciled.data._captured_conversation_id = conversationId; } catch (_) {}
    const previous = captureInfo.get(conversationId);
    storeConversation(conversationId, reconciled.data, 'passive', {
      flags: reconciled.flags,
      seq: previous ? previous.seq : 0
    });

    logDebug('Stored conversation data', {
      conversationId,
      totalCaptured: capturedConversations.size
    });

    browser.runtime.sendMessage({
      type: 'CONVERSATION_READY',
      platform: 'deepseek',
      conversationId
    }).catch(() => { /* popup might not be open */ });
  });

  // ==========================================================================
  // POPUP / BACKGROUND MESSAGES
  // ==========================================================================

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
      // Refresh when the popup opens on a chat page (at most once per
      // 30 s while it stays open and polls): DeepSeek does not re-request
      // history for an open chat, so messages sent after the first capture
      // would otherwise never reach the cache.
      const urlConvId = extractConversationIdFromPath();

      const respond = () => {
        const conversations = Array.from(capturedConversations.entries()).map(([id, data]) => {
          const biz = bizOf(data);
          return {
            id,
            title: (biz.chat_session && biz.chat_session.title) || 'Untitled Conversation'
          };
        });
        sendResponse({
          success: true,
          conversations,
          conversationIds: conversations.map(c => c.id),
          platform: 'deepseek'
        });
      };

      if (urlConvId) {
        activelyFetchAndStore(urlConvId, { force: shouldForceRefresh(urlConvId) }).finally(respond);
        return true;
      }
      respond();
      return false;
    }

    if (message.type === 'EXPORT_CONVERSATION' && message.platform === 'deepseek') {
      const conversationId = message.conversationId;

      const forward = (data, refresh) => {
        const info = captureInfo.get(conversationId) || { capturedAt: Date.now(), source: 'passive', flags: [] };
        const flags = info.flags.slice();
        if (refresh === 'failed') flags.push('refresh_failed');
        browser.runtime.sendMessage({
          type: MESSAGE_TYPE,
          payload: data,
          platform: 'deepseek',
          conversationId,
          capture: {
            captured_at: new Date(info.capturedAt).toISOString(),
            source: info.source,
            refresh,
            // The history reply does not say whether it is the whole chat.
            complete: null,
            flags
          }
        }).then(() => sendResponse({ success: true }))
          .catch(error => sendResponse({ success: false, error: error.message }));
      };

      // Always refresh before exporting so the ZIP reflects the latest state
      // of the chat; fall back to the cached copy if the refresh fails, and
      // say so in the capture record.
      lastForcedAt.set(conversationId, Date.now());
      refreshForExport(conversationId).then(fresh => {
        if (fresh) {
          forward(fresh, 'ok');
          return;
        }
        const cached = capturedConversations.get(conversationId);
        if (!cached) {
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
