"use client";

import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PlatformDot } from "@/components/charts/platform-badge";
import { PLATFORMS } from "@/lib/derive";
import {
  pingScraper,
  startScrape,
  getScrapeStatus,
  SCRAPER_URL,
  type ScrapeJob,
  type ScrapeMode,
  type ScraperHealth,
} from "@/lib/scrape-client";
import { fmtDate, platformLabel, relativeTime } from "@/lib/format";
import type { Platform, ScrapeState } from "@/lib/types";
import { cn } from "@/lib/utils";

interface ScrapeDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  lastScrapedDate?: string;
  /** Per-platform scrape state, for the post count and last run on each toggle. */
  state?: ScrapeState | null;
}

// The two ways to run it. Minutes per platform match the ETA the scraper
// service uses (scrape/server.py): incremental stops at the first page it
// already has, a full sweep re-pages every post.
const MODES: {
  value: ScrapeMode;
  label: string;
  detail: string;
  minutes: number;
}[] = [
  {
    value: "incremental",
    label: "New posts",
    detail: "Only what is newer than the last run. Stops as soon as it meets posts it already has.",
    minutes: 1,
  },
  {
    value: "full",
    label: "Full sweep",
    detail: "Re-pages every post and refreshes views, likes and comments on all of them.",
    minutes: 3,
  },
];

const modeLabel = (mode?: ScrapeMode) =>
  MODES.find((m) => m.value === mode)?.label ?? "New posts";

