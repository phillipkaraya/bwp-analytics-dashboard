// Offline tool assertions (spec section 7, step 2).
//
// Builds the assistant's dataset from public/data/*.json with the clock
// pinned to 2026-10-03T12:00:00Z and runs every tool through the same
// runner the provider uses, then a second pass over the template's empty
// stubs. Nothing here touches the network or a key.
//
// Run: cd <repo> && pnpm exec tsx --test scripts/chat-tools-check.ts

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { monthlyActivity, postHasViews } from "../lib/derive";
import type { Comment, Post } from "../lib/types";
import { makeChatData, peekComments, postKey, type ChatData } from "../lib/chat/data";
import type { ChatTurn, PostRow, ToolOutcome, ToolTrace } from "../lib/chat/types";
import { TOOL_DEFS, TOOL_NAMES } from "../lib/chat/tools/defs";
import { validateInput } from "../lib/chat/tools/validate";
import { DAY, applyFilters, windowOf } from "../lib/chat/tools/rows";
import { acceptedNumbers, flagNumbers, groundingResults } from "../lib/chat/grounding";
import { normalizeVoice } from "../lib/chat/markdown";
import { indexByTag } from "../lib/chat/tools/hashtags";
import { loadAllPosts, loadAnalytics } from "../lib/data";
import { TOOL_RESULT_MAX_CHARS, capResult, createToolRunner, truncationNote, type AnyEnvelope } from "../lib/chat/tools/run";
import { runPostingTimes } from "../lib/chat/tools/times";
import { runTopPosts } from "../lib/chat/tools/posts";
import { renderToolDefs, DEFS_JSON_PATH } from "./export-tool-defs";

const ROOT = resolve(__dirname, "..");
const BWP_DATA = resolve(ROOT, "public/data");
const TEMPLATE_DATA = resolve(ROOT, "../social-analytics-dashboard-template/public/data");
const NOW = Date.parse("2026-10-03T12:00:00Z");
const PLATFORM_FILES = ["instagram", "tiktok", "youtube", "threads", "linkedin"] as const;
const FORBIDDEN_KEYS = ["followData", "followerProjections", "thumbnailUrl"];

function readJson<T>(dir: string, file: string, fallback: T): T {
  const path = resolve(dir, file);
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function loadDataset(dir: string): ChatData {
  const posts: Post[] = PLATFORM_FILES.flatMap((p) => readJson<Post[]>(dir, `${p}_posts.json`, []));
  return makeChatData(
    {
      posts,
      analytics: readJson(dir, "analytics.json", {}),
      vault: readJson(dir, "content_vault.json", { generatedAt: "", totalPosts: 0, categories: [], byPost: {} }),
      history: readJson(dir, "follower_history.json", []),
      scrape: readJson(dir, "scrape_state.json", { followers: { instagram: 0, tiktok: 0, youtube: 0, threads: 0, linkedin: 0 } }),
      comments: () => Promise.resolve(readJson<Comment[]>(dir, "comments.json", [])),
    },
    () => NOW,
  );
}

function parse<T = Record<string, unknown>>(outcome: ToolOutcome): T {
  assert.equal(outcome.isError, false, `tool errored: ${outcome.content}`);
  return JSON.parse(outcome.content) as T;
}

function keysDeep(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysDeep(v, into);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      into.add(k);
      keysDeep(v, into);
    }
  }
  return into;
}

function hasConstraint(schema: unknown): boolean {
  const banned = new Set(["minimum", "maximum", "minLength", "maxLength", "maxItems"]);
  for (const key of keysDeep(schema)) if (banned.has(key)) return true;
  return false;
}

/** Every envelope the battery below produces is checked for the shared
 *  guarantees: size cap, JSON, notes array, no forbidden keys. */
function checkEnvelope(name: string, outcome: ToolOutcome): AnyEnvelope {
  assert.ok(outcome.content.length <= TOOL_RESULT_MAX_CHARS, `${name}: ${outcome.content.length} chars exceeds the cap`);
  const env = JSON.parse(outcome.content) as AnyEnvelope;
  assert.equal(env.ok, true, `${name}: ok must be true`);
  assert.ok(Array.isArray(env.notes) && env.notes.every((n) => typeof n === "string"), `${name}: notes must be string[]`);
  assert.ok(typeof env.asOf?.posts === "string", `${name}: asOf.posts`);
  assert.ok(env.window === "all time" || typeof env.window === "object", `${name}: window`);
  const keys = keysDeep(env);
  for (const bad of FORBIDDEN_KEYS) assert.ok(!keys.has(bad), `${name}: forbidden key ${bad}`);
  return env;
}

const BATTERY: Array<[string, unknown]> = [
  ["top_posts", { days: 30, platforms: null, types: null, metric: "reach", order: "desc", limit: 25 }],
  ["top_posts", { days: null, platforms: null, types: null, metric: "reach", order: "desc", limit: 25 }],
  ["top_posts", { days: null, platforms: null, types: null, metric: "views", order: "asc", limit: 25 }],
  ["top_posts", { days: null, platforms: null, types: null, metric: "engagementRate", order: "desc", limit: 25 }],
  ["top_posts", { days: null, platforms: null, types: null, metric: "saves", order: "desc", limit: 25 }],
  ["top_posts", { days: null, platforms: null, types: null, metric: "shares", order: "desc", limit: 25 }],
  ["top_posts", { days: 365, platforms: ["tiktok", "youtube"], types: ["reel"], metric: "likes", order: "desc", limit: 25 }],
  ["window_summary", { windows: [7, 30, 90, 365], platforms: null, types: null }],
  ["window_summary", { windows: [180], platforms: ["instagram"], types: ["shortform"] }],
  ["platform_breakdown", { days: null }],
  ["platform_breakdown", { days: 180 }],
  ["monthly_trend", { months: 24, platforms: null, types: null }],
  ["monthly_trend", { months: 1, platforms: ["threads"], types: null }],
  ["posting_times", { days: null, platforms: null, groupBy: "cell", minCount: 3, limit: 25 }],
  ["posting_times", { days: null, platforms: null, groupBy: "day", minCount: 2, limit: 25 }],
  ["posting_times", { days: 365, platforms: ["instagram"], groupBy: "hour", minCount: 2, limit: 25 }],
  ["search_posts", { query: "car", days: null, platforms: null, limit: 25 }],
  ["search_posts", { query: "#airbnbhost", days: null, platforms: null, limit: 25 }],
  ["hashtag_stats", { tags: null, days: null, platforms: null, limit: 25 }],
  ["hashtag_stats", { tags: null, days: 365, platforms: ["instagram"], limit: 25 }],
  ["hashtag_stats", { tags: ["#dontletthisflop", "entrepreneurship", "#nosuchtag"], days: null, platforms: null, limit: 25 }],
  ["content_insights", { section: "topics", topic: null, platforms: null, limit: 25 }],
  ["content_insights", { section: "topics", topic: "comedy", platforms: ["instagram"], limit: 25 }],
  ["content_insights", { section: "hooks", topic: null, platforms: null, limit: 25 }],
  ["content_insights", { section: "viral", topic: null, platforms: null, limit: 25 }],
  ["content_insights", { section: "cross_posts", topic: null, platforms: null, limit: 25 }],
  ["follower_growth", {}],
  ["comment_insights", { kind: "sentiment", postId: null, query: null, platforms: null, limit: 25 }],
  ["comment_insights", { kind: "sentiment", postId: null, query: null, platforms: ["instagram", "tiktok"], limit: 25 }],
  ["comment_insights", { kind: "top_questions", postId: null, query: null, platforms: null, limit: 25 }],
  ["comment_insights", { kind: "top_commenters", postId: null, query: null, platforms: null, limit: 25 }],
  ["comment_insights", { kind: "search", postId: null, query: "the", platforms: null, limit: 25 }],
  ["post_detail", { idOrUrl: "ig_3988981312806879246_5251656103" }],
];

