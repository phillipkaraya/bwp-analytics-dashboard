// window_summary, platform_breakdown and monthly_trend (section 2.3, tools
// 2, 3 and 4). Windows use derive.windowTotals semantics, (start, end]
// rolling from the session clock; percent changes are precomputed with
// pctChange so the model never divides; views are summed over postHasViews
// rows only and viewPosts always sits beside views.

import type { Platform, Post } from "../../types";
import {
  PLATFORMS,
  avgEngagementRate,
  engagementMeasured,
  hasViews,
  pctChange,
  platformCadence,
  platformLastPosted,
  postHasViews,
  toNum,
  windowTotals,
} from "../../derive";
import { datePart, type ChatData } from "../data";
import type { ToolEnvelope } from "../types";
import { DAY, NOT_MEASURED, applyFilters, emptyEnvelope, envelope, isoDate, round2, windowOf, windowStart, windowEnd } from "./rows";
import type { MonthlyTrendInput, PlatformBreakdownInput, WindowSummaryInput } from "./validate";

// Shared helpers

/** Mean of views over posts that report them and have at least one (the
 *  analyze.py rule), or "not measured" when none do. */
export function lifetimeAvgViews(posts: readonly Post[]): number | typeof NOT_MEASURED {
  const viewed = posts.filter((p) => postHasViews(p) && toNum(p.views) > 0);
  if (viewed.length === 0) return NOT_MEASURED;
  return Math.trunc(viewed.reduce((s, p) => s + toNum(p.views), 0) / viewed.length);
}

export interface EngagementStats {
  avgEngagementRate: number | null;
  measuredPosts: number;
}

/** Engagement over measured posts only; null when none are measured. */
export function engagementStats(posts: readonly Post[]): EngagementStats {
  const measured = posts.filter(engagementMeasured);
  return {
    avgEngagementRate: measured.length ? round2(avgEngagementRate(measured)) : null,
    measuredPosts: measured.length,
  };
}

/** Posts dated in (end - days, end], the windowTotals rule. */
export function postsInWindow(posts: readonly Post[], days: number, offsetDays: number, now: number): Post[] {
  const end = now - offsetDays * DAY;
  const start = end - days * DAY;
  return posts.filter((p) => {
    const t = new Date(p.date).getTime();
    return Number.isFinite(t) && t > start && t <= end;
  });
}

// window_summary

export interface WindowStats {
  posts: number;
  viewPosts: number;
  views: number;
  likes: number;
  comments: number;
  avgEngagementRate: number | null;
  measuredPosts: number;
}
export interface WindowChange {
  posts: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  avgEngagementRate: number | null;
}
export interface PlatformMini {
  platform: Platform;
  posts: number;
  viewPosts: number;
  views: number;
  likes: number;
  comments: number;
}
export interface WindowRow {
  days: number;
  start: string;
  end: string;
  current: WindowStats;
  previous: WindowStats & { start: string; end: string };
  change: WindowChange;
  byPlatform: PlatformMini[];
}
export interface WindowSummaryResult {
  windows: WindowRow[];
}

function statsFor(posts: readonly Post[], days: number, offsetDays: number, now: number): WindowStats {
  const totals = windowTotals([...posts], days, offsetDays, now);
  const eng = engagementStats(postsInWindow(posts, days, offsetDays, now));
  return { ...totals, ...eng };
}

function change(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  const pct = pctChange(current, previous);
  return pct === null ? null : round2(pct);
}

export function runWindowSummary(data: ChatData, input: WindowSummaryInput): ToolEnvelope<WindowSummaryResult> {
  const now = data.now();
  const longest = Math.max(...input.windows);
  const window = windowOf(longest, now, true);
  const filters: Record<string, unknown> = { ...input };
  if (data.posts.length === 0) return emptyEnvelope(data, window, filters, { windows: [] });

  const filtered = applyFilters(data.posts, { platforms: input.platforms, types: input.types }, now);
  const platforms = input.platforms ?? PLATFORMS;
  const notes: string[] = [];
  const windows: WindowRow[] = input.windows.map((days) => {
    const current = statsFor(filtered, days, 0, now);
    const previous = statsFor(filtered, days, days, now);
    const noBaseline = previous.posts === 0;
    const changes: WindowChange = noBaseline
      ? { posts: null, views: null, likes: null, comments: null, avgEngagementRate: null }
      : {
          posts: change(current.posts, previous.posts),
          views: change(current.views, previous.views),
          likes: change(current.likes, previous.likes),
          comments: change(current.comments, previous.comments),
          avgEngagementRate: change(current.avgEngagementRate, previous.avgEngagementRate),
        };
    if (noBaseline) notes.push(`${days} days: no posts in the prior window, so no percent change`);
    if (current.posts < 5) notes.push(`${days} days: only ${current.posts} ${current.posts === 1 ? "post" : "posts"}; a longer window gives a fuller picture`);
    const inWindow = postsInWindow(filtered, days, 0, now);
    const byPlatform: PlatformMini[] = platforms.map((platform) => {
      const rows = inWindow.filter((p) => p.platform === platform);
      const viewed = rows.filter(postHasViews);
      return {
        platform,
        posts: rows.length,
        viewPosts: viewed.length,
        views: viewed.reduce((s, p) => s + toNum(p.views), 0),
        likes: rows.reduce((s, p) => s + toNum(p.likes), 0),
        comments: rows.reduce((s, p) => s + toNum(p.comments), 0),
      };
    });
    return {
      days,
      start: windowStart(now - days * DAY, true),
      end: windowEnd(now),
      current,
      previous: { ...previous, start: windowStart(now - 2 * days * DAY, true), end: windowEnd(now - days * DAY) },
      change: changes,
      byPlatform,
    };
  });
  notes.push("views are summed over viewPosts only; Threads, LinkedIn, carousels and photos report no views");
  return envelope(data, window, filters, notes, { windows });
}

