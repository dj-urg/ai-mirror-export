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

  // ==========================================================================
  // MEMORY MANAGEMENT (mirror of Grok/Claude/ChatGPT)
  // ==========================================================================

  function storeConversation(id, data) {
    if (capturedConversations.size >= MAX_STORED_CONVERSATIONS) {
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
        logDebug('Memory limit reached. Evicted oldest conversation', { conversationId: oldestId });
      }
    }
    capturedConversations.set(id, data);
    conversationTimestamps.set(id, Date.now());
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
  // to /a/chat/s/<uuid> and the passive intercept has not seen a request yet.
  // Mirrors Grok/Claude.
  // ==========================================================================

  let activeFetchInFlight = null;

  function extractConversationIdFromPath() {
    const m = window.location.pathname.match(
      /\/a\/chat\/s\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
    );
    return m ? m[1] : null;
  }

  async function activelyFetchAndStore(convId) {
    if (!convId) return null;
    if (capturedConversations.has(convId)) return capturedConversations.get(convId);
    if (activeFetchInFlight) {
      try { await activeFetchInFlight; } catch (_) {}
      if (capturedConversations.has(convId)) return capturedConversations.get(convId);
    }
    activeFetchInFlight = (async () => {
      try {
        const url = `/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(convId)}`;
        const resp = await fetch(url, { credentials: 'include' });
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
        if (!hasConversationShape(data)) {
          logWarn('Active fetch returned unexpected shape');
          return null;
        }
        // Stamp the URL id in case the response omits chat_session.id.
        try { data._captured_conversation_id = convId; } catch (_) {}
        storeConversation(convId, data);
        const biz = data.data && data.data.biz_data ? data.data.biz_data : (data.biz_data || data);
        logDebug('Actively fetched conversation', {
          conversationId: convId,
          messageCount: Array.isArray(biz.chat_messages) ? biz.chat_messages.length : 0
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
    })();
    try {
      return await activeFetchInFlight;
    } finally {
      activeFetchInFlight = null;
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

  // SPA navigation: DeepSeek swaps conversations without a full page reload.
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

    const conversationData = event.data.payload;
    if (!conversationData || !hasConversationShape(conversationData)) {
      logWarn('Received message without a usable conversation shape');
      return;
    }

    const biz = conversationData.data && conversationData.data.biz_data
      ? conversationData.data.biz_data
      : (conversationData.biz_data || conversationData);

    const rawId =
      conversationData._captured_conversation_id ||
      (biz.chat_session && biz.chat_session.id) ||
      null;

    if (typeof rawId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(rawId)) {
      logWarn('Received conversation data with missing or malformed id');
      return;
    }
    const conversationId = rawId;
    try { conversationData._captured_conversation_id = conversationId; } catch (_) {}

    storeConversation(conversationId, conversationData);

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
      const urlConvId = extractConversationIdFromPath();
      const needActive = urlConvId && !capturedConversations.has(urlConvId);

      const respond = () => {
        const conversations = Array.from(capturedConversations.entries()).map(([id, data]) => {
          const biz = data.data && data.data.biz_data
            ? data.data.biz_data
            : (data.biz_data || data);
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

      if (needActive) {
        activelyFetchAndStore(urlConvId).finally(respond);
        return true;
      }
      respond();
      return false;
    }

    if (message.type === 'EXPORT_CONVERSATION' && message.platform === 'deepseek') {
      const conversationId = message.conversationId;

      const forward = (data) => {
        browser.runtime.sendMessage({
          type: MESSAGE_TYPE,
          payload: data,
          platform: 'deepseek'
        }).then(() => sendResponse({ success: true }))
          .catch(error => sendResponse({ success: false, error: error.message }));
      };

      const existing = capturedConversations.get(conversationId);
      if (!existing) {
        activelyFetchAndStore(conversationId).then(data => {
          if (!data) {
            sendResponse({
              success: false,
              error: 'Conversation not found. Please reload the page and try again.'
            });
            return;
          }
          forward(data);
        });
        return true;
      }
      forward(existing);
      return true;
    }

    return false;
  });

  logInfo('Content script loaded');

})();
