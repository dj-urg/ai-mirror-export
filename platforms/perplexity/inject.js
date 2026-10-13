/**
 * Perplexity Platform - Page Context Script (inject.js)
 *
 * Runs in the MAIN world to passively intercept Perplexity's own fetch calls.
 * When the page loads a thread from /rest/thread/{uuid}, this script captures
 * the response, strips the thread read/write token, and forwards it to the
 * content script via a signed postMessage.
 *
 * Perplexity paginates thread history across multiple requests to the same
 * endpoint (offset / next_cursor); each page is forwarded individually and the
 * content script merges pages keyed by thread UUID.
 *
 * No authentication headers are captured or stored.
 */

(function () {
  'use strict';

  const PLATFORM = 'Perplexity';
  const MESSAGE_TYPE = 'PERPLEXITY_CONVERSATION_DATA';
  const SOURCE_ID = 'perplexity-exporter-inject';

  const IS_PRODUCTION = false;
  const DEBUG_MODE = true;
  const MAX_RESPONSE_SIZE = 100 * 1024 * 1024; // 100MB

  const originalFetch = window.fetch;
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;
  const originalPostMessage = window.postMessage.bind(window);
  const originalMessageSecurity = window.MessageSecurity;

  // Always-on install breadcrumb so we can tell from the console whether
  // the MAIN-world script loaded. Carries no page data.
  console.log('[Perplexity Exporter] inject.js installed in MAIN world');
  // Expose a tiny probe so the user can run a one-liner in the console to
  // confirm this file is active and verify URL-matching.
  window.__perplexityExporterProbe = {
    installed: true,
    testUrl(url) {
      return UUID_RE.test(String(url));
    }
  };

  // Generate the signing secret in the MAIN world before any page scripts run,
  // then stash it in a documentElement attribute so content.js can read it once
  // and remove it. Same handshake as the ChatGPT/Claude handlers.
  const storedSecret = (() => {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
  })();
  document.documentElement.setAttribute('data-perplexity-exporter-secret', storedSecret);

  // Fields that could be used by anyone who obtains the exported bundle to post
  // in the thread or impersonate the owner. Stripped before any data leaves
  // the MAIN world, so neither content.js, the background worker, nor the
  // user's download can ever see them.
  const TOKEN_FIELDS = new Set([
    'read_write_token',
    'write_token',
    'collection_write_token',
    'session_token'
  ]);

  function stripTokens(value) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      for (const item of value) stripTokens(item);
      return value;
    }
    for (const key of Object.keys(value)) {
      if (TOKEN_FIELDS.has(key)) {
        delete value[key];
        continue;
      }
      const child = value[key];
      if (child && typeof child === 'object') stripTokens(child);
    }
    return value;
  }

  function redactSensitiveData(data) {
    if (!data || typeof data !== 'object') return data;
    const redacted = Array.isArray(data) ? [...data] : { ...data };
    for (const key of ['uuid', 'backend_uuid', 'thread_uuid', 'id']) {
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

  function logWarn(message, data = null) {
    if (IS_PRODUCTION) return;
    data
      ? console.warn(`[${PLATFORM}] [WARN]`, message, redactSensitiveData(data))
      : console.warn(`[${PLATFORM}] [WARN]`, message);
  }

  function validateResponse(response) {
    if (!response.ok) {
      return { isValid: false, error: `Response not OK: ${response.status}` };
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      const size = parseInt(contentLength, 10);
      if (isNaN(size)) return { isValid: false, error: 'Invalid content-length header' };
      if (size > MAX_RESPONSE_SIZE) {
        return { isValid: false, error: `Response too large: ${size} bytes` };
      }
    }
    return { isValid: true };
  }

  // Match /rest/thread/<uuid> (and the historical /rest/threads/<uuid>) with
  // the UUID as the last path segment so we don't accidentally pick up
  // sub-resources like /export, /share, /comments.
  const UUID_RE = /\/rest\/threads?\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i;

  function extractThreadUuid(url) {
    const m = typeof url === 'string' ? url.match(UUID_RE) : null;
    return m ? m[1] : null;
  }

  async function sendDataToContentScript(threadUuid, data) {
    if (!threadUuid || !data || typeof data !== 'object') return;

    // Attach the URL-derived UUID so the content script can key pages even if
    // the response body uses a different top-level field name.
    data.__thread_uuid = threadUuid;

    const signedMessage = await originalMessageSecurity.createSignedMessage(
      data,
      MESSAGE_TYPE,
      SOURCE_ID,
      'perplexity',
      storedSecret
    );

    originalPostMessage(signedMessage, window.location.origin);

    logDebug('Captured thread page', {
      uuid: threadUuid,
      entryCount: Array.isArray(data.entries) ? data.entries.length
        : Array.isArray(data.data) ? data.data.length : 0
    });
  }

  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);

    try {
      const request = args[0];
      let url = '';
      if (typeof request === 'string') url = request;
      else if (request instanceof Request) url = request.url;
      else if (request && typeof request === 'object' && request.url) url = request.url;
      else url = String(request);

      const threadUuid = extractThreadUuid(url);
      if (!threadUuid) return response;

      console.log('[Perplexity Exporter] fetch matched thread URL', {
        uuid: threadUuid.substring(0, 8) + '...',
        status: response.status
      });

      const validation = validateResponse(response);
      if (!validation.isValid) {
        console.warn('[Perplexity Exporter] fetch rejected:', validation.error);
        return response;
      }

      const ctype = response.headers.get('content-type') || '';
      if (!ctype.toLowerCase().includes('application/json')) {
        console.warn('[Perplexity Exporter] fetch rejected: not JSON (' + ctype + ')');
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
          if (!data || typeof data !== 'object') return;
          stripTokens(data);
          await sendDataToContentScript(threadUuid, data);
        })
        .catch(error => {
          console.warn('[Perplexity Exporter] failed to parse response', error.message);
        });
    } catch (_) {
      // Never interrupt the original fetch return.
    }

    return response;
  };

  // XMLHttpRequest hook as a fallback — some SPA frameworks still use XHR.
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      this.__perplexityExporterUrl = typeof url === 'string' ? url : String(url);
    } catch (_) {}
    return originalXhrOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    try {
      const url = this.__perplexityExporterUrl || '';
      const threadUuid = extractThreadUuid(url);
      if (threadUuid) {
        this.addEventListener('load', () => {
          try {
            if (this.status < 200 || this.status >= 300) return;
            const text = this.responseText;
            if (!text || text.length > MAX_RESPONSE_SIZE) return;
            let data;
            try { data = JSON.parse(text); } catch (_) { return; }
            if (!data || typeof data !== 'object') return;
            console.log('[Perplexity Exporter] XHR matched thread URL', {
              uuid: threadUuid.substring(0, 8) + '...',
              status: this.status
            });
            stripTokens(data);
            sendDataToContentScript(threadUuid, data).catch(() => {});
          } catch (e) {
            console.warn('[Perplexity Exporter] XHR load handler failed', e.message);
          }
        });
      }
    } catch (_) {}
    return originalXhrSend.apply(this, args);
  };

  console.log('[Perplexity Exporter] fetch + XHR interceptors installed');

})();