const BAD_INPUTS: Array<[string, unknown]> = [
  ["top_posts", { days: 30, platforms: null, types: null, metric: "reach", order: "desc", limit: 500 }],
  ["top_posts", { days: 30, platforms: ["facebook"], types: null, metric: "reach", order: "desc", limit: 5 }],
  ["window_summary", { windows: [], platforms: null, types: null }],
  ["no_such_tool", {}],
  ["top_posts", { days: 45, platforms: null, types: null, metric: "reach", order: "desc", limit: 5 }],
  ["search_posts", { query: "x".repeat(201), days: null, platforms: null, limit: 5 }],
  ["comment_insights", { kind: "for_post", postId: null, query: null, platforms: null, limit: 5 }],
  ["post_detail", "not an object"],
];

// =========================================================================
// Pass 1: the real dataset

const data = loadDataset(BWP_DATA);
const hints: number[] = [];
const run = createToolRunner(data, { onCommentsLoading: () => hints.push(Date.now()) });

test("dataset facts the assertions rely on", () => {
  assert.equal(data.rawPostCount, 2107);
  assert.equal(data.posts.length, 2103);
  assert.equal(data.now(), NOW);
});

test("schemas: additionalProperties false, required lists every property, no numeric or string constraints", () => {
  assert.equal(TOOL_DEFS.length, 11);
  for (const def of TOOL_DEFS) {
    const s = def.inputSchema;
    assert.equal(s.type, "object", def.name);
    assert.equal(s.additionalProperties, false, def.name);
    assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort(), `${def.name}: required must list every property`);
    assert.ok(!hasConstraint(s), `${def.name}: schema carries a constraint keyword`);
  }
});

test("defs.json matches TOOL_DEFS (rerun scripts/export-tool-defs.ts after editing defs.ts)", () => {
  assert.ok(existsSync(DEFS_JSON_PATH), "lib/chat/tools/defs.json is missing");
  assert.equal(readFileSync(DEFS_JSON_PATH, "utf8"), renderToolDefs());
});

test("top_posts: last 30 days include the refreshed October posts and viewless carousels", async () => {
  const env = parse<{ rows: PostRow[]; postsInWindow: number; notes: string[]; window: { start: string; end: string } }>(
    await run("top_posts", { days: 30, platforms: null, types: null, metric: "reach", order: "desc", limit: 25 }),
  );
  assert.equal(env.postsInWindow, 6);
  assert.equal(env.rows.length, 6);
  assert.deepEqual(env.window, { days: 30, start: "2026-09-04", end: "2026-10-03" });
  const reel = env.rows.find(r => r.id === "ig_3988981312806879246_5251656103")!;
  const carousel = env.rows.find(r => r.id === "ig_3986484940837355954_5251656103")!;
  assert.equal(reel.id, "ig_3988981312806879246_5251656103");
  assert.equal(reel.type, "reel");
  assert.equal(reel.views, 1094);
  assert.equal(reel.reachMetric, "views");
  assert.equal(reel.shares, null, "shares is null on Instagram");
  assert.equal(carousel.type, "carousel");
  assert.equal(carousel.views, "not measured");
  assert.equal(carousel.reachMetric, "likes");
  assert.equal(carousel.reach, 403);
  assert.equal(carousel.likes, 403);
  assert.ok(env.rows.every((r) => ["instagram", "tiktok"].includes(r.platform) && r.date >= "2026-09-04"));
  const week = parse<{ rows: PostRow[]; postsInWindow: number; notes: string[] }>(
    await run("top_posts", { days: 7, platforms: null, types: null, metric: "reach", order: "desc", limit: 25 }),
  );
  assert.equal(week.postsInWindow, 4);
  assert.equal(week.rows.filter(r => r.platform === "instagram").length, 3);
  assert.equal(week.rows.filter(r => r.platform === "tiktok").length, 1);
  assert.ok(week.notes.some(n => n.startsWith("Only 4 posts fall in this window")));
});

test("top_posts: shortform expands to reel, video and short only", async () => {
  const env = parse<{ rows: PostRow[] }>(
    await run("top_posts", { days: null, platforms: null, types: ["shortform"], metric: "reach", order: "desc", limit: 25 }),
  );
  assert.ok(env.rows.length > 0);
  assert.ok(env.rows.every((r) => r.type === "reel" || r.type === "video" || r.type === "short"), JSON.stringify(env.rows.map((r) => r.type)));
});

