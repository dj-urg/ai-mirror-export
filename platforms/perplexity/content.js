/**
 * Perplexity Platform - Content Script
 *
 * Runs in the isolated world. Responsibilities:
 * 1. Pick up the signing secret written by inject.js and remove it.
 * 2. Verify signed postMessages from inject.js carrying thread page JSON.
 * 3. Merge paginated thread pages into one conversation keyed by thread UUID.
 * 4. Respond to popup / background messages for status and export.
 */

(function () {
  'use strict';

  // Idempotency guard. background.js registers this file through the
  // scripting API as well as manifest.json, and every copy of an
  // extension's content scripts in a frame shares one isolated-world
  // global, so a second evaluation would otherwise add a second
  // runtime.onMessage listener and produce two ZIPs per export. The marker
  // lives in the isolated world and is not visible to the page.
  const INSTALL_MARKER = '__aiChatExporterPerplexityContentInstalled';
  if (globalThis[INSTALL_MARKER] === true) return;
  globalThis[INSTALL_MARKER] = true;

  const PLATFORM = 'Perplexity';
  const MESSAGE_TYPE = 'PERPLEXITY_CONVERSATION_DATA';
  const SOURCE_ID = 'perplexity-exporter-inject';

  const IS_PRODUCTION = true;
  const DEBUG_MODE = false;

  const MAX_STORED_CONVERSATIONS = 50;
  const MAX_CONVERSATION_AGE_MS = 3600000; // 1 hour
  const CLEANUP_INTERVAL_MS = 300000;      // 5 minutes

  // Keyed by thread UUID. Each value is a merged conversation:
  // { uuid, title, created_at, updated_at, entries: [...], entryKeys: Set, lastPageMeta }
  const capturedConversations = new Map();
  const conversationTimestamps = new Map();

  // Pick up the signing secret from inject.js. MAIN world runs at document_start
  // the same as this content script; if MAIN hasn't finished when we read, a
  // MutationObserver catches the write.
  const _ATTR = 'data-perplexity-exporter-secret';
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
    for (const key of ['uuid', 'thread_uuid', 'backend_uuid', 'id']) {
      if (typeof redacted[key] === 'string' && redacted[key].length > 8) {
        redacted[key] = redacted[key].substring(0, 8) + '...';
      }
    }
    return redacted;
  }

  function logDebug(message, data = null) {
    if (!DEBUG_MODE) return;
    data
      ? console.log(`[${PLATFORM}] [DEBUG]`, message, redactSensitiveData(data))
      : console.log(`[${PLATFORM}] [DEBUG]`, message);
  }

  function logInfo(message, data = null) {
    if (IS_PRODUCTION) return;
    data
      ? console.log(`[${PLATFORM}]`, message, redactSensitiveData(data))
      : console.log(`[${PLATFORM}]`, message);
  }

  function logWarn(message, data = null) {
    if (IS_PRODUCTION) return;
    data
      ? console.warn(`[${PLATFORM}] [WARN]`, message, redactSensitiveData(data))
      : console.warn(`[${PLATFORM}] [WARN]`, message);
  }

  // Resolve the preferred top-level identifier on a page response. The URL
  // path is authoritative; use body fields only to backfill title/timestamps.
  function pickString(obj, keys) {
    for (const k of keys) {
      if (obj && typeof obj[k] === 'string' && obj[k].length > 0) return obj[k];
    }
    return '';
  }

  function pickTimestamp(obj, keys) {
    for (const k of keys) {
      if (!obj) continue;
      const v = obj[k];
      if (v === null || v === undefined || v === '') continue;
      return v;
    }
    return '';
  }

  function entryKeyOf(entry, fallbackIndex) {
    if (!entry || typeof entry !== 'object') return `idx:${fallbackIndex}`;
    return entry.uuid
      || entry.backend_uuid
      || entry.id
      || entry.entry_uuid
      || `idx:${fallbackIndex}`;
  }

  // Extract the entries array from whatever field name Perplexity used on the
  // page. Shape-tolerant on purpose — the field has been seen as `entries` on
  // thread detail responses and `data` on some paginated variants.
  function readEntries(page) {
    if (!page || typeof page !== 'object') return [];
    if (Array.isArray(page.entries)) return page.entries;
    if (Array.isArray(page.data)) return page.data;
    if (Array.isArray(page.results)) return page.results;
    return [];
  }

  function mergeConversation(threadUuid, page) {
    let conv = capturedConversations.get(threadUuid);
    if (!conv) {
      conv = {
        uuid: threadUuid,
        title: '',
        created_at: '',
        updated_at: '',
        entries: [],
        entryKeys: new Map(),  // key -> index into entries[]
        lastPageMeta: null
      };
      capturedConversations.set(threadUuid, conv);
    }

    // Latest metadata wins. Perplexity threads mutate (title generation,
    // follow-up questions), so a later page may carry an updated title.
    const title = pickString(page, ['title', 'thread_title']);
    if (title) conv.title = title;
    const createdAt = pickTimestamp(page, ['created_at', 'created_datetime', 'created']);
    if (createdAt && !conv.created_at) conv.created_at = createdAt;
    const updatedAt = pickTimestamp(page, [
      'updated_at', 'updated_datetime', 'last_query_datetime', 'updated'
    ]);
    if (updatedAt) conv.updated_at = updatedAt;

    const pageEntries = readEntries(page);
    for (let i = 0; i < pageEntries.length; i++) {
      const entry = pageEntries[i];
      const key = entryKeyOf(entry, conv.entries.length);
      const existingIdx = conv.entryKeys.get(key);
      if (existingIdx === undefined) {
        conv.entryKeys.set(key, conv.entries.length);
        conv.entries.push(entry);
      } else {
        // Later data wins — covers the common pattern where Perplexity returns
        // the same entry on a subsequent page with its final COMPLETED status.
        conv.entries[existingIdx] = entry;
      }
    }

    conv.lastPageMeta = {
      next_cursor: page.next_cursor || page.cursor || null,
      has_more: typeof page.has_more === 'boolean' ? page.has_more : null,
      page_count: (conv.lastPageMeta?.page_count || 0) + 1
    };

    conversationTimestamps.set(threadUuid, Date.now());
    enforceLruLimit();
  }

  function enforceLruLimit() {
    while (capturedConversations.size > MAX_STORED_CONVERSATIONS) {
      let oldestId = null;
      let oldestTime = Infinity;
      for (const [id, ts] of conversationTimestamps.entries()) {
        if (ts < oldestTime) { oldestTime = ts; oldestId = id; }
      }
      if (!oldestId) break;
      capturedConversations.delete(oldestId);
      conversationTimestamps.delete(oldestId);
      logDebug('Memory limit reached, evicted oldest conversation', {
        id: oldestId.substring(0, 8) + '...'
      });
    }
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

  // Return the merged conversation in the shape the background extractor
  // expects. entryKeys is a working index; strip it from exports.
  function exportShape(threadUuid) {
    const conv = capturedConversations.get(threadUuid);
    if (!conv) return null;
    return {
      uuid: conv.uuid,
      title: conv.title,
      created_at: conv.created_at,
      updated_at: conv.updated_at,
      entries: conv.entries,
      page_count: conv.lastPageMeta?.page_count || 0
    };
  }

  window.addEventListener('message', async event => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    if (!event.data || event.data.type !== MESSAGE_TYPE) return;
    if (event.data.source !== SOURCE_ID) {
      logWarn('Message source mismatch', { source: event.data.source });
      return;
    }
    if (!SECRET_KEY) {
      logWarn('Secret key not ready yet');
      return;
    }

    const verification = await MessageSecurity.verifySignedMessage(
      event.data, MESSAGE_TYPE, SOURCE_ID, SECRET_KEY
    );
    if (!verification.isValid) {
      logWarn('Message verification failed', { error: verification.error });
      return;
    }

    const page = event.data.payload;
    if (!page || typeof page !== 'object') {
      logWarn('Received message with no payload');
      return;
    }

    const threadUuid = typeof page.__thread_uuid === 'string' ? page.__thread_uuid : '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadUuid)) {
      logWarn('Received page with missing or malformed thread UUID');
      return;
    }
    delete page.__thread_uuid;

    mergeConversation(threadUuid, page);

    browser.runtime.sendMessage({
      type: 'CONVERSATION_READY',
      platform: 'perplexity',
      conversationId: threadUuid
    }).catch(() => {});
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!sender || sender.id !== browser.runtime.id) {
      logWarn('Message from unauthorized sender');
      return;
    }
    if (!message || typeof message.type !== 'string') {
      logWarn('Invalid message structure');
      return;
    }

    if (message.type === 'GET_CAPTURED_CONVERSATIONS') {
      const conversations = Array.from(capturedConversations.entries()).map(([id, conv]) => ({
        id,
        title: conv.title || 'Untitled Thread'
      }));
      sendResponse({
        success: true,
        conversations,
        conversationIds: conversations.map(c => c.id),
        platform: 'perplexity'
      });
      return false;
    }

    if (message.type === 'EXPORT_CONVERSATION' && message.platform === 'perplexity') {
      const conversationId = message.conversationId;
      const payload = exportShape(conversationId);

      if (!payload) {
        sendResponse({
          success: false,
          error: 'Conversation not found. Please wait for the thread to load, then retry.'
        });
        return false;
      }

      browser.runtime.sendMessage({
        type: MESSAGE_TYPE,
        payload,
        platform: 'perplexity'
      }).then(() => {
        sendResponse({ success: true });
      }).catch(error => {
        sendResponse({ success: false, error: error.message });
      });

      return true; // async
    }

    return false;
  });

  logInfo('Content script loaded');

})();
