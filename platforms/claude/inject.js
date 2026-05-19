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
  document.documentElement.dataset.claudeExporterSecret = storedSecret;

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
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      return { isValid: false, error: `Invalid content type: ${contentType}` };
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
    const secret = storedSecret;

    const timestamp = Date.now();
    const nonce = crypto.getRandomValues(new Uint32Array(1))[0].toString(36);

    const messageData = {
      type: MESSAGE_TYPE,
      payload: data,
      source: SOURCE_ID,
      platform: 'claude',
      timestamp,
      nonce
    };

    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const msgData = encoder.encode(JSON.stringify(messageData));

    const key = await crypto.subtle.importKey(
      'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sigBuffer = await crypto.subtle.sign('HMAC', key, msgData);
    const signature = Array.from(new Uint8Array(sigBuffer), b =>
      b.toString(16).padStart(2, '0')
    ).join('');

    window.postMessage({ ...messageData, signature }, window.location.origin);

    logDebug('Captured conversation data', {
      uuid: conversationId,
      messageCount: data.chat_messages.length
    });
  }

  // ============================================================================
  // PASSIVE FETCH INTERCEPTOR
  // ============================================================================

  window.fetch = async function (...args) {
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

      const isConversationRequest = url && (
        url.includes('chat_conversations') ||
        (url.includes('/api/organizations/') && url.includes('/chat/'))
      );

      if (isConversationRequest) {
        const validation = validateResponse(response);
        if (!validation.isValid) {
          logWarn('Passive intercept validation failed', { error: validation.error });
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
    } catch (e) {
      // Never interrupt the original fetch return
    }

    return response;
  };

  logDebug('Passive fetch interceptor installed');

})();
