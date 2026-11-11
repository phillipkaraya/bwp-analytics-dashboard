"use client";

import { fmt, fmtDate, fmtShort, numeralShift, platformLabel, relativeTime } from "@/lib/format";
import {
  PLATFORMS,
  WINDOW_OPTIONS,
  followerDeltas,
  pctChange,
  platformLastPosted,
  toNum,
  windowLabel,
  windowTotals,
  type WindowDays,
} from "@/lib/derive";
import type { AccountScope, FollowerSnapshot, Platform, Post, ScrapeState } from "@/lib/types";
import { accountLabel } from "@/lib/derive";
import { AccountSwitch } from "@/components/layout/account-switch";
import { PlatformDot } from "@/components/charts/platform-badge";
import { HeroPanel, HeroRow, PageHero, SignedCount } from "@/components/layout/page-hero";
import { cn } from "@/lib/utils";

interface HeroProps {
  posts: Post[];
  scrape: ScrapeState;
  history: FollowerSnapshot[];
  /** Rolling window in days: Phil's choice, or pickWindow() until he makes one. */
  days: WindowDays;
  onDays: (d: WindowDays) => void;
  /** The account in view and the platforms it covers. */
  scope: AccountScope;
  platforms: Platform[];
}

/** 7 / 30 / 60 / 90 day switch on the eyebrow row (Phil, 2026-09-16). */
function WindowSelect({ days, onDays }: { days: WindowDays; onDays: (d: WindowDays) => void }) {
  return (
    <div
      role="radiogroup"
      aria-label="Summary window"
      className="inline-flex rounded-full bg-white/10 p-0.5 ring-1 ring-white/15"
    >
      {WINDOW_OPTIONS.map((d) => {
        const on = d === days;
        return (
          <button
            key={d}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onDays(d)}
            className={cn(
              "tabular rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] transition",
              on ? "bg-white text-ink" : "text-white/70 hover:text-white",
            )}
          >
            {d}d
          </button>
        );
      })}
    </div>
  );
}

/** The Overview band: the chosen window at display size, followers on the right. */
export function Hero({ posts, scrape, history, days, onDays, scope, platforms }: HeroProps) {
  const cur = windowTotals(posts, days);
  const prev = windowTotals(posts, days, days);
  const deltas = followerDeltas(history);
  const last = platformLastPosted(posts);
  const totalFollowers = platforms.reduce(
    (sum, p) => sum + (scrape.followers?.[p] ?? 0),
    0,
  );

  // Views are summed over posts that report them. When the window also holds
  // carousels or photos, say so instead of letting their zeros read as views;
  // when it holds nothing but those, a zero video-view count is the truth.
  const viewsStat =
    cur.viewPosts === cur.posts
      ? { label: "Views", value: fmtShort(cur.views), pct: pctChange(cur.views, prev.views) }
      : cur.viewPosts > 0
        ? {
            label: "Video views",
            value: fmtShort(cur.views),
            hint: `${fmt(cur.viewPosts)} of ${fmt(cur.posts)} posts are video. Carousels report no views.`,
          }
        : {
            label: "Video views",
            value: "0",
            hint: "No video posts. Carousels and photos report no views.",
          };

  return (
    <PageHero
      eyebrow={`${windowLabel(days)} · ${accountLabel[scope]}`}
      controls={
        <div className="flex flex-wrap items-center gap-2">
          <AccountSwitch />
          <WindowSelect days={days} onDays={onDays} />
        </div>
      }
      stats={[
        viewsStat,
        { label: "Posts published", value: fmtShort(cur.posts), pct: pctChange(cur.posts, prev.posts) },
        { label: "Likes", value: fmtShort(cur.likes), pct: pctChange(cur.likes, prev.likes) },
        { label: "Comments", value: fmtShort(cur.comments), pct: pctChange(cur.comments, prev.comments) },
      ]}
      footer={
        <p>
          {last.date ? (
            <>
              Last post {fmtDate(last.date)} ({relativeTime(last.date)}).
            </>
          ) : (
            "No dated posts yet."
          )}{" "}
          {cur.posts === 0 ? (
            <>Nothing went out in the last {days} days. Widen the window above.</>
          ) : (
            <>Deltas compare against the {days} days before.</>
          )}
        </p>
      }
      aside={
        <HeroPanel label="Followers">
          <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span
              className="tabular font-display text-4xl font-semibold leading-none tracking-[-0.02em]"
              style={{ marginLeft: numeralShift(fmt(totalFollowers)) }}
            >
              {fmt(totalFollowers)}
            </span>
            {deltas.total !== null && deltas.since && (
              <span className="text-xs text-white/60">
                <SignedCount n={deltas.total} /> since {fmtDate(deltas.since)}
              </span>
            )}
          </div>
          <ul className="mt-5 space-y-2.5">
            {platforms.map((p) => (
              <HeroRow
                key={p}
                label={
                  <>
                    <PlatformDot platform={p} className="shrink-0 ring-2 ring-white/20" />
                    <span>{platformLabel[p]}</span>
                  </>
                }
              >
                <span className="tabular font-medium">{fmt(scrape.followers?.[p] ?? 0)}</span>
                <span className="tabular w-12 text-right font-mono text-[11px] text-white/55">
                  {deltas.byPlatform[p] === null ? "" : <SignedCount n={deltas.byPlatform[p] ?? 0} />}
                </span>
              </HeroRow>
            ))}
          </ul>
          <Sparkline history={history} />
        </HeroPanel>
      }
    />
  );
}

/** Only drawn once there are three or more snapshots. Two points is a line,
 *  not a trend, and we would rather show nothing than fake a curve. */
function Sparkline({ history }: { history: FollowerSnapshot[] }) {
  const pts = [...history]
    .filter((h) => h && h.date)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((h) => PLATFORMS.reduce((sum, p) => sum + toNum(h[p]), 0));
  if (pts.length < 3) return null;
  const w = 280;
  const h = 48;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const d = pts
    .map((v, i) => {
      const x = (i / (pts.length - 1)) * w;
      const y = h - ((v - min) / span) * (h - 4) - 2;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="mt-5 h-12 w-full text-white/70"
      role="img"
      aria-label={`Total followers across ${pts.length} snapshots`}
    >
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}
