/**
 * Microsoft 365 Copilot - Content Script
 *
 * Mirrors the pattern used by platforms/copilot/content.js. Picks up the
 * HMAC secret from the data attribute inject.js wrote, verifies signed
 * postMessages from inject.js, stores captured conversations in memory, and
 * exposes them to the popup via browser.runtime messaging.
 */

(function () {
  'use strict';

  const PLATFORM = 'M365Copilot';
  const MESSAGE_TYPE = 'M365_COPILOT_CONVERSATION_DATA';
  const SOURCE_ID = 'm365-copilot-exporter-inject';

  const IS_PRODUCTION = true;
  const DEBUG_MODE = false;

  const MAX_STORED_CONVERSATIONS = 50;
  const MAX_CONVERSATION_AGE_MS = 3600000; // 1 hour
  const CLEANUP_INTERVAL_MS = 300000; // 5 minutes

  const capturedConversations = new Map();
  const conversationTimestamps = new Map();

  // Read the signing secret that inject.js wrote in MAIN world. Both scripts
  // run at document_start, so a MutationObserver covers the (unlikely) race
  // where our read happens before inject's write.
  const _ATTR = 'data-m365-copilot-exporter-secret';
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

  function redactSensitiveData(data) {
    if (!data || typeof data !== 'object') return data;
    const redacted = Array.isArray(data) ? [...data] : { ...data };
    if (typeof redacted.conversationId === 'string') {
      redacted.conversationId = redacted.conversationId.substring(0, 8) + '...';
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

  function storeConversation(id, data) {
    if (capturedConversations.size >= MAX_STORED_CONVERSATIONS) {
      let oldestId = null;
      let oldestTime = Infinity;
      for (const [convId, ts] of conversationTimestamps.entries()) {
        if (ts < oldestTime) { oldestTime = ts; oldestId = convId; }
      }
      if (oldestId) {
        capturedConversations.delete(oldestId);
        conversationTimestamps.delete(oldestId);
      }
    }
    capturedConversations.set(id, data);
    conversationTimestamps.set(id, Date.now());
  }

  function cleanupOldConversations() {
    const now = Date.now();
    for (const [id, ts] of conversationTimestamps.entries()) {
      if (now - ts > MAX_CONVERSATION_AGE_MS) {
        capturedConversations.delete(id);
        conversationTimestamps.delete(id);
      }
    }
  }
  setInterval(cleanupOldConversations, CLEANUP_INTERVAL_MS);

  async function verifySignature(message, signature, secret) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const expected = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
    const expectedHex = Array.from(new Uint8Array(expected), b => b.toString(16).padStart(2, '0')).join('');
    if (signature.length !== expectedHex.length) return false;
    let result = 0;
    for (let i = 0; i < signature.length; i++) {
      result |= signature.charCodeAt(i) ^ expectedHex.charCodeAt(i);
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

    const now = Date.now();
    const age = now - event.data.timestamp;
    if (age < 0 || age > 30000) {
      logWarn('Message timestamp out of valid range');
      return;
    }

    const { signature, ...messageData } = event.data;
    const isValid = await verifySignature(JSON.stringify(messageData), signature, SECRET_KEY);
    if (!isValid) {
      logWarn('Invalid message signature');
      return;
    }

    const payload = event.data.payload;
    if (!payload || !Array.isArray(payload.results)) {
      logWarn('Received payload missing results array');
      return;
    }

    const rawId = payload.conversationId;
    if (typeof rawId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(rawId)) {
      logWarn('Malformed conversationId');
      return;
    }

    storeConversation(rawId, payload);
    logDebug('Stored conversation', {
      conversationId: rawId,
      messageCount: payload.results.length,
      totalCaptured: capturedConversations.size
    });

    browser.runtime.sendMessage({
      type: 'CONVERSATION_READY',
      platform: 'm365_copilot',
      conversationId: rawId,
      turnCount: payload.results.length
    }).catch(() => { /* popup may be closed */ });
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!sender || sender.id !== browser.runtime.id) {
      logWarn('Message from unauthorized sender', { senderId: sender?.id });
      return;
    }
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'GET_CAPTURED_CONVERSATIONS') {
      const conversations = Array.from(capturedConversations.entries()).map(([id, data]) => {
        // Prefer the authoritative title from the type:2 frame (defaultChatName
        // via inject.js metadata). Falls back to the first user prompt text.
        let title = (data.metadata && data.metadata.default_chat_name) || 'Untitled Conversation';
        if (title === 'Untitled Conversation') {
          const results = Array.isArray(data.results) ? data.results : [];
          const firstUser = results.find(r => r && r.author === 'user' && typeof r.text === 'string' && r.text.length > 0);
          if (firstUser) title = firstUser.text.slice(0, 80);
        }
        return { id, title, isComplete: Boolean(data.isComplete) };
      });
      sendResponse({
        success: true,
        conversations,
        conversationIds: conversations.map(c => c.id),
        platform: 'm365_copilot'
      });
      return false;
    }

    if (message.type === 'EXPORT_CONVERSATION' && message.platform === 'm365_copilot') {
      // M365's conversationId lives in the Chathub WebSocket URL, not the page
      // URL — the popup can't extract it. If the caller doesn't pass one,
      // fall back to the most recently captured conversation.
      let targetId = message.conversationId;
      let data = targetId ? capturedConversations.get(targetId) : null;
      if (!data && !targetId) {
        let newest = null;
        let newestTs = -Infinity;
        for (const [id, ts] of conversationTimestamps.entries()) {
          if (ts > newestTs) { newestTs = ts; newest = id; }
        }
        if (newest) {
          targetId = newest;
          data = capturedConversations.get(newest);
        }
      }
      if (!data) {
        sendResponse({
          success: false,
          error: 'No M365 Copilot conversation captured yet. Open a chat and send at least one message, then try again.'
        });
        return false;
      }
      if (!data.isComplete) {
        sendResponse({
          success: false,
          error: 'The current turn is still streaming. Wait until Copilot finishes replying, then try again.'
        });
        return false;
      }
      browser.runtime.sendMessage({
        type: MESSAGE_TYPE,
        payload: data,
        platform: 'm365_copilot'
      }).then(() => sendResponse({ success: true }))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true;
    }

    return false;
  });

  logInfo('Content script loaded');

})();
