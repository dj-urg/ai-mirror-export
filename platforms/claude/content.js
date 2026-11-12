/**
 * Claude Platform - Content Script
 * 
 * This script:
 * 1. Injects inject.js into the page context
 * 2. Listens for conversation data via window.postMessage
 * 3. Forwards the data to the background script for processing
 */

(function () {
  'use strict';

  const PLATFORM = 'Claude';
  const MESSAGE_TYPE = 'CLAUDE_CONVERSATION_DATA';
  const SOURCE_ID = 'claude-exporter-inject';

  // Logging configuration
  const IS_PRODUCTION = true;
  const DEBUG_MODE = false;

  // Memory management configuration
  const MAX_STORED_CONVERSATIONS = 50;
  const MAX_CONVERSATION_AGE_MS = 3600000; // 1 hour
  const CLEANUP_INTERVAL_MS = 300000; // 5 minutes

  // Store captured conversations in memory with timestamps
  const capturedConversations = new Map();
  const conversationTimestamps = new Map();

  // Read the signing secret written by inject.js (MAIN world) via setAttribute.
  // Using getAttribute/removeAttribute is XRay-wrapper-safe in Firefox content
  // scripts. Both scripts run at document_start before any page script executes.
  // inject.js writes 32 random bytes as 64 hex characters; anything else is
  // not its secret and is ignored.
  const _ATTR = 'data-claude-exporter-secret';
  const SECRET_RE = /^[0-9a-f]{64}$/;
  const SECRET_WAIT_MS = 10000;
  let SECRET_KEY = null;

  function takeSecretFromAttribute() {
    const s = document.documentElement.getAttribute(_ATTR);
    if (!s) return false;
    document.documentElement.removeAttribute(_ATTR);
    if (!SECRET_RE.test(s)) return false;
    SECRET_KEY = s;
    return true;
  }

  if (!takeSecretFromAttribute()) {
    const _secretObserver = new MutationObserver(() => {
      if (takeSecretFromAttribute()) _secretObserver.disconnect();
    });
    _secretObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [_ATTR]
    });
    // inject.js sets the attribute as it loads. If it has not done so by now
    // it never will, and a listener left waiting would accept a secret from
    // whoever sets the attribute next.
    setTimeout(() => _secretObserver.disconnect(), SECRET_WAIT_MS);
  }

  /**
   * Redact sensitive information from log data
   */
  function redactSensitiveData(data) {
    if (!data || typeof data !== 'object') {
      return data;
    }

    const redacted = Array.isArray(data) ? [...data] : { ...data };

    if (redacted.conversationId && typeof redacted.conversationId === 'string') {
      redacted.conversationId = redacted.conversationId.substring(0, 8) + '...';
    }
    if (redacted.conversation_id && typeof redacted.conversation_id === 'string') {
      redacted.conversation_id = redacted.conversation_id.substring(0, 8) + '...';
    }
    if (redacted.id && typeof redacted.id === 'string' && redacted.id.length > 16) {
      redacted.id = redacted.id.substring(0, 8) + '...';
    }
    if (redacted.uuid && typeof redacted.uuid === 'string') {
      redacted.uuid = redacted.uuid.substring(0, 8) + '...';
    }

    return redacted;
  }

  function logDebug(message, data = null) {
    if (!DEBUG_MODE) return;
    if (data) {
      console.log(`[${PLATFORM}] [DEBUG]`, message, redactSensitiveData(data));
    } else {
      console.log(`[${PLATFORM}] [DEBUG]`, message);
    }
  }

  function logInfo(message, data = null) {
    if (IS_PRODUCTION) return;
    if (data) {
      console.log(`[${PLATFORM}]`, message, redactSensitiveData(data));
    } else {
      console.log(`[${PLATFORM}]`, message);
    }
  }

  function logWarn(message, data = null) {
    if (IS_PRODUCTION) return;
    if (data) {
      console.warn(`[${PLATFORM}] [WARN]`, message, redactSensitiveData(data));
    } else {
      console.warn(`[${PLATFORM}] [WARN]`, message);
    }
  }


  // Where each stored conversation came from: 'passive' (the page's own
  // request, seen by inject.js), 'active' (our fetch on page load or when the
  // popup opens) or 'export_refresh' (our fetch at export time).
  const conversationSources = new Map();

  function forgetConversation(id) {
    capturedConversations.delete(id);
    conversationTimestamps.delete(id);
    conversationSources.delete(id);
  }

  /**
   * Store conversation with memory management
   * Implements LRU (Least Recently Used) eviction when limit is reached
   */
  function storeConversation(id, data, source) {
    // Clean up oldest conversation if at limit. Replacing a conversation that
    // is already stored does not grow the map, so nothing is evicted for it.
    if (!capturedConversations.has(id) && capturedConversations.size >= MAX_STORED_CONVERSATIONS) {
      // Find oldest conversation by timestamp
      let oldestId = null;
      let oldestTime = Infinity;

      for (const [convId, timestamp] of conversationTimestamps.entries()) {
        if (timestamp < oldestTime) {
          oldestTime = timestamp;
          oldestId = convId;
        }
      }

      if (oldestId) {
        forgetConversation(oldestId);
        logDebug('Memory limit reached. Evicted oldest conversation', { conversationId: oldestId });
      }
    }

    // Store conversation with current timestamp
    capturedConversations.set(id, data);
    conversationTimestamps.set(id, Date.now());
    conversationSources.set(id, source);
  }

  /**
   * Describe the stored copy of a conversation for the export manifest:
   * when it was captured, how, and whether the refresh at export worked.
   */
  function captureInfo(id, refresh) {
    const capturedAt = conversationTimestamps.get(id);
    return {
      captured_at: new Date(typeof capturedAt === 'number' ? capturedAt : Date.now()).toISOString(),
      source: conversationSources.get(id) || 'passive',
      refresh,
      // The API does not say whether an answer is still being written.
      complete: null,
      flags: refresh === 'failed' ? ['refresh_failed'] : []
    };
  }

  /**
   * Clean up old conversations based on age
   */
  function cleanupOldConversations() {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [id, timestamp] of conversationTimestamps.entries()) {
      if (now - timestamp > MAX_CONVERSATION_AGE_MS) {
        forgetConversation(id);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logDebug(`Cleaned up ${cleanedCount} old conversation(s)`, { remaining: capturedConversations.size });
    }
  }

  // Start periodic cleanup
  setInterval(cleanupOldConversations, CLEANUP_INTERVAL_MS);

  // ==========================================================================
  // ACTIVE FETCH — Claude migrated some endpoints to gRPC-Web, so passive
  // interception races against the page bundle. We instead directly call the
  // REST endpoint that still exists, using the page's logged-in cookies.
  // ==========================================================================

  // One fetch chain per conversation id.
  const fetchesInFlight = new Map();
  const FETCH_TIMEOUT_MS = 20000;

  // The organisation the last conversation was found in; tried first.
  let lastGoodOrgId = null;

  // Auth-failure debounce. Only notify background once per content-script
  // lifetime so we don't spam AUTH_FAILED. Reset by clearAuthFailure() on
  // the next successful fetch so a user who signs back in gets a fresh
  // "ready" state next time the popup opens.
  //
  // 401 is treated as "sign in required". 403 is deliberately NOT treated
  // as auth failure — on Claude it's often a Cloudflare interstitial, not
  // a logged-out session; those fall through to the generic stuck-state
  // message from step 8d.
  //
  // Message goes content → background via browser.runtime.sendMessage, which
  // the browser isolates from page JS entirely, so no HMAC via
  // shared/message-security.js is needed. Background still validates
  // sender.id + sender.tab + sender.frameId + hostname-matches-claude.
  let authFailureNotified = false;
  function notifyAuthFailure(where) {
    if (authFailureNotified) return;
    authFailureNotified = true;
    try {
      browser.runtime.sendMessage({
        type: 'AUTH_FAILED',
        platform: 'claude',
        detail: { where }
      }).catch(() => { /* popup may not be open; background still stores it */ });
    } catch (_) { /* runtime unavailable (e.g. extension reloaded) */ }
  }
  function clearAuthFailure() {
    if (!authFailureNotified) return;
    authFailureNotified = false;
    try {
      browser.runtime.sendMessage({
        type: 'AUTH_RECOVERED',
        platform: 'claude'
      }).catch(() => {});
    } catch (_) {}
  }

  function extractConversationIdFromPath() {
    const m = window.location.pathname.match(/\/chat\/([0-9a-f-]{8,})/i);
    return m ? m[1] : null;
  }

  // fetch() with a time limit, so an export never waits on a hung request.
  async function fetchWithTimeout(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, { credentials: 'include', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchOrgIds() {
    const resp = await fetchWithTimeout('/api/organizations');
    // fetch() does NOT reject on 4xx; the real status code is the only
    // reliable signal (no string matching on error messages).
    if (resp.status === 401) {
      notifyAuthFailure('organizations');
      throw new Error('organizations 401');
    }
    if (!resp.ok) throw new Error(`organizations ${resp.status}`);
    const orgs = await resp.json();
    if (!Array.isArray(orgs) || orgs.length === 0) throw new Error('no organizations returned');
    const ids = orgs
      .map(o => (o && typeof o.uuid === 'string') ? o.uuid : '')
      .filter(Boolean);
    if (ids.length === 0) throw new Error('organization missing uuid');
    return ids;
  }

  async function fetchConversationFromOrg(orgId, convId) {
    const url = `/api/organizations/${encodeURIComponent(orgId)}/chat_conversations/${encodeURIComponent(convId)}?tree=True&rendering_mode=messages&render_all_tools=true`;
    const resp = await fetchWithTimeout(url);
    if (resp.status === 401) {
      notifyAuthFailure('conversation');
      throw new Error('chat_conversations 401');
    }
    if (!resp.ok) throw new Error(`chat_conversations ${resp.status}`);
    return resp.json();
  }

  /**
   * Fetch a conversation. An account can belong to several organisations and
   * the conversation lives in one of them, so each is tried in turn, starting
   * with the one that worked last time. A 401 means signed out everywhere and
   * stops the search.
   */
  async function fetchConversation(convId) {
    const orgIds = await fetchOrgIds();
    if (lastGoodOrgId && orgIds.includes(lastGoodOrgId)) {
      orgIds.splice(orgIds.indexOf(lastGoodOrgId), 1);
      orgIds.unshift(lastGoodOrgId);
    }
    let lastError = null;
    for (const orgId of orgIds) {
      try {
        const data = await fetchConversationFromOrg(orgId, convId);
        if (!data || !Array.isArray(data.chat_messages)) {
          throw new Error('response missing chat_messages');
        }
        lastGoodOrgId = orgId;
        return data;
      } catch (e) {
        lastError = e;
        if (/ 401$/.test(e.message)) break;
      }
    }
    throw lastError || new Error('conversation not found in any organization');
  }

  async function fetchAndStore(convId, source) {
    const data = await fetchConversation(convId);
    storeConversation(convId, data, source);
    // Success — if a previous call hit 401, the user has signed back in.
    clearAuthFailure();
    logDebug('Actively fetched conversation', {
      conversationId: convId,
      messageCount: data.chat_messages.length
    });
    browser.runtime.sendMessage({
      type: 'CONVERSATION_READY',
      platform: 'claude',
      conversationId: convId
    }).catch(() => { /* popup may not be open */ });
    return data;
  }

  /**
   * Fetch a conversation and store it. Returns the stored payload, or null
   * when the fetch failed.
   *
   * Without `force` the stored copy is returned when there is one, and a
   * fetch already under way for the same conversation is joined. With
   * `force` (export) a new request is always made, after any request already
   * under way has finished: that one started before the export was asked for
   * and may predate the latest messages, so its result is not handed back as
   * fresh. A null result under `force` means the refresh failed; the stored
   * copy, if any, is left untouched for the caller to fall back on.
   */
  async function activelyFetchAndStore(convId, { force = false } = {}) {
    if (!convId) return null;
    if (!force && capturedConversations.has(convId)) return capturedConversations.get(convId);

    const pending = fetchesInFlight.get(convId);
    let run;
    if (pending && !force) {
      run = pending;
    } else {
      const source = force ? 'export_refresh' : 'active';
      run = (async () => {
        if (pending) await pending.catch(() => {});
        return fetchAndStore(convId, source);
      })();
      fetchesInFlight.set(convId, run);
    }

    try {
      return await run;
    } catch (e) {
      logWarn('Active fetch failed', { error: e.message });
      return null;
    } finally {
      if (fetchesInFlight.get(convId) === run) fetchesInFlight.delete(convId);
    }
  }

  // Kick off an opportunistic fetch on load — fast path for when the popup
  // opens right after the user navigates to a chat.
  function kickoffIfOnChatPage() {
    const convId = extractConversationIdFromPath();
    if (convId) {
      activelyFetchAndStore(convId).catch(() => {});
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', kickoffIfOnChatPage, { once: true });
  } else {
    kickoffIfOnChatPage();
  }

  // SPA navigation: Claude swaps conversations without full page reload.
  // Watch for pathname changes and refetch when a new /chat/<uuid> appears.
  let _lastPath = window.location.pathname;
  setInterval(() => {
    if (window.location.pathname !== _lastPath) {
      _lastPath = window.location.pathname;
      kickoffIfOnChatPage();
    }
  }, 1500);

  /**
   * Verify HMAC-SHA256 signature
   */
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
    const keyData = encoder.encode(secret);
    const messageData = encoder.encode(message);

    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const expectedSig = await crypto.subtle.sign('HMAC', key, messageData);
    const expectedHex = Array.from(new Uint8Array(expectedSig), byte =>
      byte.toString(16).padStart(2, '0')
    ).join('');

    // Constant-time comparison
    if (signature.length !== expectedHex.length) return false;
    let result = 0;
    for (let i = 0; i < signature.length; i++) {
      result |= signature.charCodeAt(i) ^ expectedHex.charCodeAt(i);
    }
    return result === 0;
  }

  /**
   * Listen for messages from the injected page script
   */
  window.addEventListener('message', async event => {
    // Only accept messages from the same window and same origin.
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;

    // Only accept our specific message type
    if (!event.data || event.data.type !== MESSAGE_TYPE) return;

    // Verify source
    if (event.data.source !== SOURCE_ID) {
      logWarn('Message source mismatch', { source: event.data.source });
      return;
    }

    // Verify signature
    if (!event.data.signature || !event.data.timestamp || !event.data.nonce) {
      logWarn('Message missing security fields');
      return;
    }

    // Verify timestamp (prevent replay attacks - max 30 seconds old)
    const now = Date.now();
    const age = now - event.data.timestamp;
    if (age < 0 || age > 30000) {
      logWarn('Message timestamp out of valid range');
      return;
    }

    // Without a secret there is nothing to verify against (a missing key
    // would otherwise be encoded as the text "null").
    if (!SECRET_KEY) {
      logWarn('Secret key not ready yet');
      return;
    }

    // Verify signature
    const { signature, ...messageData } = event.data;
    if (typeof signature !== 'string') {
      logWarn('Message signature is not a string');
      return;
    }
    const messageString = JSON.stringify(messageData);
    const isValid = await verifySignature(messageString, signature, SECRET_KEY);

    if (!isValid) {
      logWarn('Invalid message signature - possible injection attempt');
      return;
    }
    if (isReplayedNonce(event.data.nonce)) {
      logWarn('Replayed message nonce');
      return;
    }

    logDebug('Message signature verified');

    // Take the payload from the string the signature was checked against,
    // not from event.data, which the page could have changed in the meantime.
    const conversationData = JSON.parse(messageString).payload;

    if (!conversationData || typeof conversationData !== 'object') {
      logWarn('Received message with no payload');
      return;
    }

    if (!Array.isArray(conversationData.chat_messages)) {
      logWarn('Received conversation data without chat_messages');
      return;
    }

    // Require a safely-formatted UUID so it can be used as a Map key, logged,
    // and later composed into a filename without any sanitization footguns.
    const rawId = conversationData.uuid;
    if (typeof rawId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(rawId)) {
      logWarn('Received conversation data with missing or malformed uuid');
      return;
    }
    const conversationId = rawId;

    // A request without `tree=True` returns the current branch only. Such a
    // copy must not replace a fuller one already stored; our own fetches
    // always ask for the whole tree, and export fetches again anyway.
    const stored = capturedConversations.get(conversationId);
    if (stored && Array.isArray(stored.chat_messages)
        && conversationData.chat_messages.length < stored.chat_messages.length) {
      logDebug('Kept the fuller stored conversation', { conversationId });
      return;
    }

    // Store in memory with memory management
    storeConversation(conversationId, conversationData, 'passive');

    logDebug('Stored conversation data', {
      conversationId: conversationId,
      messageCount: conversationData.chat_messages.length,
      conversationName: conversationData.name || 'Untitled',
      totalCaptured: capturedConversations.size
    });

    // AUTOMATIC DOWNLOAD DISABLED FOR POLICY COMPLIANCE
    // Data is stored in memory (capturedConversations) and waits for manual export via popup
    logDebug('Conversation data captured and stored in memory', { conversationId });

    // Notify popup that conversation data is ready (event-driven update)
    browser.runtime.sendMessage({
      type: 'CONVERSATION_READY',
      platform: 'claude',
      conversationId: conversationId
    }).catch(() => {
      // Popup might not be open, ignore error
    });
  });

  /**
   * Listen for messages from popup/background
   */
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Proper sender validation
    if (!sender || sender.id !== browser.runtime.id) {
      logWarn('Message from unauthorized sender', { senderId: sender?.id });
      return;
    }

    // Validate message structure
    if (!message || typeof message.type !== 'string') {
      logWarn('Invalid message structure');
      return;
    }

    if (message.type === 'GET_CAPTURED_CONVERSATIONS') {
      const urlConvId = extractConversationIdFromPath();
      const needActiveFetch = urlConvId && !capturedConversations.has(urlConvId);

      const respond = () => {
        const conversations = Array.from(capturedConversations.entries()).map(([id, data]) => ({
          id,
          title: data.name || 'Untitled Conversation'
        }));
        sendResponse({
          success: true,
          conversations: conversations,
          conversationIds: conversations.map(c => c.id),
          platform: 'claude'
        });
      };

      if (needActiveFetch) {
        activelyFetchAndStore(urlConvId).finally(respond);
        return true; // async
      }
      respond();
      return false;
    }

    if (message.type === 'EXPORT_CONVERSATION' && message.platform === 'claude') {
      const conversationId = message.conversationId;
      if (typeof conversationId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(conversationId)) {
        sendResponse({
          success: false,
          error: 'Conversation not found. Please reload the page and try again.'
        });
        return false;
      }

      // Always fetch the conversation again before exporting, so the ZIP
      // holds the chat as it is now and not the copy stored when the page
      // loaded. If that fails, fall back to the stored copy and say so in
      // `capture`, which background writes to the manifest.
      activelyFetchAndStore(conversationId, { force: true }).then(fresh => {
        const conversationData = fresh || capturedConversations.get(conversationId);
        if (!conversationData) {
          sendResponse({
            success: false,
            error: 'Conversation not found. Please reload the page and try again.'
          });
          return;
        }

        // Forward to background for CSV generation
        return browser.runtime.sendMessage({
          type: MESSAGE_TYPE,
          payload: conversationData,
          platform: 'claude',
          capture: captureInfo(conversationId, fresh ? 'ok' : 'failed')
        }).then(() => sendResponse({ success: true }));
      }).catch(error => sendResponse({ success: false, error: error.message }));

      return true; // Keep channel open for async response
    }

    return false;
  });

  logInfo('Content script loaded');

})();

