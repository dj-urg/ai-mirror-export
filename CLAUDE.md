# CLAUDE.md

Guidance for Claude Code and other AI assistants working on this repo. Keep
it short; details that change often belong in `docs/` or the code itself.

## What this is

Firefox extension that exports conversations from ChatGPT, Claude, Copilot,
Microsoft 365 Copilot, Perplexity, Grok, DeepSeek, Mistral, and Google Search
AI Overview to CSV, entirely locally. Published on AMO as a Development
Preview under `local-ai-chat-exporter`. Users include non-technical research
participants, so trust messaging and plain language matter.

## Rules of the road

- **Nothing leaves the browser.** No analytics, no telemetry, no remote
  fonts, no CDN assets, no new network requests. `data_collection_permissions`
  stays `"none"`.
- **No new dependencies without asking.** `playwright` + `@axe-core/playwright`
  are dev-only (ignored by the AMO build via `web-ext-config.mjs`).
- **No new permissions without asking.** Current set is `activeTab`,
  `downloads`, `storage`, `scripting` (no `tabs`: the icon state works from
  the host permissions). Any addition triggers a user re-approval prompt on
  update — see `docs/ux-audit.md` §9.
- **AMO reviewers see the source.** Code stays unbundled, unminified,
  readable. No build step that changes what ships.
- **Golden-output policy.** `testing/tests/test_background_golden.js` pins
  every ZIP entry (CSVs and manifest) for every platform, scrubbing off and
  on, against `testing/data/synthetic/golden/`. Any change to
  `background.js`, `platforms/*/extractor.js`, `utils/` or the content
  scripts that alters export bytes must be intentional: its own commit, the
  changed files/columns and the reason in the message, goldens refreshed in
  that same commit (`UPDATE_GOLDEN=1 node testing/tests/test_background_golden.js`),
  the schema version bumped in `utils/manifest.js` `SCHEMA_VERSIONS` when
  columns change, and METHODS.md + CHANGELOG.md updated. Never refresh
  goldens to make an unrelated failure pass. Scrub-off output must stay
  byte-identical unless the change is one of the listed intentional ones.
- **Protected zone.** `background.js`, the extractors, the content/inject
  scripts, `utils/pii.js`, `utils/manifest.js` and `utils/validators.js`
  decide what research data looks like. Changes there need the golden
  test, the PII sweep (`test_pii_sweep.js`) and, for content scripts, a
  real-browser check from `docs/manual-tests.md`, because nothing automated
  covers them.
- **Synthetic data only.** Fixtures under `testing/data/synthetic/` are
  hand-written. Real-origin captures (`testing/data/<site>/`, `test/`,
  `dev/m365_ws_capture.json`, HAR files, `.playwright-mcp/`) are ignored
  and must never be opened, printed, or committed.
- **ESLint is strict about imports.** Globals are scoped per file in
  `eslint.config.mjs`: only content/inject scripts get `MessageSecurity`.
  A missing `import` in `background.js`, an extractor or `utils/` is a
  lint error, not a runtime surprise. `npm run lint` must report 0
  warnings.
- **Match consent-gate copy exactly** — it's methodological, not UX. All
  trust/preview messaging lives outside the consent flow.

## Design tokens (popup)

Full palette in `popup.css` under `:root`. Highlights:

| Token                             | Light           | Dark                | Use                        |
|-----------------------------------|-----------------|---------------------|----------------------------|
| `--color-primary`                 | `#0060df`       | `#4891ff`           | accent, focus, info surfaces |
| `--color-background`              | `#ffffff`       | `#1b1b1f`           | popup body                 |
| `--color-background-secondary`    | `#f9f9fb`       | `#2a2a30`           | cards, disclosures         |
| `--color-text-primary`            | `#15141a`       | `#ededed`           | body text                  |
| `--color-success/warning/error`   | status accents  | lightened pairs     | status card borders        |
| `--color-success-text` (etc.)     | darkened pairs  | lightened pairs     | status card text           |
| `--badge-<platform>-{strong,bg,text}` | per-platform palette | lightened dark pairs | platform badges in header |
| `--focus-ring`                    | `0 0 0 2px rgba(0,96,223,0.3)` | `0 0 0 2px rgba(72,145,255,0.55)` | focus affordance |

