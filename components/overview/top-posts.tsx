"use client";

import { useState } from "react";
import { Section } from "@/components/charts/section";
import { PlatformBadge, PlatformDot } from "@/components/charts/platform-badge";
import { fmt, fmtPct, fmtDate, platformLabel, platformShort } from "@/lib/format";
import {
  PLATFORMS,
  TOP_POSTS_WINDOWS,
  postHasViews,
  topPosts,
  toNum,
  windowLabel,
  type TopPostsDays,
} from "@/lib/derive";
import { Numbered } from "@/components/charts/numbered";
import type { Platform, Post } from "@/lib/types";
import { cn } from "@/lib/utils";

/** 30 / 60 / 90 switch, the hero's pill in the card's light palette. */
function WindowSwitch({ days, onDays }: { days: TopPostsDays; onDays: (d: TopPostsDays) => void }) {
  return (
    <div
      role="radiogroup"
      aria-label="Top posts window"
      className="inline-flex rounded-full bg-muted p-0.5 ring-1 ring-border"
    >
      {TOP_POSTS_WINDOWS.map((d) => {
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
              on ? "bg-ink text-white" : "text-ink-muted hover:text-ink",
            )}
          >
            {d}d
          </button>
        );
      })}
    </div>
  );
}

/** One checkbox chip per platform. Unchecked chips go grey; the dot keeps
 *  the platform colour so the row still reads as the five platforms. */
function PlatformChecks({
  checked,
  onToggle,
}: {
  checked: ReadonlySet<Platform>;
  onToggle: (p: Platform) => void;
}) {
  return (
    <div role="group" aria-label="Platforms" className="flex flex-wrap gap-1.5">
      {PLATFORMS.map((p) => {
        const on = checked.has(p);
        return (
          <button
            key={p}
            type="button"
            role="checkbox"
            aria-checked={on}
            aria-label={platformLabel[p]}
            title={platformLabel[p]}
            onClick={() => onToggle(p)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] transition",
              on
                ? "border-border bg-card text-ink"
                : "border-dashed border-border bg-transparent text-ink-muted line-through decoration-ink-muted/60",
            )}
          >
            <PlatformDot platform={p} className={on ? "" : "opacity-40"} />
            {platformShort[p]}
          </button>
        );
      })}
    </div>
  );
}

const ALL_PLATFORMS: ReadonlySet<Platform> = new Set(PLATFORMS);

/** The table's window starts on the Overview's window when that is one of
 *  its own (30, 60, 90) and on 30 days otherwise; after that it is its own
 *  control (Phil, 2026-09-27: "a 30, 60, 90 toggle as well as platforms to
 *  check or uncheck"). The component mounts after the data has loaded, so
 *  the seed is the Overview's final choice. */
function seedDays(days: number): TopPostsDays {
  return (TOP_POSTS_WINDOWS as readonly number[]).includes(days) ? (days as TopPostsDays) : 30;
}

export function TopPosts({ posts, days: overviewDays = 30 }: { posts: Post[]; days?: number }) {
  const [days, setDays] = useState<TopPostsDays>(() => seedDays(overviewDays));
  const [checked, setChecked] = useState<ReadonlySet<Platform>>(ALL_PLATFORMS);
  const top = topPosts(posts, days, 10, checked);

  function toggle(p: Platform) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  const hint =
    checked.size === PLATFORMS.length
      ? `${windowLabel(days)}, every platform, ranked by views`
      : checked.size === 0
        ? `${windowLabel(days)}, no platform checked`
        : `${windowLabel(days)}, ${PLATFORMS.filter((p) => checked.has(p))
            .map((p) => platformLabel[p])
            .join(", ")}, ranked by views`;

  return (
    <Numbered n={5}>
    <Section
      kicker="Ranked by views"
      title="Top Performing Posts"
      hint={hint}
      action={
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
          <WindowSwitch days={days} onDays={setDays} />
          <PlatformChecks checked={checked} onToggle={toggle} />
        </div>
      }
      bodyClassName="-mx-5"
    >
      <div className="overflow-x-auto">
        <table className="data-table tabular w-full text-sm">
          <thead>
            <tr className="border-y border-border bg-muted/40 text-left">
              <th className="w-12 px-5 py-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">
                #
              </th>
              <th className="px-2 py-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">
                Platform
              </th>
              <th className="px-2 py-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">
                Date
              </th>
              <th className="px-2 py-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">
                Title
              </th>
              <th className="px-2 py-2.5 text-right font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">
                Views
              </th>
              <th className="px-2 py-2.5 text-right font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">
                Likes
              </th>
              <th className="px-2 py-2.5 text-right font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">
                Comments
              </th>
              <th className="px-5 py-2.5 text-right font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">
                Engage
              </th>
            </tr>
          </thead>
          <tbody>
            {top.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-5 py-8 text-center text-sm text-ink-muted"
                >
                  {checked.size === 0
                    ? "Check a platform to rank its posts."
                    : "No posts in this window."}
                </td>
              </tr>
            ) : (
              top.map((p, i) => (
                <tr
                  key={p.id}
                  className="border-b border-border transition even:bg-muted/30 last:border-b-0 hover:bg-muted/40"
                >
                  <td className="tabular px-5 py-3 font-display text-lg font-semibold leading-none text-brand/70">
                    {String(i + 1).padStart(2, "0")}
                  </td>
                  <td className="px-2 py-3">
                    <PlatformBadge platform={p.platform} />
                  </td>
                  <td className="whitespace-nowrap px-2 py-3 text-ink-muted">
                    {fmtDate(p.date)}
                  </td>
                  <td className="px-2 py-3 max-w-[460px] truncate text-ink">
                    {p.url ? (
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="hover:text-brand hover:underline underline-offset-2"
                      >
                        {p.title || p.caption?.slice(0, 80) || "(no title)"}
                      </a>
                    ) : (
                      p.title || p.caption?.slice(0, 80) || "(no title)"
                    )}
                  </td>
                  <td className="px-2 py-3 text-right text-ink">
                    {postHasViews(p) ? (
                      fmt(p.views)
                    ) : (
                      <span className="text-ink-soft" title="No view count for this post; likes are its reach">
                        {fmt(p.likes)}
                        <span className="ml-1 font-mono text-[10px] text-ink-muted">likes</span>
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-3 text-right text-ink-soft">
                    {fmt(p.likes)}
                  </td>
                  <td className="px-2 py-3 text-right text-ink-soft">
                    {fmt(p.comments)}
                  </td>
                  <td className="px-5 py-3 text-right text-brand">
                    {fmtPct(toNum(p.engagementRate))}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Section>
    </Numbered>
  );
}
