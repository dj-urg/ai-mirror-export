/**
 * Copilot Platform - Page Context Script (inject.js)
 * 
 * This script runs in the page context to intercept Copilot's fetch calls
 * and capture conversation JSON payloads.
 */

(function () {
  'use strict';

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
  document.documentElement.dataset.copilotExporterSecret = storedSecret;

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
   * Log info message
   */
  function logInfo(message, data = null) {
    if (IS_PRODUCTION) return;
    if (data) {
      console.log(`[${PLATFORM}]`, message, redactSensitiveData(data));
    } else {
      console.log(`[${PLATFORM}]`, message);
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

  /**
   * Log error message
   */
  function logError(message, data = null) {
    if (IS_PRODUCTION) return;
    if (data) {
      console.error(`[${PLATFORM}] [ERROR]`, message, redactSensitiveData(data));
    } else {
      console.error(`[${PLATFORM}] [ERROR]`, message);
    }
  }

  /**
   * Validate response before processing
   * @param {Response} response - The fetch response
   * @returns {Object} Validation result with isValid and error properties
   */
  function validateResponse(response) {
    // Check if response is OK
    if (!response.ok) {
      return { isValid: false, error: `Response not OK: ${response.status}` };
    }

    // Validate Content-Type
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      return { isValid: false, error: `Invalid content type: ${contentType}` };
    }

    // Check response size
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


  /**
   * Sign a message using HMAC-SHA256
   */
  async function signMessage(message, secret) {
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

    const signature = await crypto.subtle.sign('HMAC', key, messageData);
    return Array.from(new Uint8Array(signature), byte =>
      byte.toString(16).padStart(2, '0')
    ).join('');
  }

  /**
   * Extract conversation ID from Copilot API URL
   * @param {string} url - The API URL
   * @returns {string} The conversation ID or 'unknown'
   */
  function extractConversationIdFromUrl(url) {
    // Match pattern: /c/api/conversations/{conversationId}/history
    const match = url.match(/\/c\/api\/conversations\/([^/]+)\/history/);
    return match ? match[1] : 'unknown';
  }

  /**
   * Hook window.fetch to intercept conversation API responses
   */
  window.fetch = async function (...args) {
    // Call the original fetch
    const response = await originalFetch.apply(this, args);

    try {
      // Extract URL from arguments
      const request = args[0];
      let url = '';

      if (typeof request === 'string') {
        url = request;
      } else if (request instanceof Request) {
        url = request.url;
      } else if (request && typeof request === 'object' && request.url) {
        url = request.url;
      } else {
        url = String(request);
      }

      // Check if this is a conversation history API request
      // Copilot uses URLs like: /c/api/conversations/{conversationId}/history?api-version=2
      const isConversationRequest = url && (
        url.includes('/c/api/conversations/') &&
        url.includes('/history')
      );

      if (isConversationRequest) {
        logDebug('Detected conversation API request, attempting to capture...');

        // Validate response before processing
        const validation = validateResponse(response);
        if (!validation.isValid) {
          logWarn('Response validation failed', { error: validation.error });
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
              // Extract conversation ID from URL
              const conversationId = extractConversationIdFromUrl(url);

              // Add conversation ID to the payload
              const payloadWithId = {
                ...data,
                conversationId: conversationId
              };

              if (!storedSecret) {
                logWarn('Secret key not available, cannot send message');
                return;
              }
              const secret = storedSecret;

              // Create message with timestamp and nonce
              const timestamp = Date.now();
              const nonce = crypto.getRandomValues(new Uint32Array(1))[0].toString(36);

              const messageData = {
                type: MESSAGE_TYPE,
                payload: payloadWithId,
                source: SOURCE_ID,
                platform: 'copilot',
                timestamp: timestamp,
                nonce: nonce
              };

              // Sign the message
              const messageString = JSON.stringify(messageData);
              const signature = await signMessage(messageString, secret);

              // Send signed message to content script via postMessage
              window.postMessage(
                {
                  ...messageData,
                  signature: signature
                },
                window.location.origin
              );

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

  logInfo('Fetch interceptor installed in page context');

})();
