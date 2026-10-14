/**
 * Mistral (Le Chat / Vibe) Platform - Page Context Script (inject.js)
 *
 * Runs in the MAIN world to passively intercept Mistral's own fetch/XHR calls.
 * Mistral's web app uses tRPC batched endpoints under /api/trpc/, with two
 * endpoints of interest:
 *   - chat.byId        → conversation metadata (title, model, timestamps)
 *   - message.all      → the full message list for a chatId
 * Both can appear either on their own or batched together with other calls, so
 * we unwrap tRPC's `[{result:{data:{json:...}}}, ...]` envelope and pick off
 * the two procedures we care about.
 *
 * No authentication headers are captured. If the extension installs after a
 * conversation was already fetched, reload the page to re-trigger the fetches.
 */

(function () {
  'use strict';

  const PLATFORM = 'Mistral';
  const MESSAGE_TYPE = 'MISTRAL_CONVERSATION_DATA';
  const SOURCE_ID = 'mistral-exporter-inject';

  const IS_PRODUCTION = true;
  const DEBUG_MODE = false;
  const MAX_RESPONSE_SIZE = 100 * 1024 * 1024; // 100MB

  const originalFetch = window.fetch;
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;
  const originalPostMessage = window.postMessage.bind(window);
  const originalMessageSecurity = window.MessageSecurity;

  // ==========================================================================
  // SECRET BRIDGE — same pattern as Claude/Grok/ChatGPT. Write a hex-encoded
  // 32-byte secret into a dataset attribute at document_start so content.js
  // (ISOLATED world) can pick it up and we can use HMAC-signed postMessages.
  // ==========================================================================

  const storedSecret = (() => {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
  })();
  document.documentElement.setAttribute('data-mistral-exporter-secret', storedSecret);

  // ==========================================================================
  // LOGGING
  // ==========================================================================

  function redactSensitiveData(data) {
    if (!data || typeof data !== 'object') return data;
    const redacted = Array.isArray(data) ? [...data] : { ...data };
    if (redacted.conversationId && typeof redacted.conversationId === 'string') {
      redacted.conversationId = redacted.conversationId.substring(0, 8) + '...';
    }
    if (redacted.chatId && typeof redacted.chatId === 'string') {
      redacted.chatId = redacted.chatId.substring(0, 8) + '...';
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

  // ==========================================================================
  // RESPONSE VALIDATION
  // ==========================================================================

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

  // ==========================================================================
  // URL MATCHING
  //
  // Mistral batches tRPC procedures by joining them with commas, e.g.
  //   /api/trpc/settings.getEnabledChatFeatures,chat.byId,message.all?batch=1
  // Match the two procedures of interest by looking at the comma-separated
  // list, which also makes it trivial to recover the position of each
  // procedure in a batch when parsing the response.
  // ==========================================================================

  const TRPC_PATH_RE = /\/api\/trpc\/([^/?#]+)/;

  function trpcProcedures(url) {
    if (!url) return [];
    const m = url.match(TRPC_PATH_RE);
    if (!m) return [];
    return m[1].split(',').map(s => s.trim()).filter(Boolean);
  }

  function isInterestingRequest(url) {
    const procs = trpcProcedures(url);
    return procs.includes('message.all') || procs.includes('chat.byId');
  }

  // Extract the chatId that was requested for a given procedure, by parsing
  // the `input` query parameter. tRPC's batched input is a JSON object keyed
  // by batch position, so we need to know *which* index in the batch corresponds
  // to our procedure to find its arguments.
  function parseTrpcInput(url) {
    try {
      const u = new URL(url, window.location.origin);
      const raw = u.searchParams.get('input');
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function chatIdForProcedure(url, procedureName) {
    const procs = trpcProcedures(url);
    const idx = procs.indexOf(procedureName);
    if (idx === -1) return null;
    const input = parseTrpcInput(url);
    if (!input) return null;
    const entry = input[String(idx)];
    const json = entry && entry.json;
    if (!json || typeof json !== 'object') return null;
    return json.chatId || json.id || null;
  }

  // ==========================================================================
  // DATA FORWARDING
  //
  // Mistral's conversation state lives across two separate tRPC procedures,
  // so we assemble the final payload before signing + forwarding. Each piece
  // arrives independently (either from the same batched request, or from
  // separate requests moments apart); the content script merges them by
  // chatId once both are present.
  // ==========================================================================

  async function sendPartialToContentScript(partial) {
    if (!partial || typeof partial !== 'object') return;
    if (!partial.chatId) return;

    if (!storedSecret) {
      logWarn('Secret key not available, cannot send message');
      return;
    }

    const signedMessage = await originalMessageSecurity.createSignedMessage(
      partial,
      MESSAGE_TYPE,
      SOURCE_ID,
      'mistral',
      storedSecret
    );

    originalPostMessage(signedMessage, window.location.origin);

    logDebug('Captured Mistral partial', {
      chatId: partial.chatId,
      kind: partial.kind,
      itemCount: Array.isArray(partial.messages) ? partial.messages.length : undefined
    });
  }

  // Unwrap a tRPC batched response and pull out the `chat.byId` and
  // `message.all` payloads if present. The batched response is a JSON array
  // whose order matches the comma-joined procedure order in the URL.
  function extractFromTrpcBatch(url, body) {
    const procs = trpcProcedures(url);
    if (procs.length === 0) return [];

    let parsed;
    try { parsed = JSON.parse(body); } catch (_) { return []; }
    if (!Array.isArray(parsed)) return [];

    const out = [];
    for (let i = 0; i < procs.length; i++) {
      const name = procs[i];
      if (name !== 'chat.byId' && name !== 'message.all') continue;
      const entry = parsed[i];
      const json = entry && entry.result && entry.result.data && entry.result.data.json;
      if (!json || typeof json !== 'object') continue;
      const chatId = chatIdForProcedure(url, name);
      if (name === 'chat.byId') {
        // chat.byId returns the chat record directly as json.
        out.push({ chatId: json.id || chatId, kind: 'chat', chat: json });
      } else if (name === 'message.all') {
        const items = Array.isArray(json.items) ? json.items : [];
        if (items.length === 0 && !chatId) continue;
        const resolvedChatId = chatId || (items[0] && items[0].chatId) || null;
        if (!resolvedChatId) continue;
        out.push({ chatId: resolvedChatId, kind: 'messages', messages: items });
      }
    }
    return out;
  }

  // ==========================================================================
  // PASSIVE FETCH INTERCEPTOR
  // ==========================================================================

  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);

    try {
      const request = args[0];
      let url = '';
      if (typeof request === 'string') url = request;
      else if (request instanceof Request) url = request.url;
      else if (request && typeof request === 'object' && request.url) url = request.url;
      else url = String(request);

      if (!isInterestingRequest(url)) return response;

      const validation = validateResponse(response);
      if (!validation.isValid) {
        logWarn('Passive intercept validation failed', { error: validation.error });
        return response;
      }

      const ctype = response.headers.get('content-type') || '';
      if (!ctype.toLowerCase().includes('application/json')) return response;

      let clone;
      try { clone = response.clone(); }
      catch (cloneError) {
        logWarn('Could not clone response', { error: cloneError.message });
        return response;
      }

      clone.text().then(async body => {
        const partials = extractFromTrpcBatch(url, body);
        for (const p of partials) {
          await sendPartialToContentScript(p);
        }
      }).catch(error => {
        logWarn('Failed to parse response', { error: error.message });
      });
    } catch (_) {
      // Never interrupt the original fetch return.
    }

    return response;
  };

  // ==========================================================================
  // PASSIVE XHR INTERCEPTOR — defense in depth; Mistral uses fetch today but
  // tRPC links can switch transports under load.
  // ==========================================================================

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      this.__mistralExporterUrl = typeof url === 'string' ? url : String(url);
      this.__mistralExporterMethod = method;
    } catch (_) {}
    return originalXhrOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    try {
      const url = this.__mistralExporterUrl || '';
      if (isInterestingRequest(url)) {
        this.addEventListener('load', () => {
          try {
            if (this.status < 200 || this.status >= 300) return;
            const text = this.responseText;
            if (!text || text.length > MAX_RESPONSE_SIZE) return;
            const partials = extractFromTrpcBatch(url, text);
            for (const p of partials) {
              sendPartialToContentScript(p).catch(() => {});
            }
          } catch (e) {
            logWarn('XHR load handler failed', { error: e.message });
          }
        });
      }
    } catch (_) {}
    return originalXhrSend.apply(this, args);
  };

  // Expose the helper names needed by tests / debugging without leaking the
  // secret or the capture state.
  Object.defineProperty(window, '__mistralExporterIsInterestingRequest', {
    value: isInterestingRequest,
    writable: false,
    configurable: false,
    enumerable: false
  });

})();
