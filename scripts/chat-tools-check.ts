// Offline tool assertions (spec section 7, step 2).
//
// Builds the assistant's dataset from public/data/*.json with the clock
// pinned to 2026-09-28T12:00:00Z and runs every tool through the same
// runner the provider uses, then a second pass over the template's empty
// stubs. Nothing here touches the network or a key.
//
// Run: cd <repo> && pnpm exec tsx --test scripts/chat-tools-check.ts

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { postHasViews } from "../lib/derive";
import type { Comment, Post } from "../lib/types";
import { makeChatData, peekComments, postKey, type ChatData } from "../lib/chat/data";
import type { PostRow, ToolOutcome } from "../lib/chat/types";
import { TOOL_DEFS, TOOL_NAMES } from "../lib/chat/tools/defs";
import { validateInput } from "../lib/chat/tools/validate";
import { DAY } from "../lib/chat/tools/rows";
import { TOOL_RESULT_MAX_CHARS, capResult, createToolRunner, truncationNote, type AnyEnvelope } from "../lib/chat/tools/run";
import { runPostingTimes } from "../lib/chat/tools/times";
import { runTopPosts } from "../lib/chat/tools/posts";
import { renderToolDefs, DEFS_JSON_PATH } from "./export-tool-defs";

const ROOT = resolve(__dirname, "..");
const BWP_DATA = resolve(ROOT, "public/data");
const TEMPLATE_DATA = resolve(ROOT, "../social-analytics-dashboard-template/public/data");
const NOW = Date.parse("2026-09-28T12:00:00Z");
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
  assert.equal(data.rawPostCount, 2103);
  assert.equal(data.posts.length, 2099);
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

test("top_posts: last 30 days are the two September Instagram posts with the viewless carousel marked", async () => {
  const env = parse<{ rows: PostRow[]; postsInWindow: number; notes: string[]; window: { start: string; end: string } }>(
    await run("top_posts", { days: 30, platforms: null, types: null, metric: "reach", order: "desc", limit: 25 }),
  );
  assert.equal(env.postsInWindow, 2);
  assert.equal(env.rows.length, 2);
  assert.deepEqual(env.window, { days: 30, start: "2026-08-29", end: "2026-09-28" });
  const reel = env.rows[0];
  const carousel = env.rows[1];
  assert.equal(reel.id, "ig_3988981312806879246_5251656103");
  assert.equal(reel.type, "reel");
  assert.equal(reel.views, 1094);
  assert.equal(reel.reachMetric, "views");
  assert.equal(reel.shares, null, "shares is null on Instagram");
  assert.equal(carousel.type, "carousel");
  assert.equal(carousel.views, "not measured");
  assert.equal(carousel.reachMetric, "likes");
  assert.equal(carousel.reach, 391);
  assert.equal(carousel.likes, 391);
  assert.ok(env.rows.every((r) => r.platform === "instagram" && r.date >= "2026-09-01"));
  assert.ok(env.notes.some((n) => n.startsWith("Only 2 posts fall in this window")));
});

test("top_posts: shortform expands to reel, video and short only", async () => {
  const env = parse<{ rows: PostRow[] }>(
    await run("top_posts", { days: null, platforms: null, types: ["shortform"], metric: "reach", order: "desc", limit: 25 }),
  );
  assert.ok(env.rows.length > 0);
  assert.ok(env.rows.every((r) => r.type === "reel" || r.type === "video" || r.type === "short"), JSON.stringify(env.rows.map((r) => r.type)));
});

test("top_posts: a views ranking drops viewless posts and says so; saves outside Instagram never rank", async () => {
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
  assert.ok(saves.rows.every((r) => r.platform === "instagram" && typeof r.saves === "number"));
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
  // The spec expected every prior window to be empty; in the real data only
  // the 30 day prior window is. The 60 day prior window (2026-06-01 to
  // 2026-07-30) holds 25 posts and the 90 day one (2026-04-01 to 2026-06-30)
  // holds 41, so those two get real percent changes.
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
    assert.equal(w.end, "2026-09-28");
    assert.equal(w.previous.end, w.start);
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
  assert.equal(by[60].previous.posts, 25);
  assert.equal(by[90].previous.posts, 41);
  assert.equal(by[30].current.posts, 2);
  assert.equal(by[30].current.viewPosts, 1);
  assert.equal(by[90].change.posts, Math.round(((2 - 41) / 41) * 100 * 100) / 100);
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
  assert.equal(by.instagram.lastPosted, "2026-09-18");
  assert.equal(by.instagram.daysSinceLastPost, Math.floor((NOW - Date.parse("2026-09-18")) / DAY));
  assert.equal(by.instagram.daysSinceLastPost, 10);
  assert.equal(by.linkedin.lastPosted, "2023-02-08");
  assert.equal(by.linkedin.daysSinceLastPost, Math.floor((NOW - Date.parse("2023-02-08")) / DAY));
  assert.equal(by.instagram.followers, 11000);
  assert.equal(by.instagram.posts, 683);
  assert.ok(by.threads.postsPerWeekLifetime > 0);
  const windowed = parse<{ rows: Row[] }>(await run("platform_breakdown", { days: 30 }));
  assert.equal(windowed.rows.find((r) => r.platform === "instagram")?.posts, 2);
  assert.equal(windowed.rows.find((r) => r.platform === "tiktok")?.posts, 0);
});

test("monthly_trend {months: 6}: calendar months ending now, zero rows for 2026-07 and 2026-08", async () => {
  type Row = { month: string; posts: number; views: number; viewPosts: number; avgEngagementRate: number | null };
  const env = parse<{ rows: Row[]; from: string; to: string }>(await run("monthly_trend", { months: 6, platforms: null, types: null }));
  assert.deepEqual(env.rows.map((r) => r.month), ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]);
  assert.equal(env.from, "2026-04");
  assert.equal(env.to, "2026-09");
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
  assert.equal(env.totalPosts, 2099);
  assert.ok(env.notes.some((n) => n.startsWith("Only 413 of the 2099 posts")));
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
  assert.ok(overall.notes.some((n) => n.startsWith("Comments were last collected on 2026-02-22; posts run to 2026-09-21")));
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

test("follower_growth returns 5 snapshots with latestDelta since 2026-09-16", async () => {
  type Res = { current: Record<string, number>; snapshots: Array<{ date: string; linkedin: number | null }>; latestDelta: { from: string; to: string; days: number; total: number }; sinceFirst: { from: string; byPlatform: Record<string, number | null> }; notes: string[] };
  const env = parse<Res>(await run("follower_growth", {}));
  assert.equal(env.snapshots.length, 5);
  assert.equal(env.latestDelta.from, "2026-09-16");
  assert.equal(env.latestDelta.to, "2026-09-21");
  assert.equal(env.latestDelta.days, 5);
  assert.equal(env.latestDelta.total, 0);
  assert.equal(env.sinceFirst.from, "2026-03-28");
  assert.equal(env.sinceFirst.byPlatform.instagram, 28);
  assert.equal(env.sinceFirst.byPlatform.linkedin, null);
  assert.equal(env.snapshots[0].linkedin, null);
  assert.equal(env.current.instagram, 11000);
  assert.ok(env.notes.some((n) => n.startsWith("No change between the last two snapshots")));
  assert.ok(env.notes.some((n) => n === "Only 5 snapshots exist; the earliest is 2026-03-28"));
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
  assert.equal(comedy.topic.count, 798);
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

test("template stubs: every tool returns ok, empty rows and the 'No posts loaded yet' note", { skip: existsSync(TEMPLATE_DATA) ? false : `template data not found at ${TEMPLATE_DATA}` }, async () => {
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
