/**
 * Grok Platform - Page Context Script (inject.js)
 *
 * Runs in the MAIN world to passively intercept Grok's own fetch/XHR calls.
 * When Grok loads a conversation from its backend REST API, this script captures
 * the response and forwards it to the content script via a signed postMessage.
 *
 * No authentication headers are captured or stored. Users may need to reload
 * the page if the extension installs after the conversation was already fetched.
 */

(function () {
  'use strict';

  const PLATFORM = 'Grok';
  const MESSAGE_TYPE = 'GROK_CONVERSATION_DATA';
  const SOURCE_ID = 'grok-exporter-inject';

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
  // SECRET GENERATION — same pattern as Claude/ChatGPT: dataset handoff between
  // MAIN (this file) and ISOLATED (content.js) worlds at document_start.
  // ============================================================================

  const storedSecret = (() => {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
  })();
  document.documentElement.setAttribute('data-grok-exporter-secret', storedSecret);

  // ============================================================================
  // LOGGING
  // ============================================================================

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
  // Grok's web app loads conversations through REST endpoints under
  // `/rest/app-chat/conversations/<uuid>` (seen in the browser Network panel).
  // We match the conversation UUID at the tail of the path, and reject known
  // sub-resources (title updates, feedback, etc.) so only the full-conversation
  // GET endpoint flows through.
  // ============================================================================

  // The UUID is taken from the request path so it can be stamped onto the
  // payload before forwarding: Grok's conversation response is a flat
  // `{ responses: [...] }` with no top-level conversationId, so the URL is the
  // only reliable source for the id.
  //
  // Only Grok's own conversation reads are captured: same origin, exactly
  // one of the two conversation paths, GET. A looser match would let any
  // request whose URL merely contains such a path (another host, a query
  // string, a POST for part of a conversation) be stored as a conversation.
  const CONV_PATH_RE = /^\/rest\/app-chat\/conversations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/responses)?\/?$/i;

  function conversationIdFromUrl(url) {
    if (typeof url !== 'string' || !url) return null;
    try {
      const u = new URL(url, window.location.href);
      if (u.origin !== window.location.origin) return null;
      const m = u.pathname.match(CONV_PATH_RE);
      return m ? m[1] : null;
    } catch (_) {
      return null;
    }
  }

  function isConversationUrl(url) {
    return conversationIdFromUrl(url) !== null;
  }

  function isGet(method) {
    return method === undefined || method === null || String(method).toUpperCase() === 'GET';
  }

  // ============================================================================
  // DATA FORWARDING
  // ============================================================================

  function hasConversationShape(data) {
    if (!data || typeof data !== 'object') return false;
    // Grok's conversation payloads surface messages under `responses` (array).
    // Some endpoints wrap the conversation shape under a top-level
    // `conversation` key — accept both.
    if (Array.isArray(data.responses)) return true;
    if (data.conversation && Array.isArray(data.responses)) return true;
    if (data.conversation && typeof data.conversation === 'object' && Array.isArray(data.conversation.responses)) return true;
    // Defensive fallback: some variants use `messages` directly.
    if (Array.isArray(data.messages)) return true;
    return false;
  }

  async function sendDataToContentScript(data, urlConversationId) {
    if (!hasConversationShape(data)) return;

    const conversationId =
      urlConversationId ||
      (data.conversation && data.conversation.conversationId) ||
      data.conversationId ||
      data.id ||
      null;

    // Grok's conversation payload omits the UUID, so stamp it on from the URL
    // before forwarding. Downstream code reads `_captured_conversation_id`.
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
      'grok',
      storedSecret
    );

    originalPostMessage(signedMessage, window.location.origin);

    logDebug('Captured conversation data', {
      conversationId,
      messageCount: Array.isArray(data.responses)
        ? data.responses.length
        : (Array.isArray(data.messages) ? data.messages.length : 0)
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
  // PASSIVE XHR INTERCEPTOR — mirrors Claude's approach so the extension works
  // even if Grok switches a given endpoint from fetch to XHR.
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
            const urlConvId = conversationIdFromUrl(this.responseURL);
            if (!urlConvId) return;
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
