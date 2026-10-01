// top_posts, search_posts and post_detail (section 2.3, tools 1, 6 and 11).
//
// Every post reaches the model through toRow(); a ranking never sums views,
// never ranks a viewless post by views, and every exclusion is counted and
// explained in notes. Relative imports only: tsx runs this in Node.

import type { Platform, Post } from "../../types";
import { PLATFORMS, VIEWLESS_PLATFORMS, engagementMeasured, postHasViews, sentimentBreakdown, toNum } from "../../derive";
import { asOf, postKey, type ChatData } from "../data";
import type { PostRow, ToolEnvelope } from "../types";
import {
  SAVES_PLATFORMS,
  SHARES_PLATFORMS,
  NOT_MEASURED,
  COMMENT_TEXT_MAX,
  applyFilters,
  clipText,
  emptyEnvelope,
  envelope,
  reachOf,
  round2,
  sortByReach,
  sortByValue,
  toRow,
  windowOf,
} from "./rows";
import type { PostDetailInput, SearchPostsInput, TopPostsInput, TopPostsMetric } from "./validate";
import { lifetimeAvgViews } from "./windows";

// top_posts

export interface TopPostsResult {
  rows: PostRow[];
  postsInWindow: number;
  postsRanked: number;
  excluded: { noViews: number; noEngagementMeasurement: number; noMetric: number };
}

/** The number a post is ranked by for each metric. */
function metricValue(metric: TopPostsMetric): (p: Post) => number {
  switch (metric) {
    case "reach":
      return reachOf;
    case "views":
      return (p) => toNum(p.views);
    case "likes":
      return (p) => toNum(p.likes);
    case "comments":
      return (p) => toNum(p.comments);
    case "shares":
      return (p) => toNum(p.shares);
    case "saves":
      return (p) => toNum(p.saves);
    case "engagementRate":
      return (p) => toNum(p.engagementRate);
  }
}

/** Whether a post carries the metric at all (rule 4: a zero is not a
 *  measurement where the field is not reported). Mirrors toRow() using
 *  the metrics the scrapers actually measure. */
function metricEligible(metric: TopPostsMetric, p: Post): boolean {
  switch (metric) {
    case "views":
      return postHasViews(p);
    case "engagementRate":
      return engagementMeasured(p);
    case "shares":
      return SHARES_PLATFORMS.has(p.platform);
    case "saves":
      return SAVES_PLATFORMS.has(p.platform);
    default:
      return true;
  }
}

const PLATFORM_WORD: Record<Platform, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  threads: "Threads",
  linkedin: "LinkedIn",
};

