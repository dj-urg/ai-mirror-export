/**
 * Google Gemini Platform - Content Script
 *
 * Gemini's web app keeps conversations behind a private batchexecute RPC
 * (`hNvQHb`) rather than a plain JSON endpoint. This script:
 *
 * - Reads the page's XSRF token (`SNlM0e`), build label (`cfb2h`), and
 *   session id (`FdrFJe`) from the rendered HTML (with a
 *   `performance.getEntriesByType('resource')` fallback for the last two).
 * - Re-fetches the open conversation through that RPC, page by page, using
 *   the site's own cookies. Same-origin only; nothing leaves the browser.
 * - Decodes the raw protobuf-ish turn arrays into a plain
 *   `{ conversation, messages }` payload so the extractor does not depend on
 *   Gemini's array layout.
 * - Stores conversations in memory for the popup to export on demand.
 * - Forwards export requests to the background for CSV generation.
 *
 * The RPC returns turns newest-first; this script reverses them and dedupes
 * by response id so the payload is oldest-first, like every other platform.
 */

(function () {
  'use strict';

  const PLATFORM = 'Gemini';
  const MESSAGE_TYPE = 'GEMINI_CONVERSATION_DATA';
  const RPC_ID = 'hNvQHb';
  const PAGE_SIZE = 50;
  const MAX_PAGES = 200;

  const IS_PRODUCTION = true;
  const DEBUG_MODE = false;

  const MAX_STORED_CONVERSATIONS = 50;
  const MAX_CONVERSATION_AGE_MS = 3600000; // 1 hour
  const CLEANUP_INTERVAL_MS = 300000; // 5 minutes
  const REQUEST_TIMEOUT_MS = 20000;
  // How long GET_CAPTURED_CONVERSATIONS waits for a cold fetch before
  // answering. The popup polls every 2 s, so answering quickly and letting
  // the next poll pick up the data is better than blocking the popup on a
  // long paginated export.
  const COLD_START_WAIT_MS = 4000;

  // Keyed by normalized conversation id (`c_<url id>`); value:
  //   { id, title, conversation, messages, fetchedAt }
  const capturedConversations = new Map();
  const conversationTimestamps = new Map();
  // In-flight fetches, keyed by conversation id, so the page-load kickoff,
  // the popup poll and an export click share one network round-trip.
  const inflightFetches = new Map();

  let authFailureReported = false;

  // ==========================================================================
  // LOGGING
  // ==========================================================================

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
    if (data) console.log(`[${PLATFORM}] [DEBUG]`, message, redactSensitiveData(data));
    else console.log(`[${PLATFORM}] [DEBUG]`, message);
  }

  function logInfo(message, data = null) {
    if (IS_PRODUCTION) return;
    if (data) console.log(`[${PLATFORM}]`, message, redactSensitiveData(data));
    else console.log(`[${PLATFORM}]`, message);
  }

  function logWarn(message, data = null) {
    if (IS_PRODUCTION) return;
    if (data) console.warn(`[${PLATFORM}] [WARN]`, message, redactSensitiveData(data));
    else console.warn(`[${PLATFORM}] [WARN]`, message);
  }

  // ==========================================================================
  // MEMORY MANAGEMENT
  // ==========================================================================

  function evictOldestIfFull() {
    if (capturedConversations.size < MAX_STORED_CONVERSATIONS) return;
    let oldestId = null;
    let oldestTime = Infinity;
    for (const [id, ts] of conversationTimestamps.entries()) {
      if (ts < oldestTime) { oldestTime = ts; oldestId = id; }
    }
    if (oldestId) {
      capturedConversations.delete(oldestId);
      conversationTimestamps.delete(oldestId);
      logDebug('Memory limit reached. Evicted oldest conversation', { conversationId: oldestId });
    }
  }

  function storeConversation(record) {
    evictOldestIfFull();
    capturedConversations.set(record.id, record);
    conversationTimestamps.set(record.id, Date.now());
  }

  function cleanupOldConversations() {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, ts] of conversationTimestamps.entries()) {
      if (now - ts > MAX_CONVERSATION_AGE_MS) {
        capturedConversations.delete(id);
        conversationTimestamps.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logDebug(`Cleaned up ${cleaned} old conversation(s)`, { remaining: capturedConversations.size });
    }
  }
  setInterval(cleanupOldConversations, CLEANUP_INTERVAL_MS);

  function isConversationComplete(record) {
    return !!(record && Array.isArray(record.messages) && record.messages.length > 0);
  }

  // ==========================================================================
  // ROUTE / CONFIG HELPERS
  // ==========================================================================

  /**
   * Normalize the `/app/<id>` path segment to the id the RPC expects.
   * Gemini's own pages use a bare id; the history RPC wants `c_<id>`.
   * @returns {{ id: string, rawId: string } | null}
   */
  function parseConversationFromPath() {
    const match = window.location.pathname.match(/^(?:\/u\/\d+)?\/app\/([^/?]+)/);
    if (!match) return null;
    let rawId;
    try {
      rawId = decodeURIComponent(match[1]);
    } catch (_) {
      rawId = match[1];
    }
    if (!rawId) return null;
    return { id: rawId.startsWith('c_') ? rawId : `c_${rawId}`, rawId };
  }

  function extractConversationIdFromPath() {
    const parsed = parseConversationFromPath();
    return parsed ? parsed.id : null;
  }

  /** Multi-account prefix: `/u/<n>/`, omitted for the default account. */
  function accountPrefix() {
    const match = window.location.pathname.match(/^\/u\/(\d+)(?:\/|$)/);
    return match ? `/u/${match[1]}` : '';
  }

  /**
   * Read the batchexecute request parameters. The tokens are embedded in the
   * page's inline `WIZ_global_data` script, which the isolated content-script
   * world can read through the DOM. The build label and session id also
   * appear on requests Gemini has already made, used as a fallback when the
   * HTML has not been parsed yet.
   * @returns {{ at: string, bl: string, sid: string }}
   */
  function readPageConfig() {
    let html = '';
    try {
      html = document.documentElement ? document.documentElement.innerHTML : '';
    } catch (_) {
      html = '';
    }

    const atMatch = html.match(/"SNlM0e":"([^"]+)"/);
    const blMatch = html.match(/"cfb2h":"([^"]+)"/);
    const sidMatch = html.match(/"FdrFJe":"([^"]+)"/);

    let bl = blMatch ? blMatch[1] : '';
    let sid = sidMatch ? sidMatch[1] : '';

    if (!bl || !sid) {
      try {
        const entry = performance.getEntriesByType('resource')
          .find((e) => typeof e.name === 'string' && e.name.includes('batchexecute'));
        if (entry) {
          if (!bl) {
            const m = entry.name.match(/[?&]bl=([^&]+)/);
            if (m) bl = decodeURIComponent(m[1]);
          }
          if (!sid) {
            const m = entry.name.match(/[?&]f\.sid=(-?\d+)/);
            if (m) sid = m[1];
          }
        }
      } catch (_) {
        // performance API unavailable; fall through to the defaults.
      }
    }

    return {
      at: atMatch ? atMatch[1] : '',
      bl: bl || 'boq_assistant-bard-web-server_20250101.00_p0',
      sid: sid || '0'
    };
  }

  // ==========================================================================
  // BATCHEXECUTE RPC
  // ==========================================================================

  function parseJsonLines(raw) {
    if (typeof raw !== 'string' || raw.length === 0) return [];
    const withoutPrefix = raw.replace(/^\)\]\}'\r?\n?/, '');
    const out = [];
    for (const rawLine of withoutPrefix.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || /^\d+$/.test(line)) continue;
      try {
        out.push(JSON.parse(line));
      } catch (_) {
        // Length markers and transport metadata are not payloads.
      }
    }
    return out;
  }

  function findRpcPayload(value, rpcId) {
    if (!Array.isArray(value)) return null;
    if (value[0] === 'wrb.fr' && value[1] === rpcId && typeof value[2] === 'string') {
      return value[2];
    }
    for (const child of value) {
      const found = findRpcPayload(child, rpcId);
      if (found !== null) return found;
    }
    return null;
  }

  function parseBatchexecuteResponse(raw, rpcId) {
    for (const chunk of parseJsonLines(raw)) {
      const encoded = findRpcPayload(chunk, rpcId);
      if (encoded === null) continue;
      try {
        return JSON.parse(encoded);
      } catch (error) {
        throw new Error(`Gemini returned malformed JSON for ${rpcId}: ${error.message}`);
      }
    }
    throw new Error(`Gemini's response did not contain ${rpcId}. The private API may have changed.`);
  }

  function makeReqId() {
    return String(Math.floor(Math.random() * 9000000) + 1000000);
  }

  function reportAuthFailure() {
    if (authFailureReported) return;
    authFailureReported = true;
    browser.runtime.sendMessage({
      type: 'AUTH_FAILED',
      platform: 'gemini',
      detail: { where: 'history' }
    }).catch(() => { /* popup may not be open */ });
  }

  function reportAuthRecovered() {
    if (!authFailureReported) return;
    authFailureReported = false;
    browser.runtime.sendMessage({
      type: 'AUTH_RECOVERED',
      platform: 'gemini'
    }).catch(() => { /* popup may not be open */ });
  }

  async function fetchHistoryPage(conversationId, rawId, cursor) {
    const config = readPageConfig();
    if (!config.at) {
      throw new Error('Gemini page configuration is not ready. Reload the conversation and try again.');
    }

    const prefix = accountPrefix();
    const sourcePath = `${prefix}/app/${rawId}`;
    const params = new URLSearchParams({
      rpcids: RPC_ID,
      'source-path': sourcePath,
      bl: config.bl,
      'f.sid': config.sid,
      hl: 'en',
      _reqid: makeReqId(),
      rt: 'c'
    });

    const rpcArguments = [
      conversationId.startsWith('c_') ? conversationId : `c_${conversationId}`,
      PAGE_SIZE,
      cursor,
      1,
      [0],
      [4],
      null,
      1
    ];
    const rpcCall = [RPC_ID, JSON.stringify(rpcArguments), null, 'generic'];
    const body = new URLSearchParams({
      'f.req': JSON.stringify([[rpcCall]]),
      at: config.at
    });

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      : null;

    let response;
    try {
      response = await fetch(`${prefix}/_/BardChatUi/data/batchexecute?${params.toString()}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'X-Same-Domain': '1'
        },
        body: body.toString(),
        signal: controller ? controller.signal : undefined
      });
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new Error('Gemini did not answer in time. Reload the page and try again.');
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403) {
      reportAuthFailure();
      throw new Error('Gemini rejected the request. Sign in and try again.');
    }
    if (!response.ok) {
      throw new Error(`Gemini history request failed with HTTP ${response.status}.`);
    }

    const text = await response.text();
    reportAuthRecovered();
    const payload = parseBatchexecuteResponse(text, RPC_ID);
    if (!Array.isArray(payload) || !Array.isArray(payload[0])) {
      throw new Error('Gemini returned an unrecognized history payload.');
    }
    return {
      turns: payload[0],
      cursor: (typeof payload[1] === 'string' && payload[1].length > 0) ? payload[1] : null
    };
  }

  async function fetchAllTurns(conversationId, rawId) {
    const turns = [];
    const seenCursors = new Set();
    let cursor = null;

    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await fetchHistoryPage(conversationId, rawId, cursor);
      turns.push(...result.turns);

      if (!result.cursor) return turns;
      if (result.turns.length === 0) {
        throw new Error('Gemini returned a continuation cursor with no turns.');
      }
      if (seenCursors.has(result.cursor)) {
        // Do not silently duplicate: stop and keep what we have.
        logWarn('Gemini repeated a history cursor; stopping pagination');
        return turns;
      }
      seenCursors.add(result.cursor);
      cursor = result.cursor;
    }

    throw new Error(`Gemini history exceeded ${MAX_PAGES} pages. Export stopped to avoid an incomplete file.`);
  }

  // ==========================================================================
  // TURN DECODING
  // ==========================================================================

  function timestampToIso(tuple) {
    if (!Array.isArray(tuple) || !Number.isFinite(Number(tuple[0]))) return '';
    const seconds = Number(tuple[0]);
    const nanos = Number(tuple[1] || 0);
    const date = new Date(seconds * 1000 + nanos / 1000000);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }

  /**
   * Pick the selected assistant candidate (regenerated answers produce more
   * than one). Gemini's response structure is
   *   turn[3] = [ [candidateId, [markdown fragments], [null, [refs]], ...], ... ]
   * and the active candidate is the first one with non-empty text.
   */
  function selectedCandidate(turn) {
    const candidates = turn && turn[3] && turn[3][0];
    if (!Array.isArray(candidates)) return null;
    for (const candidate of candidates) {
      if (!Array.isArray(candidate) || !Array.isArray(candidate[1])) continue;
      const text = candidate[1].filter((part) => typeof part === 'string').join('');
      if (text.trim()) return { candidate, text };
    }
    return null;
  }

  /**
   * Find the cited passage in the answer. Gemini lists the passage's position
   * more than once (observed: UTF-8 byte offsets, then character offsets;
   * the two diverge after the first non-ASCII character), so the pairs are
   * alternative encodings of one span, not separate spans. Returns the first
   * pair that lands on the passage, else the passage's first occurrence,
   * else null. `shift` is the whitespace trimmed off the front of the answer.
   */
  function locatePassage(text, passage, pairs, shift) {
    const needle = passage.trim();
    if (!needle) return null;
    for (const pair of pairs) {
      const start = Number(pair[0]) - shift;
      const end = Number(pair[1]) - shift;
      if (start >= 0 && end <= text.length && text.slice(start, end).trim() === needle) {
        return [start, end];
      }
    }
    const at = text.indexOf(needle);
    return at >= 0 ? [at, at + needle.length] : null;
  }

  /**
   * Flatten the citation list attached to an assistant candidate, one row per
   * reference. Each ref is
   *   [ ["cited passage", null, null, [[start, end], ...]], [1], [[url, title]], "spp_id" ]
   * where the passage is the part of the answer the source supports. Offsets
   * are exported as columns (JavaScript string offsets into the exported
   * `text`) rather than injected into `text`, which stays the raw model
   * output; Gemini's own pairs are kept in `raw_spans`.
   */
  function extractCitations(refsData, text, shift) {
    const rows = [];
    const refList = refsData && Array.isArray(refsData[1]) ? refsData[1] : [];
    for (let refIndex = 0; refIndex < refList.length; refIndex++) {
      const ref = refList[refIndex];
      if (!Array.isArray(ref)) continue;
      const content = Array.isArray(ref[0]) ? ref[0] : null;
      const urls = Array.isArray(ref[2]) ? ref[2] : [];
      const first = Array.isArray(urls[0]) ? urls[0] : [];
      const rawUrl = typeof first[0] === 'string' ? first[0] : '';
      if (!rawUrl) continue;
      const url = rawUrl.split('#:~:')[0];
      const title = typeof first[1] === 'string' ? first[1] : '';
      const snippet = content && typeof content[0] === 'string' ? content[0] : '';
      const sourceId = typeof ref[3] === 'string' ? ref[3] : '';
      const spans = content && Array.isArray(content[3]) ? content[3] : [];

      const usableSpans = spans.filter(
        (span) => Array.isArray(span) && span.length === 2
          && Number.isFinite(Number(span[0])) && Number.isFinite(Number(span[1]))
      );
      const located = locatePassage(text, snippet, usableSpans, shift);

      rows.push({
        source_index: rows.length,
        ref_index: refIndex,
        source_id: sourceId,
        url,
        title,
        snippet,
        start_index: located ? located[0] : '',
        end_index: located ? located[1] : '',
        raw_spans: usableSpans.map((span) => [Number(span[0]), Number(span[1])])
      });
    }
    return rows;
  }

  function decodeTurn(turn, turnIndex) {
    if (!Array.isArray(turn)) return null;

    const responseId = turn[0] && typeof turn[0][1] === 'string' ? turn[0][1] : '';
    const parentResponseId = turn[1] && typeof turn[1][1] === 'string' ? turn[1][1] : '';
    const parentCandidateId = turn[1] && typeof turn[1][2] === 'string' ? turn[1][2] : '';
    const createdAt = timestampToIso(turn[4]);

    const rawUser = turn[2] && turn[2][0] && typeof turn[2][0][0] === 'string'
      ? turn[2][0][0].trim()
      : '';

    const selected = selectedCandidate(turn);
    const assistantText = selected ? selected.text.trim() : '';
    const candidateId = selected && typeof selected.candidate[0] === 'string'
      ? selected.candidate[0]
      : (turn[3] && typeof turn[3][3] === 'string' ? turn[3][3] : '');
    const leadingTrim = selected ? selected.text.length - selected.text.trimStart().length : 0;
    const citations = selected ? extractCitations(selected.candidate[2], assistantText, leadingTrim) : [];
    const model = turn[3] && typeof turn[3][21] === 'string' ? turn[3][21].trim() : '';

    const userMessageId = responseId ? `user-${responseId}` : `user-turn-${turnIndex}`;
    const assistantMessageId = responseId || `assistant-turn-${turnIndex}`;

    return {
      responseId,
      parentResponseId,
      parentCandidateId,
      createdAt,
      rawUser,
      assistantText,
      candidateId,
      citations,
      model,
      userMessageId,
      assistantMessageId
    };
  }

  function historyToMessages(rawTurnsNewestFirst) {
    const seen = new Set();
    const decoded = [];

    for (let i = 0; i < rawTurnsNewestFirst.length; i++) {
      const turn = decodeTurn(rawTurnsNewestFirst[i], i);
      if (!turn) continue;
      const key = turn.responseId
        || `${turn.createdAt || 'unknown'}\u0000${turn.rawUser}\u0000${turn.assistantText}`;
      if (seen.has(key)) continue;
      seen.add(key);
      decoded.push(turn);
    }

    decoded.reverse();

    const messages = [];
    for (let turnIndex = 0; turnIndex < decoded.length; turnIndex++) {
      const turn = decoded[turnIndex];
      if (turn.rawUser) {
        messages.push({
          message_id: turn.userMessageId,
          parent_message_id: turn.parentResponseId,
          candidate_id: '',
          parent_candidate_id: turn.parentCandidateId,
          turn_index: turnIndex,
          role: 'user',
          text: turn.rawUser,
          created_at: turn.createdAt,
          model_identifier: '',
          citations: []
        });
      }
      if (turn.assistantText) {
        messages.push({
          message_id: turn.assistantMessageId,
          parent_message_id: turn.rawUser ? turn.userMessageId : turn.parentResponseId,
          candidate_id: turn.candidateId,
          parent_candidate_id: turn.parentCandidateId,
          turn_index: turnIndex,
          role: 'assistant',
          text: turn.assistantText,
          created_at: turn.createdAt,
          model_identifier: turn.model,
          citations: turn.citations
        });
      }
    }
    return messages;
  }

  function cleanDocumentTitle() {
    const raw = typeof document.title === 'string' ? document.title : '';
    return raw
      .replace(/\s*[-–—|]\s*(?:Google\s+)?Gemini\s*$/i, '')
      .trim();
  }

  function titleForRecord(record, messages) {
    if (record && typeof record.title === 'string' && record.title.trim()) {
      return record.title.trim();
    }
    const firstUser = messages.find((m) => m.role === 'user' && m.text);
    if (firstUser) {
      const oneLine = firstUser.text.replace(/\s+/g, ' ').trim();
      return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
    }
    return 'Untitled Conversation';
  }

  function buildRecord(parsed, rawTurns) {
    const messages = historyToMessages(rawTurns);
    if (messages.length === 0) return null;

    const first = messages[0];
    const last = messages[messages.length - 1];
    const model = messages.find((m) => m.role === 'assistant' && m.model_identifier) || null;
    const title = cleanDocumentTitle();
    const prefix = accountPrefix();

    return {
      id: parsed.id,
      title: title && !/^(google\s+)?gemini$/i.test(title) ? title : '',
      conversation: {
        id: parsed.id,
        title: title && !/^(google\s+)?gemini$/i.test(title) ? title : '',
        url: `${window.location.origin}${prefix}/app/${parsed.rawId}`,
        account_prefix: prefix,
        source_path: `${prefix}/app/${parsed.rawId}`,
        model: model ? model.model_identifier : '',
        created_at: first.created_at || '',
        updated_at: last.created_at || ''
      },
      messages
    };
  }

  // ==========================================================================
  // ACTIVE FETCH
  // ==========================================================================

  async function activelyFetchAndStore(conversationId, { force = false } = {}) {
    if (!conversationId) return null;
    if (!force) {
      const existing = capturedConversations.get(conversationId);
      if (isConversationComplete(existing)) return existing;
    }

    const inFlight = inflightFetches.get(conversationId);
    if (inFlight) {
      try {
        return await inFlight;
      } catch (_) {
        return capturedConversations.get(conversationId) || null;
      }
    }

    const parsed = parseConversationFromPath();
    if (!parsed || parsed.id !== conversationId) {
      // The user navigated away while the popup was open; nothing to fetch.
      return capturedConversations.get(conversationId) || null;
    }

    const fetchPromise = (async () => {
      const rawTurns = await fetchAllTurns(conversationId, parsed.rawId);
      const record = buildRecord(parsed, rawTurns);
      if (!record) return null;

      storeConversation(record);
      logDebug('Actively fetched conversation', {
        conversationId,
        messageCount: record.messages.length
      });

      browser.runtime.sendMessage({
        type: 'CONVERSATION_READY',
        platform: 'gemini',
        conversationId
      }).catch(() => { /* popup may not be open */ });

      return record;
    })();

    inflightFetches.set(conversationId, fetchPromise);
    try {
      return await fetchPromise;
    } catch (error) {
      logWarn('Active fetch failed', { conversationId, error: error && error.message });
      return capturedConversations.get(conversationId) || null;
    } finally {
      inflightFetches.delete(conversationId);
    }
  }

  function kickoffIfOnChatPage() {
    const conversationId = extractConversationIdFromPath();
    if (conversationId) activelyFetchAndStore(conversationId).catch(() => {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', kickoffIfOnChatPage, { once: true });
  } else {
    kickoffIfOnChatPage();
  }

  // SPA navigation: Gemini swaps conversations without a full page reload.
  let _lastPath = window.location.pathname;
  setInterval(() => {
    if (window.location.pathname !== _lastPath) {
      _lastPath = window.location.pathname;
      kickoffIfOnChatPage();
    }
  }, 1500);

  // ==========================================================================
  // POPUP / BACKGROUND MESSAGES
  // ==========================================================================

  function assemblePayload(record) {
    return {
      _captured_conversation_id: record.id,
      conversation: record.conversation,
      messages: record.messages
    };
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!sender || sender.id !== browser.runtime.id) {
      logWarn('Message from unauthorized sender', { senderId: sender && sender.id });
      return false;
    }
    if (!message || typeof message.type !== 'string') {
      logWarn('Invalid message structure');
      return false;
    }

    if (message.type === 'GET_CAPTURED_CONVERSATIONS') {
      const urlConvId = extractConversationIdFromPath();
      const existing = urlConvId ? capturedConversations.get(urlConvId) : null;

      const respond = () => {
        const conversations = Array.from(capturedConversations.entries())
          .filter(([, record]) => isConversationComplete(record))
          .map(([id, record]) => ({
            id,
            title: titleForRecord(record, record.messages)
          }));
        sendResponse({
          success: true,
          conversations,
          conversationIds: conversations.map((c) => c.id),
          platform: 'gemini'
        });
      };

      if (urlConvId && !isConversationComplete(existing)) {
        // Give a cold fetch a short head start so the first popup open often
        // shows "ready" immediately, but never block the poll indefinitely.
        Promise.race([activelyFetchAndStore(urlConvId), wait(COLD_START_WAIT_MS)])
          .finally(respond);
        return true;
      }

      respond();
      return false;
    }

    if (message.type === 'EXPORT_CONVERSATION' && message.platform === 'gemini') {
      const conversationId = message.conversationId || extractConversationIdFromPath();

      const forward = (record) => {
        browser.runtime.sendMessage({
          type: MESSAGE_TYPE,
          payload: assemblePayload(record),
          platform: 'gemini',
          conversationId: record.id
        }).then(() => sendResponse({ success: true }))
          .catch((error) => sendResponse({ success: false, error: error.message }));
      };

      // Always refresh before exporting. Gemini streams new replies without
      // re-requesting its history, so the copy cached at page load (or
      // mid-answer on a brand-new chat) misses later turns. A failed refresh
      // falls back to the cached copy inside activelyFetchAndStore.
      activelyFetchAndStore(conversationId, { force: true }).then((record) => {
        if (!isConversationComplete(record)) {
          sendResponse({
            success: false,
            error: 'Conversation not found. Please reload the page and try again.'
          });
          return;
        }
        forward(record);
      });
      return true;
    }

    return false;
  });

  logInfo('Content script loaded');

})();
