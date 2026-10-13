/**
 * Shared text cleaner for the `text_cleaned` column that lives alongside
 * `text` in every platform's messages CSV.
 *
 * Purpose: strip presentation-layer markup (HTML/XML tags, platform-specific
 * render directives, citation placeholders, invisible characters) so the
 * cleaned column is suitable for downstream NLP without any preprocessing.
 *
 * Scope decisions:
 * - Markdown is preserved (asterisks, hashes, dashes, pipes, backticks) because
 *   those are semantically meaningful text that NLP models typically keep.
 * - Only tags that look like real tags are stripped (`<` followed by a letter)
 *   so comparisons like `a<b and b>c` in prose stay intact.
 * - Pure string module: no DOM, no browser APIs. Safe for background worker,
 *   content scripts, and Node tests.
 */

/**
 * Strip Grok-specific inline render directives.
 *
 * Observed shape (from a real capture):
 *   <grok:render card_id="866af7" card_type="citation_card" type="render_inline_citation">
 *     <argument name="citation_id">0</argument>
 *   </grok:render>
 *
 * These are presentation hints for Grok's web UI and carry no information
 * beyond what the sources CSV already captures.
 */
const GROK_RENDER_RE = /<grok:render\b[^>]*>[\s\S]*?<\/grok:render>/gi;

/**
 * Generic HTML/XML tag. Requires `<` to be followed by a letter so prose like
 * `a < b` or `2 > 1` stays untouched. Handles paired tags, self-closing tags,
 * and namespaced tags (`<ns:name>`).
 */
const HTML_TAG_RE = /<\/?[a-zA-Z][a-zA-Z0-9:._-]*(?:\s[^>]*)?\/?>/g;

/**
 * ChatGPT's inline citation placeholders. Two observed variants:
 *   citeturn0search1          (plain)
 *   cite​turn0​search1   (with zero-width space separators)
 *   【0†source】              (bracketed with dagger)
 */
const CHATGPT_CITE_TOKEN_RE = /\u200B?cite\u200B?turn\d+\u200B?[a-z]+\d+/gi;
const BRACKETED_CITE_RE = /【[^】]*†[^】]*】/g;

/**
 * Zero-width and other invisible characters that creep in from rich-text UIs.
 * Includes ZWSP, ZWNJ, ZWJ, LRM/RLM, line/paragraph separators (U+2028/9),
 * narrow NBSPs, and the UTF-8 BOM.
 */
const INVISIBLE_RE = /[\u200B-\u200F\u2028-\u202F\u205F\uFEFF]/g;

/**
 * Clean message text for NLP use.
 *
 * @param {unknown} text  The raw text (any non-string returns '').
 * @returns {string}      The cleaned text, trimmed. Never null/undefined.
 */
export function cleanText(text) {
  if (typeof text !== 'string' || text.length === 0) return '';

  let s = text;

  // 1. Platform-specific render blocks first (they contain nested <argument>
  //    tags that would be preserved as debris if we stripped generic tags
  //    before stripping the surrounding grok:render).
  s = s.replace(GROK_RENDER_RE, '');

  // 2. Generic HTML/XML tags.
  s = s.replace(HTML_TAG_RE, '');

  // 3. Platform-specific citation placeholders.
  s = s.replace(CHATGPT_CITE_TOKEN_RE, '');
  s = s.replace(BRACKETED_CITE_RE, '');

  // 4. Invisible characters.
  s = s.replace(INVISIBLE_RE, '');

  // 5. Normalize whitespace: trim trailing spaces/tabs on each line, collapse
  //    runs of 3+ newlines to a paragraph break.
  s = s.replace(/[ \t]+(\r?\n)/g, '$1');
  s = s.replace(/\n{3,}/g, '\n\n');

  return s.trim();
}
