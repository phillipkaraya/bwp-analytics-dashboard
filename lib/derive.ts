// Computed/derived data from raw posts + comments. Pure functions, no side effects.

import type { Post, Comment, Platform, FollowerSnapshot } from "./types";

const DAY = 86_400_000;

export const PLATFORMS: Platform[] = [
  "instagram",
  "tiktok",
  "youtube",
  "threads",
  "linkedin",
];

/**
 * Threads publishes likes, replies and reposts but no view count, so every
 * Threads post arrives with views 0 and engagementRate 0. Anything that shows,
 * averages or ranks by views must leave Threads out (or show likes instead)
 * rather than present that zero as a measurement (Phil, 2026-09-04).
 */
export const VIEWLESS_PLATFORMS: ReadonlySet<Platform> = new Set<Platform>(["threads", "linkedin"]);

export function hasViews(platform: Platform): boolean {
  return !VIEWLESS_PLATFORMS.has(platform);
}

/**
 * Views are a video metric. Instagram reports play counts for reels and
 * videos only; carousels and photos arrive with views 0 no matter how well
 * they did (all 109 of them in the data as of 2026-09-16). A zero there is
 * not a measurement, so those posts take likes as reach, the same way
 * Threads and LinkedIn do (Phil, 2026-09-16).
 */
export const VIEWLESS_TYPES: ReadonlySet<string> = new Set(["carousel", "post", "image", "article"]);

/** Whether this particular post carries a real view count. */
export function postHasViews(p: Post): boolean {
  return hasViews(p.platform) && !VIEWLESS_TYPES.has((p.type ?? "").toLowerCase());
}

/** The reach number a post is judged by: views where the post reports
 *  them, likes otherwise. Use for ranking, never for summing across posts. */
export function reach(p: Post): number {
  return postHasViews(p) ? toNum(p.views) : toNum(p.likes);
}

export function toNum(v: string | number | undefined | null): number {
  if (v === undefined || v === null) return 0;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : 0;
}

export function totals(posts: Post[]) {
  return posts.reduce(
    (acc, p) => {
      acc.posts += 1;
      acc.views += toNum(p.views);
      acc.likes += toNum(p.likes);
      acc.comments += toNum(p.comments);
      acc.shares += toNum(p.shares);
      acc.saves += toNum(p.saves);
      return acc;
    },
    { posts: 0, views: 0, likes: 0, comments: 0, shares: 0, saves: 0 },
  );
}

/**
 * The TikTok and YouTube readers collect views only (scrape/platforms/tiktok.py
 * and youtube.py write likes, comments and shares as 0), so a post from them
 * with all three at 0 carries no engagement measurement, and its "0.00" rate
 * must not be averaged. A post from them with any of the three filled was
 * measured (older data backfilled from v1) and counts. Remove a platform here
 * once its reader collects likes.
 */
export const VIEWS_ONLY_READERS: ReadonlySet<Platform> = new Set<Platform>(["tiktok", "youtube"]);

/** Whether a post's engagementRate is a measurement rather than a reader's
 *  zero. The studio pass (scrape/platforms/studio.py) stamps the posts it
 *  counted, so their zeros are real; older posts count when any figure is
 *  filled. */
export function engagementMeasured(p: Post): boolean {
  if (!VIEWS_ONLY_READERS.has(p.platform)) return true;
  if (p.engagementMeasured) return true;
  return toNum(p.likes) > 0 || toNum(p.comments) > 0 || toNum(p.shares) > 0;
}

export function avgEngagementRate(posts: Post[]): number {
  const counted = posts.filter(engagementMeasured);
  if (!counted.length) return 0;
  const sum = counted.reduce((s, p) => s + toNum(p.engagementRate), 0);
  return sum / counted.length;
}

export function byPlatform<T>(
  items: T[],
  pick: (i: T) => Platform,
): Record<Platform, T[]> {
  const out: Record<Platform, T[]> = {
    instagram: [],
    tiktok: [],
    youtube: [],
    threads: [],
    linkedin: [],
  };
  for (const it of items) out[pick(it)].push(it);
  return out;
}

/** The windows the Top Performing Posts table offers (Phil, 2026-09-27). */
export const TOP_POSTS_WINDOWS = [30, 60, 90] as const;
export type TopPostsDays = (typeof TOP_POSTS_WINDOWS)[number];

/** Posts in the last `days`, ranked by reach. `platforms` narrows to the
 *  checked platforms; leave it out for every platform. */
export function topPosts(
  posts: Post[],
  days = 30,
  limit = 10,
  platforms?: ReadonlySet<Platform>,
): Post[] {
  const cutoff = Date.now() - days * 86_400_000;
  return [...posts]
    .filter((p) => {
      if (platforms && !platforms.has(p.platform)) return false;
      const t = new Date(p.date).getTime();
      return Number.isFinite(t) && t >= cutoff;
    })
    .sort((a, b) => reach(b) - reach(a))
    .slice(0, limit);
}

export function monthlyActivity(
  posts: Post[],
  months = 18,
): Array<{ month: string; posts: number; views: number }> {
  const buckets = new Map<string, { posts: number; views: number }>();
  for (const p of posts) {
    const d = new Date(p.date);
    if (Number.isNaN(d.getTime())) continue;
    const key = p.date.slice(0, 7);
    const b = buckets.get(key) ?? { posts: 0, views: 0 };
    b.posts += 1;
    b.views += toNum(p.views);
    buckets.set(key, b);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-months)
    .map(([month, b]) => ({ month, ...b }));
}

