/**
 * DeepSeek Platform - Page Context Script (inject.js)
 *
 * Runs in the MAIN world to passively intercept DeepSeek's own fetch/XHR calls.
 * When DeepSeek loads a conversation from its REST API, this script captures
 * the response and forwards it to the content script via a signed postMessage.
 *
 * No authentication headers are captured or stored. Users may need to reload
 * the page if the extension installs after the conversation was already fetched.
 */

(function () {
  'use strict';

  const PLATFORM = 'DeepSeek';
  const MESSAGE_TYPE = 'DEEPSEEK_CONVERSATION_DATA';
  const SOURCE_ID = 'deepseek-exporter-inject';

  const IS_PRODUCTION = true;
  const DEBUG_MODE = false;
  const MAX_RESPONSE_SIZE = 100 * 1024 * 1024; // 100MB

  const capturedIds = new Set();

  const originalFetch = window.fetch;
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;
  const originalPostMessage = window.postMessage.bind(window);
  const originalMessageSecurity = window.MessageSecurity;

  // ============================================================================
  // SECRET GENERATION — same pattern as Grok/Claude/ChatGPT: dataset handoff
  // between MAIN (this file) and ISOLATED (content.js) worlds at document_start.
  // ============================================================================

  const storedSecret = (() => {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
  })();
  document.documentElement.setAttribute('data-deepseek-exporter-secret', storedSecret);

  // ============================================================================
  // LOGGING
  // ============================================================================

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
    data
      ? console.log(`[${PLATFORM}] [DEBUG]`, message, redactSensitiveData(data))
      : console.log(`[${PLATFORM}] [DEBUG]`, message);
  }

  function logWarn(message, data = null) {
    if (IS_PRODUCTION) return;
    data
      ? console.warn(`[${PLATFORM}] [WARN]`, message, redactSensitiveData(data))
      : console.warn(`[${PLATFORM}] [WARN]`, message);
  }

  // ============================================================================
  // RESPONSE VALIDATION
  // ============================================================================

  function validateResponse(response) {
    if (!response.ok) {
      return { isValid: false, error: `Response not OK: ${response.status}` };
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      const size = parseInt(contentLength, 10);
      if (isNaN(size)) return { isValid: false, error: 'Invalid content-length header' };
      if (size > MAX_RESPONSE_SIZE) {
        return { isValid: false, error: `Response too large: ${size} bytes (max: ${MAX_RESPONSE_SIZE})` };
      }
    }
    return { isValid: true };
  }

  // ============================================================================
  // URL MATCHING
  //
  // DeepSeek's web app loads conversations through `/api/v0/chat/history_messages`
  // with a `chat_session_id` query parameter. The URL does not carry the
  // conversation UUID in its path, so we read it off the query string. The
  // page URL itself is `/a/chat/s/<uuid>` which is the authoritative source
  // when we actively fetch (see content.js).
  // ============================================================================

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Only DeepSeek's own history read is captured: same origin, exactly this
  // path, GET. A looser match would let any request whose URL merely
  // contains the path (another host, a longer path) be stored as a
  // conversation.
  const HISTORY_PATH = '/api/v0/chat/history_messages';

  function parseHistoryUrl(url) {
    if (typeof url !== 'string' || !url) return null;
    try {
      const u = new URL(url, window.location.href);
      if (u.origin !== window.location.origin) return null;
      if (u.pathname !== HISTORY_PATH) return null;
      return u;
    } catch (_) {
      return null;
    }
  }

  function isConversationUrl(url) {
    return parseHistoryUrl(url) !== null;
  }

  function conversationIdFromUrl(url) {
    const u = parseHistoryUrl(url);
    if (!u) return null;
    const id = u.searchParams.get('chat_session_id');
    return id && UUID_RE.test(id) ? id : null;
  }

  function isGet(method) {
    return method === undefined || method === null || String(method).toUpperCase() === 'GET';
  }

  // ============================================================================
  // DATA FORWARDING
  // ============================================================================

  function hasConversationShape(data) {
    if (!data || typeof data !== 'object') return false;
    // DeepSeek wraps the payload: `{ data: { biz_code, biz_data: { chat_session, chat_messages, ... } } }`.
    const biz = data.data && data.data.biz_data ? data.data.biz_data : (data.biz_data || null);
    if (biz && Array.isArray(biz.chat_messages)) return true;
    // Defensive fallback: unwrapped shape.
    if (Array.isArray(data.chat_messages)) return true;
    return false;
  }

  async function sendDataToContentScript(data, urlConversationId) {
    if (!hasConversationShape(data)) return;

    const biz = data.data && data.data.biz_data
      ? data.data.biz_data
      : (data.biz_data || data);

    const conversationId =
      urlConversationId ||
      (biz.chat_session && biz.chat_session.id) ||
      null;

    // DeepSeek's chat_session may be omitted when hitting the endpoint with
    // only a cache-delta reply, so stamp the URL id onto the payload before
    // forwarding. Downstream code reads `_captured_conversation_id`.
    if (conversationId && typeof data === 'object' && data !== null && !Array.isArray(data)) {
      try { data._captured_conversation_id = conversationId; } catch (_) {}
    }

    if (conversationId) capturedIds.add(conversationId);

    if (!storedSecret) {
      logWarn('Secret key not available, cannot send message');
      return;
    }

    const signedMessage = await originalMessageSecurity.createSignedMessage(
      data,
      MESSAGE_TYPE,
      SOURCE_ID,
      'deepseek',
      storedSecret
    );

    originalPostMessage(signedMessage, window.location.origin);

    logDebug('Captured conversation data', {
      conversationId,
      messageCount: Array.isArray(biz.chat_messages) ? biz.chat_messages.length : 0
    });
  }

  // ============================================================================
  // PASSIVE FETCH INTERCEPTOR
  // ============================================================================

  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);

    try {
      // The URL and method come from the request only when it is a string
      // or a real Request; the response's own URL (after redirects) has the
      // last word, so an object that merely looks like a request cannot
      // label another response as a conversation.
      const request = args[0];
      const init = args[1];
      let url = '';
      let method;

      if (typeof request === 'string') {
        url = request;
        method = init && init.method;
      } else if (request instanceof Request) {
        url = request.url;
        method = (init && init.method) || request.method;
      } else if (request instanceof URL) {
        url = request.href;
        method = init && init.method;
      }

      if (!isGet(method) || response.type !== 'basic') return response;
      if (typeof response.url === 'string' && response.url) url = response.url;

      if (isConversationUrl(url)) {
        const validation = validateResponse(response);
        if (!validation.isValid) {
          logWarn('Passive intercept validation failed', { error: validation.error });
          return response;
        }

        const ctype = response.headers.get('content-type') || '';
        if (!ctype.toLowerCase().includes('application/json')) {
          return response;
        }

        let clone;
        try {
          clone = response.clone();
        } catch (cloneError) {
          logWarn('Could not clone response', { error: cloneError.message });
          return response;
        }

        const urlConvId = conversationIdFromUrl(url);
        clone.json()
          .then(async data => {
            if (!data || typeof data !== 'object') {
              logWarn('Invalid data structure: not an object');
              return;
            }
            if (hasConversationShape(data)) {
              await sendDataToContentScript(data, urlConvId);
            }
          })
          .catch(error => {
            logWarn('Failed to parse response', { error: error.message });
          });
      }
    } catch {
      // Never interrupt the original fetch return.
    }

    return response;
  };

  // ============================================================================
  // PASSIVE XHR INTERCEPTOR — mirrors Grok/Claude so capture still works if
  // DeepSeek switches a given endpoint from fetch to XHR.
  // ============================================================================

  // Per-request state lives in a WeakMap, not on the XHR object, where page
  // code could read or overwrite it.
  const xhrRequests = new WeakMap();

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      xhrRequests.set(this, {
        method,
        url: typeof url === 'string' ? url : (url instanceof URL ? url.href : '')
      });
    } catch (_) {}
    return originalXhrOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    try {
      const req = xhrRequests.get(this);
      if (req && isGet(req.method) && isConversationUrl(req.url)) {
        this.addEventListener('load', () => {
          try {
            if (this.status < 200 || this.status >= 300) return;
            // The final URL (after redirects) decides, not the one passed to open().
            if (!isConversationUrl(this.responseURL)) return;
            const urlConvId = conversationIdFromUrl(this.responseURL);
            const text = this.responseText;
            if (!text || text.length > MAX_RESPONSE_SIZE) return;
            let data;
            try {
              data = JSON.parse(text);
            } catch (_) {
              return;
            }
            if (hasConversationShape(data)) {
              sendDataToContentScript(data, urlConvId).catch(() => {});
            }
          } catch (e) {
            logWarn('XHR load handler failed', { error: e.message });
          }
        });
      }
    } catch (_) {}
    return originalXhrSend.apply(this, args);
  };

})();