// platform_breakdown

export interface PlatformRow {
  platform: Platform;
  posts: number;
  viewPosts: number;
  views: number;
  likes: number;
  comments: number;
  avgEngagementRate: number | null;
  measuredPosts: number;
  followers: number;
  lastPosted: string | null;
  daysSinceLastPost: number | null;
  postsPerWeekLifetime: number;
  lifetimeAvgViews: number | typeof NOT_MEASURED;
  lifetimeAvgLikes: number;
}
export interface PlatformBreakdownResult {
  rows: PlatformRow[];
}

export function daysSince(date: string | null, now: number): number | null {
  if (!date) return null;
  const t = new Date(date).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((now - t) / DAY);
}

export function runPlatformBreakdown(data: ChatData, input: PlatformBreakdownInput): ToolEnvelope<PlatformBreakdownResult> {
  const now = data.now();
  const window = windowOf(input.days, now);
  const filters: Record<string, unknown> = { ...input };
  if (data.posts.length === 0) return emptyEnvelope(data, window, filters, { rows: [] });

  const inWindow = input.days === null ? data.posts : applyFilters(data.posts, { days: input.days }, now);
  const rows: PlatformRow[] = PLATFORMS.map((platform) => {
    const lifetime = data.posts.filter((p) => p.platform === platform);
    const windowed = inWindow.filter((p) => p.platform === platform);
    const viewed = windowed.filter(postHasViews);
    const eng = engagementStats(windowed);
    const last = platformLastPosted(lifetime).date;
    return {
      platform,
      posts: windowed.length,
      viewPosts: viewed.length,
      views: viewed.reduce((s, p) => s + toNum(p.views), 0),
      likes: windowed.reduce((s, p) => s + toNum(p.likes), 0),
      comments: windowed.reduce((s, p) => s + toNum(p.comments), 0),
      avgEngagementRate: eng.avgEngagementRate,
      measuredPosts: eng.measuredPosts,
      followers: Math.round(toNum(data.scrape.followers?.[platform])),
      lastPosted: last,
      daysSinceLastPost: daysSince(last, now),
      postsPerWeekLifetime: platformCadence(lifetime).perWeek,
      lifetimeAvgViews: hasViews(platform) ? lifetimeAvgViews(lifetime) : NOT_MEASURED,
      lifetimeAvgLikes: lifetime.length ? Math.round(lifetime.reduce((s, p) => s + toNum(p.likes), 0) / lifetime.length) : 0,
    };
  });

  const notes = [
    "Cadence is a lifetime average and understates a platform that went quiet",
    "Follower counts are rounded as the platforms display them",
    "Threads and LinkedIn report no views; compare them by likes and comments",
    "Engagement rate is interactions per view on reels, videos and shorts and interactions per follower elsewhere, so compare it within a platform",
  ];
  return envelope(data, window, filters, notes, { rows });
}

// monthly_trend

export interface MonthRow {
  month: string;
  posts: number;
  viewPosts: number;
  views: number;
  likes: number;
  comments: number;
  avgEngagementRate: number | null;
  measuredPosts: number;
}
export interface MonthlyTrendResult {
  from: string;
  to: string;
  rows: MonthRow[];
}

/** The last `count` calendar months (YYYY-MM, UTC) ending in the month of
 *  `now`, oldest first. */
export function calendarMonths(now: number, count: number): string[] {
  const today = isoDate(now);
  let year = Number(today.slice(0, 4));
  let month = Number(today.slice(5, 7));
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.unshift(`${year}-${String(month).padStart(2, "0")}`);
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return out;
}

export function runMonthlyTrend(data: ChatData, input: MonthlyTrendInput): ToolEnvelope<MonthlyTrendResult> {
  const now = data.now();
  const filters: Record<string, unknown> = { ...input };
  const months = calendarMonths(now, input.months);
  const from = months[0];
  const to = months[months.length - 1];
  if (data.posts.length === 0) return emptyEnvelope(data, "all time", filters, { from, to, rows: [] });

  const filtered = applyFilters(data.posts, { platforms: input.platforms, types: input.types }, now);
  const buckets = new Map<string, Post[]>();
  for (const p of filtered) {
    const key = datePart(p.date)?.slice(0, 7);
    if (!key) continue;
    const list = buckets.get(key);
    if (list) list.push(p);
    else buckets.set(key, [p]);
  }
  const rows: MonthRow[] = months.map((month) => {
    const list = buckets.get(month) ?? [];
    const viewed = list.filter(postHasViews);
    const eng = engagementStats(list);
    return {
      month,
      posts: list.length,
      viewPosts: viewed.length,
      views: viewed.reduce((s, p) => s + toNum(p.views), 0),
      likes: list.reduce((s, p) => s + toNum(p.likes), 0),
      comments: list.reduce((s, p) => s + toNum(p.comments), 0),
      avgEngagementRate: eng.avgEngagementRate,
      measuredPosts: eng.measuredPosts,
    };
  });
  const notes = [
    "Views are lifetime views earned by that month's posts, not views received during the month",
    "Posts are grouped by their stored calendar month; the current month is partial",
  ];
  const oldest = datePart(filtered.map((p) => p.date).sort()[0]);
  if (oldest && oldest.slice(0, 7) > from) notes.push(`The selection has no posts before ${oldest}`);
  return envelope(data, "all time", filters, notes, { from, to, rows });
}
