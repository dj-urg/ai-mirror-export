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

  // Only Mistral's own tRPC reads are captured: same origin, a path that is
  // exactly /api/trpc/<procedures>, GET. A looser match would let any
  // request whose URL merely contains such a path be stored as a chat.
  const TRPC_PATH_RE = /^\/api\/trpc\/([^/]+)$/;

  function isGet(method) {
    return method === undefined || method === null || String(method).toUpperCase() === 'GET';
  }

  function trpcProcedures(url) {
    if (typeof url !== 'string' || !url) return [];
    let u;
    try { u = new URL(url, window.location.href); } catch (_) { return []; }
    if (u.origin !== window.location.origin) return [];
    const m = u.pathname.match(TRPC_PATH_RE);
    if (!m) return [];
    let list;
    try { list = decodeURIComponent(m[1]); } catch (_) { return []; }
    return list.split(',').map(s => s.trim()).filter(Boolean);
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
      const u = new URL(url, window.location.href);
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
        // A reply without an `items` array is not a message list (an error
        // or another shape); forwarding it as an empty list would wipe a
        // stored conversation.
        if (!Array.isArray(json.items)) continue;
        const items = json.items;
        if (items.length === 0 && !chatId) continue;
        const resolvedChatId = chatId || (items[0] && items[0].chatId) || null;
        if (!resolvedChatId) continue;
        // The request's cursor and the reply's nextCursor tell the content
        // script whether this is the whole list or one page of it.
        const input = parseTrpcInput(url);
        const entryInput = input && input[String(i)] && input[String(i)].json;
        const requestCursor = entryInput && entryInput.cursor !== undefined && entryInput.cursor !== null;
        const nextCursor = json.nextCursor !== undefined && json.nextCursor !== null && json.nextCursor !== '';
        out.push({
          chatId: resolvedChatId,
          kind: 'messages',
          messages: items,
          partial: Boolean(requestCursor || nextCursor)
        });
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
      // The URL and method come from the request only when it is a string
      // or a real Request; the response's own URL (after redirects) has the
      // last word, so an object that merely looks like a request cannot
      // label another response as a chat.
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
      if (req && isGet(req.method) && isInterestingRequest(req.url)) {
        this.addEventListener('load', () => {
          try {
            if (this.status < 200 || this.status >= 300) return;
            // The final URL (after redirects) decides, not the one passed to open().
            const url = this.responseURL;
            if (!isInterestingRequest(url)) return;
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

})();
