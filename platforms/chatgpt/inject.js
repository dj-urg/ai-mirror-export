/**
 * ChatGPT Platform - Page Context Script (inject.js)
 *
 * Runs in the MAIN world to passively intercept ChatGPT's own fetch calls.
 * When ChatGPT loads a conversation from its backend API, this script captures
 * the response and forwards it to the content script via a signed postMessage.
 *
 * No authentication headers are captured or stored.
 * If the extension loads after a conversation has already been fetched,
 * the user should reload the page to trigger a new fetch.
 */

(function () {
  'use strict';

  const PLATFORM = 'ChatGPT';
  const MESSAGE_TYPE = 'CHATGPT_CONVERSATION_DATA';
  const SOURCE_ID = 'chatgpt-exporter-inject';

  const IS_PRODUCTION = true;
  const DEBUG_MODE = false;
  const MAX_RESPONSE_SIZE = 100 * 1024 * 1024; // 100MB

  const originalFetch = window.fetch;
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
  document.documentElement.setAttribute('data-chatgpt-exporter-secret', storedSecret);

  // ============================================================================
  // LOGGING
  // ============================================================================

  function redactSensitiveData(data) {
    if (!data || typeof data !== 'object') return data;
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

  // A conversation payload carries its messages either as a `mapping` object
  // (node id -> node) or as a flat `messages` array. A response with neither
  // is not a conversation and must not replace one that was captured.
  function hasMessages(data) {
    const hasMapping = data.mapping !== null && typeof data.mapping === 'object' && !Array.isArray(data.mapping);
    return hasMapping || Array.isArray(data.messages);
  }

  async function sendDataToContentScript(data) {
    if (!data || !hasMessages(data)) return;

    const conversationId = data.conversation_id || data.id;

    if (!storedSecret) {
      logWarn('Secret key not available, cannot send message');
      return;
    }
    const secret = storedSecret;

    const signedMessage = await originalMessageSecurity.createSignedMessage(
      data,
      MESSAGE_TYPE,
      SOURCE_ID,
      'chatgpt',
      secret
    );

    originalPostMessage(signedMessage, window.location.origin);

    logDebug('Captured conversation data', {
      conversationId,
      nodeCount: data.mapping ? Object.keys(data.mapping).length : 0
    });
  }

  // ============================================================================
  // PASSIVE FETCH INTERCEPTOR
  // ============================================================================

  // /backend-api/conversation/{uuid} or /backend-api/conversations/{uuid},
  // matched against the whole path: the UUID is the last segment (no
  // sub-resources like /text-docs, /init) and nothing may precede the prefix.
  const CONVERSATION_PATH_RE =
    /^\/backend-api\/conversations?\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

  // The address a fetch() call names. Only the types fetch itself accepts are
  // read: a look-alike object with a `url` property is ignored, because fetch
  // would request String(object), not object.url.
  function requestUrl(input) {
    if (typeof input === 'string') return input;
    if (input instanceof Request) return input.url;
    if (input instanceof URL) return input.href;
    return '';
  }

  function requestMethod(input, init) {
    const method = (init && init.method) || (input instanceof Request ? input.method : 'GET');
    return String(method).toUpperCase();
  }

  /**
   * The conversation id if this call is ChatGPT's own GET of a conversation,
   * else null. The page can call the hooked fetch with any address, so the
   * check is on what was actually fetched: a same-origin https response
   * (`response.url`, after redirects) whose path is exactly the conversation
   * endpoint. blob:, data: and cross-origin URLs that merely contain the path
   * do not qualify.
   */
  function conversationIdForRequest(input, init, response) {
    if (requestMethod(input, init) !== 'GET') return null;
    // 'basic' is a same-origin network response; 'default' is one a service
    // worker built. 'cors' and the opaque types are cross-origin.
    if (response.type !== 'basic' && response.type !== 'default') return null;

    let parsed;
    try {
      parsed = new URL(response.url || requestUrl(input), window.location.href);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:' || parsed.origin !== window.location.origin) return null;

    const match = parsed.pathname.match(CONVERSATION_PATH_RE);
    return match ? match[1].toLowerCase() : null;
  }

  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);

    try {
      const requestedId = conversationIdForRequest(args[0], args[1], response);

      if (requestedId) {
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
            // The endpoint answers for the conversation in its URL; a body
            // that names another one is not what the page asked for.
            const bodyId = data.conversation_id || data.id;
            if (typeof bodyId === 'string' && bodyId.toLowerCase() !== requestedId) {
              logWarn('Conversation id in response does not match the request');
              return;
            }
            await sendDataToContentScript(data);
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

  logDebug('Passive fetch interceptor installed');

})();
