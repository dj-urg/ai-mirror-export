/**
 * ChatGPT Platform - Page Context Script (inject.js)
 * 
 * This script runs in the page context to:
 * 1. Intercept ChatGPT's fetch calls (Passive Strategy)
 * 2. Monitor URL changes and manually fetch data (Active Strategy)
 * 3. Capture authentication headers for active fetching
 */

(function () {
  'use strict';

  const PLATFORM = 'ChatGPT';
  const MESSAGE_TYPE = 'CHATGPT_CONVERSATION_DATA';
  const SOURCE_ID = 'chatgpt-exporter-inject';

  // Logging configuration
  const DEBUG_MODE = false; // Set to true for development, false for production

  // Response validation configuration
  const MAX_RESPONSE_SIZE = 100 * 1024 * 1024; // 100MB

  // Store captured conversation IDs to avoid duplicate fetches
  const capturedIds = new Set();

  // Store captured headers for active fetching
  let capturedHeaders = null;

  // Store the original fetch function
  const originalFetch = window.fetch;

  // Get secret key from content script
  let SECRET_KEY = null;

  /**
   * Redact sensitive information from log data
   * @param {any} data - Data to redact
   * @returns {any} Redacted data
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
   * Send data to content script with cryptographic signature
   */
  async function sendDataToContentScript(data) {
    if (!data || (!data.mapping && !data.conversation_id)) return;

    const conversationId = data.conversation_id || data.id;
    if (conversationId) {
      capturedIds.add(conversationId);
    }

    // Get secret key using shared helper
    const secret = MessageSecurity.getSharedSecret('chatgpt-exporter-secret');
    if (!secret) {
      logWarn('Secret key not available, cannot send message');
      return;
    }

    // Create signed message using shared module
    const signedMessage = await MessageSecurity.createSignedMessage(
      data,
      MESSAGE_TYPE,
      SOURCE_ID,
      'chatgpt',
      secret
    );

    // Send signed message
    window.postMessage(
      signedMessage,
      window.location.origin
    );

    logDebug('Captured conversation data (signed)', {
      conversationId: conversationId,
      nodeCount: data.mapping ? Object.keys(data.mapping).length : 0,
      source: 'active-fetch'
    });
  }

  /**
   * Manually fetch conversation data
   */
  async function fetchConversation(conversationId) {
    if (capturedIds.has(conversationId)) {
      logDebug('Already captured conversation, skipping active fetch', { conversationId });
      return;
    }

    if (!capturedHeaders) {
      logWarn('Cannot active fetch: No headers captured yet');
      return;
    }

    logDebug('Active fetch triggered', { conversationId });

    try {
      const response = await originalFetch(`https://chatgpt.com/backend-api/conversation/${conversationId}`, {
        method: 'GET',
        headers: capturedHeaders
      });

      // Validate response
      const validation = validateResponse(response);
      if (!validation.isValid) {
        logWarn('Active fetch validation failed', { error: validation.error });
        return;
      }

      const data = await response.json();

      // Validate data structure before processing
      if (!data || typeof data !== 'object') {
        logWarn('Invalid data structure: not an object');
        return;
      }

      await sendDataToContentScript(data);

    } catch (error) {
      logError('Active fetch error', { error: error.message });
    }
  }

  /**
   * Check current URL and trigger fetch if it's a conversation
   */
  function checkCurrentUrl() {
    const url = window.location.href;
    const match = url.match(/\/c\/([a-f0-9-]+)/i);

    if (match && match[1]) {
      const conversationId = match[1];
      logDebug('URL changed to conversation', { conversationId });
      fetchConversation(conversationId);
    }
  }

  /**
   * Hook History API to detect SPA navigation
   */
  function hookHistoryApi() {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
      const result = originalPushState.apply(this, args);
      checkCurrentUrl();
      return result;
    };

    history.replaceState = function (...args) {
      const result = originalReplaceState.apply(this, args);
      checkCurrentUrl();
      return result;
    };

    window.addEventListener('popstate', checkCurrentUrl);
  }

  /**
   * Hook window.fetch to intercept conversation API responses (Passive Backup)
   */
  window.fetch = async function (...args) {
    // Capture headers from outgoing requests
    try {
      const request = args[0];
      let url = '';
      let options = args[1] || {};

      if (typeof request === 'string') {
        url = request;
      } else if (request instanceof Request) {
        url = request.url;
        // If request is a Request object, we might need to clone it to read headers if they aren't in options
        // But usually for fetch(Request), headers are in the Request object
      }

      // Look for backend-api requests to capture headers
      if (url && url.includes('backend-api') && !capturedHeaders) {
        // Try to extract headers
        let headers = options.headers;

        // If headers are in the Request object
        if (!headers && request instanceof Request) {
          headers = request.headers;
        }

        if (headers) {
          // We need specific headers like Authorization
          // Convert to plain object if it's a Headers object
          const headerObj = {};
          if (headers instanceof Headers) {
            headers.forEach((value, key) => {
              headerObj[key] = value;
            });
          } else {
            Object.assign(headerObj, headers);
          }

          // Check if we have auth token
          if (headerObj['Authorization'] || headerObj['authorization']) {
            capturedHeaders = headerObj;
            console.log(`[${PLATFORM}] Captured auth headers`);
          }
        }
      }
    } catch (e) {
      // Ignore header capture errors
    }

    const response = await originalFetch.apply(this, args);

    try {
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

      // Check if this is a conversation API request
      const isConversationRequest = url && (
        url.includes('/backend-api/conversation/') ||
        url.includes('/api/conversation/') ||
        url.match(/\/conversation\/[a-f0-9-]+/i)
      );

      // Check if this is a conversation list request (to find Gizmo IDs)
      const isListRequest = url && url.includes('/conversations?');

      if (isConversationRequest) {
        // Validate response before processing
        const validation = validateResponse(response);
        if (!validation.isValid) {
          logWarn('Passive intercept validation failed', { error: validation.error });
          return response;
        }

        // Clone response for processing
        let clone;
        try {
          clone = response.clone();
        } catch (cloneError) {
          logWarn('Could not clone response', { error: cloneError.message });
          return response;
        }

        // Parse JSON with validation
        clone.json()
          .then(async data => {
            // Validate data structure
            if (!data || typeof data !== 'object') {
              logWarn('Invalid data structure: not an object');
              return;
            }

            // Validate platform-specific structure
            if (data.mapping || data.conversation_id) {
              await sendDataToContentScript(data);
            }
          })
          .catch(error => {
            logWarn('Failed to parse response', { error: error.message });
          });
      }

      if (isListRequest) {
        // Validate response before processing
        const validation = validateResponse(response);
        if (!validation.isValid) {
          return response;
        }

        const clone = response.clone();
        clone.json().then(data => {
          // console.log(`[${PLATFORM}] Intercepted conversation list`, data);
        }).catch(() => { });
      }

    } catch (e) {
      // Ignore errors in passive interceptor
    }

    return response;
  };

  // Initialize
  hookHistoryApi();
  checkCurrentUrl(); // Check initial URL
  logInfo('Active fetcher installed');

})();

