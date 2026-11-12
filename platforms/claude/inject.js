/**
 * Claude Platform - Page Context Script (inject.js)
 *
 * Runs in the MAIN world to passively intercept Claude's own fetch calls.
 * When Claude loads a conversation from its backend API, this script captures
 * the response and forwards it to the content script via a signed postMessage.
 *
 * No authentication headers are captured or stored.
 * If the extension loads after a conversation has already been fetched,
 * the user should reload the page to trigger a new fetch.
 */

(function () {
  'use strict';

  const PLATFORM = 'Claude';
  const MESSAGE_TYPE = 'CLAUDE_CONVERSATION_DATA';
  const SOURCE_ID = 'claude-exporter-inject';

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
  // SECRET GENERATION
  // ============================================================================

  // Generate the signing secret here in the MAIN world at document_start,
  // before any page scripts execute. Write it to a dataset attribute so
  // content.js (isolated world) — which also runs at document_start — can
  // read it once and immediately delete it. By the time any page script runs,
  // the attribute is gone and the secret exists only in these two closures.
  const storedSecret = (() => {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
  })();
  document.documentElement.setAttribute('data-claude-exporter-secret', storedSecret);

  // ============================================================================
  // LOGGING
  // ============================================================================

  function redactSensitiveData(data) {
    if (!data || typeof data !== 'object') return data;
    const redacted = Array.isArray(data) ? [...data] : { ...data };
    if (redacted.conversationId && typeof redacted.conversationId === 'string') {
      redacted.conversationId = redacted.conversationId.substring(0, 8) + '...';
    }
    if (redacted.uuid && typeof redacted.uuid === 'string') {
      redacted.uuid = redacted.uuid.substring(0, 8) + '...';
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
  // DATA FORWARDING
  // ============================================================================

  async function sendDataToContentScript(data) {
    if (!data || !Array.isArray(data.chat_messages)) return;

    const conversationId = data.uuid;
    if (conversationId) {
      capturedIds.add(conversationId);
    }

    if (!storedSecret) {
      logWarn('Secret key not available, cannot send message');
      return;
    }

    const signedMessage = await originalMessageSecurity.createSignedMessage(
      data,
      MESSAGE_TYPE,
      SOURCE_ID,
      'claude',
      storedSecret
    );

    originalPostMessage(signedMessage, window.location.origin);

    logDebug('Captured conversation data', {
      uuid: conversationId,
      messageCount: data.chat_messages.length
    });
  }

  // ============================================================================
  // URL MATCHING
  // ============================================================================

  // Only the conversation GET endpoint itself:
  //   /api/organizations/<org>/chat_conversations/<uuid>
  // Sub-resources (/completion, /latest, /title, ...) carry other payloads
  // and must not replace a captured conversation.
  const CONVERSATION_PATH_RE = /^\/api\/organizations\/[^/]+\/chat_conversations\/[0-9a-f-]{10,}$/i;

  /**
   * True when `url` is Claude's own conversation endpoint: same origin as the
   * page and exactly the conversation path. The URL is resolved first, so a
   * path that merely appears inside another origin's URL, a query string or a
   * fragment does not match.
   */
  function isConversationUrl(url) {
    if (typeof url !== 'string' || !url) return false;
    let parsed;
    try {
      parsed = new URL(url, window.location.href);
    } catch (_) {
      return false;
    }
    if (parsed.origin !== window.location.origin) return false;
    return CONVERSATION_PATH_RE.test(parsed.pathname);
  }

  function isGetMethod(method) {
    return method === undefined || method === null || String(method).toUpperCase() === 'GET';
  }

  /**
   * URL and method of a fetch() call. Only a string, a URL or a real Request
   * is read; any other object is ignored, because the page decides what such
   * an object claims in `.url` and what it turns into when fetched.
   */
  function describeFetchCall(args) {
    const request = args[0];
    const init = args[1];
    const initMethod = init && typeof init === 'object' ? init.method : undefined;
    if (typeof request === 'string') return { url: request, method: initMethod };
    if (request instanceof URL) return { url: request.href, method: initMethod };
    if (request instanceof Request) return { url: request.url, method: initMethod || request.method };
    return null;
  }

  // ============================================================================
  // PASSIVE FETCH INTERCEPTOR
  // ============================================================================

  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);

    try {
      const call = describeFetchCall(args);

      // The response's own URL is what was actually fetched (after redirects);
      // it has to be the conversation endpoint too, served same-origin.
      const isConversationRequest = call !== null
        && isGetMethod(call.method)
        && isConversationUrl(call.url)
        && response.type === 'basic'
        && isConversationUrl(response.url);

      if (isConversationRequest) {
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

        clone.json()
          .then(async data => {
            if (!data || typeof data !== 'object') {
              logWarn('Invalid data structure: not an object');
              return;
            }
            if (Array.isArray(data.chat_messages)) {
              await sendDataToContentScript(data);
            }
          })
          .catch(error => {
            logWarn('Failed to parse response', { error: error.message });
          });
      }
    } catch {
      // Never interrupt the original fetch return
    }

    return response;
  };

  // ============================================================================
  // PASSIVE XHR INTERCEPTOR
  // ============================================================================

  // Requests opened through the real XMLHttpRequest.open, keyed by instance.
  // An object that never went through open() is not in the map, so send()
  // called on a look-alike object is not treated as a conversation request.
  const openedXhrs = new WeakMap();

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const result = originalXhrOpen.call(this, method, url, ...rest);
    try {
      openedXhrs.set(this, { url: typeof url === 'string' ? url : String(url), method });
    } catch (_) {}
    return result;
  };

  XMLHttpRequest.prototype.send = function (...args) {
    try {
      const opened = openedXhrs.get(this);
      if (opened && isGetMethod(opened.method) && isConversationUrl(opened.url)) {
        this.addEventListener('load', () => {
          try {
            if (this.status < 200 || this.status >= 300) return;
            // responseURL is the final URL after redirects.
            if (!isConversationUrl(this.responseURL)) return;
            const text = this.responseText;
            if (!text || text.length > MAX_RESPONSE_SIZE) return;
            let data;
            try {
              data = JSON.parse(text);
            } catch (_) {
              return;
            }
            if (data && typeof data === 'object' && Array.isArray(data.chat_messages)) {
              sendDataToContentScript(data).catch(() => {});
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
