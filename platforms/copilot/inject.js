/**
 * Copilot Platform - Page Context Script (inject.js)
 * 
 * This script runs in the page context to intercept Copilot's fetch calls
 * and capture conversation JSON payloads.
 */

(function () {
  'use strict';

  // Idempotency guard. If this file is evaluated more than once in the same
  // page, a second evaluation must not wrap fetch again or mint a second
  // signing secret. The marker is a non-enumerable boolean; it carries no
  // data. It is set further down, once the prerequisites are known to be
  // present, so a failed first evaluation does not block a later one.
  const INSTALL_MARKER = '__aiChatExporterCopilotInjectInstalled';
  if (window[INSTALL_MARKER] === true) return;

  const PLATFORM = 'Copilot';
  const MESSAGE_TYPE = 'COPILOT_CONVERSATION_DATA';
  const SOURCE_ID = 'copilot-exporter-inject';

  // Logging configuration
  const IS_PRODUCTION = true;
  const DEBUG_MODE = false;

  // Response validation configuration
  const MAX_RESPONSE_SIZE = 100 * 1024 * 1024; // 100MB

  // Store the original fetch function
  const originalFetch = window.fetch;
  const originalPostMessage = window.postMessage.bind(window);
  const originalMessageSecurity = window.MessageSecurity;

  if (typeof originalFetch !== 'function' || !originalMessageSecurity) return;
  try {
    Object.defineProperty(window, INSTALL_MARKER, {
      value: true, enumerable: false, configurable: false, writable: false
    });
  } catch { /* defineProperty refused: install once anyway */ }

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
  document.documentElement.setAttribute('data-copilot-exporter-secret', storedSecret);

  /**
   * Redact sensitive information from log data
   */
  function redactSensitiveData(data) {
    if (!data || typeof data !== 'object') {
      return data;
    }

    const redacted = Array.isArray(data) ? [...data] : { ...data };

    // Redact conversation IDs (show first 8 chars only)
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

  /**
   * Log debug message (only in debug mode)
   */
  function logDebug(message, data = null) {
    if (!DEBUG_MODE) return;
    if (data) {
      console.log(`[${PLATFORM}] [DEBUG]`, message, redactSensitiveData(data));
    } else {
      console.log(`[${PLATFORM}] [DEBUG]`, message);
    }
  }

  /**
   * Log warning message
   */
  function logWarn(message, data = null) {
    if (IS_PRODUCTION) return;
    if (data) {
      console.warn(`[${PLATFORM}] [WARN]`, message, redactSensitiveData(data));
    } else {
      console.warn(`[${PLATFORM}] [WARN]`, message);
    }
  }

  function validateResponse(response) {
    if (!response.ok) {
      return { isValid: false, error: `Response not OK: ${response.status}` };
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      const size = parseInt(contentLength, 10);
      if (isNaN(size)) {
        return { isValid: false, error: 'Invalid content-length header' };
      }
      if (size > MAX_RESPONSE_SIZE) {
        return { isValid: false, error: `Response too large: ${size} bytes (max: ${MAX_RESPONSE_SIZE})` };
      }
    }

    return { isValid: true };
  }


  // Copilot URL shape: /c/api/conversations/{conversationId}/history
  // (optional query). The whole pathname has to match, on this origin, so a
  // URL that merely contains these substrings (another host, a fragment, a
  // query value, a sub-resource) is never captured.
  const HISTORY_PATH_RE = /^\/c\/api\/conversations\/([^/]+)\/history\/?$/i;

  /**
   * The URL a fetch call went to. Prefers the URL the browser reports on the
   * response; otherwise takes it from a string, URL or real Request argument
   * and nothing else (an arbitrary object with a `url` property is not a
   * request).
   */
  function requestUrl(request, response) {
    if (response && typeof response.url === 'string' && response.url) return response.url;
    if (typeof request === 'string') return request;
    if (request instanceof URL) return request.href;
    if (request instanceof Request) return request.url;
    return '';
  }

  /**
   * Extract conversation ID from a Copilot history API URL
   * @param {string} url - The API URL
   * @returns {string|null} The conversation ID, or null if the URL is not a
   *   same-origin history request
   */
  function extractConversationIdFromUrl(url) {
    if (!url) return null;
    let parsed;
    try {
      parsed = new URL(url, window.location.href);
    } catch {
      return null;
    }
    if (parsed.origin !== window.location.origin) return null;
    const match = parsed.pathname.match(HISTORY_PATH_RE);
    return match ? match[1] : null;
  }

  /**
   * Hook window.fetch to intercept conversation API responses
   */
  window.fetch = async function (...args) {
    // Call the original fetch
    const response = await originalFetch.apply(this, args);

    try {
      // Check if this is a conversation history API request
      const conversationId = extractConversationIdFromUrl(requestUrl(args[0], response));
      const isConversationRequest = conversationId !== null;

      if (isConversationRequest) {
        logDebug('Detected conversation API request, attempting to capture...');

        // Validate response before processing
        const validation = validateResponse(response);
        if (!validation.isValid) {
          logWarn('Response validation failed', { error: validation.error });
          return response;
        }

        const ctype = response.headers.get('content-type') || '';
        if (!ctype.toLowerCase().includes('application/json')) {
          return response;
        }

        // Clone the response so we can read it without consuming it
        let clone;
        try {
          clone = response.clone();
        } catch (cloneError) {
          logWarn('Could not clone response', { error: cloneError.message });
          return response;
        }

        // Parse the JSON asynchronously with validation
        clone.json()
          .then(async data => {
            // Validate data structure
            if (!data || typeof data !== 'object') {
              logWarn('Invalid data structure: not an object');
              return;
            }

            // Verify this looks like conversation data
            // Copilot conversations have a results array
            if (Array.isArray(data.results)) {
              // Add conversation ID (from the URL) to the payload
              const payloadWithId = {
                ...data,
                conversationId: conversationId
              };

              if (!storedSecret) {
                logWarn('Secret key not available, cannot send message');
                return;
              }

              const signedMessage = await originalMessageSecurity.createSignedMessage(
                payloadWithId,
                MESSAGE_TYPE,
                SOURCE_ID,
                'copilot',
                storedSecret
              );

              originalPostMessage(signedMessage, window.location.origin);

              logDebug('Captured conversation data (signed)', {
                conversationId: conversationId,
                messageCount: data.results.length,
                hasResults: true
              });
            } else {
              logDebug('Response does not look like conversation data (missing results array)');
            }
          })
          .catch(error => {
            logWarn('Failed to parse response', { error: error.message });
          });
      }
    } catch (e) {
      // Do not break the page if anything goes wrong
      logDebug('Error intercepting fetch', { error: e.message });
    }

    // Always return the original response
    return response;
  };

  logDebug('Passive fetch interceptor installed');

})();