Dark theme kicks in on `@media (prefers-color-scheme: dark)` AND on
`html[data-force-color-scheme="dark"]` (used by the preview harness).
The two palettes are deliberately duplicated — CSS can't share a token set
across a media query and an attribute selector in one block. Every
platform has `--badge-<id>-{strong,bg,text}` tokens in all three blocks.

## Component conventions

- BEM naming: `.block`, `.block__element`, `.block--modifier`.
- Every interactive element gets a visible outline fallback **in addition
  to** `box-shadow: var(--focus-ring)` — some environments drop shadows.
- `prefers-reduced-motion: reduce` collapses all animations + transitions
  to ~0 ms via a universal override; new keyframes don't need to opt in.
- `role="status"` + `aria-live="polite"` on the status card, always polite
  (an assertive region inside a status role is contradictory). Regions
  that are rebuilt on the 2 s poll (platform badge, file list) carry no
  live attributes and are diffed before they are written; the elapsed
  counter lives outside the atomic card and is `aria-hidden`.
- "Not a conversation yet" and "unsupported page" render as info, not
  error.

## Preview harness (dev-only)

```bash
python3 -m http.server 8766       # from repo root
# open http://localhost:8766/dev/harness.html
```

Dropdown picks one of 36 harness states (ready and idle per platform,
loading, errors, sign-out, consent gate, and the export outcomes, which
click Export for you); theme radio flips the palette; viewport radio
shows 320/380/600 widths. Behind the scenes, a mock `browser.*` sits in
the iframe so the popup renders without a real chat site; the mock
keeps the popup's `runtime.onMessage` listeners so it can deliver
`EXPORT_RESULT` broadcasts.

For automated baselines + axe runs across every state × theme (the run
records the status-card text, review-card copy and focused element in
each `.axe.json`, and exits non-zero if a capture produced no result):

```bash
npm run baseline -- --label before
# make changes
npm run baseline -- --label after
npm run baseline:compare -- before after
```

Run tests and baselines one at a time (the baseline serves the repo on
port 8766 and reads popup files from disk while it runs).

Firefox only — the popup depends on `-moz-system-ui` and Firefox form
control rendering; Chromium runs produce different metrics.

## Accessibility rules

- WCAG 2.2 AA baseline. Contrast ≥ 4.5:1 for body text, ≥ 3:1 for UI
  components. Dark palette tokens enforce the same floors.
- Information is never conveyed by colour alone — status icons, titles,
  and ARIA labels carry the same information.
- Popup opens with focus on the primary action (consent checkbox on
  first run, export button when ready, set after the first status check
  resolves). After a confirmed export, focus moves to the review card's
  "Show in Downloads" button. `Escape` closes the popup (Firefox doesn't
  do this natively) and blurs text inputs instead of closing if focus is
  in one. Enter/Space on buttons is native; do not add synthetic clicks.
- Every `<details>` has an accessible name via `aria-label` or
  `aria-labelledby`.

## Where to look

| Looking for … | Start here |
|---|---|
| UX decisions + severity-ranked findings | `docs/ux-audit.md` |
| Manual-test checklist | `docs/manual-tests.md` |
| How the exporter is verified (tests, baseline, real-data validation log) | `docs/validation.md` |
| Preview harness controls | `dev/harness.html` + `dev/README.md` |
| Baseline capture / compare | `dev/baseline.mjs` |
| Error taxonomy + copy | `shared/errors.js` |
| Design tokens | `popup.css` under `:root` |
| Platform configs + domain lists | `config/settings.js` |
| Toolbar icon state logic | `background.js` under "Toolbar icon state" |

## Not covered by automated checks (so test manually)

- Firefox-chrome native fit (fonts, icon rendering)
- `web-ext run` end-to-end flows on real logged-in sessions
- Toolbar icon state transitions across tab switches
- The toolbar `!` badge after a failed export when the popup has already
  been closed (the popup no longer auto-closes, so an open popup always
  receives the background's `EXPORT_RESULT`)
- The review step's "Show in Downloads" (`downloads.show`)
- M365 Copilot's WebSocket interception path (no synthetic fixture, no
  raw-capture validation yet)
- DeepSeek's token-bearing history refresh and Google's single re-fetch
  (content scripts have no automated coverage)

See `docs/manual-tests.md` for the full checklist.
