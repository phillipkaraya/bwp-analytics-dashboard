// Shared row and envelope builders for every tool (section 2.1).
//
// toRow() is the only way a post reaches the model: title clipped, views and
// engagementRate "not measured" where the post does not report them, no
// caption, no thumbnail. applyFilters() and windowOf() implement the rolling
// window with the same >= cutoff rule as derive.topPosts, but rolling from the
// session clock instead of Date.now(). Sorting is stable with id as tiebreak.

import type { Platform, Post, ContentVault } from "../../types";
import { engagementMeasured, postHasViews, reach, toNum } from "../../derive";
import { asOf, type ChatData } from "../data";
import type { PostRow, ToolEnvelope, ToolWindow } from "../types";

export { reach as reachOf };

export const DAY = 86_400_000;
export const SAVES_PLATFORMS = new Set<Platform>(["tiktok"]);
export const SHARES_PLATFORMS = new Set<Platform>(["tiktok", "threads", "linkedin"]);
export const NOT_MEASURED = "not measured" as const;
export const TITLE_MAX = 90;
export const COMMENT_TEXT_MAX = 160;
export const EMPTY_DATA_NOTE = "No posts loaded yet. Run the scraper first.";
/** "shortform" expands to these three types. */
export const SHORTFORM_TYPES: readonly string[] = ["reel", "video", "short"];

/** YYYY-MM-DD for an instant on the reader's own calendar. Windows are
 *  rolling instants (as in derive.ts), so this only labels them; the local
 *  date is what "today" means to the person reading the answer. */
export function isoDate(ms: number): string {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Collapse whitespace and clip to `max` characters total, ending in an
 *  ellipsis when clipped. */
export function clipText(text: string | null | undefined, max: number): string {
  const s = (text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function toRow(post: Post, rank: number, vault: ContentVault): PostRow {
  const hasViews = postHasViews(post);
  return {
    rank,
    id: post.id,
    platform: post.platform,
    type: post.type ?? null,
    date: post.date,
    title: clipText(post.title || post.caption, TITLE_MAX) || "(no title)",
    reach: reach(post),
    reachMetric: hasViews ? "views" : "likes",
    views: hasViews ? toNum(post.views) : NOT_MEASURED,
    likes: toNum(post.likes),
    comments: toNum(post.comments),
    shares: SHARES_PLATFORMS.has(post.platform) ? toNum(post.shares) : null,
    saves: SAVES_PLATFORMS.has(post.platform) ? toNum(post.saves) : null,
    engagementRate: engagementMeasured(post) ? round2(toNum(post.engagementRate)) : NOT_MEASURED,
    topics: vault.byPost?.[post.id] ?? [],
    url: post.url ?? null,
  };
}

/** The window an envelope prints: rolling `days` ending at `now`, or
 *  "all time" for a null window. */
export function windowStart(cutoff: number, exclusive = false): string {
  const first = exclusive ? Math.floor(cutoff / DAY) + 1 : Math.ceil(cutoff / DAY);
  return new Date(first * DAY).toISOString().slice(0, 10);
}

export function windowEnd(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function windowOf(days: number | null | undefined, now: number, exclusive = false): ToolWindow {
  if (days === null || days === undefined) return "all time";
  return { days, start: windowStart(now - days * DAY, exclusive), end: windowEnd(now) };
}

export interface PostFilters {
  days?: number | null;
  platforms?: readonly Platform[] | null;
  types?: readonly string[] | null;
}

/** Expand the type filter: "shortform" becomes reel, video and short.
 *  Returns null for no type filter. */
export function expandTypes(types: readonly string[] | null | undefined): Set<string> | null {
  if (!types || types.length === 0) return null;
  const out = new Set<string>();
  for (const t of types) {
    const lower = t.toLowerCase();
    if (lower === "shortform") for (const s of SHORTFORM_TYPES) out.add(s);
    else out.add(lower);
  }
  return out;
}

/** Posts in the rolling window (date >= now - days, the topPosts rule),
 *  on the given platforms, of the given types. Dates that do not parse are
 *  dropped, as everywhere else. */
export function applyFilters(posts: readonly Post[], filters: PostFilters, now: number): Post[] {
  const cutoff = typeof filters.days === "number" ? now - filters.days * DAY : null;
  const platforms = filters.platforms && filters.platforms.length ? new Set<Platform>(filters.platforms) : null;
  const types = expandTypes(filters.types);
  return posts.filter((p) => {
    if (platforms && !platforms.has(p.platform)) return false;
    if (types && !types.has((p.type ?? "").toLowerCase())) return false;
    if (cutoff !== null) {
      const t = new Date(p.date).getTime();
      if (!Number.isFinite(t) || t < cutoff) return false;
    }
    return true;
  });
}

/** Stable sort: `compare` first, then id ascending so equal values always
 *  come out in the same order. Returns a new array. */
export function stableSort<T>(items: readonly T[], compare: (a: T, b: T) => number, id: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const c = compare(a, b);
    if (c !== 0) return c;
    const ia = id(a);
    const ib = id(b);
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}

/** Sort by a numeric value in the given order with the id tiebreak. */
export function sortByValue<T>(
  items: readonly T[],
  value: (item: T) => number,
  order: "desc" | "asc",
  id: (item: T) => string,
): T[] {
  const sign = order === "asc" ? 1 : -1;
  return stableSort(items, (a, b) => sign * (value(a) - value(b)), id);
}

/** Sort posts by reach() descending, id tiebreak. */
export function sortByReach(posts: readonly Post[], order: "desc" | "asc" = "desc"): Post[] {
  return sortByValue(posts, reach, order, (p) => p.id);
}

/** Wrap a tool body in the envelope of 2.1. `filters` is the validated
 *  input echoed back; `notes` are the caveats the model must relay. */
export function envelope<T extends object>(
  data: ChatData,
  window: ToolWindow,
  filters: Record<string, unknown>,
  notes: readonly string[],
  body: T,
): ToolEnvelope<T> {
  return {
    ok: true as const,
    asOf: asOf(data),
    window,
    filters: { ...filters },
    notes: [...notes],
    ...body,
  };
}

/** The standard empty-data envelope every tool returns when no posts are
 *  loaded: ok true, empty body arrays supplied by the caller, and the note. */
export function emptyEnvelope<T extends object>(
  data: ChatData,
  window: ToolWindow,
  filters: Record<string, unknown>,
  body: T,
): ToolEnvelope<T> {
  return envelope(data, window, filters, [EMPTY_DATA_NOTE], body);
}
