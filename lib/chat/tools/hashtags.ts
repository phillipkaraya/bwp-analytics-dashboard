// hashtag_stats (section 2.3, tool 7).
//
// Post.hashtags is a whitespace separated "#a #b" string. With no filters
// the top list comes from analytics.hashtagPerformance (tags used 3 or more
// times, ranked by average views, the Insights tab's list) and is enriched
// from the posts index; any filter or an explicit tag list is computed from
// the posts. Averages of views run over posts that report views only.

import type { Platform, Post } from "../../types";
import { PLATFORMS, postHasViews, toNum } from "../../derive";
import type { ChatData } from "../data";
import type { ToolEnvelope } from "../types";
import { NOT_MEASURED, TITLE_MAX, applyFilters, clipText, emptyEnvelope, envelope, reachOf, stableSort, windowOf } from "./rows";
import type { HashtagStatsInput } from "./validate";

export const MIN_TAG_USES = 3;

export interface HashtagRow {
  tag: string;
  uses: number;
  postsWithViews: number;
  avgViews: number | typeof NOT_MEASURED;
  avgLikes: number;
  totalViews: number;
  platforms: Record<Platform, number>;
  topPostTitle: string | null;
  topPostReach: number | null;
  topPostReachMetric: "views" | "likes" | null;
}
export interface HashtagStatsResult {
  rows: HashtagRow[];
  postsWithHashtags: number;
  totalPosts: number;
}

/** "#Tag " or "tag" to "#tag". */
export function normalizeTag(tag: string): string {
  const s = tag.trim().toLowerCase().replace(/^#+/, "");
  return `#${s}`;
}

/** Distinct normalized tags on one post. */
export function postTags(p: Post): string[] {
  if (typeof p.hashtags !== "string") return [];
  const out = new Set<string>();
  for (const raw of p.hashtags.split(/\s+/)) {
    if (raw.startsWith("#") && raw.length > 1) out.add(normalizeTag(raw));
  }
  return [...out];
}

export function indexByTag(posts: readonly Post[]): Map<string, Post[]> {
  const index = new Map<string, Post[]>();
  for (const p of posts) {
    for (const tag of postTags(p)) {
      const list = index.get(tag);
      if (list) list.push(p);
      else index.set(tag, [p]);
    }
  }
  return index;
}

function emptyPlatforms(): Record<Platform, number> {
  return { instagram: 0, tiktok: 0, youtube: 0, threads: 0, linkedin: 0 };
}

function rowFor(tag: string, posts: readonly Post[]): HashtagRow {
  const viewed = posts.filter((p) => postHasViews(p) && toNum(p.views) > 0);
  const totalViews = viewed.reduce((s, p) => s + toNum(p.views), 0);
  const platforms = emptyPlatforms();
  for (const p of posts) platforms[p.platform] += 1;
  const top = posts.length ? stableSort(posts, (a, b) => reachOf(b) - reachOf(a), (p) => p.id)[0] : null;
  return {
    tag,
    uses: posts.length,
    postsWithViews: viewed.length,
    avgViews: viewed.length ? Math.round(totalViews / viewed.length) : NOT_MEASURED,
    avgLikes: posts.length ? Math.round(posts.reduce((s, p) => s + toNum(p.likes), 0) / posts.length) : 0,
    totalViews,
    platforms,
    topPostTitle: top ? clipText(top.title || top.caption, TITLE_MAX) || null : null,
    topPostReach: top ? reachOf(top) : null,
    topPostReachMetric: top ? (postHasViews(top) ? "views" : "likes") : null,
  };
}

function avgViewsValue(row: HashtagRow): number {
  return typeof row.avgViews === "number" ? row.avgViews : -1;
}

export function runHashtagStats(data: ChatData, input: HashtagStatsInput): ToolEnvelope<HashtagStatsResult> {
  const now = data.now();
  const window = windowOf(input.days, now);
  const filters: Record<string, unknown> = { ...input };
  if (data.posts.length === 0) return emptyEnvelope(data, window, filters, { rows: [], postsWithHashtags: 0, totalPosts: 0 });

  const selected = applyFilters(data.posts, { days: input.days, platforms: input.platforms }, now);
  const index = indexByTag(selected);
  const postsWithHashtags = selected.filter((p) => postTags(p).length > 0).length;
  const notes: string[] = [];
  let rows: HashtagRow[];

  const unfiltered = input.days === null && input.platforms === null;
  const precomputed = data.analytics.hashtagPerformance;
  if (input.tags) {
    rows = input.tags.map(normalizeTag).map((tag) => rowFor(tag, index.get(tag) ?? []));
    const missing = rows.filter((r) => r.uses === 0).map((r) => r.tag);
    if (missing.length) notes.push(`${missing.join(", ")} ${missing.length === 1 ? "was" : "were"} not used in the selection`);
  } else if (unfiltered && Array.isArray(precomputed) && precomputed.length > 0) {
    rows = precomputed.slice(0, input.limit).map((stat) => {
      const tag = normalizeTag(stat.tag);
      const fromPosts = rowFor(tag, index.get(tag) ?? []);
      return {
        ...fromPosts,
        uses: stat.count,
        avgViews: stat.avgViews > 0 ? Math.round(stat.avgViews) : fromPosts.avgViews,
        avgLikes: Math.round(stat.avgLikes),
        totalViews: Math.round(stat.totalViews),
      };
    });
    notes.push(`Top tags are those used ${MIN_TAG_USES} or more times, ranked by average views, as on the Insights tab`);
  } else {
    const all = [...index.entries()].map(([tag, posts]) => rowFor(tag, posts)).filter((r) => r.uses >= MIN_TAG_USES);
    rows = stableSort(all, (a, b) => avgViewsValue(b) - avgViewsValue(a), (r) => r.tag).slice(0, input.limit);
    notes.push(`Only tags used ${MIN_TAG_USES} or more times in the selection are listed, ranked by average views`);
    if (rows.length === 0 && postsWithHashtags > 0) notes.push(`No tag reaches ${MIN_TAG_USES} uses in this selection; widen the window or pass specific tags`);
  }

  notes.push(`Only ${postsWithHashtags} of the ${selected.length} posts in the selection carry hashtags`);
  notes.push("Correlation, not cause: one viral post dominates a tag's average");
  notes.push("YouTube posts carry no hashtags; avgViews is over posts that report views");
  const platformsInSelection = new Set(selected.map((p) => p.platform));
  if (PLATFORMS.some((p) => platformsInSelection.has(p) && (p === "threads" || p === "linkedin"))) {
    notes.push("Threads and LinkedIn tags count toward uses and likes but not views");
  }

  return envelope(data, window, filters, notes, { rows, postsWithHashtags, totalPosts: selected.length });
}