test("top_posts: a views ranking drops viewless posts and says so; saves outside TikTok never rank", async () => {
  const views = parse<{ rows: PostRow[]; excluded: { noViews: number }; notes: string[]; postsInWindow: number; postsRanked: number }>(
    await run("top_posts", { days: null, platforms: ["threads", "instagram"], types: null, metric: "views", order: "desc", limit: 25 }),
  );
  assert.ok(views.rows.every((r) => typeof r.views === "number" && r.platform === "instagram"));
  assert.ok(views.excluded.noViews > 0);
  assert.equal(views.postsInWindow - views.postsRanked, views.excluded.noViews);
  assert.ok(views.notes.some((n) => n.includes("Threads")));
  const saves = parse<{ rows: PostRow[] }>(
    await run("top_posts", { days: null, platforms: null, types: null, metric: "saves", order: "desc", limit: 25 }),
  );
  assert.ok(saves.rows.every((r) => r.platform === "tiktok" && typeof r.saves === "number"));
});

test("every Threads or LinkedIn row anywhere has views 'not measured'", async () => {
  const outcomes = await Promise.all([
    run("top_posts", { days: null, platforms: ["threads", "linkedin"], types: null, metric: "reach", order: "desc", limit: 25 }),
    run("search_posts", { query: "the", days: null, platforms: ["threads", "linkedin"], limit: 25 }),
    run("top_posts", { days: null, platforms: null, types: ["post", "article", "image"], metric: "likes", order: "desc", limit: 25 }),
  ]);
  let seen = 0;
  for (const o of outcomes) {
    const env = parse<{ rows: PostRow[] }>(o);
    for (const r of env.rows) {
      if (r.platform === "threads" || r.platform === "linkedin") {
        seen += 1;
        assert.equal(r.views, "not measured", r.id);
        assert.equal(r.reachMetric, "likes", r.id);
      }
    }
  }
  assert.ok(seen > 20, `expected many viewless rows, saw ${seen}`);
});

test("window_summary {30, 60, 90}: empty prior windows give null changes and the note; viewPosts matches postHasViews", async () => {
  // The October 3 scrape has six recent posts. The prior 60-day window
  // contains five posts and the prior 90-day window contains 41.
  type Stats = { posts: number; viewPosts: number; views: number };
  type Row = { days: number; start: string; end: string; current: Stats; previous: Stats & { start: string; end: string }; change: Record<string, number | null>; byPlatform: Array<{ platform: string; posts: number }> };
  const env = parse<{ windows: Row[]; notes: string[] }>(await run("window_summary", { windows: [30, 60, 90], platforms: null, types: null }));
  assert.equal(env.windows.length, 3);
  for (const w of env.windows) {
    // Independent recount with the windowTotals rule: (end - days, end].
    const count = (offset: number) =>
      data.posts.filter((p) => {
        const t = new Date(p.date).getTime();
        const end = NOW - offset * DAY;
        return t > end - w.days * DAY && t <= end;
      });
    const inWindow = count(0);
    const inPrior = count(w.days);
    assert.equal(w.current.posts, inWindow.length);
    assert.equal(w.previous.posts, inPrior.length);
    assert.equal(w.current.viewPosts, inWindow.filter(postHasViews).length);
    assert.equal(w.previous.viewPosts, inPrior.filter(postHasViews).length);
    assert.equal(w.current.views, inWindow.filter(postHasViews).reduce((s, p) => s + Number(p.views), 0));
    assert.equal(w.byPlatform.reduce((s, r) => s + r.posts, 0), inWindow.length);
    assert.equal(w.end, "2026-10-03");
    assert.equal(new Date(w.previous.end).getTime() + DAY, new Date(w.start).getTime());
    if (w.previous.posts === 0) {
      assert.ok(Object.values(w.change).every((v) => v === null), `${w.days} days: every change null`);
      assert.ok(env.notes.some((n) => n === `${w.days} days: no posts in the prior window, so no percent change`));
    } else {
      assert.equal(typeof w.change.posts, "number", `${w.days} days: posts change is numeric`);
      assert.ok(!env.notes.some((n) => n === `${w.days} days: no posts in the prior window, so no percent change`));
    }
  }
  const by = Object.fromEntries(env.windows.map((w) => [w.days, w]));
  assert.equal(by[30].previous.posts, 0);
  assert.equal(by[60].previous.posts, 5);
  assert.equal(by[90].previous.posts, 41);
  assert.equal(by[30].current.posts, 6);
  assert.equal(by[30].current.viewPosts, 4);
  assert.equal(by[90].change.posts, Math.round(((6 - 41) / 41) * 100 * 100) / 100);
});

test("window_summary 365: a real prior window yields numeric percent changes", async () => {
  type Row = { current: { posts: number }; previous: { posts: number }; change: { posts: number | null } };
  const env = parse<{ windows: Row[] }>(await run("window_summary", { windows: [365], platforms: null, types: null }));
  const w = env.windows[0];
  assert.ok(w.previous.posts > 0);
  assert.equal(typeof w.change.posts, "number");
  assert.equal(w.change.posts, Math.round(((w.current.posts - w.previous.posts) / w.previous.posts) * 100 * 100) / 100);
});

test("platform_breakdown: viewless platforms say 'not measured' and days since last post use the pinned clock", async () => {
  type Row = { platform: string; posts: number; lifetimeAvgViews: number | string; lastPosted: string | null; daysSinceLastPost: number | null; followers: number; postsPerWeekLifetime: number };
  const env = parse<{ rows: Row[] }>(await run("platform_breakdown", { days: null }));
  assert.equal(env.rows.length, 5);
  const by = Object.fromEntries(env.rows.map((r) => [r.platform, r]));
  assert.equal(by.threads.lifetimeAvgViews, "not measured");
  assert.equal(by.linkedin.lifetimeAvgViews, "not measured");
  assert.equal(typeof by.instagram.lifetimeAvgViews, "number");
  assert.equal(by.instagram.lastPosted, "2026-10-02");
  assert.equal(by.instagram.daysSinceLastPost, Math.floor((NOW - Date.parse("2026-10-02")) / DAY));
  assert.equal(by.instagram.daysSinceLastPost, 1);
  assert.equal(by.linkedin.lastPosted, "2023-02-08");
  assert.equal(by.linkedin.daysSinceLastPost, Math.floor((NOW - Date.parse("2023-02-08")) / DAY));
  assert.equal(by.instagram.followers, 11000);
  assert.equal(by.instagram.posts, 686);
  assert.ok(by.threads.postsPerWeekLifetime > 0);
  const windowed = parse<{ rows: Row[] }>(await run("platform_breakdown", { days: 30 }));
  assert.equal(windowed.rows.find((r) => r.platform === "instagram")?.posts, 5);
  assert.equal(windowed.rows.find((r) => r.platform === "tiktok")?.posts, 1);
});

