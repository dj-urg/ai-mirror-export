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
- **No new permissions without asking.** Current set is `activeTab`, `tabs`,
  `downloads`, `storage`, `scripting`. Any addition triggers a user
  re-approval prompt on update — see `docs/ux-audit.md` §9.
- **AMO reviewers see the source.** Code stays unbundled, unminified,
  readable. No build step that changes what ships.
- **Don't touch `window.fetch` hooks or extractor logic** unless a UX fix
  genuinely requires it. If you do, prove the CSV output is byte-identical
  on synthetic fixtures first.
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
across a media query and an attribute selector in one block.

## Component conventions

- BEM naming: `.block`, `.block__element`, `.block--modifier`.
- Every interactive element gets a visible outline fallback **in addition
  to** `box-shadow: var(--focus-ring)` — some environments drop shadows.
- `prefers-reduced-motion: reduce` collapses all animations + transitions
  to ~0 ms via a universal override; new keyframes don't need to opt in.
- `role="status"` + `aria-live="polite"` on the status card; `aria-live=
  "assertive"` only when the user needs to notice immediately.

## Preview harness (dev-only)

```bash
python3 -m http.server 8766       # from repo root
# open http://localhost:8766/dev/harness.html
```

Dropdown picks one of 13 harness states (idle/ready per platform,
loading, errors, consent gate, auth failure); theme radio flips the
palette; viewport radio shows 320/380/600 widths. Behind the scenes, a
mock `browser.*` sits in the iframe so the popup renders without a real
chat site.

For automated baselines + axe runs across every state × theme:

```bash
npm run baseline -- --label before
# make changes
npm run baseline -- --label after
npm run baseline:compare -- before after
```

Firefox only — the popup depends on `-moz-system-ui` and Firefox form
control rendering; Chromium runs produce different metrics.

## Accessibility rules

- WCAG 2.2 AA baseline. Contrast ≥ 4.5:1 for body text, ≥ 3:1 for UI
  components. Dark palette tokens enforce the same floors.
- Information is never conveyed by colour alone — status icons, titles,
  and ARIA labels carry the same information.
- Popup opens with focus on the primary action (consent checkbox on
  first run, export button when ready). `Escape` closes the popup
  (Firefox doesn't do this natively) and blurs text inputs instead of
  closing if focus is in one.
- Every `<details>` has an accessible name via `aria-label` or
  `aria-labelledby`.

## Where to look

| Looking for … | Start here |
|---|---|
| UX decisions + severity-ranked findings | `docs/ux-audit.md` |
| Manual-test checklist | `docs/manual-tests.md` |
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
- The 3-second popup auto-close vs. late background `EXPORT_RESULT`
  broadcasts (race condition — covered by the toolbar `!` badge)
- M365 Copilot's WebSocket interception path (no synthetic fixture yet)

See `docs/manual-tests.md` for the full checklist.