// --- Rolling windows (Overview hero) ---------------------------------------

export interface WindowTotals {
  posts: number;
  /** Posts in the window that carry a view count (postHasViews). `views`
   *  is summed over these only; the rest report no views, not zero views. */
  viewPosts: number;
  views: number;
  likes: number;
  comments: number;
}

/** Totals for posts dated in (end - days, end], where end = now - offsetDays.
 *  offsetDays = days gives the immediately preceding window of equal length. */
export function windowTotals(
  posts: Post[],
  days: number,
  offsetDays = 0,
  now = Date.now(),
): WindowTotals {
  const end = now - offsetDays * DAY;
  const start = end - days * DAY;
  const out: WindowTotals = { posts: 0, viewPosts: 0, views: 0, likes: 0, comments: 0 };
  for (const p of posts) {
    const t = new Date(p.date).getTime();
    if (!Number.isFinite(t) || t <= start || t > end) continue;
    out.posts += 1;
    if (postHasViews(p)) {
      out.viewPosts += 1;
      out.views += toNum(p.views);
    }
    out.likes += toNum(p.likes);
    out.comments += toNum(p.comments);
  }
  return out;
}

/** The windows the Overview lets Phil switch between (2026-09-16). */
export const WINDOW_OPTIONS = [7, 30, 60, 90] as const;
export type WindowDays = (typeof WINDOW_OPTIONS)[number];

/** Windows the default pick considers. 7 days is never auto-picked: it is
 *  an opt-in close-up, not a summary. */
export const WINDOW_CANDIDATES = [30, 60, 90] as const;

/** Shortest candidate window that contains at least one post, so the hero
 *  never opens on a row of zeros after a quiet month. Falls back to 90. */
export function pickWindow(posts: Post[], now = Date.now()): WindowDays {
  for (const days of WINDOW_CANDIDATES) {
    if (windowTotals(posts, days, 0, now).posts > 0) return days;
  }
  return 90;
}

export function windowLabel(days: number): string {
  if (days === 365) return "Last 12 months";
  return `Last ${days} days`;
}

/** Percent change, or null when there is no baseline to compare against. */
export function pctChange(current: number, previous: number): number | null {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}

export interface FollowerDeltas {
  /** Date of the snapshot the deltas are measured from, or null if < 2 points. */
  since: string | null;
  byPlatform: Record<Platform, number | null>;
  total: number | null;
}

/** Change per platform between the two most recent follower snapshots. */
export function followerDeltas(history: FollowerSnapshot[]): FollowerDeltas {
  const empty: FollowerDeltas = {
    since: null,
    byPlatform: { instagram: null, tiktok: null, youtube: null, threads: null, linkedin: null },
    total: null,
  };
  const sorted = [...history]
    .filter((h) => h && h.date)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length < 2) return empty;
  const last = sorted[sorted.length - 1];
  const prev = sorted[sorted.length - 2];
  const byPlatform = { ...empty.byPlatform };
  let total = 0;
  for (const p of PLATFORMS) {
    // A platform missing from the earlier snapshot has no delta yet.
    if (prev[p] === undefined || last[p] === undefined) {
      byPlatform[p] = null;
      continue;
    }
    const d = toNum(last[p]) - toNum(prev[p]);
    byPlatform[p] = d;
    total += d;
  }
  return { since: prev.date, byPlatform, total };
}

export function platformLastPosted(posts: Post[]): {
  date: string | null;
  daysAgo: number | null;
} {
  if (!posts.length) return { date: null, daysAgo: null };
  const dates = posts
    .map((p) => new Date(p.date).getTime())
    .filter((t) => Number.isFinite(t));
  if (!dates.length) return { date: null, daysAgo: null };
  const last = Math.max(...dates);
  const daysAgo = Math.floor((Date.now() - last) / 86_400_000);
  return { date: new Date(last).toISOString().slice(0, 10), daysAgo };
}

export function platformCadence(posts: Post[]): {
  perWeek: number;
  perMonth: number;
} {
  if (!posts.length) return { perWeek: 0, perMonth: 0 };
  const dates = posts
    .map((p) => new Date(p.date).getTime())
    .filter((t) => Number.isFinite(t));
  if (dates.length < 2) return { perWeek: 0, perMonth: 0 };
  const range = (Math.max(...dates) - Math.min(...dates)) / 86_400_000;
  if (range <= 0) return { perWeek: 0, perMonth: 0 };
  const perDay = dates.length / range;
  return {
    perWeek: Number((perDay * 7).toFixed(1)),
    perMonth: Number((perDay * 30).toFixed(1)),
  };
}

/** Labels come from scrape/sentiment.py and live in comments.json. The UI
 *  never re-classifies; a missing label counts as neutral. `question` is the
 *  number of comments flagged as questions, independent of sentiment. */
export function sentimentBreakdown(comments: Comment[]) {
  const out = { positive: 0, neutral: 0, negative: 0, question: 0 };
  for (const c of comments) {
    out[c.sentiment ?? "neutral"] += 1;
    if (c.isQuestion) out.question += 1;
  }
  return out;
}
