import { fmt, fmtDate, numeralShift, platformLabel, relativeTime } from "@/lib/format";
import { PlatformDot } from "@/components/charts/platform-badge";
import {
  PLATFORMS,
  byPlatform,
  followerDeltas,
  platformCadence,
  platformLastPosted,
} from "@/lib/derive";
import type { FollowerSnapshot, Platform, Post, ScrapeState } from "@/lib/types";
import { cn } from "@/lib/utils";

/** One card, one cell per platform: followers, delta, cadence and last post. */
// Tailwind only ships classes it can read as literals, so the column count
// is looked up rather than interpolated.
const LG_COLS: Record<number, string> = {
  1: "lg:grid-cols-1",
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
  5: "lg:grid-cols-5",
  6: "lg:grid-cols-6",
  7: "lg:grid-cols-7",
};

export function PlatformStatusRow({
  posts,
  scrape,
  history,
  platforms = PLATFORMS,
}: {
  posts: Post[];
  scrape: ScrapeState;
  history: FollowerSnapshot[];
  /** The platforms of the account in view; every platform by default. */
  platforms?: Platform[];
}) {
  const grouped = byPlatform(posts, (p) => p.platform);
  const deltas = followerDeltas(history);

  return (
    <div className={cn("card rise grid grid-cols-1 sm:grid-cols-2", LG_COLS[platforms.length] ?? "lg:grid-cols-5")}>
      {platforms.map((p, i) => {
        const last = platformLastPosted(grouped[p]);
        const cad = platformCadence(grouped[p]);
        const followers = scrape.followers?.[p] ?? 0;
        const delta = deltas.byPlatform[p];
        const quiet = (last.daysAgo ?? 0) > 7;
        return (
          <div
            key={p}
            className={cn(
              "relative p-5",
              // hairline dividers between cells, not around them:
              // stacked on phones, 2x2 from sm, one row from lg
              i > 0 && "border-t border-border/70",
              i === 1 && "sm:border-t-0",
              i % 2 === 1 && "sm:border-l sm:border-border/70",
              "lg:border-t-0",
              i > 0 && "lg:border-l lg:border-border/70",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              {/* Name first, dot after, so the label's left edge is the cell's
                  left edge and the number below lines up under it. */}
              <div className="flex items-center gap-2">
                <h4 className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
                  {platformLabel[p]}
                </h4>
                <PlatformDot platform={p} />
              </div>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em]",
                  // A page that has published nothing is neither active nor quiet.
                  last.date === null
                    ? "bg-muted text-ink-muted"
                    : quiet
                      ? "bg-warn-soft text-warn"
                      : "bg-positive-soft text-positive",
                )}
              >
                {last.date === null ? "no posts" : quiet ? "quiet" : "active"}
              </span>
            </div>
            <div className="mt-3 flex flex-wrap items-baseline gap-x-2">
              <p
                className="font-display tabular text-3xl font-semibold leading-none tracking-[-0.02em] text-ink"
                style={{ marginLeft: numeralShift(fmt(followers)) }}
              >
                {fmt(followers)}
              </p>
              <span className="text-xs text-ink-muted">followers</span>
              {delta !== null && deltas.since && (
                <span
                  className={cn(
                    "tabular ml-auto font-mono text-[11px]",
                    delta > 0 ? "text-positive" : delta < 0 ? "text-negative" : "text-ink-muted",
                  )}
                  title={`Since ${fmtDate(deltas.since)}`}
                >
                  {delta > 0 ? "+" : delta < 0 ? "−" : ""}
                  {fmt(Math.abs(delta))}
                </span>
              )}
            </div>
            <dl className="mt-4 grid grid-cols-3 gap-2 text-xs">
              <div>
                <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Last</dt>
                <dd className="mt-0.5 text-ink-soft">{last.date ? relativeTime(last.date) : "none"}</dd>
              </div>
              <div>
                <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Per wk</dt>
                <dd className="tabular mt-0.5 text-ink-soft">{cad.perWeek.toFixed(1)}</dd>
              </div>
              <div>
                <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Posts</dt>
                <dd className="tabular mt-0.5 text-ink-soft">{fmt(grouped[p].length)}</dd>
              </div>
            </dl>
          </div>
        );
      })}
    </div>
  );
}

export type { Platform };