test("monthly_trend {months: 6}: calendar months ending now, zero rows for 2026-07 and 2026-08", async () => {
  type Row = { month: string; posts: number; views: number; viewPosts: number; avgEngagementRate: number | null };
  const env = parse<{ rows: Row[]; from: string; to: string }>(await run("monthly_trend", { months: 6, platforms: null, types: null }));
  assert.deepEqual(env.rows.map((r) => r.month), ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
  assert.equal(env.from, "2026-05");
  assert.equal(env.to, "2026-10");
  const by = Object.fromEntries(env.rows.map((r) => [r.month, r]));
  assert.deepEqual([by["2026-07"].posts, by["2026-07"].views, by["2026-07"].avgEngagementRate], [0, 0, null]);
  assert.deepEqual([by["2026-08"].posts, by["2026-08"].views, by["2026-08"].avgEngagementRate], [0, 0, null]);
  assert.equal(by["2026-09"].posts, 2);
  assert.equal(by["2026-09"].viewPosts, 1);
  assert.equal(by["2026-09"].views, 1094);
});

test("posting_times default equals the first five analytics.bestPostingTimes and every row carries medianReach", async () => {
  type Row = { day: string | null; hour: number | null; count: number; avgReach: number; medianReach: number; reachBasis: string; topPostTitle: string | null };
  const env = parse<{ rows: Row[]; postsWithTime: number; postsWithoutTime: number }>(
    await run("posting_times", { days: null, platforms: null, groupBy: "cell", minCount: 3, limit: 5 }),
  );
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const expected = (data.analytics.bestPostingTimes ?? []).slice(0, 5);
  assert.equal(expected.length, 5);
  assert.equal(env.rows.length, 5);
  env.rows.forEach((r, i) => {
    assert.equal(r.day, names[expected[i].day]);
    assert.equal(r.hour, expected[i].hour);
    assert.equal(r.count, expected[i].count);
    assert.equal(r.avgReach, Math.round(expected[i].avgViews));
    assert.equal(typeof r.medianReach, "number");
    assert.ok(r.topPostTitle);
  });
  assert.equal(env.rows[0].day, "Mon");
  assert.equal(env.rows[0].hour, 11);
  assert.equal(env.postsWithTime + env.postsWithoutTime, data.posts.length);
  assert.equal(env.postsWithoutTime, 0, "every dated post carries a time today");
});

test("posting_times excludes posts without a time (synthetic) and honours minCount and groupBy", async () => {
  const mk = (id: string, date: string, time: string | undefined, views: number): Post => ({
    id, platform: "instagram", type: "reel", date, time, views, likes: 1, comments: 0, engagementRate: "1.0", title: id,
  });
  const synthetic = makeChatData(
    {
      posts: [
        mk("ig_1_1", "2026-09-14", "11:00", 100), // Monday
        mk("ig_2_1", "2026-09-07", "11:00", 300), // Monday
        mk("ig_3_1", "2026-08-31", "11:00", 200), // Monday
        mk("ig_4_1", "2026-09-15", "09:00", 900), // Tuesday, alone
        mk("ig_5_1", "2026-09-16", undefined, 5000),
      ],
      analytics: {},
      vault: { generatedAt: "", totalPosts: 5, categories: [], byPost: {} },
      history: [],
      scrape: { followers: { instagram: 0, tiktok: 0, youtube: 0, threads: 0, linkedin: 0 } },
    },
    () => NOW,
  );
  const env = runPostingTimes(synthetic, { days: null, platforms: null, groupBy: "cell", minCount: 2, limit: 25 });
  assert.equal(env.postsWithTime, 4);
  assert.equal(env.postsWithoutTime, 1);
  assert.equal(env.rows.length, 1, "the lone Tuesday slot is hidden");
  assert.deepEqual([env.rows[0].day, env.rows[0].hour, env.rows[0].count, env.rows[0].avgReach, env.rows[0].medianReach], ["Mon", 11, 3, 200, 200]);
  assert.equal(env.rows[0].reachBasis, "views");
  assert.ok(env.notes.some((n) => n.includes("no time")));
  const byHour = runPostingTimes(synthetic, { days: null, platforms: null, groupBy: "hour", minCount: 2, limit: 25 });
  assert.deepEqual(byHour.rows.map((r) => [r.day, r.hour]), [[null, 11]]);
});

test("hashtag_stats {tags: ['#dontletthisflop']} returns 4 uses, and the top list matches the Insights table", async () => {
  type Row = { tag: string; uses: number; postsWithViews: number; avgViews: number | string; platforms: Record<string, number>; topPostReachMetric: string | null };
  const env = parse<{ rows: Row[]; postsWithHashtags: number; totalPosts: number; notes: string[] }>(
    await run("hashtag_stats", { tags: ["#dontletthisflop"], days: null, platforms: null, limit: 25 }),
  );
  assert.equal(env.rows.length, 1);
  assert.equal(env.rows[0].tag, "#dontletthisflop");
  assert.equal(env.rows[0].uses, 4);
  assert.equal(env.rows[0].platforms.tiktok, 4);
  assert.equal(env.rows[0].topPostReachMetric, "views");
  assert.equal(env.postsWithHashtags, 413);
  assert.equal(env.totalPosts, 2103);
  assert.ok(env.notes.some((n) => n.startsWith("Only 413 of the 2103 posts")));
  const top = parse<{ rows: Row[] }>(await run("hashtag_stats", { tags: null, days: null, platforms: null, limit: 5 }));
  const expected = (data.analytics.hashtagPerformance ?? []).slice(0, 5).map((h) => h.tag.toLowerCase());
  assert.deepEqual(top.rows.map((r) => r.tag), expected);
  const bare = parse<{ rows: Row[] }>(await run("hashtag_stats", { tags: ["DontLetThisFlop"], days: null, platforms: null, limit: 25 }));
  assert.equal(bare.rows[0].uses, 4, "tags match with or without # and case");
});

test("postKey maps 7999 of 7999 comments to an existing post key", async () => {
  const comments = await data.comments();
  assert.equal(comments.length, 7999);
  const keys = new Set(data.posts.map((p) => postKey(p.id)));
  const mapped = comments.filter((c) => typeof c.postId === "string" && keys.has(postKey(c.postId))).length;
  assert.equal(mapped, 7999);
  const exact = new Set(data.posts.map((p) => p.id));
  assert.ok(comments.filter((c) => typeof c.postId === "string" && exact.has(c.postId)).length < 7999, "exact ids alone would miss Instagram comments");
});

test("comment_insights for_post finds comments via postKey; the spec's example post is newer than the snapshot", async () => {
  // The spec's example post (2026-09-18) postdates the comment snapshot
  // (2026-02-22), so the real answer is zero comments plus the note.
  type Res = { counts: Record<string, number>; rows: Array<{ username: string; likes: number; postId: string | null }>; notes: string[] };
  const example = parse<Res>(
    await run("comment_insights", { kind: "for_post", postId: "ig_3988981312806879246_5251656103", query: null, platforms: null, limit: 5 }),
  );
  assert.equal(example.counts.comments, 0);
  assert.equal(example.rows.length, 0);
  assert.ok(example.notes.some((n) => n.includes("newer than the comment snapshot")));

  // A post whose comments carry the suffix-less key: found only through postKey.
  const comments = await data.comments();
  const tally = new Map<string, number>();
  for (const c of comments) if (c.platform === "instagram" && c.postId) tally.set(postKey(c.postId), (tally.get(postKey(c.postId)) ?? 0) + 1);
  const [busiestKey, busiestCount] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  const post = data.posts.find((p) => postKey(p.id) === busiestKey);
  assert.ok(post && post.id !== busiestKey, "the Instagram post id carries an owner suffix the comment key lacks");
  const found = parse<Res>(await run("comment_insights", { kind: "for_post", postId: post!.id, query: null, platforms: null, limit: 5 }));
  assert.equal(found.counts.comments, busiestCount);
  assert.equal(found.rows.length, 5);
  assert.ok(found.rows.every((r) => r.postId === post!.id));
  for (let i = 1; i < found.rows.length; i++) assert.ok(found.rows[i - 1].likes >= found.rows[i].likes, "sorted by likes");
  const byKey = parse<Res>(await run("comment_insights", { kind: "for_post", postId: busiestKey, query: null, platforms: null, limit: 5 }));
  assert.equal(byKey.counts.comments, busiestCount, "a comment-style id also resolves");
});

test("comment_insights sentiment: precomputed totals without a load, per platform from the file", async () => {
  const overall = parse<{ counts: Record<string, number>; notes: string[] }>(
    await run("comment_insights", { kind: "sentiment", postId: null, query: null, platforms: null, limit: 5 }),
  );
  assert.deepEqual(overall.counts, { positive: 5300, neutral: 2187, negative: 512, question: 559, total: 7999 });
  assert.ok(overall.notes.some((n) => n.startsWith("Comments were last collected on 2026-02-22; posts run to 2026-10-03")));
  const per = parse<{ counts: Record<string, number>; byPlatform: Array<{ platform: string; total: number }> }>(
    await run("comment_insights", { kind: "sentiment", postId: null, query: null, platforms: ["youtube", "threads"], limit: 5 }),
  );
  assert.deepEqual(per.byPlatform.map((r) => [r.platform, r.total]), [["youtube", 160], ["threads", 26]]);
  assert.equal(per.counts.total, 186);
});

test("post_detail resolves by id and by url and errors cleanly on an unknown post", async () => {
  type Res = { post: PostRow | null; caption: string; hashtags: string[]; platformAvgViews: number | string; multiplier: number | null; commentCount: number; topComments: unknown[] };
  const byId = parse<Res>(await run("post_detail", { idOrUrl: "ig_3988981312806879246_5251656103" }));
  assert.equal(byId.post?.views, 1094);
  assert.equal(typeof byId.platformAvgViews, "number");
  assert.equal(byId.multiplier, Math.round((1094 / (byId.platformAvgViews as number)) * 100) / 100);
  assert.equal(byId.commentCount, 0);
  const byUrl = parse<Res>(await run("post_detail", { idOrUrl: "https://www.tiktok.com/@phillip.karaya/video/7031283140316499205" }));
  assert.equal(byUrl.post?.id, "tt_7031283140316499205");
  assert.equal(byUrl.commentCount, 682);
  assert.equal(byUrl.topComments.length, 5);
  assert.ok(byUrl.hashtags.includes("#dontletthisflop"));
  const viewless = parse<Res>(await run("post_detail", { idOrUrl: "ig_3986484940837355954_5251656103" }));
  assert.equal(viewless.post?.views, "not measured");
  assert.equal(viewless.multiplier, null);
  const missing = await run("post_detail", { idOrUrl: "nope_123" });
  assert.equal(missing.isError, true);
  assert.match(JSON.parse(missing.content).error, /No post matches/);
});

test("follower_growth returns 6 snapshots with latestDelta since 2026-09-21", async () => {
  type Res = { current: Record<string, number>; snapshots: Array<{ date: string; linkedin: number | null }>; latestDelta: { from: string; to: string; days: number; total: number }; sinceFirst: { from: string; byPlatform: Record<string, number | null> }; notes: string[] };
  const env = parse<Res>(await run("follower_growth", {}));
  assert.equal(env.snapshots.length, 6);
  assert.equal(env.latestDelta.from, "2026-09-21");
  assert.equal(env.latestDelta.to, "2026-10-03");
  assert.equal(env.latestDelta.days, 12);
  assert.equal(env.latestDelta.total, 0);
  assert.equal(env.sinceFirst.from, "2026-03-28");
  assert.equal(env.sinceFirst.byPlatform.instagram, 28);
  assert.equal(env.sinceFirst.byPlatform.linkedin, null);
  assert.equal(env.snapshots[0].linkedin, null);
  assert.equal(env.current.instagram, 11000);
  assert.ok(env.notes.some((n) => n.startsWith("No change between the last two snapshots")));
  assert.ok(env.notes.some((n) => n === "Only 6 snapshots exist; the earliest is 2026-03-28"));
});

test("content_insights: topics, a topic's posts, hooks, viral and cross posts", async () => {
  const topics = parse<{ rows: Array<{ slug: string; count: number }>; totalItems: number }>(
    await run("content_insights", { section: "topics", topic: null, platforms: null, limit: 3 }),
  );
  assert.deepEqual(topics.rows.map((r) => r.slug), ["comedy", "other", "education"]);
  assert.equal(topics.totalItems, 14);
  const comedy = parse<{ rows: PostRow[]; topic: { slug: string; count: number } }>(
    await run("content_insights", { section: "topics", topic: "Comedy", platforms: null, limit: 3 }),
  );
  assert.equal(comedy.topic.count, 800);
  assert.equal(comedy.rows.length, 3);
  assert.ok(comedy.rows.every((r) => r.topics.includes("comedy")));
  const unknown = await run("content_insights", { section: "topics", topic: "nope", platforms: null, limit: 3 });
  assert.equal(unknown.isError, true);
  const hooks = parse<{ rows: Array<{ postId: string; views: number | string }>; hookTypes: Array<{ type: string }> }>(
    await run("content_insights", { section: "hooks", topic: null, platforms: null, limit: 3 }),
  );
  assert.equal(hooks.rows.length, 3);
  assert.equal(hooks.hookTypes.length, 8);
  const viral = parse<{ rows: Array<{ platform: string; multiplier: number | null; date: string | null }>; totalItems: number }>(
    await run("content_insights", { section: "viral", topic: null, platforms: ["tiktok"], limit: 25 }),
  );
  assert.equal(viral.totalItems, 5);
  assert.ok(viral.rows.every((r) => r.platform === "tiktok" && typeof r.multiplier === "number" && r.date));
  const cross = parse<{ rows: Array<{ bestPlatform: string | null; legs: Array<{ platform: string; reachMetric: string }> }>; notes: string[] }>(
    await run("content_insights", { section: "cross_posts", topic: null, platforms: null, limit: 25 }),
  );
  assert.ok(cross.rows.length > 0 && cross.rows.length < 25, "the 8,000 character cap trims the 25 row request");
  assert.ok(cross.notes.some((n) => n.startsWith("truncated to ")));
  for (const row of cross.rows) for (const leg of row.legs) {
    if (leg.platform === "threads" || leg.platform === "linkedin") assert.equal(leg.reachMetric, "likes");
  }
});

test("search_posts matches every term across title, caption and hashtags", async () => {
  const env = parse<{ rows: PostRow[]; matches: number }>(await run("search_posts", { query: "#dontletthisflop turo", days: null, platforms: null, limit: 25 }));
  assert.ok(env.matches >= 1);
  assert.ok(env.rows.some((r) => r.id === "tt_7031283140316499205"));
  for (let i = 1; i < env.rows.length; i++) assert.ok(env.rows[i - 1].reach >= env.rows[i].reach);
  const none = parse<{ rows: PostRow[]; matches: number; notes: string[] }>(await run("search_posts", { query: "zzzzqqq", days: null, platforms: null, limit: 25 }));
  assert.equal(none.matches, 0);
  assert.ok(none.notes.some((n) => n.startsWith("No post matched")));
});

test("every envelope in the battery is under the cap, parses, has notes and no forbidden keys", async () => {
  for (const [name, input] of BATTERY) {
    const outcome = await run(name, input);
    assert.equal(outcome.isError, false, `${name} ${JSON.stringify(input)}: ${outcome.content}`);
    checkEnvelope(`${name} ${JSON.stringify(input)}`, outcome);
  }
});

test("bad input yields isError true and never throws", async () => {
  for (const [name, input] of BAD_INPUTS) {
    const outcome = await run(name, input);
    assert.equal(outcome.isError, true, `${name} ${JSON.stringify(input)} should be rejected`);
    const parsed = JSON.parse(outcome.content) as { error: string };
    assert.equal(typeof parsed.error, "string");
    assert.ok(parsed.error.length > 0);
  }
  assert.equal(validateInput("no_such_tool", {}).ok, false);
});

test("size cap cuts the main array from the tail and appends the truncation note", async () => {
  // Straight from the tool, before the runner's cap, so all 25 rows exist.
  const env = runTopPosts(data, { days: null, platforms: null, types: null, metric: "reach", order: "desc", limit: 25 });
  assert.equal(env.rows.length, 25);
  const full = JSON.stringify(env).length;
  assert.ok(full > TOOL_RESULT_MAX_CHARS, "25 lifetime rows exceed the cap, so the runner must trim them");
  const viaRunner = JSON.parse((await run("top_posts", { days: null, platforms: null, types: null, metric: "reach", order: "desc", limit: 25 })).content) as { rows: PostRow[]; notes: string[] };
  assert.ok(viaRunner.rows.length < 25 && viaRunner.rows.length > 0);
  assert.equal(viaRunner.notes[viaRunner.notes.length - 1], truncationNote(viaRunner.rows.length));
  assert.deepEqual(viaRunner.rows, env.rows.slice(0, viaRunner.rows.length));
  const capped = capResult(env, 3000);
  assert.ok(capped.content.length <= 3000);
  assert.ok(capped.truncatedTo !== null && capped.truncatedTo < 25 && capped.truncatedTo > 0);
  const cut = JSON.parse(capped.content) as { rows: PostRow[]; notes: string[]; ok: boolean };
  assert.equal(cut.rows.length, capped.truncatedTo);
  assert.deepEqual(cut.rows, env.rows.slice(0, capped.truncatedTo!), "rows are cut from the tail, the head is untouched");
  assert.equal(cut.notes[cut.notes.length - 1], truncationNote(capped.truncatedTo!));
  assert.equal(cut.ok, true);
  const untouched = capResult(env, full);
  assert.equal(untouched.truncatedTo, null);
  assert.equal(untouched.content, JSON.stringify(env));
});

test("the comments loading hook never fires more than once per runner", () => {
  // An earlier test loaded comments directly through data.comments(), so
  // the shared runner may have seen them already loaded; the fresh runner
  // below checks the exact ordering.
  assert.ok(hints.length <= 1);
  assert.ok(peekComments(data) !== null);
});

test("the hook fires once, before the first comment file load, and not for tools that never open the file", async () => {
  const fresh = loadDataset(BWP_DATA);
  let fired = 0;
  const runner = createToolRunner(fresh, {
    onCommentsLoading: () => {
      fired += 1;
      assert.equal(peekComments(fresh), null, "the hint must precede the load");
    },
  });
  await runner("comment_insights", { kind: "sentiment", postId: null, query: null, platforms: null, limit: 5 });
  await runner("comment_insights", { kind: "top_questions", postId: null, query: null, platforms: null, limit: 5 });
  await runner("comment_insights", { kind: "top_commenters", postId: null, query: null, platforms: null, limit: 5 });
  await runner("top_posts", { days: null, platforms: null, types: null, metric: "reach", order: "desc", limit: 5 });
  assert.equal(fired, 0);
  assert.equal(peekComments(fresh), null);
  await runner("comment_insights", { kind: "search", postId: null, query: "kenyan", platforms: null, limit: 5 });
  assert.equal(fired, 1);
  await runner("post_detail", { idOrUrl: "tt_7031283140316499205" });
  assert.equal(fired, 1, "fires once per runner");
});

// =========================================================================
// Pass 2: the template's empty stubs

const EMPTY_BATTERY: Array<[string, unknown]> = [
  ...BATTERY.filter(([name]) => name !== "post_detail" && name !== "comment_insights"),
  ["comment_insights", { kind: "sentiment", postId: null, query: null, platforms: null, limit: 5 }],
  ["comment_insights", { kind: "for_post", postId: "ig_1_1", query: null, platforms: null, limit: 5 }],
  ["comment_insights", { kind: "search", postId: null, query: "hello", platforms: null, limit: 5 }],
  ["post_detail", { idOrUrl: "ig_1_1" }],
];

test("template stubs: every tool returns ok, empty rows and the 'No posts loaded yet' note", async () => {
  const empty = loadDataset(TEMPLATE_DATA);
  assert.equal(empty.posts.length, 0);
  let fired = 0;
  const runner = createToolRunner(empty, { onCommentsLoading: () => (fired += 1) });
  const covered = new Set<string>();
  for (const [name, input] of EMPTY_BATTERY) {
    covered.add(name);
    const outcome = await runner(name, input);
    const env = checkEnvelope(`template ${name}`, outcome) as AnyEnvelope & Record<string, unknown>;
    assert.ok(env.notes.includes("No posts loaded yet. Run the scraper first."), `${name}: note`);
    for (const [key, value] of Object.entries(env)) {
      if (Array.isArray(value) && key !== "notes") assert.equal(value.length, 0, `${name}.${key} must be empty`);
    }
    if ("post" in env) assert.equal(env.post, null);
  }
  assert.deepEqual([...covered].sort(), [...TOOL_NAMES].sort(), "every tool ran on the stubs");
  assert.equal(fired, 0, "no comment load on empty data");
  assert.equal(peekComments(empty), null);
  const bad = await runner("top_posts", { days: 45, platforms: null, types: null, metric: "reach", order: "desc", limit: 5 });
  assert.equal(bad.isError, true);
});

test("post ids stay unique and YouTube underscores cannot mix comments", async () => {
  const raw = PLATFORM_FILES.flatMap((p) => readJson<Post[]>(BWP_DATA, `${p}_posts.json`, []));
  assert.equal(new Set(raw.map((p) => postKey(p.id))).size, raw.length);
  assert.notEqual(postKey("yt_ab_cd"), postKey("yt_ab_ef"));
  assert.equal(postKey("ig_123_456"), postKey("ig_123"));
});

test("saves and shares rank recorded metrics and preserve LinkedIn reposts", async () => {
  const saves = parse<{ rows: PostRow[]; postsRanked: number }>(await run("top_posts", { days: null, platforms: null, types: null, metric: "saves", order: "desc", limit: 5 }));
  const expected = data.posts.filter((p) => p.platform === "tiktok").sort((a, b) => Number(b.saves) - Number(a.saves)).slice(0, 5);
  assert.deepEqual(saves.rows.map((r) => r.id), expected.map((p) => p.id));
  assert.ok(saves.rows[0].saves! > 0);
  const shares = parse<{ rows: PostRow[] }>(await run("top_posts", { days: null, platforms: ["linkedin"], types: null, metric: "shares", order: "desc", limit: 5 }));
  assert.ok(shares.rows.length > 0 && shares.rows[0].shares! > 0);
  const yt = parse<{ rows: PostRow[] }>(await run("top_posts", { days: null, platforms: ["youtube"], types: null, metric: "reach", order: "desc", limit: 5 }));
  assert.ok(yt.rows.every((r) => r.shares === null && r.saves === null));
});

test("window labels name the first included date with afternoon and midnight cutoffs", () => {
  const template = data.posts[0];
  for (const now of [Date.parse("2026-09-28T15:00:00Z"), Date.parse("2026-09-28T00:00:00Z")]) {
    const window = windowOf(30, now);
    assert.notEqual(window, "all time");
    if (window === "all time") return;
    const first = { ...template, date: window.start };
    const previous = { ...template, date: new Date(new Date(window.start).getTime() - DAY).toISOString().slice(0, 10) };
    assert.deepEqual(applyFilters([previous, first], { days: 30 }, now), [first]);
  }
});

test("grounding ignores free text, ids, dates and echoed filters", () => {
  const accepted = acceptedNumbers([JSON.stringify({ rows: [{ title: "Made 9876", caption: "87%", text: "Revenue 5432", username: "9999", date: "2026-09-18", views: 1094 }], filters: { limit: 999 } })], "Today: 2026-09-18. Posts: 2103.");
  assert.deepEqual(flagNumbers("9876, 87%, 5432, 9999, 18%, 999, 1,094 and 2,103", accepted, ""), ["9876", "87%", "5432", "9999", "18%", "999"]);
});

test("follow-up grounding retains recent numeric evidence and excludes failed turns and tools", () => {
  const trace = (n: number, isError = false): ToolTrace => ({ id: String(n), name: "top_posts", input: null, label: "Posts", result: JSON.stringify({ views: n }), isError, ms: 1, status: isError ? "error" : "done" });
  const turn = (n: number, end: ChatTurn["end"] = "done"): ChatTurn => ({ id: String(n), at: "", user: "q", assistant: "answer", end, traces: [trace(n)] });
  const results = groundingResults([turn(1111), turn(2222), turn(3333), turn(4444, "refused"), turn(5555, "error")], [trace(6666), trace(7777, true)]);
  assert.deepEqual(flagNumbers("1111, 2222, 3333, 4444, 5555, 6666, 7777", acceptedNumbers(results, ""), ""), ["1111", "4444", "5555", "7777"]);
});

test("numeric ranges retain their meaning and grounding tokens", () => {
  assert.equal(normalizeVoice("10\u201320%"), "10 to 20%");
  assert.equal(normalizeVoice("1,094\u20142,000 views"), "1,094 to 2,000 views");
  assert.equal(normalizeVoice("Sep 1\u2013Sep 30"), "Sep 1 to Sep 30");
  assert.deepEqual(flagNumbers(normalizeVoice("1,094\u20132,000 views"), new Set(), ""), ["1,094", "2,000"]);
});

test("monthly dashboard buckets match the assistant on the first of a month", () => {
  const posts = [{ ...data.posts[0], date: "2026-09-01" }, { ...data.posts[0], date: "2026-08-31" }];
  assert.deepEqual(monthlyActivity(posts).map((r) => [r.month, r.posts]), [["2026-08", 1], ["2026-09", 1]]);
});

test("question results resolve their post titles and urls without downloading comments", async () => {
  const fresh = loadDataset(BWP_DATA);
  const runner = createToolRunner(fresh);
  const env = parse<{ rows: Array<{ platform: string; postTitle: string | null; postUrl: string | null }> }>(await runner("comment_insights", { kind: "top_questions", postId: null, query: null, platforms: ["instagram"], limit: 5 }));
  assert.ok(env.rows.length > 0);
  assert.ok(env.rows.every((r) => r.postTitle && r.postUrl));
  assert.equal(peekComments(fresh), null);
});

test("hashtag indexing and averages agree with the analyzer's stored rows", async () => {
  const index = indexByTag(data.posts);
  for (const row of data.analytics.hashtagPerformance ?? []) assert.equal(index.get(row.tag)?.length, row.count);
  const plain = parse<{ rows: Array<{ tag: string; avgViews: number | string }> }>(await run("hashtag_stats", { days: null, platforms: null, tags: null, limit: 5 }));
  const filtered = parse<{ rows: Array<{ tag: string; avgViews: number | string }> }>(await run("hashtag_stats", { days: null, platforms: [...PLATFORM_FILES], tags: plain.rows.map((r) => r.tag), limit: 5 }));
  assert.deepEqual(filtered.rows.map((r) => r.avgViews), plain.rows.map((r) => r.avgViews));
});

test("post_detail and viral insight use the same average and multiplier", async () => {
  const viral = parse<{ rows: Array<{ id: string; avgViewsForPlatform: number; multiplier: number }> }>(await run("content_insights", { section: "viral", topic: null, platforms: ["tiktok"], limit: 3 }));
  for (const row of viral.rows) {
    const detail = parse<{ platformAvgViews: number; multiplier: number }>(await run("post_detail", { idOrUrl: row.id }));
    assert.equal(detail.platformAvgViews, row.avgViewsForPlatform);
    assert.equal(detail.multiplier, row.multiplier);
  }
});

test("caption search reaches beyond the detail clip and topic notes do not invent filters", async () => {
  const fresh = makeChatData({ posts: [{ ...data.posts[0], id: "test", caption: "x".repeat(150) + " uniqueending" }], analytics: {}, vault: { generatedAt: "", totalPosts: 2, categories: [{ slug: "topic", label: "Topic", count: 2, avgViews: 1, totalViews: 1, platforms: {}, postIds: ["test", "missing"] }], byPost: {} }, scrape: data.scrape, history: [] }, () => NOW);
  const runner = createToolRunner(fresh);
  const search = parse<{ rows: PostRow[]; notes: string[] }>(await runner("search_posts", { query: "uniqueending", platforms: null, days: null, limit: 5 }));
  assert.equal(search.rows.length, 1);
  assert.ok(!search.notes.some((n) => n.includes("120")));
  const topic = parse<{ notes: string[] }>(await runner("content_insights", { section: "topics", topic: "topic", platforms: null, limit: 5 }));
  assert.ok(topic.notes.some((n) => n.includes("undated or unavailable")));
  assert.ok(!topic.notes.some((n) => n.includes("platform filter")));
});

test("comments loading hint clears when the comments request finishes", async () => {
  const events: string[] = [];
  const runner = createToolRunner(loadDataset(BWP_DATA), { onCommentsLoading: () => events.push("loading"), onCommentsLoaded: () => events.push("loaded") });
  await runner("comment_insights", { kind: "search", postId: null, query: "question", platforms: null, limit: 5 });
  await runner("top_posts", { days: null, platforms: null, types: null, metric: "views", order: "desc", limit: 5 });
  assert.deepEqual(events, ["loading", "loaded"]);
});

test("the page and assistant share successful data loads and retry failed loads", async () => {
  const savedFetch = globalThis.fetch;
  const counts = new Map<string, number>();
  globalThis.fetch = (async (url) => {
    const path = String(url);
    counts.set(path, (counts.get(path) ?? 0) + 1);
    if (path.includes("analytics") && counts.get(path) === 1) return new Response("unavailable", { status: 500 });
    return new Response(JSON.stringify(path.includes("analytics") ? {} : []));
  }) as typeof fetch;
  try {
    const [a, b] = await Promise.all([loadAllPosts(), loadAllPosts()]);
    assert.deepEqual(a, b);
    assert.ok([...counts.values()].every((n) => n === 1));
    await loadAnalytics();
    await loadAnalytics();
    assert.equal(counts.get("/data/analytics.json"), 2);
  } finally { globalThis.fetch = savedFetch; }
});

test("posting-time notes distinguish sparse slots from rows omitted by the limit", () => {
  const env = runPostingTimes(data, { days: null, platforms: null, groupBy: "cell", minCount: 3, limit: 3 });
  const slots = new Map<string, Post[]>();
  for (const p of data.posts) {
    if (!p.time || !/^\d\d:\d\d$/.test(p.time)) continue;
    const day = new Date(`${p.date}T00:00:00Z`).getUTCDay();
    const key = `${day}-${Number(p.time.slice(0, 2))}`;
    const posts = slots.get(key) ?? [];
    posts.push(p); slots.set(key, posts);
  }
  const sparse = [...slots.values()].filter((ps) => ps.length < 3).length;
  const eligible = slots.size - sparse;
  assert.ok(env.notes.some((n) => n.startsWith(`${sparse} slots with fewer than 3`)));
  assert.ok(env.notes.includes(`Showing 3 of ${eligible} slots that meet the minimum count`));
  assert.ok(env.notes.some((n) => n.includes("viewless posts counted as zero")));
  for (const r of env.rows) {
    const ps = slots.get(`${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(r.day!)}-${r.hour}`)!;
    assert.equal(r.reachBasis, ps.every(postHasViews) ? "views" : "mixed");
  }
});