export function ScrapeDialog({
  open,
  onOpenChange,
  lastScrapedDate,
  state,
}: ScrapeDialogProps) {
  // undefined = still probing, null = service offline, object = reachable.
  const [health, setHealth] = useState<ScraperHealth | null | undefined>(
    undefined,
  );
  const [job, setJob] = useState<ScrapeJob | null>(null);
  const [starting, setStarting] = useState(false);
  // What the next run does. Both persist across open/close within a page
  // load so a second run does not reset a deliberate narrower choice.
  const [mode, setMode] = useState<ScrapeMode>("incremental");
  const [selected, setSelected] = useState<Platform[]>(PLATFORMS);
  const pollRef = useRef<number | null>(null);

  // Probe health when the dialog opens. The "checking" state is the reset
  // done in handleClose, so this effect only ever sets state asynchronously.
  useEffect(() => {
    if (!open) return;
    let live = true;
    pingScraper().then((h) => {
      if (live) setHealth(h);
    });
    return () => {
      live = false;
    };
  }, [open]);

  // Poll job status while running
  useEffect(() => {
    if (!job || (job.status !== "queued" && job.status !== "running")) {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    pollRef.current = window.setInterval(async () => {
      const next = await getScrapeStatus(job.id);
      if (next) setJob(next);
    }, 2000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [job]);

  async function handleStart() {
    if (selected.length === 0) return;
    setStarting(true);
    const started = await startScrape({ platforms: selected, mode });
    setStarting(false);
    if (started) setJob(started);
  }

  function handleClose(v: boolean) {
    if (!v && job?.status === "complete") {
      // Reload so the dashboard picks up fresh JSON
      window.location.reload();
      return;
    }
    if (!v) setHealth(undefined); // next open starts from "checking"
    onOpenChange(v);
  }

  const eta = job ? new Date(Date.parse(job.startedAt) + job.etaSeconds * 1000) : null;
  const etaLabel = eta?.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">
            Refresh Dashboard Data
          </DialogTitle>
          <DialogDescription>
            Choose how much to fetch and which platforms. The local scraper
            service runs it against the shared Chrome.
          </DialogDescription>
        </DialogHeader>

        {/* Last scrape summary */}
        <div className="rounded-md border border-border bg-muted/40 p-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            Last scraped
          </div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="font-display text-lg font-medium text-ink">
              {lastScrapedDate ? fmtDate(lastScrapedDate) : "Never"}
            </span>
            <span className="font-mono text-xs text-ink-muted">
              {lastScrapedDate ? relativeTime(lastScrapedDate) : "—"}
            </span>
          </div>
        </div>

        {/* States */}
        {health === undefined && (
          <p className="text-sm text-ink-muted">Checking scraper service…</p>
        )}

        {health === null && <ServiceOffline />}

        {health && !job && (
          <ReadyToStart
            mode={mode}
            onMode={setMode}
            selected={selected}
            onSelected={setSelected}
            state={state}
          />
        )}

        {job && (job.status === "queued" || job.status === "running") && (
          <RunningJob job={job} etaLabel={etaLabel} />
        )}

        {job?.status === "complete" && (
          <CompleteJob job={job} etaLabel={etaLabel} />
        )}

        {job?.status === "error" && (
          <div className="rounded-md border border-negative/40 bg-negative-soft p-3 text-sm text-ink">
            <div className="font-mono text-[10px] uppercase tracking-wider text-negative">
              Scrape failed
            </div>
            <p className="mt-1">{job.error ?? "Unknown error"}</p>
          </div>
        )}

        <DialogFooter>
          {!job && health && (
            <>
              <Button variant="ghost" onClick={() => handleClose(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleStart}
                disabled={starting || selected.length === 0}
              >
                {starting
                  ? "Starting…"
                  : `Start ${modeLabel(mode).toLowerCase()} · ${selected.length}`}
              </Button>
            </>
          )}
          {job?.status === "complete" && (
            <Button onClick={() => window.location.reload()}>
              Reload to see fresh data
            </Button>
          )}
          {(job?.status === "queued" || job?.status === "running") && (
            <Button variant="ghost" onClick={() => handleClose(false)}>
              Close and keep running
            </Button>
          )}
          {(health === null || job?.status === "error") && (
            <Button variant="ghost" onClick={() => handleClose(false)}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ServiceOffline() {
  return (
    <div className="rounded-md border border-warn/40 bg-warn-soft p-3 text-sm text-ink-soft">
      <div className="font-mono text-[10px] uppercase tracking-wider text-warn">
        Scraper service not running
      </div>
      <p className="mt-2">
        Start it in a terminal so the dashboard can call it on{" "}
        <code className="font-mono text-xs">{SCRAPER_URL}</code>:
      </p>
      <pre className="mt-2 overflow-x-auto rounded bg-ink/90 px-3 py-2 font-mono text-[11px] text-white">
        python3 ~/projects/bwp-analytics-dashboard/scrape/server.py
      </pre>
    </div>
  );
}

function ReadyToStart({
  mode,
  onMode,
  selected,
  onSelected,
  state,
}: {
  mode: ScrapeMode;
  onMode: (m: ScrapeMode) => void;
  selected: Platform[];
  onSelected: Dispatch<SetStateAction<Platform[]>>;
  state?: ScrapeState | null;
}) {
  const perPlatform = MODES.find((m) => m.value === mode)?.minutes ?? 1;
  const minutes = perPlatform * selected.length;

  // Keep PLATFORMS order so the request and the progress list read the same.
  // Functional update: two toggles in one tick must not read a stale list.
  function toggle(p: Platform) {
    onSelected((prev) =>
      prev.includes(p)
        ? prev.filter((x) => x !== p)
        : PLATFORMS.filter((x) => x === p || prev.includes(x)),
    );
  }

  return (
    <div className="space-y-4 text-sm text-ink-soft">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
          What to fetch
        </div>
        <div role="radiogroup" aria-label="Scrape mode" className="mt-2 grid grid-cols-2 gap-2">
          {MODES.map((m) => {
            const on = mode === m.value;
            return (
              <button
                key={m.value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onMode(m.value)}
                className={cn(
                  "rounded-md border p-3 text-left transition",
                  on
                    ? "border-brand bg-brand-soft"
                    : "border-border bg-muted/40 hover:border-brand/50",
                )}
              >
                <div
                  className={cn(
                    "font-display text-base font-medium",
                    on ? "text-brand-deep" : "text-ink",
                  )}
                >
                  {m.label}
                </div>
                <p className="mt-1 text-xs leading-snug text-ink-soft">{m.detail}</p>
                <div className="mt-2 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
                  ~{m.minutes} min / platform
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="flex items-baseline justify-between">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            Platforms
          </div>
          <div className="flex gap-3 font-mono text-[10px] uppercase tracking-wider">
            <button
              type="button"
              className="text-brand hover:underline"
              onClick={() => onSelected(PLATFORMS)}
            >
              All
            </button>
            <button
              type="button"
              className="text-ink-muted hover:underline"
              onClick={() => onSelected([])}
            >
              None
            </button>
          </div>
        </div>
        <ul className="mt-2 space-y-1.5" aria-label="Platforms to scrape">
          {PLATFORMS.map((p) => {
            const on = selected.includes(p);
            const s = state?.[p];
            return (
              <li key={p}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => toggle(p)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition",
                    on
                      ? "border-brand/60 bg-brand-soft"
                      : "border-border bg-muted/30 opacity-70 hover:opacity-100",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] leading-none",
                      on
                        ? "border-brand bg-brand text-white"
                        : "border-border bg-background",
                    )}
                  >
                    {on ? "✓" : ""}
                  </span>
                  <PlatformDot platform={p} />
                  <span className="font-medium text-ink">{platformLabel[p]}</span>
                  <span className="ml-auto font-mono text-[11px] tabular text-ink-muted">
                    {s?.totalScraped != null
                      ? `${s.totalScraped.toLocaleString()} posts`
                      : "no data"}
                    {" · "}
                    {s?.lastScrapedDate ? relativeTime(s.lastScrapedDate) : "never"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="rounded border border-border bg-muted/40 px-3 py-2 text-xs">
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            Estimate
          </span>
          <span className="font-mono text-[11px] tabular text-ink">
            {selected.length === 0
              ? "pick at least one platform"
              : `about ${minutes} min for ${selected.length} platform${selected.length === 1 ? "" : "s"}`}
          </span>
        </div>
        <ul className="mt-1.5 space-y-0.5">
          <li>Needs the shared Chrome on :9222, signed in to each platform you picked.</li>
          <li>Insights, the Vault and follower history are rebuilt after the last platform finishes.</li>
        </ul>
      </div>
    </div>
  );
}

function RunningJob({
  job,
  etaLabel,
}: {
  job: ScrapeJob;
  etaLabel?: string;
}) {
  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
          <span>
            {modeLabel(job.mode)}
            {job.currentPlatform ? ` · ${job.currentPlatform}` : " …"}
          </span>
          <span className="tabular text-ink">{job.progress}%</span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-brand transition-all duration-500"
            style={{ width: `${job.progress}%` }}
          />
        </div>
      </div>
      <div className="rounded-md border border-brand/40 bg-brand-soft p-3 text-sm text-brand-deep">
        <div className="font-mono text-[10px] uppercase tracking-wider text-brand">
          Come back at {etaLabel ?? "—"}
        </div>
        <p className="mt-1 text-ink-soft">
          You can close this dialog and the scrape keeps running. Reload the
          dashboard once it&apos;s complete and the new numbers will appear.
        </p>
      </div>
    </div>
  );
}

function CompleteJob({
  job,
  etaLabel,
}: {
  job: ScrapeJob;
  etaLabel?: string;
}) {
  // The service reports "complete" whenever at least one platform succeeded,
  // so a partial run has to be read off the per-platform errors.
  const failed = Object.entries(job.errors ?? {}).filter(([k]) => k !== "analyze");
  const analyzeError = job.errors?.analyze;
  const ok = job.platforms.filter((p) => !(job.errors && p in job.errors));
  const partial = failed.length > 0 || !!analyzeError;
  const at = job.completedAt
    ? new Date(job.completedAt).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      })
    : etaLabel;
  const name = (p: string) =>
    (platformLabel as Record<string, string>)[p] ?? p;

  return (
    <div
      className={cn(
        "rounded-md border p-3 text-sm text-ink",
        partial
          ? "border-warn/40 bg-warn-soft"
          : "border-positive/40 bg-positive-soft",
      )}
    >
      <div
        className={cn(
          "font-mono text-[10px] uppercase tracking-wider",
          partial ? "text-warn" : "text-positive",
        )}
      >
        {partial ? "Finished with problems" : "✓ Scrape complete"}
      </div>
      <p className="mt-1">
        {modeLabel(job.mode)} finished at {at}.{" "}
        {ok.length > 0
          ? `${ok.map(name).join(", ")} updated.`
          : "Nothing was updated."}
      </p>
      {failed.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {failed.map(([p, msg]) => (
            <li key={p} className="text-xs">
              <span className="font-medium text-ink">{name(p)} failed:</span>{" "}
              <span className="text-ink-soft">{msg.split("\n")[0]}</span>
            </li>
          ))}
        </ul>
      )}
      {analyzeError && (
        <p className="mt-2 text-xs">
          <span className="font-medium text-ink">Rebuilding Insights failed:</span>{" "}
          <span className="text-ink-soft">{analyzeError.split("\n")[0]}</span>
        </p>
      )}
      {ok.length > 0 && (
        <p className="mt-2 text-xs text-ink-soft">
          Reload the dashboard to see the updated data.
        </p>
      )}
    </div>
  );
}
