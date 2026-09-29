# Build With Phil: Social Media Analytics

PIN-gated analytics dashboard for Phillip Karaya / Build With Phil's
cross-platform content (Instagram, TikTok, YouTube, Threads).

**Live:** https://phillipkaraya.github.io/bwp-analytics-dashboard/
(PIN-gated; the PIN is not stored in this repo.)

## Stack

- Next.js 16 (App Router) + TypeScript
- Tailwind v4 with `@theme` design tokens
- shadcn/ui components on top of Base UI
- Recharts for line / bar / doughnut charts (custom 7×24 heatmap)
- Zustand with `localStorage` persistence for client-side state
- System font stack (sans / mono) with the BWP light-blue palette
- Static export to GitHub Pages (no SSR)
- Python scraper + analyzer in `scrape/` (see `scrape/README.md`)

## Project layout

```
app/                     Next.js App Router routes (one per tab)
components/
  charts/                Reusable primitives — KpiCard, LineChart,
                         BarChart, DoughnutChart, PlatformBadge, Section
  layout/                AppShell, Nav, AuthGate, PinWall, DataStatusBar,
                         ScrapeDialog (Refresh data)
  overview/              Overview tab (30-day hero, platform strip,
                         activity chart, topics ribbon, top posts)
  posts/, comments/      Post Analysis and Comments tabs
  insights/              Insights tab (sections from analytics.json)
  vault/                 Content Vault tab (posts grouped by topic)
  chat/                  Ask your dashboard: launcher, panel, messages,
                         tool traces, post cards, settings
lib/
  chat/                  The assistant: providers (Anthropic key, mock,
                         local CLI stub), 11 data tools, system prompt,
                         grounding check, transcript and settings storage
  data.ts                Typed JSON loaders for /public/data/*
  derive.ts              Pure helpers (totals, byPlatform, cadence, etc.)
  store.ts               Zustand store with localStorage persistence
  auth.ts                SHA-256 PIN check (Web Crypto API)
  format.ts              fmt(), fmtPct(), fmtDate(), platformLabel
  scrape-client.ts       Client for scrape/server.py (Refresh data button)
  types.ts               Shared TypeScript types (mirror the JSON shapes)
scrape/                  Python scraper, analyzer, topic map — scrape/README.md
scripts/                 chat-tools-check and chat-loop-test (pnpm test),
                         chat-smoke (real API, needs a key), export-tool-defs
public/data/             Real scraped JSON data (read-only at runtime)
v1-archive/              Original single-file dashboard preserved as-is
```

## Local development

```bash
pnpm install
pnpm dev               # http://localhost:3000
pnpm build             # static export to out/
pnpm lint
pnpm typecheck
pnpm test              # assistant tools and request loop, no network
```

In `pnpm dev` with no `.env.local` the PIN is 0000. To use your own, set
`NEXT_PUBLIC_DASHBOARD_PIN_HASH` (SHA-256 hex) in `.env.local`.

## Refreshing data

The dashboard reads `public/data/*.json` at runtime via fetch. To
update, with the shared Chrome running and logged in:

```bash
python3 scrape/run.py            # incremental: only new posts
python3 scrape/run.py --full     # master sweep: refresh every post
git add public/data && git commit -m "Refresh data" && git push
```

`run.py` scrapes, then regenerates `analytics.json`, `content_vault.json`
and `follower_history.json`. GitHub Pages redeploys in about a minute.
Full details, including how the incremental stop works, are in
`scrape/README.md`.

## Optional local tool

The Refresh data button talks to `scrape/server.py` on `localhost:5556`
and degrades gracefully when the service is offline.

## Ask your dashboard

The Ask button in the header (or Cmd/Ctrl+K) opens an assistant that
answers questions about the loaded data: best reels in a window, posting
times, hashtag performance, follower growth, what the comments ask for.

It runs entirely in the browser. The page calls the Anthropic API directly
with your own API key, and every figure comes from a lookup over the JSON
the dashboard already loaded. The lookups are listed under each answer and
open to the raw result. A number the assistant states that no lookup
returned is underlined so you can treat it with suspicion.

Setup: open the panel, choose Settings, and paste an API key from
console.anthropic.com. Give that key a monthly spend limit in the console.
The key is stored only in this browser's localStorage under
`bwp_chat_api_key`. It is never written to a file, a URL, the Zustand
store or the repo, and Forget key removes it. The transcript lives in
sessionStorage and clears when the tab closes.

A local helper route for subscription CLIs (Claude Code, Codex, Gemini
CLI) is stubbed in `lib/chat/providers/local-cli.ts` and not wired up yet.

## Deploy

GitHub Actions workflow at `.github/workflows/deploy.yml` builds and
publishes to GitHub Pages on every push to `main`. The build refuses to
publish until the `DASHBOARD_PIN_HASH` repository secret exists; there is
no built-in PIN in a published site.
