/**
 * Google Search – AI Overview Content Script
 *
 * Captures the AI Overview block from google.com/search?q=... pages.
 *
 * Strategy:
 *   1. The AI Overview text only exists in the initial /search HTML response
 *      and in later async updates streamed to the same URL. Google does NOT
 *      expose a separate JSON API for it.
 *   2. To avoid live-DOM scraping (which breaks whenever Google tweaks their
 *      framework), we re-fetch the current /search URL with the user's cookies
 *      and parse the raw HTML server response. This gives us a stable snapshot
 *      and lets us anchor on Google's own semantic markers (data-attrid,
 *      jsname, aria-label) instead of CSS classes.
 *   3. The extracted overview is stored in memory keyed by (query, mode) via
 *      `captureKey`, where mode is 'ai_overview' or 'ai_mode'. The popup
 *      derives the exact same key from `tab.url` so the two sides never drift
 *      when Google rewrites the URL client-side after load.
 *   4. Data is exposed to the popup via the same GET_CAPTURED_CONVERSATIONS /
 *      EXPORT_CONVERSATION message contract used by other platforms.
 */

(function () {
  'use strict';

  const PLATFORM = 'GoogleSearch';
  const MESSAGE_TYPE = 'GOOGLE_SEARCH_AI_OVERVIEW_DATA';

  const IS_PRODUCTION = true;
  const DEBUG_MODE = false;

  const MAX_STORED = 20;
  const MAX_AGE_MS = 3600000;

  const captured = new Map();
  const timestamps = new Map();

  function logDebug(msg, data) {
    if (!DEBUG_MODE) return;
    data ? console.log(`[${PLATFORM}] [DEBUG]`, msg, data) : console.log(`[${PLATFORM}] [DEBUG]`, msg);
  }
  function logWarn(msg, data) {
    if (IS_PRODUCTION) return;
    data ? console.warn(`[${PLATFORM}] [WARN]`, msg, data) : console.warn(`[${PLATFORM}] [WARN]`, msg);
  }

  function storeOverview(key, data) {
    if (captured.size >= MAX_STORED) {
      let oldestKey = null, oldestTs = Infinity;
      for (const [k, t] of timestamps) {
        if (t < oldestTs) { oldestTs = t; oldestKey = k; }
      }
      if (oldestKey) {
        captured.delete(oldestKey);
        timestamps.delete(oldestKey);
      }
    }
    captured.set(key, data);
    timestamps.set(key, Date.now());
  }

  setInterval(() => {
    const now = Date.now();
    for (const [k, t] of timestamps) {
      if (now - t > MAX_AGE_MS) {
        captured.delete(k);
        timestamps.delete(k);
      }
    }
  }, 300000);

  // ==========================================================================
  // Query extraction – from URL
  // ==========================================================================

  function currentQuery() {
    try {
      const u = new URL(window.location.href);
      if (u.pathname !== '/search') return null;
      const q = u.searchParams.get('q');
      return q && q.trim() ? q.trim() : null;
    } catch (_) { return null; }
  }

  // Stable storage key for a captured conversation. We used to key by
  // `${query}::${window.location.href}` but Google rewrites the URL after
  // load (adds sei=, sclient=, …) via history.replaceState. That caused the
  // popup's computed id to drift away from the content script's stored key,
  // which made the popup show "waiting" or fail to export a conversation it
  // had already captured. The popup computes this same key from `tab.url`,
  // so both sides stay aligned regardless of URL rewrites.
  function captureKey(query, url) {
    const mode = isAIModeUrl(url) ? 'ai_mode' : 'ai_overview';
    return `${query}::${mode}`;
  }

  // ==========================================================================
  // HTML extraction – anchored on semantic markers
  // ==========================================================================

  // Google uses these stable-ish markers inside the AI Overview / AI Mode
  // container. Multiple fallbacks because Google A/B-tests markers across
  // regions and iterates on them.
  const AIO_CONTAINER_SELECTORS = [
    // Current (2026): Search Results Page Generative Summary (AI Mode + AI Overview)
    '[data-attrid*="SrpGenSumSummary"]',
    // Older AI Overview markers (keep as fallback)
    '[data-attrid*="AioHostElement"]',
    '[data-async-type="aiov"]',
    '[data-async-type="agscls"]',
    '[jsname="FFzE2"]',
    // Locale-specific aria labels
    '[aria-label*="AI Overview" i]',
    '[aria-label*="AI-overzicht" i]',
    '[aria-label*="AI overzicht" i]',
    '[aria-label*="AI Mode" i]'
  ];

  // Heading text fallback: if no attribute match, locate a heading-ish element
  // whose text is exactly the overview label and walk up to a stable ancestor.
  const AIO_HEADING_TEXTS = [
    'AI Overview', 'AI-overzicht', 'AI overzicht', 'AI Overzicht',
    'AI-aperçu', 'Aperçu AI', 'KI-Übersicht', 'Resumen de IA',
    // AI Mode variants
    'AI Mode replied:', 'AI Mode replied', 'AI Mode reply',
    'AI-modus antwoord:', 'AI-modus antwoord'
  ];

  function normalizeTextEarly(s) {
    return (s || '').replace(/\s+/g, ' ').replace(/ /g, ' ').trim();
  }

  // textContent-equivalent that ignores <style>/<script>/<noscript>/<template>
  // so stylesheet rules can't leak into the overview text.
  function visibleTextContent(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('style, script, noscript, template, link').forEach(n => n.remove());
    return normalizeTextEarly(clone.textContent);
  }

  // Telemetry about which selector matched. Surfaced in the manifest sidecar
  // so researchers can detect silent degradation when Google changes layout.
  let _lastExtractionTelemetry = {
    selector_used: null,
    selector_index: null,
    used_heading_fallback: false,
    container_selectors_tried: AIO_CONTAINER_SELECTORS.length
  };

  function findOverviewRoot(doc) {
    for (let i = 0; i < AIO_CONTAINER_SELECTORS.length; i++) {
      const sel = AIO_CONTAINER_SELECTORS[i];
      try {
        const el = doc.querySelector(sel);
        if (el && visibleTextContent(el).length > 50) {
          _lastExtractionTelemetry = {
            selector_used: sel,
            selector_index: i,
            used_heading_fallback: false,
            container_selectors_tried: AIO_CONTAINER_SELECTORS.length
          };
          return el;
        }
      } catch (_) { /* bad selector in some engines */ }
    }
    const walker = doc.createTreeWalker(doc.body || doc, NodeFilter.SHOW_ELEMENT, null);
    let node = walker.currentNode;
    while (node) {
      const tag = node.tagName;
      if (tag && /^(H1|H2|H3|H4|SPAN|DIV|P)$/.test(tag)) {
        const txt = normalizeTextEarly(node.textContent);
        if (txt && AIO_HEADING_TEXTS.some(h => txt === h)) {
          let cur = node;
          for (let i = 0; i < 5 && cur && cur.parentElement; i++) {
            cur = cur.parentElement;
            const bodyLen = visibleTextContent(cur).length;
            if (bodyLen > 200 && bodyLen < 20000) {
              _lastExtractionTelemetry = {
                selector_used: null,
                selector_index: null,
                used_heading_fallback: true,
                container_selectors_tried: AIO_CONTAINER_SELECTORS.length
              };
              return cur;
            }
          }
        }
      }
      node = walker.nextNode();
    }
    _lastExtractionTelemetry = {
      selector_used: null,
      selector_index: null,
      used_heading_fallback: false,
      container_selectors_tried: AIO_CONTAINER_SELECTORS.length
    };
    return null;
  }

  function normalizeText(s) {
    return (s || '').replace(/\s+/g, ' ').replace(/ /g, ' ').trim();
  }

  // ==========================================================================
  // Follow-up / related questions
  // ==========================================================================

  const RELATED_HEADING_TEXTS = [
    'Related links', 'Related', 'People also ask',
    'Gerelateerde links', 'Mensen vragen ook',
    'Questions associées', 'Weitere Fragen'
  ];

  function extractRelatedQuestions(doc) {
    const walker = doc.createTreeWalker(doc.body || doc, NodeFilter.SHOW_ELEMENT, null);
    let heading = null;
    let node = walker.currentNode;
    while (node) {
      const tag = node.tagName;
      if (tag && /^(H1|H2|H3|H4|SPAN|DIV|P)$/.test(tag)) {
        const txt = normalizeTextEarly(node.textContent);
        if (txt && RELATED_HEADING_TEXTS.some(h => txt === h || txt.startsWith(h))) {
          heading = node;
          break;
        }
      }
      node = walker.nextNode();
    }
    if (!heading) return [];

    // Walk up to a reasonable container.
    let container = heading;
    for (let i = 0; i < 5 && container.parentElement; i++) {
      container = container.parentElement;
      if (visibleTextContent(container).length > 60) break;
    }

    // Keep only strings that look like real follow-up questions. Google's
    // "Related" section mixes in news snippets, UI controls, and source
    // chips — none of which are questions.
    const QUESTION_START_RE = /^(what|why|how|when|where|who|which|is|are|can|could|do|does|did|should|would|will|has|have|had|was|were|wat|waarom|hoe|wanneer|waar|wie|welk|welke|is|zijn|kan|kunnen|hebben|had|was|waren)\b/i;
    const UI_CHROME = new Set([
      'Customise', 'Customize', 'Send feedback', 'Reload results',
      'More news', 'Show more', 'More', 'Share', 'Feedback',
      'Aanpassen', 'Feedback verzenden', 'Resultaten opnieuw laden'
    ]);

    const questions = [];
    const seen = new Set();
    const candidates = container.querySelectorAll('a, [role="listitem"], [role="button"]');
    for (const el of candidates) {
      const t = normalizeTextEarly(el.textContent);
      if (!t || t.length < 8 || t.length > 200) continue;
      if (seen.has(t)) continue;
      if (RELATED_HEADING_TEXTS.includes(t) || UI_CHROME.has(t)) continue;
      // Must end with '?' OR start with a question word. This filters out
      // news headlines, source chips, and nav items.
      const looksLikeQuestion = t.endsWith('?') || QUESTION_START_RE.test(t);
      if (!looksLikeQuestion) continue;
      seen.add(t);
      questions.push(t);
      if (questions.length >= 20) break;
    }
    return questions;
  }

  // Strip the heading/UI chrome Google renders at the top/bottom of the
  // overview container so the captured text is just the AI's answer.
  const HEADING_PREFIX_RE = new RegExp(
    '^(?:' + AIO_HEADING_TEXTS.map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')+',
    'i'
  );
  // Trailing UI noise Google appends to the overview block.
  const TRAILING_NOISE_PATTERNS = [
    /Shared\s*\d*\s*files?$/i,
    /Send feedback.*$/i,
    /Reload results.*$/i,
    /\+\d+$/
  ];

  function cleanOverviewText(raw) {
    let t = raw;
    // Drop leading "AI Overview" / "AI Mode reply for ..." style prefixes.
    for (let i = 0; i < 3; i++) {
      const next = t.replace(HEADING_PREFIX_RE, '').trim();
      // "AI Mode reply for <query>" — strip anything up to the first sentence.
      const modePrefix = next.match(/^AI Mode reply for [^.!?]*[.!?]?/i);
      const after = modePrefix ? next.slice(modePrefix[0].length).trim() : next;
      if (after === t) break;
      t = after;
    }
    // Drop trailing UI noise.
    for (let i = 0; i < 3; i++) {
      let changed = false;
      for (const re of TRAILING_NOISE_PATTERNS) {
        const next = t.replace(re, '').trim();
        if (next !== t) { t = next; changed = true; }
      }
      if (!changed) break;
    }
    return t;
  }

  // ==========================================================================
  // AI Mode (Google's conversational mode — URL has udm=50)
  // ==========================================================================

  function isAIModeUrl(url) {
    try {
      return new URL(url).searchParams.get('udm') === '50';
    } catch { return false; }
  }

  // Headings Google renders to delimit each conversation turn.
  const AIMODE_USER_RE = /^(?:You said:|Jij zei:|Je zei:|Vous avez dit\s*:|Du sagtest\s*:|Tú dijiste\s*:)\s*(.+)$/i;
  const AIMODE_ASSISTANT_RE = /^(?:AI Mode reply for|AI-modus antwoord op|Réponse AI Mode pour|AI-Modus-Antwort für|Respuesta de AI Mode para)\s*(.+)$/i;
  // Headings to drop from captured body text.
  const AIMODE_HEADING_NOISE_RE = /^(Share public link|Shared|Notebooks|Notitieboeken|Gedeeld|Deel openbare link)$/i;

  function extractAIModeTurns(doc) {
    const headings = Array.from(doc.querySelectorAll('h1, h2, h3, h4'));
    const markers = [];
    for (const h of headings) {
      const t = normalizeTextEarly(h.textContent);
      if (!t) continue;
      let m = t.match(AIMODE_USER_RE);
      if (m) { markers.push({ heading: h, role: 'user', label: m[1].trim() }); continue; }
      m = t.match(AIMODE_ASSISTANT_RE);
      if (m) { markers.push({ heading: h, role: 'assistant', label: m[1].trim() }); }
    }
    if (markers.length === 0) return [];

    const turns = [];
    for (let i = 0; i < markers.length; i++) {
      const marker = markers[i];
      const next = i + 1 < markers.length ? markers[i + 1].heading : null;

      let text = '';
      let sources = [];
      if (marker.role === 'user') {
        text = marker.label;
      } else {
        // Grab the DOM range from just after this heading to just before the
        // next turn heading (or end-of-body). This naturally bounds each turn.
        try {
          const range = doc.createRange();
          range.setStartAfter(marker.heading);
          if (next) range.setEndBefore(next);
          else range.setEndAfter(doc.body || doc.documentElement);

          const frag = range.cloneContents();
          const wrapper = doc.createElement('div');
          wrapper.appendChild(frag);
          wrapper.querySelectorAll('style, script, noscript, template, link').forEach(n => n.remove());
          // Drop stray UI headings that fall inside the range.
          wrapper.querySelectorAll('h1, h2, h3, h4').forEach(hh => {
            const ht = normalizeTextEarly(hh.textContent);
            if (!ht || AIMODE_HEADING_NOISE_RE.test(ht)) hh.remove();
          });
          text = cleanOverviewText(normalizeTextEarly(wrapper.textContent));

          // Sources: external anchors in the fragment, filtered the same way
          // the main overview filters.
          const seen = new Set();
          for (const a of wrapper.querySelectorAll('a[href]')) {
            const href = a.getAttribute('href') || '';
            if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
            let real = href;
            if (href.startsWith('/url?')) {
              try {
                const u = new URL(href, 'https://www.google.com');
                real = u.searchParams.get('q') || u.searchParams.get('url') || href;
              } catch { continue; }
            } else if (!href.startsWith('http')) {
              continue;
            }
            try {
              const host = new URL(real).hostname;
              if (/^(www\.)?google\.(com|be|nl|fr|de|co\.uk|es|it|ca|com\.au)$/i.test(host)) continue;
              if (/\.(google|googleusercontent|gstatic|googleadservices|googlesyndication)\.com$/i.test(host)) continue;
            } catch { continue; }
            if (seen.has(real)) continue;
            seen.add(real);
            sources.push({ url: real, title: normalizeTextEarly(a.textContent).slice(0, 300) });
            if (sources.length >= 20) break;
          }
        } catch (e) {
          logWarn('AI Mode range extraction failed', { error: e.message });
        }
      }

      turns.push({
        index: i,
        role: marker.role,
        text,
        query_label: marker.label,
        sources
      });
    }
    return turns.filter(t => t.text);
  }

  function extractAIMode(doc, query, sourceUrl) {
    const turns = extractAIModeTurns(doc);
    if (turns.length === 0) return null;
    // Conversation title: first user turn's text, falling back to the URL q=.
    const firstUser = turns.find(t => t.role === 'user');
    const capturedAt = new Date().toISOString();
    // Stamp each turn with the capture time so sequence analysis can
    // distinguish "no per-turn timestamp" from "same time" after the fact.
    turns.forEach(t => { t.captured_at = capturedAt; });
    return {
      mode: 'ai_mode',
      conversation_title: (firstUser && firstUser.text) || query || '',
      source_page_url: sourceUrl,
      captured_at: capturedAt,
      turns,
      extraction_telemetry: {
        selector_used: 'ai_mode_heading_scan',
        selector_index: null,
        used_heading_fallback: false,
        container_selectors_tried: 0,
        turn_count: turns.length
      }
    };
  }

  function extractOverview(doc, query, sourceUrl) {
    const root = findOverviewRoot(doc);
    if (!root) return null;

    // Clone and strip the AI Overview / AI Mode heading nodes before taking
    // text so they don't leak into the captured content.
    const working = root.cloneNode(true);
    working.querySelectorAll('style, script, noscript, template, link').forEach(n => n.remove());
    // Headings that match the AI Overview label itself.
    working.querySelectorAll('h1, h2, h3, h4').forEach(h => {
      const t = normalizeTextEarly(h.textContent);
      if (!t) return;
      const isLabel = AIO_HEADING_TEXTS.some(x => t === x || t.startsWith(x));
      const isAIModeLine = /^AI Mode reply for /i.test(t);
      if (isLabel || isAIModeLine) h.remove();
    });

    const text = cleanOverviewText(normalizeTextEarly(working.textContent));
    // Guard against tiny / spurious matches
    if (text.length < 60) return null;

    // Google often renders source citations as siblings of (not inside) the
    // summary element. Walk up to the nearest "section-like" ancestor so we
    // catch citation chips below the summary text too.
    let sourceScope = root;
    for (let i = 0; i < 3 && sourceScope.parentElement; i++) {
      const parent = sourceScope.parentElement;
      // Stop climbing once we hit a known top-level search region.
      const role = parent.getAttribute && parent.getAttribute('role');
      if (role === 'main' || parent.id === 'rcnt' || parent.id === 'search') break;
      sourceScope = parent;
      if (sourceScope.querySelectorAll('a[href]').length >= 4) break;
    }

    const seen = new Set();
    const sources = [];
    for (const a of sourceScope.querySelectorAll('a[href]')) {
      try {
        const href = a.getAttribute('href') || '';
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
        let real = href;
        if (href.startsWith('/url?')) {
          const u = new URL(href, 'https://www.google.com');
          real = u.searchParams.get('q') || u.searchParams.get('url') || href;
        } else if (href.startsWith('http')) {
          real = href;
        } else {
          continue;
        }
        try {
          const host = new URL(real).hostname;
          if (/^(www\.)?google\.(com|be|nl|fr|de|co\.uk|es|it|ca|com\.au)$/i.test(host)) continue;
          if (/\.(google|googleusercontent|gstatic|googleadservices|googlesyndication)\.com$/i.test(host)) continue;
          if (host === 'policies.google.com' || host === 'support.google.com') continue;
        } catch { continue; }
        if (seen.has(real)) continue;
        seen.add(real);
        const title = normalizeTextEarly(a.textContent).slice(0, 300);
        sources.push({ url: real, title: title || '' });
        if (sources.length >= 30) break;
      } catch (_) { /* skip */ }
    }

    const followUps = extractRelatedQuestions(doc);

    return {
      query,
      source_page_url: sourceUrl,
      captured_at: new Date().toISOString(),
      ai_overview_text: text,
      sources,
      follow_up_questions: followUps,
      extraction_telemetry: { ..._lastExtractionTelemetry }
    };
  }

  // ==========================================================================
  // Active fetch – pull a fresh HTML snapshot of the current search URL and
  // parse the overview from its semantic markers.
  // ==========================================================================

  let fetchInFlight = null;

  async function activelyCaptureAIOverview() {
    const query = currentQuery();
    if (!query) return null;

    const key = captureKey(query, window.location.href);
    const isAIMode = isAIModeUrl(window.location.href);
    // AI Mode conversations grow over time (user keeps asking follow-ups).
    // Never short-circuit on cached data — always re-scan the live DOM.
    if (!isAIMode && captured.has(key)) return captured.get(key);
    if (fetchInFlight) {
      try { await fetchInFlight; } catch (_) {}
      if (!isAIMode && captured.has(key)) return captured.get(key);
    }

    fetchInFlight = (async () => {
      const url = window.location.href;
      const isAIMode = isAIModeUrl(url);
      // Live DOM first — AI Mode is dynamically rendered and never appears
      // in a re-fetched HTML, so for AI Mode we don't bother with the fetch
      // fallback.
      let data = isAIMode
        ? extractAIMode(document, query, url)
        : extractOverview(document, query, url);
      if (!data && !isAIMode) {
        // Fallback for classic AI Overview: re-fetch the search URL. The AI
        // Mode case can't use this path because its content is injected by
        // client-side JS and isn't in the server HTML.
        const resp = await fetch(url, {
          credentials: 'include',
          headers: { 'Accept': 'text/html,application/xhtml+xml' }
        });
        if (!resp.ok) throw new Error(`search ${resp.status}`);
        const html = await resp.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        data = extractOverview(doc, query, url);
      }
      if (!data) throw new Error(isAIMode ? 'AI Mode conversation not found' : 'AI Overview not found in page');
      storeOverview(key, data);
      logDebug('Captured AI Overview', {
        query,
        textLength: data.ai_overview_text.length,
        sources: data.sources.length
      });
      // Include turn count so the popup can show live progress during long
      // waits (AI Mode conversations can take 10+ seconds to render fully).
      const turnCount = Array.isArray(data.turns)
        ? data.turns.length
        : (Array.isArray(data.follow_up_questions) ? data.follow_up_questions.length : 0);
      browser.runtime.sendMessage({
        type: 'CONVERSATION_READY',
        platform: 'google_search',
        conversationId: key,
        mode: isAIMode ? 'ai_mode' : 'ai_overview',
        turnCount
      }).catch(() => {});
      return data;
    })();

    try {
      return await fetchInFlight;
    } catch (e) {
      logWarn('Active capture failed', { error: e.message });
      return null;
    } finally {
      fetchInFlight = null;
    }
  }

  // Opportunistic capture on load + on SPA URL changes.
  function kickoff() {
    if (!currentQuery()) return;
    activelyCaptureAIOverview().catch(() => {});
    // AI Mode renders turns asynchronously via client-side JS. On tab reload
    // the MutationObserver sometimes misses early render passes (shadow-DOM
    // or synchronous-batch updates), so we also retry a handful of times
    // during the first ~15 s. Each retry re-reads the live DOM; cheap.
    if (isAIModeUrl(window.location.href)) {
      [1500, 3000, 5000, 8000, 13000].forEach(delay => {
        setTimeout(() => {
          if (currentQuery()) {
            activelyCaptureAIOverview().catch(() => {});
          }
        }, delay);
      });
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', kickoff, { once: true });
  } else {
    kickoff();
  }

  let _lastHref = window.location.href;
  setInterval(() => {
    if (window.location.href !== _lastHref) {
      _lastHref = window.location.href;
      kickoff();
    }
  }, 1500);

  // AI Mode and some AI Overview flavors render asynchronously via client-side
  // JS. The first kickoff on DOMContentLoaded often runs before any turn
  // headings exist in the DOM. Watch for new headings and re-trigger capture
  // when they appear — debounced so we don't thrash while Google streams in.
  (function installMutationObserver() {
    if (typeof MutationObserver !== 'function') return;
    let debounceTimer = null;
    const observer = new MutationObserver(() => {
      if (!currentQuery()) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        activelyCaptureAIOverview().catch(() => {});
      }, 800);
    });
    const start = () => {
      const target = document.body || document.documentElement;
      if (!target) return;
      observer.observe(target, { childList: true, subtree: true });
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  })();

  // ==========================================================================
  // Popup / background message bridge
  // ==========================================================================

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!sender || sender.id !== browser.runtime.id) return;
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'GET_CAPTURED_CONVERSATIONS') {
      const query = currentQuery();
      const key = query ? captureKey(query, window.location.href) : null;
      const needFetch = key && !captured.has(key);

      const respond = (noOverviewForThisPage) => {
        const conversations = Array.from(captured.entries()).map(([k, d]) => ({
          id: k,
          title: `AI Overview — ${d.query}`.slice(0, 120)
        }));
        sendResponse({
          success: true,
          conversations,
          conversationIds: conversations.map(c => c.id),
          platform: 'google_search',
          noOverviewForThisPage: !!noOverviewForThisPage
        });
      };

      if (needFetch) {
        activelyCaptureAIOverview()
          .then(data => respond(!data))
          .catch(() => respond(true));
        return true;
      }
      respond(false);
      return false;
    }

    if (message.type === 'EXPORT_CONVERSATION' && message.platform === 'google_search') {
      const id = message.conversationId;
      const forward = (data) => {
        browser.runtime.sendMessage({
          type: MESSAGE_TYPE,
          payload: data,
          platform: 'google_search'
        }).then(() => sendResponse({ success: true }))
          .catch(e => sendResponse({ success: false, error: e.message }));
      };

      // Prefer the id the popup sent. If it's absent or no longer in the
      // map (e.g., popup running an older build, or Google rewrote the URL
      // between capture and export), fall back to whatever we have stored
      // for the current page before giving up and re-scanning the DOM.
      let existing = id ? captured.get(id) : undefined;
      if (!existing) {
        const q = currentQuery();
        if (q) existing = captured.get(captureKey(q, window.location.href));
      }
      if (existing) {
        forward(existing);
        return true;
      }
      activelyCaptureAIOverview().then(data => {
        if (!data) {
          sendResponse({
            success: false,
            error: 'No AI Overview captured. Run a search that triggers an AI Overview, then try again.'
          });
          return;
        }
        forward(data);
      });
      return true;
    }

    return false;
  });

  logDebug('Google Search content script loaded');
})();