function listWords(platforms: Iterable<Platform>): string {
  const words = PLATFORMS.filter((p) => new Set(platforms).has(p)).map((p) => PLATFORM_WORD[p]);
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function runTopPosts(data: ChatData, input: TopPostsInput): ToolEnvelope<TopPostsResult> {
  const now = data.now();
  const window = windowOf(input.days, now);
  const filters: Record<string, unknown> = { ...input };
  const empty: TopPostsResult = {
    rows: [],
    postsInWindow: 0,
    postsRanked: 0,
    excluded: { noViews: 0, noEngagementMeasurement: 0, noMetric: 0 },
  };
  if (data.posts.length === 0) return emptyEnvelope(data, window, filters, empty);

  const inWindow = applyFilters(data.posts, input, now);
  const eligible = inWindow.filter((p) => metricEligible(input.metric, p));
  const left = inWindow.filter((p) => !metricEligible(input.metric, p));
  const metric = input.metric;
  const excluded = {
    noViews: metric === "views" ? left.length : 0,
    noEngagementMeasurement: metric === "engagementRate" ? left.length : 0,
    noMetric: metric === "shares" || metric === "saves" ? left.length : 0,
  };
  const sorted =
    metric === "reach"
      ? sortByReach(eligible, input.order)
      : sortByValue(eligible, metricValue(metric), input.order, (p) => p.id);
  const rows = sorted.slice(0, input.limit).map((p, i) => toRow(p, i + 1, data.vault));

  const notes: string[] = [];
  if (input.days !== null && inWindow.length < 5) {
    notes.push(
      `Only ${inWindow.length} ${plural(inWindow.length, "post falls", "posts fall")} in this window; 180 or 365 days gives a fuller picture`,
    );
  }
  if (metric === "views" && left.length > 0) {
    const viewless = new Set<Platform>(left.map((p) => p.platform).filter((p) => VIEWLESS_PLATFORMS.has(p)));
    if (viewless.size > 0) {
      notes.push(`${listWords(viewless)} ${plural(viewless.size, "reports", "report")} no views, so those posts were left out of this ranking; rank them by likes instead`);
    }
    const viewlessTypes = left.filter((p) => !VIEWLESS_PLATFORMS.has(p.platform)).length;
    if (viewlessTypes > 0) {
      notes.push(`${viewlessTypes} ${plural(viewlessTypes, "post", "posts")} of a type that reports no views (carousels, photos, images, articles) were left out`);
    }
  }
  if (metric === "engagementRate" && left.length > 0) {
    notes.push(`${left.length} ${plural(left.length, "post", "posts")} without an engagement measurement ${plural(left.length, "was", "were")} left out`);
  }
  if (metric === "shares" && left.length > 0) {
    notes.push(`${listWords(new Set(left.map((p) => p.platform)))} shares or reposts are not measured in this dataset, so those posts were left out`);
  }
  if (metric === "saves" && left.length > 0) {
    notes.push("Saves are measured only for TikTok in this dataset, so other platforms were left out");
  }
  if (input.types?.includes("reel") && input.platforms?.some((p) => p !== "instagram")) {
    notes.push("reel is an Instagram type: TikTok posts are type video and YouTube Shorts are type short; shortform covers all three");
  }
  if (rows.length === 0 && inWindow.length > 0) {
    notes.push("No post in the selection carries this metric");
  }

  return envelope(data, window, filters, notes, {
    rows,
    postsInWindow: inWindow.length,
    postsRanked: eligible.length,
    excluded,
  });
}

// search_posts

export interface SearchPostsResult {
  rows: PostRow[];
  matches: number;
}

/** Lowercased whitespace terms, empty ones dropped. */
export function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** The same rule as components/posts/posts.tsx: every term must appear in
 *  the title, caption or hashtags. */
export function postMatches(p: Post, terms: readonly string[]): boolean {
  if (terms.length === 0) return false;
  const hay = `${p.title ?? ""} ${p.caption ?? ""} ${p.hashtags ?? ""}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

export function runSearchPosts(data: ChatData, input: SearchPostsInput): ToolEnvelope<SearchPostsResult> {
  const now = data.now();
  const window = windowOf(input.days, now);
  const filters: Record<string, unknown> = { ...input };
  if (data.posts.length === 0) return emptyEnvelope(data, window, filters, { rows: [], matches: 0 });

  const terms = searchTerms(input.query);
  const candidates = applyFilters(data.posts, { days: input.days, platforms: input.platforms }, now);
  const matched = sortByReach(candidates.filter((p) => postMatches(p, terms)), "desc");
  const rows = matched.slice(0, input.limit).map((p, i) => toRow(p, i + 1, data.vault));

  const notes: string[] = [];
  if (matched.length === 0) notes.push("No post matched every word; try fewer or different words");
  else if (matched.length > rows.length) notes.push(`Showing the top ${rows.length} of ${matched.length} matches by reach`);

  return envelope(data, window, filters, notes, { rows, matches: matched.length });
}

// post_detail

export interface TopCommentRow {
  username: string;
  text: string;
  likes: number;
  date: string;
  sentiment: "positive" | "neutral" | "negative";
}

export interface PostDetailResult {
  post: PostRow | null;
  caption: string;
  hashtags: string[];
  platformAvgViews: number | typeof NOT_MEASURED;
  multiplier: number | null;
  commentCount: number;
  sentiment: { positive: number; neutral: number; negative: number; question: number };
  topComments: TopCommentRow[];
}

const TOP_COMMENTS = 5;
/** The detail view clips the stored caption to 120 characters. Search
 *  still reads the full stored title and caption. */
const CAPTION_MAX = 120;

function normalizeUrl(url: string): string {
  let s = url.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  const cut = s.search(/[?#]/);
  if (cut >= 0) s = s.slice(0, cut);
  return s.replace(/\/+$/, "");
}

/** Find a post by exact id, by comment-style key (ig_<mediaId>) or by url. */
export function findPost(posts: readonly Post[], idOrUrl: string): Post | null {
  const needle = idOrUrl.trim();
  if (!needle) return null;
  const exact = posts.find((p) => p.id === needle);
  if (exact) return exact;
  if (!/^https?:\/\//i.test(needle) && needle.includes("_")) {
    const key = postKey(needle);
    const byKey = posts.find((p) => postKey(p.id) === key);
    if (byKey) return byKey;
  }
  const url = normalizeUrl(needle);
  if (!url) return null;
  return posts.find((p) => typeof p.url === "string" && normalizeUrl(p.url) === url) ?? null;
}

export function splitHashtags(hashtags: string | null | undefined): string[] {
  if (typeof hashtags !== "string") return [];
  return hashtags.split(/\s+/).filter((t) => t.length > 1 && t.startsWith("#"));
}

export async function runPostDetail(data: ChatData, input: PostDetailInput): Promise<ToolEnvelope<PostDetailResult>> {
  const filters: Record<string, unknown> = { ...input };
  const empty: PostDetailResult = {
    post: null,
    caption: "",
    hashtags: [],
    platformAvgViews: NOT_MEASURED,
    multiplier: null,
    commentCount: 0,
    sentiment: { positive: 0, neutral: 0, negative: 0, question: 0 },
    topComments: [],
  };
  if (data.posts.length === 0) return emptyEnvelope(data, "all time", filters, empty);

  const post = findPost(data.posts, input.idOrUrl);
  if (!post) {
    throw new Error(`No post matches "${clipText(input.idOrUrl, 80)}". Pass an id from an earlier result or the post url.`);
  }

  const row = toRow(post, 1, data.vault);
  const platformPosts = data.posts.filter((p) => p.platform === post.platform);
  const platformAvgViews = lifetimeAvgViews(platformPosts);
  const multiplier =
    typeof row.views === "number" && typeof platformAvgViews === "number" && platformAvgViews > 0
      ? round2(row.views / platformAvgViews)
      : null;

  const key = postKey(post.id);
  const all = await data.comments();
  const mine = all.filter((c) => typeof c.postId === "string" && postKey(c.postId) === key);
  const sentiment = sentimentBreakdown(mine);
  const topComments = sortByValue(mine, (c) => toNum(c.likes), "desc", (c) => c.id)
    .slice(0, TOP_COMMENTS)
    .map((c) => ({
      username: c.username,
      text: clipText(c.text, COMMENT_TEXT_MAX),
      likes: toNum(c.likes),
      date: c.date,
      sentiment: c.sentiment ?? "neutral",
    }));

  const notes: string[] = [];
  const dates = asOf(data);
  if (typeof row.views !== "number") {
    notes.push(`${PLATFORM_WORD[post.platform]} ${post.type ? `${post.type}s` : "posts"} report no views; reach here is likes`);
  } else if (typeof platformAvgViews === "number") {
    notes.push(`Platform average views are lifetime, over ${PLATFORM_WORD[post.platform]} posts that report views`);
  }
  if (dates.comments) {
    notes.push(`Comments were last collected on ${dates.comments}; posts run to ${dates.posts}`);
    if (mine.length === 0 && post.date > dates.comments) {
      notes.push("This post is newer than the comment snapshot, so no comments are loaded for it");
    }
  }
  if (mine.length > topComments.length) notes.push(`Showing the ${topComments.length} most liked of ${mine.length} comments`);

  return envelope(data, "all time", filters, notes, {
    post: row,
    caption: clipText(post.caption, CAPTION_MAX),
    hashtags: splitHashtags(post.hashtags),
    platformAvgViews,
    multiplier,
    commentCount: mine.length,
    sentiment,
    topComments,
  });
}
