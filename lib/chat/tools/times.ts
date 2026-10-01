// posting_times (section 2.3, tool 5).
//
// The default call (lifetime, all platforms, by cell, minCount 3) reads the
// dashboard's precomputed analytics.bestPostingTimes so the assistant and the
// Insights tab agree; every other shape is built from posts with a time,
// using the same day and hour rules as derive.ts and the heatmap. Medians
// sit beside averages because one viral post skews a small slot.

import type { BestPostingTime, Post } from "../../types";
import { postHasViews } from "../../derive";
import type { ChatData } from "../data";
import type { ToolEnvelope } from "../types";
import { TITLE_MAX, applyFilters, clipText, emptyEnvelope, envelope, reachOf, stableSort, windowOf } from "./rows";
import type { PostingGroupBy, PostingTimesInput } from "./validate";
import { engagementStats } from "./windows";

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const DEFAULT_MIN_COUNT = 3;

export interface PostingTimeRow {
  day: string | null;
  hour: number | null;
  count: number;
  avgReach: number;
  medianReach: number;
  reachBasis: "views" | "mixed";
  avgEngagementRate: number | null;
  topPostTitle: string | null;
}
export interface PostingTimesResult {
  rows: PostingTimeRow[];
  postsWithTime: number;
  postsWithoutTime: number;
}

/** Hour from "HH:MM", or null when the post has no usable time. */
export function postHour(p: Post): number | null {
  if (typeof p.time !== "string" || p.time.length < 2) return null;
  const h = parseInt(p.time.slice(0, 2), 10);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : null;
}

/** Weekday 0 to 6 (Sunday first) of the post date, UTC as derive.ts does. */
export function postDay(p: Post): number | null {
  const d = new Date(`${p.date}T00:00:00Z`);
  const t = d.getTime();
  return Number.isFinite(t) ? d.getUTCDay() : null;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface Slot {
  key: string;
  day: number | null;
  hour: number | null;
  posts: Post[];
}

function slotKey(groupBy: PostingGroupBy, day: number, hour: number): string {
  if (groupBy === "day") return `d${day}`;
  if (groupBy === "hour") return `h${hour}`;
  return `d${day}h${hour}`;
}

function groupSlots(posts: readonly Post[], groupBy: PostingGroupBy): Map<string, Slot> {
  const slots = new Map<string, Slot>();
  for (const p of posts) {
    const day = postDay(p);
    const hour = postHour(p);
    if (day === null || hour === null) continue;
    const key = slotKey(groupBy, day, hour);
    const slot = slots.get(key);
    if (slot) slot.posts.push(p);
    else {
      slots.set(key, {
        key,
        day: groupBy === "hour" ? null : day,
        hour: groupBy === "day" ? null : hour,
        posts: [p],
      });
    }
  }
  return slots;
}

function topTitle(posts: readonly Post[]): string | null {
  if (posts.length === 0) return null;
  const best = stableSort(posts, (a, b) => reachOf(b) - reachOf(a), (p) => p.id)[0];
  return clipText(best.title || best.caption, TITLE_MAX) || null;
}

function reachBasis(posts: readonly Post[]): "views" | "mixed" {
  return posts.length > 0 && posts.every(postHasViews) ? "views" : "mixed";
}

function rowFromSlot(slot: Slot): PostingTimeRow {
  const reaches = slot.posts.map(reachOf);
  return {
    day: slot.day === null ? null : DAY_NAMES[slot.day],
    hour: slot.hour,
    count: slot.posts.length,
    avgReach: Math.round(reaches.reduce((s, r) => s + r, 0) / reaches.length),
    medianReach: Math.round(median(reaches)),
    reachBasis: reachBasis(slot.posts),
    avgEngagementRate: engagementStats(slot.posts).avgEngagementRate,
    topPostTitle: topTitle(slot.posts),
  };
}

function isDefaultShape(input: PostingTimesInput): boolean {
  return (
    input.days === null &&
    input.platforms === null &&
    input.groupBy === "cell" &&
    input.minCount === DEFAULT_MIN_COUNT
  );
}

export function runPostingTimes(data: ChatData, input: PostingTimesInput): ToolEnvelope<PostingTimesResult> {
  const now = data.now();
  const window = windowOf(input.days, now);
  const filters: Record<string, unknown> = { ...input };
  if (data.posts.length === 0) return emptyEnvelope(data, window, filters, { rows: [], postsWithTime: 0, postsWithoutTime: 0 });

  const selected = applyFilters(data.posts, { days: input.days, platforms: input.platforms }, now);
  const withTime = selected.filter((p) => postHour(p) !== null && postDay(p) !== null);
  const postsWithoutTime = selected.length - withTime.length;
  const notes: string[] = ["Hours are the post's own clock; the time zone is not recorded"];

  const precomputed = data.analytics.bestPostingTimes;
  let rows: PostingTimeRow[];
  let hidden = 0;
  let available = 0;
  if (isDefaultShape(input) && Array.isArray(precomputed) && precomputed.length > 0) {
    // Preserve the Insights average, including zero-view posts.
    // The median, basis and top post are filled from the same cells.
    const cells = groupSlots(withTime, "cell");
    rows = precomputed.slice(0, input.limit).map((bpt: BestPostingTime) => {
      const slot = cells.get(slotKey("cell", bpt.day, bpt.hour));
      const posts = slot?.posts ?? [];
      return {
        day: DAY_NAMES[bpt.day] ?? null,
        hour: bpt.hour,
        count: bpt.count,
        avgReach: Math.round(bpt.avgViews),
        medianReach: Math.round(median(posts.map(reachOf))),
        reachBasis: reachBasis(posts),
        avgEngagementRate: typeof bpt.avgEngagement === "number" ? bpt.avgEngagement : null,
        topPostTitle: topTitle(posts),
      };
    });
    hidden = [...cells.values()].filter((s) => s.posts.length < input.minCount).length;
    available = cells.size - hidden;
    notes.push("Average views come from the dashboard's Insights table over every post in the slot, with viewless posts counted as zero; the median uses views or likes for each post");
  } else {
    const slots = [...groupSlots(withTime, input.groupBy).values()];
    const kept = slots.filter((s) => s.posts.length >= input.minCount);
    hidden = slots.length - kept.length;
    available = kept.length;
    const built = kept.map(rowFromSlot);
    rows = stableSort(built, (a, b) => b.avgReach - a.avgReach, (r) => `${r.day ?? ""}-${r.hour ?? ""}`).slice(0, input.limit);
    notes.push("avgReach and medianReach use views where the post reports them and likes otherwise; reachBasis says which");
  }

  if (available > rows.length) notes.push(`Showing ${rows.length} of ${available} slots that meet the minimum count`);
  notes.push(
    hidden > 0
      ? `${hidden} ${hidden === 1 ? "slot" : "slots"} with fewer than ${input.minCount} posts ${hidden === 1 ? "is" : "are"} hidden`
      : `Slots with fewer than ${input.minCount} posts are hidden`,
  );
  notes.push("A single viral post skews a small slot; the median is beside the average");
  if (postsWithoutTime > 0) notes.push(`${postsWithoutTime} ${postsWithoutTime === 1 ? "post has" : "posts have"} no time and ${postsWithoutTime === 1 ? "was" : "were"} left out`);
  if (input.days !== null && withTime.length < 5) notes.push(`Only ${withTime.length} posts fall in this window; lifetime (days null) gives a fuller picture`);

  return envelope(data, window, filters, notes, { rows, postsWithTime: withTime.length, postsWithoutTime });
}
