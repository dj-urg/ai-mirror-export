/**
 * Google Search – AI Overview Content Script
 *
 * Captures the AI Overview block (and AI Mode conversations) from
 * google.com/search?q=... pages.
 *
 * Strategy:
 *   1. The capture is read from the live DOM, passively: on load, when the
 *      page changes (MutationObserver) and again when the user exports, so
 *      the export is the answer as it was on screen at export time, not the
 *      first partial render. Loading a search page never makes this script
 *      send a request.
 *   2. The container is located through Google's own semantic markers
 *      (data-attrid, jsname, aria-label) instead of CSS classes, with a
 *      heading-text heuristic as the last resort. Text is taken block by
 *      block, skipping hidden nodes and page chrome.
 *   3. Only when the user exports and the DOM holds no AI Overview does the
 *      script re-fetch the current /search URL once (the user's own query,
 *      same origin, their cookies) and parse the server HTML. Such a capture
 *      is marked `source: 'refetch'` because Google may answer the second
 *      request with a different overview than the one that was on screen; it
 *      never replaces a capture read from the DOM.
 *   4. Captures are stored in memory keyed by (query, mode) via `captureKey`,
 *      where mode is 'ai_overview' or 'ai_mode'. The popup derives the exact
 *      same key from `tab.url` so the two sides never drift when Google
 *      rewrites the URL client-side after load.
 *   5. Data is exposed to the popup via the same GET_CAPTURED_CONVERSATIONS /
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

  // captureKey -> { data, source, flags, signature, changedAt }
  //   data       the payload forwarded to the background on export
  //   source     'dom' (read from the page) or 'refetch' (server HTML)
  //   flags      extraction caveats, e.g. 'heuristic_root'
  //   signature  the captured text, to tell a changed capture from a re-read
  //   changedAt  when the captured text last changed (ms)
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

  function storeOverview(key, record) {
    if (!captured.has(key) && captured.size >= MAX_STORED) {
      let oldestKey = null, oldestTs = Infinity;
      for (const [k, t] of timestamps) {
        if (t < oldestTs) { oldestTs = t; oldestKey = k; }
      }
      if (oldestKey) {
        captured.delete(oldestKey);
        timestamps.delete(oldestKey);
      }
    }
    captured.set(key, record);
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

  // The page URL as exported in `source_page_url`: the query and the AI Mode
  // switch only. Google's session and click-tracking parameters (sei, ved,
  // sxsrf, ei, …) say nothing about the answer and are dropped.
  function exportedPageUrl(url) {
    try {
      const u = new URL(url);
      const kept = new URLSearchParams();
      for (const name of ['q', 'udm']) {
        const value = u.searchParams.get(name);
        if (value !== null) kept.set(name, value);
      }
      const qs = kept.toString();
      return `${u.origin}${u.pathname}${qs ? `?${qs}` : ''}`;
    } catch (_) { return ''; }
  }

  // ==========================================================================
  // HTML extraction – anchored on semantic markers
  // ==========================================================================

  // Google uses these stable-ish markers inside the AI Overview / AI Mode
  // container. Multiple fallbacks because Google A/B-tests markers across
  // regions and iterates on them. Structural markers come first; the
  // aria-label entries depend on the interface language.
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
  // Selectors from this index on match a translated label, not structure.
  const FIRST_LOCALIZED_SELECTOR = AIO_CONTAINER_SELECTORS
    .findIndex(sel => sel.startsWith('[aria-label'));

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

  // ==========================================================================
  // Block-aware text extraction
  //
  // `textContent` glues adjacent blocks together ("…first point.Second
  // point") and includes hidden nodes. The walker below reads the tree in
  // document order, starts a new line at every block element and skips nodes
  // that are not part of the answer.
  // ==========================================================================

  // Never text of the answer.
  const SKIPPED_TAGS = new Set([
    'STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'SVG',
    'TEXTAREA', 'INPUT', 'SELECT', 'NAV', 'FOOTER', 'IFRAME', 'CANVAS', 'DIALOG'
  ]);
  // Page chrome, by ARIA landmark role.
  const SKIPPED_ROLES = new Set(['navigation', 'contentinfo', 'search', 'dialog']);
  // Used when the element has no layout to ask (a parsed, not rendered,
  // document) – see isBlock.
  const BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL',
    'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FORM', 'H1', 'H2', 'H3', 'H4',
    'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'OL', 'P', 'PRE', 'SECTION',
    'SUMMARY', 'TABLE', 'TBODY', 'TFOOT', 'THEAD', 'TR', 'UL'
  ]);

  function tagOf(el) {
    return typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  }

  function attr(el, name) {
    return typeof el.getAttribute === 'function' ? el.getAttribute(name) : null;
  }

  // Hidden by markup. Deliberately not based on computed style: an answer
  // that Google has collapsed behind "Show more" is still part of the
  // answer and stays in the export.
  function isHidden(el) {
    if (attr(el, 'hidden') !== null) return true;
    if (attr(el, 'aria-hidden') === 'true') return true;
    const style = attr(el, 'style');
    return !!style && /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(style);
  }

  function isBlock(el, tag) {
    // On the live page the layout knows best (Google builds most of the
    // overview from <div>s and <span>s whose role depends on CSS).
    if (el.ownerDocument === document && typeof getComputedStyle === 'function') {
      try {
        const display = getComputedStyle(el).display;
        if (display && display !== 'none') {
          return !(display.startsWith('inline') || display === 'contents');
        }
      } catch (_) { /* fall through to the tag list */ }
    }
    return BLOCK_TAGS.has(tag);
  }

  function createLineBuffer() {
    const lines = [];
    let current = '';
    return {
      text(s) { current += s; },
      breakLine() {
        const line = normalizeTextEarly(current);
        if (line) lines.push(line);
        current = '';
      },
      lines() {
        this.breakLine();
        return lines;
      }
    };
  }

  /**
   * Walk `node` in document order, feeding text to `sink.text`, block
   * boundaries to `sink.breakLine`, and every visited element to
   * `sink.enter(el, tag)` (return false to skip that element's subtree).
   * `stats.hiddenWithText` counts hidden elements that held text.
   */
  function walkVisible(node, sink, stats) {
    if (!node) return;
    if (node.nodeType === 3) {
      sink.text(node.nodeValue || '');
      return;
    }
    if (node.nodeType !== 1) return;

    const tag = tagOf(node);
    if (SKIPPED_TAGS.has(tag) || SKIPPED_ROLES.has(attr(node, 'role'))) return;
    if (isHidden(node)) {
      if (stats && (node.textContent || '').trim()) stats.hiddenWithText++;
      return;
    }
    if (tag === 'BR') {
      sink.breakLine();
      return;
    }
    if (sink.enter && sink.enter(node, tag) === false) return;

    const block = isBlock(node, tag);
    if (block) sink.breakLine();
    for (const child of Array.from(node.childNodes || [])) walkVisible(child, sink, stats);
    if (block) sink.breakLine();
    else if (tag === 'TD' || tag === 'TH') sink.text(' ');
  }

  /** Visible text of an element as lines, one per block. */
  function blockLines(el, { stats = null, enter = null } = {}) {
    const buffer = createLineBuffer();
    walkVisible(el, {
      text: s => buffer.text(s),
      breakLine: () => buffer.breakLine(),
      enter
    }, stats);
    return buffer.lines();
  }

  // Visible text on one line (labels, headings, size checks).
  function visibleTextContent(el) {
    return el ? blockLines(el).join(' ') : '';
  }

  /** Every element under `root` (inclusive), in document order. */
  function* elementsOf(root) {
    if (!root || root.nodeType !== 1) return;
    yield root;
    for (const child of Array.from(root.childNodes || [])) yield* elementsOf(child);
  }

  function isHeading(el, tag) {
    return /^H[1-4]$/.test(tag) || attr(el, 'role') === 'heading';
  }

  // Telemetry about which selector matched. Surfaced in the manifest sidecar
  // so researchers can detect silent degradation when Google changes layout.
  let _lastExtractionTelemetry = {
    selector_used: null,
    selector_index: null,
    used_heading_fallback: false,
    container_selectors_tried: AIO_CONTAINER_SELECTORS.length
  };

  function setTelemetry(selector, index, usedHeadingFallback) {
    _lastExtractionTelemetry = {
      selector_used: selector,
      selector_index: index,
      used_heading_fallback: usedHeadingFallback,
      container_selectors_tried: AIO_CONTAINER_SELECTORS.length
    };
  }

  /**
   * Locate the overview container.
   * @param {Document} doc
   * @param {{ structuralOnly?: boolean }} [options] only accept the
   *   language-independent selectors (no aria-label, no heading heuristic)
   */
  function findOverviewRoot(doc, { structuralOnly = false } = {}) {
    const selectorCount = structuralOnly ? FIRST_LOCALIZED_SELECTOR : AIO_CONTAINER_SELECTORS.length;
    for (let i = 0; i < selectorCount; i++) {
      const sel = AIO_CONTAINER_SELECTORS[i];
      try {
        // Not only the first match: Google sometimes renders an empty
        // placeholder with the same marker ahead of the real container.
        for (const el of doc.querySelectorAll(sel)) {
          if (visibleTextContent(el).length > 50) {
            setTelemetry(sel, i, false);
            return el;
          }
        }
      } catch (_) { /* bad selector in some engines */ }
    }
    if (!structuralOnly) {
      for (const node of elementsOf(doc.body || doc.documentElement)) {
        if (!/^(H1|H2|H3|H4|SPAN|DIV|P)$/.test(tagOf(node))) continue;
        const txt = normalizeTextEarly(node.textContent);
        if (!txt || !AIO_HEADING_TEXTS.some(h => txt === h)) continue;
        let cur = node;
        for (let i = 0; i < 5 && cur && cur.parentElement; i++) {
          cur = cur.parentElement;
          const bodyLen = visibleTextContent(cur).length;
          if (bodyLen > 200 && bodyLen < 20000) {
            setTelemetry(null, null, true);
            return cur;
          }
        }
      }
    }
    setTelemetry(null, null, false);
    return null;
  }

  // Caveats about how the container was found, for `capture.flags`.
  function rootFlags(telemetry) {
    if (telemetry.used_heading_fallback) return ['heuristic_root'];
    if (telemetry.selector_index !== null && telemetry.selector_index >= FIRST_LOCALIZED_SELECTOR) {
      return ['localized_label_root'];
    }
    return [];
  }

  // ==========================================================================
  // Follow-up / related questions
  // ==========================================================================

  const RELATED_HEADING_TEXTS = [
    'Related links', 'Related', 'People also ask',
    'Gerelateerde links', 'Mensen vragen ook',
    'Questions associées', 'Weitere Fragen'
  ];

  // Labels of Google's own controls around the overview.
  const UI_CHROME = new Set([
    'Customise', 'Customize', 'Send feedback', 'Reload results',
    'More news', 'Show more', 'More', 'Share', 'Feedback',
    'Aanpassen', 'Feedback verzenden', 'Resultaten opnieuw laden'
  ]);

  function extractRelatedQuestions(doc) {
    let heading = null;
    for (const node of elementsOf(doc.body || doc.documentElement)) {
      if (!/^(H1|H2|H3|H4|SPAN|DIV|P)$/.test(tagOf(node))) continue;
      const txt = normalizeTextEarly(node.textContent);
      if (txt && RELATED_HEADING_TEXTS.some(h => txt === h || txt.startsWith(h))) {
        heading = node;
        break;
      }
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

  // ==========================================================================
  // Cleaning – whole lines only
  // ==========================================================================

  const HEADING_PREFIX_RE = new RegExp(
    '^(?:' + AIO_HEADING_TEXTS.map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')+',
    'i'
  );

  // A trailing line is dropped only when the whole line is one of Google's
  // own controls: a UI label, a "+3" source-count chip or the "Shared 2
  // files" chip. A sentence that merely contains or ends with those words
  // is answer text and is kept.
  function isTrailingNoiseLine(line) {
    return UI_CHROME.has(line)
      || /^\+\d+$/.test(line)
      || /^Shared\s*\d*\s*files?$/i.test(line);
  }

  // Strip the heading/UI chrome Google renders at the top/bottom of the
  // overview container so the captured text is just the AI's answer.
  function cleanOverviewLines(rawLines) {
    const lines = rawLines.slice();

    // Leading label: a line that is the label, or a label glued to the
    // start of the first line when Google renders it inline.
    while (lines.length > 0) {
      const stripped = lines[0].replace(HEADING_PREFIX_RE, '').trim();
      if (stripped === lines[0]) break;
      if (stripped) {
        lines[0] = stripped;
        break;
      }
      lines.shift();
    }
    // "AI Mode reply for <query>" on a line of its own.
    while (lines.length > 0 && AIMODE_ASSISTANT_RE.test(lines[0]) && lines[0].length <= 300) {
      lines.shift();
    }

    while (lines.length > 0 && isTrailingNoiseLine(lines[lines.length - 1])) {
      lines.pop();
    }
    return lines;
  }

  function cleanOverviewText(rawLines) {
    return cleanOverviewLines(rawLines).join('\n');
  }

  // ==========================================================================
  // Sources
  // ==========================================================================

  /** The destination of a result link, or null for Google's own links. */
  function externalUrl(a) {
    const href = attr(a, 'href') || '';
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return null;
    let real = href;
    if (href.startsWith('/url?')) {
      try {
        const u = new URL(href, 'https://www.google.com');
        real = u.searchParams.get('q') || u.searchParams.get('url') || href;
      } catch (_) { return null; }
    } else if (!href.startsWith('http')) {
      return null;
    }
    try {
      const host = new URL(real).hostname;
      if (/^(www\.)?google\.(com|be|nl|fr|de|co\.uk|es|it|ca|com\.au)$/i.test(host)) return null;
      if (/\.(google|googleusercontent|gstatic|googleadservices|googlesyndication)\.com$/i.test(host)) return null;
    } catch (_) { return null; }
    return real;
  }

  /** Collects de-duplicated `{ url, title }` sources up to `limit`. */
  function createSourceList(limit) {
    const seen = new Set();
    const sources = [];
    return {
      sources,
      add(a) {
        if (sources.length >= limit) return;
        const real = externalUrl(a);
        if (!real || seen.has(real)) return;
        seen.add(real);
        sources.push({ url: real, title: normalizeTextEarly(a.textContent).slice(0, 300) });
      }
    };
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

  const AIMODE_SOURCE_LIMIT = 20;
  const OVERVIEW_SOURCE_LIMIT = 30;

  /**
   * Split the page into turns at Google's turn headings. One pass over the
   * document: a turn heading starts a turn, and everything visible up to the
   * next turn heading (or the end of the page) belongs to it.
   */
  function extractAIModeTurns(doc, stats) {
    const turns = [];
    let current = null;
    let markerIndex = 0;

    const finish = () => {
      if (!current) return;
      const text = current.role === 'user'
        ? current.label
        : cleanOverviewText(current.buffer.lines());
      turns.push({
        index: current.index,
        role: current.role,
        text,
        query_label: current.label,
        sources: current.sourceList.sources
      });
      current = null;
    };

    walkVisible(doc.body || doc.documentElement, {
      enter(el, tag) {
        if (isHeading(el, tag)) {
          const t = visibleTextContent(el);
          const user = t.match(AIMODE_USER_RE);
          const assistant = user ? null : t.match(AIMODE_ASSISTANT_RE);
          if (user || assistant) {
            finish();
            current = {
              index: markerIndex++,
              role: user ? 'user' : 'assistant',
              label: (user || assistant)[1].trim(),
              buffer: createLineBuffer(),
              sourceList: createSourceList(AIMODE_SOURCE_LIMIT)
            };
            return false;
          }
          // Drop stray UI headings that fall inside a turn.
          if (!t || AIMODE_HEADING_NOISE_RE.test(t)) return false;
        }
        if (current && current.role === 'assistant' && tag === 'A') current.sourceList.add(el);
        return true;
      },
      text(s) { if (current && current.role === 'assistant') current.buffer.text(s); },
      breakLine() { if (current && current.role === 'assistant') current.buffer.breakLine(); }
    }, stats);
    finish();

    return turns.filter(t => t.text);
  }

  /**
   * AI Mode without recognisable turn headings (an interface language not
   * listed above): fall back to the structural summary container and export
   * it as one question/answer pair. Later turns of a longer conversation
   * are not separated, so the capture is flagged.
   */
  function extractAIModeFromContainer(doc, query, stats) {
    const root = findOverviewRoot(doc, { structuralOnly: true });
    if (!root) return null;
    const text = cleanOverviewText(blockLines(root, { stats }));
    if (text.length < 60) return null;
    const sourceList = createSourceList(AIMODE_SOURCE_LIMIT);
    for (const a of root.querySelectorAll('a[href]')) sourceList.add(a);
    return [
      { index: 0, role: 'user', text: query, query_label: query, sources: [] },
      { index: 1, role: 'assistant', text, query_label: query, sources: sourceList.sources }
    ];
  }

  /** @returns {{ data: object, flags: string[] } | null} */
  function extractAIMode(doc, query, sourceUrl) {
    const stats = { hiddenWithText: 0 };
    const flags = [];
    let telemetry = {
      selector_used: 'ai_mode_heading_scan',
      selector_index: null,
      used_heading_fallback: false,
      container_selectors_tried: 0
    };

    let turns = extractAIModeTurns(doc, stats);
    if (turns.length === 0) {
      turns = extractAIModeFromContainer(doc, query, stats);
      if (!turns) return null;
      telemetry = { ..._lastExtractionTelemetry };
      flags.push('heuristic_root', 'no_turn_markers');
    }
    if (stats.hiddenWithText > 0) flags.push('hidden_text_skipped');

    // Conversation title: first user turn's text, falling back to the URL q=.
    const firstUser = turns.find(t => t.role === 'user');
    const capturedAt = new Date().toISOString();
    // Stamp each turn with the capture time so sequence analysis can
    // distinguish "no per-turn timestamp" from "same time" after the fact.
    turns.forEach(t => { t.captured_at = capturedAt; });
    return {
      flags,
      data: {
        mode: 'ai_mode',
        // Stable id for file names, the manifest and the conversation_id
        // column: the search query from the URL, exactly as classic AI
        // Overview uses its query. The title stays the first user turn.
        conversation_id: query || '',
        conversation_title: (firstUser && firstUser.text) || query || '',
        source_page_url: exportedPageUrl(sourceUrl),
        captured_at: capturedAt,
        turns,
        extraction_telemetry: { ...telemetry, turn_count: turns.length }
      }
    };
  }

  /** @returns {{ data: object, flags: string[] } | null} */
  function extractOverview(doc, query, sourceUrl) {
    const root = findOverviewRoot(doc);
    if (!root) return null;
    const telemetry = { ..._lastExtractionTelemetry };
    const stats = { hiddenWithText: 0 };

    // Skip the AI Overview / AI Mode heading nodes so the label does not
    // leak into the captured content.
    const lines = blockLines(root, {
      stats,
      enter(el, tag) {
        if (!isHeading(el, tag)) return true;
        const t = visibleTextContent(el);
        if (!t) return true;
        const isLabel = AIO_HEADING_TEXTS.some(x => t === x || t.startsWith(x));
        return !(isLabel || AIMODE_ASSISTANT_RE.test(t));
      }
    });

    const text = cleanOverviewText(lines);
    // Guard against tiny / spurious matches
    if (text.length < 60) return null;

    // Google often renders source citations as siblings of (not inside) the
    // summary element. Walk up to the nearest "section-like" ancestor so we
    // catch citation chips below the summary text too.
    let sourceScope = root;
    for (let i = 0; i < 3 && sourceScope.parentElement; i++) {
      const parent = sourceScope.parentElement;
      // Stop climbing once we hit a known top-level search region.
      if (attr(parent, 'role') === 'main' || parent.id === 'rcnt' || parent.id === 'search') break;
      sourceScope = parent;
      if (sourceScope.querySelectorAll('a[href]').length >= 4) break;
    }

    const sourceList = createSourceList(OVERVIEW_SOURCE_LIMIT);
    for (const a of sourceScope.querySelectorAll('a[href]')) sourceList.add(a);

    const flags = rootFlags(telemetry);
    if (stats.hiddenWithText > 0) flags.push('hidden_text_skipped');

    return {
      flags,
      data: {
        query,
        source_page_url: exportedPageUrl(sourceUrl),
        captured_at: new Date().toISOString(),
        ai_overview_text: text,
        sources: sourceList.sources,
        follow_up_questions: extractRelatedQuestions(doc),
        extraction_telemetry: telemetry
      }
    };
  }

  // ==========================================================================
  // Capture
  //
  // `captureFromDom` reads the live page and is the only capture that runs
  // on its own (page load, URL change, DOM mutation, popup poll, export). It
  // makes no request.
  //
  // `captureFromRefetch` requests the current search URL again and parses
  // the server HTML. It runs only from the export path, only for a classic
  // AI Overview that the DOM read could not find, and at most once per
  // page/query (`fetchAttempted`; a failed request may be retried by the
  // next export click). AI Mode is never re-fetched: its content is
  // rendered client-side and is not in the server HTML.
  // ==========================================================================

  // A capture whose text changed this recently is probably still streaming.
  const SETTLE_MS = 1500;

  function signatureOf(data) {
    if (Array.isArray(data.turns)) {
      return data.turns.map(t => `${t.role}\u0000${t.text}`).join('\u0001');
    }
    return typeof data.ai_overview_text === 'string' ? data.ai_overview_text : '';
  }

  function notifyReady(key, data) {
    const isAIMode = data.mode === 'ai_mode';
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
  }

  /**
   * Store a fresh extraction unless what is stored is better.
   * - A DOM capture always replaces a re-fetched one (the DOM is what the
   *   user saw); a re-fetched one never replaces a DOM capture.
   * - AI Mode: the latest read wins (the conversation grows, and a turn can
   *   be rewritten while it streams).
   * - AI Overview: the latest read wins unless it is shorter than the
   *   stored text. The overview streams in and can be collapsed again, so
   *   the longest version seen is the complete one.
   * @returns the stored record
   */
  function remember(key, extraction, source) {
    const previous = captured.get(key);
    const signature = signatureOf(extraction.data);

    if (previous) {
      if (previous.source === 'dom' && source !== 'dom') return previous;
      const sameSource = previous.source === source;
      const isAIMode = extraction.data.mode === 'ai_mode';
      if (sameSource && !isAIMode && signature.length < previous.signature.length) return previous;
      if (sameSource && signature === previous.signature) {
        // Same content read again: keep the record, refresh the read time.
        storeOverview(key, { ...previous, data: extraction.data, flags: extraction.flags });
        return captured.get(key);
      }
    }

    storeOverview(key, {
      data: extraction.data,
      source,
      flags: extraction.flags,
      signature,
      changedAt: Date.now()
    });
    logDebug('Captured AI Overview', {
      mode: extraction.data.mode || 'ai_overview',
      textLength: signature.length,
      sources: Array.isArray(extraction.data.sources) ? extraction.data.sources.length : null,
      turns: Array.isArray(extraction.data.turns) ? extraction.data.turns.length : null
    });
    notifyReady(key, extraction.data);
    return captured.get(key);
  }

  /**
   * Read the current page. Synchronous, no network.
   * @returns {{ key: string|null, record: object|null, found: boolean }}
   *   `found` is whether this read located the overview; `record` is what is
   *   stored for the page afterwards (possibly from an earlier read).
   */
  function captureFromDom() {
    const query = currentQuery();
    if (!query) return { key: null, record: null, found: false };
    const url = window.location.href;
    const key = captureKey(query, url);

    let extraction = null;
    try {
      extraction = isAIModeUrl(url)
        ? extractAIMode(document, query, url)
        : extractOverview(document, query, url);
    } catch (e) {
      logWarn('DOM capture failed', { error: e && e.message });
    }
    if (!extraction) return { key, record: captured.get(key) || null, found: false };
    return { key, record: remember(key, extraction, 'dom'), found: true };
  }

  let fetchInFlight = null;
  const fetchAttempted = new Map(); // captureKey -> timestamp of the one re-fetch

  /**
   * Re-fetch the current search page and extract the overview from the
   * server HTML. Export path only; see the section comment.
   * @returns {Promise<object|null>} the stored record
   */
  async function captureFromRefetch() {
    const query = currentQuery();
    const url = window.location.href;
    if (!query || isAIModeUrl(url)) return null;
    const key = captureKey(query, url);

    if (fetchInFlight) {
      try { await fetchInFlight; } catch (_) { /* reported by the first caller */ }
      return captured.get(key) || null;
    }
    if (fetchAttempted.has(key)) return captured.get(key) || null;
    fetchAttempted.set(key, Date.now());

    fetchInFlight = (async () => {
      let html;
      try {
        const resp = await fetch(url, {
          credentials: 'include',
          headers: { 'Accept': 'text/html,application/xhtml+xml' }
        });
        if (!resp.ok) throw new Error(`search ${resp.status}`);
        html = await resp.text();
      } catch (e) {
        // The request itself failed: let a later export click try again.
        fetchAttempted.delete(key);
        throw e;
      }
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const extraction = extractOverview(doc, query, url);
      if (!extraction) return null;
      extraction.flags.push('refetched_variant');
      return remember(key, extraction, 'refetch');
    })();

    try {
      return await fetchInFlight;
    } catch (e) {
      logWarn('Re-fetch failed', { error: e && e.message });
      return null;
    } finally {
      fetchInFlight = null;
    }
  }

  /**
   * Provenance of an exported record, sent next to the payload so the
   * background can record it in the export manifest.
   * @param {object} record
   * @param {'ok'|'failed'|'not_attempted'} refresh result of the export-time
   *   re-read of the page
   */
  function buildCapture(record, refresh) {
    const flags = record.flags.slice();
    if (refresh === 'failed') flags.push('refresh_failed');

    const data = record.data;
    const lastTurn = Array.isArray(data.turns) ? data.turns[data.turns.length - 1] : null;
    const unanswered = !!lastTurn && lastTurn.role !== 'assistant';
    const stillChanging = record.source === 'dom' && Date.now() - record.changedAt < SETTLE_MS;
    if (unanswered || stillChanging) flags.push('in_flight');

    let complete = true;
    if (flags.includes('in_flight') || flags.includes('no_turn_markers')) {
      complete = false;
    } else if (refresh !== 'ok' || record.source !== 'dom' || flags.includes('heuristic_root')) {
      // Not confirmed against the page at export time, or the container was
      // guessed: completeness is unknown.
      complete = null;
    }

    return {
      captured_at: typeof data.captured_at === 'string' ? data.captured_at : '',
      source: record.source,
      refresh,
      complete,
      flags
    };
  }

  // Opportunistic capture on load + on SPA URL changes. DOM reads only.
  function kickoff() {
    if (!currentQuery()) return;
    captureFromDom();
    // AI Mode renders turns asynchronously via client-side JS. On tab reload
    // the MutationObserver sometimes misses early render passes (shadow-DOM
    // or synchronous-batch updates), so we also retry a handful of times
    // during the first ~15 s. Each retry re-reads the live DOM; cheap.
    if (isAIModeUrl(window.location.href)) {
      [1500, 3000, 5000, 8000, 13000].forEach(delay => {
        setTimeout(() => {
          if (currentQuery()) captureFromDom();
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

  // AI Mode and the AI Overview render (and keep streaming) asynchronously
  // via client-side JS. The first kickoff on DOMContentLoaded often runs
  // before the answer is complete, or before it exists at all. Watch the
  // page and re-read it when it changes — debounced so we don't thrash while
  // Google streams in.
  (function installMutationObserver() {
    if (typeof MutationObserver !== 'function') return;
    let debounceTimer = null;
    const observer = new MutationObserver(() => {
      if (!currentQuery()) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(captureFromDom, 800);
    });
    const start = () => {
      const target = document.body || document.documentElement;
      if (!target) return;
      observer.observe(target, { childList: true, subtree: true, characterData: true });
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

  function titleFor(data) {
    const title = data.mode === 'ai_mode'
      ? `AI Mode — ${data.conversation_title || data.conversation_id || ''}`
      : `AI Overview — ${data.query || ''}`;
    return title.slice(0, 120);
  }

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!sender || sender.id !== browser.runtime.id) return;
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'GET_CAPTURED_CONVERSATIONS') {
      // DOM-only: the popup polls every 2 s, and that must never turn into
      // requests to Google. A page that is already captured is kept up to
      // date by the MutationObserver, so it is not re-read here.
      const query = currentQuery();
      const key = query ? captureKey(query, window.location.href) : null;
      const missing = !!key && !captured.has(key) && !captureFromDom().record;

      const conversations = Array.from(captured.entries()).map(([k, record]) => ({
        id: k,
        title: titleFor(record.data)
      }));
      sendResponse({
        success: true,
        conversations,
        conversationIds: conversations.map(c => c.id),
        platform: 'google_search',
        noOverviewForThisPage: missing
      });
      return false;
    }

    if (message.type === 'EXPORT_CONVERSATION' && message.platform === 'google_search') {
      const id = message.conversationId;
      const forward = (record, refresh) => {
        browser.runtime.sendMessage({
          type: MESSAGE_TYPE,
          payload: record.data,
          capture: buildCapture(record, refresh),
          platform: 'google_search'
        }).then(() => sendResponse({ success: true }))
          .catch(e => sendResponse({ success: false, error: e.message }));
      };

      // Re-read the page first, so the export is the answer as it is now
      // (the overview may have finished streaming, or the AI Mode
      // conversation may have gained turns, since the last passive read).
      const page = captureFromDom();

      // Prefer the id the popup sent. If it's absent or no longer in the
      // map (e.g., popup running an older build, or Google rewrote the URL
      // between capture and export), fall back to whatever we have stored
      // for the current page.
      if (id && id !== page.key && captured.has(id)) {
        // A capture from an earlier page in this tab; it cannot be re-read.
        forward(captured.get(id), 'not_attempted');
        return true;
      }
      if (page.record) {
        forward(page.record, page.found ? 'ok' : 'failed');
        return true;
      }

      // Nothing in the DOM. Last resort for a classic AI Overview: one
      // re-fetch of this search page, exported as `source: 'refetch'`.
      captureFromRefetch().then(record => {
        if (!record) {
          sendResponse({
            success: false,
            error: 'No AI Overview captured. Run a search that triggers an AI Overview, then try again.'
          });
          return;
        }
        forward(record, 'failed');
      }).catch(e => sendResponse({ success: false, error: (e && e.message) || 'Export failed.' }));
      return true;
    }

    return false;
  });

  logDebug('Google Search content script loaded');
})();
