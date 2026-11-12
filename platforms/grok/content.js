/**
 * Grok Platform - Content Script
 *
 * - Reads the signing secret written by inject.js (MAIN world).
 * - Listens for conversation data via window.postMessage.
 * - Stores conversations in memory for the popup to export on demand.
 * - Forwards export requests to the background for CSV generation.
 */

(function () {
  'use strict';

  const PLATFORM = 'Grok';
  const MESSAGE_TYPE = 'GROK_CONVERSATION_DATA';
  const SOURCE_ID = 'grok-exporter-inject';

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
  const _ATTR = 'data-grok-exporter-secret';
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
  // MEMORY MANAGEMENT (mirror of Claude/ChatGPT)
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

  // --------------------------------------------------------------------------
  // Passive captures must not degrade what is already stored. Grok's page
  // also requests partial views of a conversation, so a passive capture is
  // merged by responseId; without ids it only replaces the stored copy when
  // it is not smaller and carries no paging cursor. Active fetches (and the
  // refresh at export) replace the stored copy outright.
  // --------------------------------------------------------------------------

  const CURSOR_KEYS = ['nextPageToken', 'nextCursor', 'next_cursor', 'cursor', 'pageToken'];

  function hasCursor(data) {
    return CURSOR_KEYS.some(k => data[k] !== undefined && data[k] !== null && data[k] !== '');
  }

  // Same precedence as the extractor's unwrap().
  function listKey(data) {
    if (Array.isArray(data.responses)) return 'responses';
    if (data.conversation && typeof data.conversation === 'object' && Array.isArray(data.conversation.responses)) {
      return 'conversation.responses';
    }
    if (Array.isArray(data.messages)) return 'messages';
    return null;
  }

  function listOf(data) {
    const key = listKey(data);
    if (key === 'conversation.responses') return data.conversation.responses;
    return key ? data[key] : [];
  }

  function withList(data, list) {
    const key = listKey(data);
    if (key === 'conversation.responses') {
      return { ...data, conversation: { ...data.conversation, responses: list } };
    }
    return { ...data, [key]: list };
  }

  function responseId(r) {
    return r && typeof r.responseId === 'string' && r.responseId ? r.responseId : null;
  }

  // Keep conversation metadata (title, timestamps) that the stored copy had
  // and the new payload lacks. The message list is never carried over here.
  function keepConversationMeta(next, existing) {
    if (!existing || next.conversation !== undefined) return next;
    if (!existing.conversation || typeof existing.conversation !== 'object') return next;
    if (listKey(next) === 'conversation.responses') return next;
    const meta = { ...existing.conversation };
    delete meta.responses;
    return { ...next, conversation: meta };
  }

  /**
   * Decide what a passive capture does to the stored copy.
   * Returns { data, flags } or null when the stored copy must stay as it is.
   */
  function reconcilePassive(existing, incoming) {
    if (!existing) return { data: incoming, flags: hasCursor(incoming) ? ['cursor_present'] : [] };
    const oldList = listOf(existing);
    const newList = listOf(incoming);
    if (oldList.every(responseId) && newList.every(responseId)) {
      const incomingIds = new Set(newList.map(responseId));
      if (oldList.every(r => incomingIds.has(responseId(r)))) {
        return { data: keepConversationMeta(incoming, existing), flags: [] };
      }
      // The capture misses responses that are stored: keep those, take the
      // newer copy of the ones it has, append the ones that are new.
      const byId = new Map(newList.map(r => [responseId(r), r]));
      const oldIds = new Set(oldList.map(responseId));
      const merged = oldList.map(r => byId.get(responseId(r)) || r)
        .concat(newList.filter(r => !oldIds.has(responseId(r))));
      return { data: withList(existing, merged), flags: ['passive_merged'] };
    }
    if (newList.length >= oldList.length && !hasCursor(incoming)) {
      return { data: keepConversationMeta(incoming, existing), flags: [] };
    }
    return null;
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
  // ACTIVE FETCH — fast path for when the popup opens right after navigating
  // to /c/<uuid> and the passive intercept has not seen a request yet.
  // Mirrors Claude's approach.
  // ==========================================================================

  // One in-flight fetch per conversation. `fetchSeq` orders fetches by start
  // time so a slow, older fetch can never overwrite the result of a newer one.
  const fetchesInFlight = new Map(); // conversation id -> promise
  let fetchSeq = 0;

  function extractConversationIdFromPath() {
    const m = window.location.pathname.match(/\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    return m ? m[1] : null;
  }

  // Candidate REST endpoints Grok has used in production. We try them in
  // order and return the first that yields a conversation-shaped payload.
  function conversationFetchCandidates(convId) {
    const encoded = encodeURIComponent(convId);
    return [
      `/rest/app-chat/conversations/${encoded}`,
      `/rest/app-chat/conversations/${encoded}/responses`
    ];
  }

  function hasConversationShape(data) {
    if (!data || typeof data !== 'object') return false;
    if (Array.isArray(data.responses)) return true;
    if (data.conversation && typeof data.conversation === 'object' && Array.isArray(data.conversation.responses)) return true;
    if (Array.isArray(data.messages)) return true;
    return false;
  }

  /**
   * Fetch the conversation from Grok's own endpoint and store it.
   * Resolves to the stored payload, or null if no candidate endpoint answered
   * with a conversation.
   */
  async function fetchAndStore(convId, source, signal) {
    const seq = ++fetchSeq;
    let lastError = null;
    for (const url of conversationFetchCandidates(convId)) {
      try {
        const resp = await fetch(url, { credentials: 'include', signal });
        if (!resp.ok) {
          lastError = new Error(`${url} ${resp.status}`);
          continue;
        }
        const ctype = resp.headers.get('content-type') || '';
        if (!ctype.toLowerCase().includes('application/json')) {
          lastError = new Error(`${url} non-JSON response`);
          continue;
        }
        let data = await resp.json();
        if (!hasConversationShape(data)) {
          lastError = new Error(`${url} unexpected shape`);
          continue;
        }
        // A newer fetch has already stored its result: keep that one.
        const stored = captureInfo.get(convId);
        if (stored && stored.seq > seq) return capturedConversations.get(convId);

        data = keepConversationMeta(data, capturedConversations.get(convId));
        // Grok's conversation payload is a flat `{ responses: [...] }` and
        // doesn't carry its own id. Stamp the URL id so downstream can read it.
        try { data._captured_conversation_id = convId; } catch (_) {}
        storeConversation(convId, data, source, {
          flags: hasCursor(data) ? ['cursor_present'] : [],
          seq
        });
        logDebug('Actively fetched conversation', {
          conversationId: convId,
          messageCount: listOf(data).length
        });
        browser.runtime.sendMessage({
          type: 'CONVERSATION_READY',
          platform: 'grok',
          conversationId: convId
        }).catch(() => { /* popup may not be open */ });
        return data;
      } catch (e) {
        lastError = e;
      }
    }
    if (lastError) logWarn('Active fetch failed', { error: lastError.message });
    return null;
  }

  // Background fetch (page load, SPA navigation, popup open): serves the
  // cached copy when there is one and joins a fetch already under way.
  async function activelyFetchAndStore(convId) {
    if (!convId) return null;
    if (capturedConversations.has(convId)) return capturedConversations.get(convId);
    let pending = fetchesInFlight.get(convId);
    if (!pending) {
      pending = fetchAndStore(convId, 'active').finally(() => {
        if (fetchesInFlight.get(convId) === pending) fetchesInFlight.delete(convId);
      });
      fetchesInFlight.set(convId, pending);
    }
    return pending;
  }

  // Refresh at export: always a new request, never the result of a fetch
  // that started before the export was asked for. Resolves to null on
  // failure or timeout; the caller then falls back to the cached copy.
  async function refreshForExport(convId) {
    if (!convId) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXPORT_REFRESH_TIMEOUT_MS);
    try {
      return await fetchAndStore(convId, 'export_refresh', controller.signal);
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function kickoffIfOnChatPage() {
    const convId = extractConversationIdFromPath();
    if (convId) activelyFetchAndStore(convId).catch(() => {});
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', kickoffIfOnChatPage, { once: true });
  } else {
    kickoffIfOnChatPage();
  }

  // SPA navigation: Grok swaps conversations without a full page reload.
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

    const conversationData = event.data.payload;
    if (!conversationData || !hasConversationShape(conversationData)) {
      logWarn('Received message without a usable conversation shape');
      return;
    }

    const rawId =
      conversationData._captured_conversation_id ||
      (conversationData.conversation && conversationData.conversation.conversationId) ||
      conversationData.conversationId ||
      conversationData.id ||
      null;

    if (typeof rawId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(rawId)) {
      logWarn('Received conversation data with missing or malformed id');
      return;
    }
    const conversationId = rawId;
    // Ensure the stamp is set even if the message skipped the inject-side path.
    try { conversationData._captured_conversation_id = conversationId; } catch (_) {}

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
      platform: 'grok',
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
      const urlConvId = extractConversationIdFromPath();
      const needActive = urlConvId && !capturedConversations.has(urlConvId);

      const respond = () => {
        const conversations = Array.from(capturedConversations.entries()).map(([id, data]) => ({
          id,
          title:
            (data.conversation && (data.conversation.title || data.conversation.name)) ||
            data.title ||
            'Untitled Conversation'
        }));
        sendResponse({
          success: true,
          conversations,
          conversationIds: conversations.map(c => c.id),
          platform: 'grok'
        });
      };

      if (needActive) {
        activelyFetchAndStore(urlConvId).finally(respond);
        return true;
      }
      respond();
      return false;
    }

    if (message.type === 'EXPORT_CONVERSATION' && message.platform === 'grok') {
      const conversationId = message.conversationId;

      const forward = (data, refresh) => {
        const info = captureInfo.get(conversationId) || { capturedAt: Date.now(), source: 'passive', flags: [] };
        const flags = info.flags.slice();
        if (refresh === 'failed') flags.push('refresh_failed');
        browser.runtime.sendMessage({
          type: MESSAGE_TYPE,
          payload: data,
          platform: 'grok',
          // Grok's payload carries no id of its own; the id from the page URL
          // names the export when the stamped `_captured_conversation_id` is
          // missing (seen in a real export named grok_unknown_…).
          conversationId,
          capture: {
            captured_at: new Date(info.capturedAt).toISOString(),
            source: info.source,
            refresh,
            // Grok does not say whether a response list is the whole
            // conversation; only a paging cursor proves it is not.
            complete: flags.includes('cursor_present') ? false : null,
            flags
          }
        }).then(() => sendResponse({ success: true }))
          .catch(error => sendResponse({ success: false, error: error.message }));
      };

      // Always refresh before exporting so the ZIP reflects the latest state
      // of the chat; fall back to the cached copy if the refresh fails, and
      // say so in the capture record.
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
