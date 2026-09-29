@AGENTS.md

# Build With Phil Analytics Dashboard: project brain

## What this is
The Build With Phil social media analytics dashboard. Originally a
single 5,109-line `index.html` rebuilt as Next.js 16 + Tailwind v4 +
shadcn/ui in April 2026 (see `v1-archive/` for the original).

## Stack
- Next.js 16 App Router · TypeScript · Tailwind v4 · shadcn/ui
- Recharts (line/bar/doughnut). Custom 7×24 heatmap is hand-rolled.
- Zustand + localStorage persistence (key: `bwp_dashboard_v2`)
- Static export → GitHub Pages
- System font stack (the self-hosted Newsreader/Geist load was reverted
  in April 2026; `font-display` maps to the sans stack)
- Python `scrape/` pipeline: scrapers → `analyze.py` → derived JSON

## Tabs (and where they live)
| Tab | Route | Component | Reads from |
|---|---|---|---|
| Overview | `/` | `components/overview/overview.tsx` | posts × 4, scrape_state, follower_history, content_vault |
| Post Analysis | `/posts` | `components/posts/posts.tsx` | posts × 4 |
| Comments | `/comments` | `components/comments/comments.tsx` | comments |
| Insights | `/insights` | `components/insights/insights.tsx` | analytics, follow_data |
| Content Vault | `/vault` | `components/vault/vault.tsx` | content_vault + posts × 4 |

`/creators` still builds but is not in the nav (removed 2026-04-26).
Brand Deals, Content Analyzer and Montage Studio were removed 2026-09-04:
deals live in Monday now, and the other two needed a local server that
belongs in a standalone tool. Overview reads posts × 4, scrape_state,
follower_history and content_vault; the comments data moved to the
Comments tab.

## Design system (don't drift)
- Background: `#eaf3fb` (light brand blue) — non-negotiable, this is THE brand move
- Brand: `#1e6fd9` blue, used as the single dominant accent
- Surfaces: white (`#ffffff`) cards on the blue background
- Text: `#0a1628` ink, `#334155` soft, `#64748b` muted
- Positive `#16a34a`, Negative `#dc2626`, Warn `#d97706` — sparse use only
- Per-platform colors: IG `#c13584`, TT `#111111`, YT `#cc0000`, TH `#0a1628`
- Type: system sans for display and body, system mono for eyebrows, KPI
  labels, data and hashtags. Newsreader/Geist were tried and reverted;
  `font-display` is just the sans stack with tighter tracking.
- The Overview hero is the ONE dark band (`--ink` to `--brand-deep`).
  Everything else stays light cards on the blue background.
- Card borders: 8px radius. Data tables: **0px radius** — sharp.
- KPI numbers use `tabular` class for tabular figures.

When extending: don't add new accent colors without checking the
palette first. The whole point of this rebuild was escaping the v1 AI
slop palette (`#6c5ce7` purple).

## Data
- All JSON in `public/data/` is real. Posts come from `scrape/`, the
  comments and follow data are the 2026-03-28 snapshot (not re-scraped yet).
- Schema is documented in `lib/types.ts`.
- The dashboard reads via `fetch()` at runtime — no build-time data
  embedding. Push new JSON files and the live site picks them up.
- **Refresh:** `python3 scrape/run.py` (incremental) or `--full` (master
  sweep). It uses the already-running shared Chrome on :9222 and opens its
  own tabs; never relaunch Chrome for it. Then commit `public/data/` and
  push. Details in `scrape/README.md`.
- **Derived files are generated, never hand-edited:** `analytics.json`
  (all Insights sections), `content_vault.json` (Vault topics) and
  `follower_history.json` come from `scrape/analyze.py`. Change the
  computation there; change topics in `scrape/categories.json`.
- The original v1 analytics generator was lost; `analyze.py` is its
  replacement and reproduces the v1 numbers where the inputs are the same.

## PIN gate
- SHA-256 client-side check (Web Crypto API), sessionStorage flag.
- Hash configured via `NEXT_PUBLIC_DASHBOARD_PIN_HASH`. Falls back to
  the hashed v1 PIN so dev works without env config. This repo is
  public: never write the PIN itself into any tracked file.
- Set the GH repo secret `DASHBOARD_PIN_HASH` for production.

## Local tools (optional)
The Refresh data button calls `scrape/server.py` on `localhost:5556`. It
detects when the service is offline and degrades gracefully; do not break
this contract when extending.

## Chat assistant (Ask your dashboard)
- Browser only. `lib/chat/providers/anthropic-key.ts` calls api.anthropic.com
  through `@anthropic-ai/sdk` with the reader's own key. There is no server
  and no proxy. Model `claude-opus-5-5`, adaptive thinking, strict tools.
- The key lives ONLY in `localStorage["bwp_chat_api_key"]`. Never copy it
  into the Zustand store, the settings JSON, logs, URLs, tests or any
  tracked file. The production build ships a CSP meta that limits
  `connect-src` to the page, api.anthropic.com and localhost:5556.
- Every number must come from a tool result. Tools in `lib/chat/tools/`
  compute over the already loaded JSON and return `{ok, asOf, window,
  filters, notes, ...}` envelopes capped at 8000 characters; `grounding.ts`
  underlines figures no envelope returned. Add data capabilities as tools,
  never as prose in the system prompt.
- `lib/chat/tools/defs.json` is generated from `defs.ts` by
  `scripts/export-tool-defs.ts` so a future local helper can register the
  same tools over MCP. Regenerate it when a tool schema changes.
- Provider seam: `ChatProvider` and `ChatSession` in `lib/chat/types.ts`.
  `providers/local-cli.ts` is a stub for a helper `/chat` SSE route on
  :5556 that would shell out to `claude -p`, `codex exec` or the Gemini CLI
  on the reader's own subscription. Keep SDK imports out of shared code.
- Tests: `pnpm test` runs `scripts/chat-tools-check.ts` and
  `scripts/chat-loop-test.ts` against the real SDK with a scripted fetch,
  no network. Real API smoke: `secret-sync run ANTHROPIC_API_KEY -- pnpm chat:smoke`
  (use `ANTHROPIC_API_KEY_BWP_CHAT` once that dedicated key exists).
- Dev only: `localStorage["bwp_chat_mock"] = "ok"` (or slow, 401, 403, 429,
  400, 500, 529, offline, refusal, max_tokens, nokey) swaps in the scripted
  provider. It is compiled out of production builds.

## Deploy
- GH Actions: `.github/workflows/deploy.yml` builds with
  `NEXT_PUBLIC_BASE_PATH=/bwp-analytics-dashboard` and publishes
  `out/` to GitHub Pages on every push to `main`.
- Add `.nojekyll` to the artifact (already in the workflow).

## Persisted client state (Zustand)
Single store under `bwp_dashboard_v2` (persist version 2):
- `creators` (Creator Research, hidden `/creators` route)

Version 2 strips the old `deals` slice on rehydrate. Everything else the
store once held (flows, calendar, contentQueue, studioFolder) was removed
with its tab.

PIN auth uses `sessionStorage["bwp_auth"]`, separate from the store.

The assistant keeps its own keys, outside the store:
- `localStorage["bwp_chat_api_key"]`: the API key, and nothing else holds it
- `localStorage["bwp_chat_settings_v1"]`: provider, effort, showUsage
- `sessionStorage["bwp_chat_transcript_v1"]`: the transcript, per tab
- `localStorage["bwp_chat_mock"]`: dev-only mock scenario switch
