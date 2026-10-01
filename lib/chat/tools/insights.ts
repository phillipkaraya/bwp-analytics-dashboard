// content_insights (section 2.3, tool 8): topics, hooks, viral and cross
// posts from the precomputed Insights sections and the content vault. Every
// section puts its main list under `rows`; hooks adds `hookTypes`. Post
// legs never carry a raw Post: id, platform, date, reach and url only.

import type { CrossPostItem, Platform, Post, VaultCategory, ViralPost } from "../../types";
import { hasViews, postHasViews, toNum } from "../../derive";
import type { ChatData } from "../data";
import type { PostRow, ToolEnvelope } from "../types";
import { NOT_MEASURED, TITLE_MAX, clipText, emptyEnvelope, envelope, reachOf, round2, sortByReach, toRow } from "./rows";
import type { ContentInsightsInput, InsightSection } from "./validate";

export interface TopicRow {
  slug: string;
  label: string;
  count: number;
  avgViews: number | typeof NOT_MEASURED;
  totalViews: number;
  platforms: Partial<Record<Platform, number>>;
}
export interface HookTypeRow {
  type: string;
  count: number;
  avgViews: number;
  avgLikes: number;
  totalViews: number;
  topPost: string | null;
}
export interface HookRow {
  hook: string;
  platform: Platform;
  views: number | typeof NOT_MEASURED;
  likes: number;
  url: string | null;
  postId: string;
}
export interface ViralRow {
  id: string;
  title: string;
  platform: Platform;
  date: string | null;
  views: number;
  multiplier: number | null;
  avgViewsForPlatform: number | null;
  url: string | null;
}
export interface CrossPostLeg {
  id: string;
  platform: Platform;
  date: string | null;
  reach: number;
  reachMetric: "views" | "likes";
  url: string | null;
}
export interface CrossPostRow {
  title: string;
  platforms: Platform[];
  bestPlatform: Platform | null;
  legs: CrossPostLeg[];
}

export interface ContentInsightsResult {
  section: InsightSection;
  topic: { slug: string; label: string; count: number } | null;
  rows: TopicRow[] | PostRow[] | HookRow[] | ViralRow[] | CrossPostRow[];
  hookTypes?: HookTypeRow[];
  totalItems: number;
}

type RawViral = ViralPost & { date?: unknown };
type RawCrossPost = Omit<CrossPostItem, "posts"> & {
  bestPlatform?: unknown;
  posts: Array<CrossPostItem["posts"][number] & { date?: unknown }>;
};

const PLATFORM_SET = new Set<string>(["instagram", "tiktok", "youtube", "threads", "linkedin"]);

function isPlatform(v: unknown): v is Platform {
  return typeof v === "string" && PLATFORM_SET.has(v);
}

function dateOf(post: Post | undefined, raw: unknown): string | null {
  if (post?.date) return post.date;
  return typeof raw === "string" && raw ? raw : null;
}

function inPlatforms(platform: Platform, platforms: readonly Platform[] | null): boolean {
  return platforms === null || platforms.includes(platform);
}

function topicRowFromVault(cat: VaultCategory): TopicRow {
  return {
    slug: cat.slug,
    label: cat.label,
    count: cat.count,
    avgViews: cat.avgViews > 0 ? Math.round(cat.avgViews) : NOT_MEASURED,
    totalViews: Math.round(cat.totalViews),
    platforms: cat.platforms ?? {},
  };
}

function topicRowFromPosts(cat: VaultCategory, posts: readonly Post[]): TopicRow {
  const viewed = posts.filter((p) => postHasViews(p) && toNum(p.views) > 0);
  const totalViews = viewed.reduce((s, p) => s + toNum(p.views), 0);
  const platforms: Partial<Record<Platform, number>> = {};
  for (const p of posts) platforms[p.platform] = (platforms[p.platform] ?? 0) + 1;
  return {
    slug: cat.slug,
    label: cat.label,
    count: posts.length,
    avgViews: viewed.length ? Math.trunc(totalViews / viewed.length) : NOT_MEASURED,
    totalViews,
    platforms,
  };
}

function findCategory(categories: readonly VaultCategory[], topic: string): VaultCategory | undefined {
  const needle = topic.trim().toLowerCase().replace(/\s+/g, "_");
  return (
    categories.find((c) => c.slug.toLowerCase() === needle) ??
    categories.find((c) => c.label.toLowerCase() === topic.trim().toLowerCase())
  );
}

export function runContentInsights(data: ChatData, input: ContentInsightsInput): ToolEnvelope<ContentInsightsResult> {
  const filters: Record<string, unknown> = { ...input };
  if (data.posts.length === 0) {
    return emptyEnvelope(data, "all time", filters, { section: input.section, topic: null, rows: [], totalItems: 0 });
  }
  const byId = new Map<string, Post>(data.posts.map((p) => [p.id, p]));
  const platforms = input.platforms;
  const notes: string[] = [];

  switch (input.section) {
    case "topics": {
      const categories = data.vault.categories ?? [];
      if (input.topic !== null) {
        const cat = findCategory(categories, input.topic);
        if (!cat) {
          const known = categories.map((c) => c.slug).join(", ");
          throw new Error(`No topic "${clipText(input.topic, 40)}". Topics: ${known || "none"}`);
        }
        const posts = cat.postIds.map((id) => byId.get(id)).filter((p): p is Post => !!p && inPlatforms(p.platform, platforms));
        const rows = sortByReach(posts, "desc").slice(0, input.limit).map((p, i) => toRow(p, i + 1, data.vault));
        notes.push("Ranked by reach: views where the post reports them, likes otherwise");
        if (posts.length < cat.count) {
          if (platforms !== null) notes.push(`${posts.length} of the topic's ${cat.count} posts match the platform filter`);
          else notes.push(`${cat.count - posts.length} undated or unavailable posts in this topic are ignored`);
        }
        return envelope(data, "all time", filters, notes, {
          section: "topics",
          topic: { slug: cat.slug, label: cat.label, count: cat.count },
          rows,
          totalItems: posts.length,
        });
      }
      const rows: TopicRow[] = categories
        .map((cat) => {
          if (platforms === null) return topicRowFromVault(cat);
          const posts = cat.postIds.map((id) => byId.get(id)).filter((p): p is Post => !!p && inPlatforms(p.platform, platforms));
          return topicRowFromPosts(cat, posts);
        })
        .filter((r) => r.count > 0)
        .slice(0, input.limit);
      notes.push("Topic average views are over viewed posts only", "A post can belong to several topics");
      return envelope(data, "all time", filters, notes, { section: "topics", topic: null, rows, totalItems: categories.length });
    }
    case "hooks": {
      const hookTypes: HookTypeRow[] = (data.analytics.hookTypes ?? []).map((h) => ({
        type: h.type,
        count: h.count,
        avgViews: Math.round(h.avgViews),
        avgLikes: Math.round(h.avgLikes),
        totalViews: Math.round(h.totalViews),
        topPost: h.topPost ? clipText(h.topPost, TITLE_MAX) : null,
      }));
      const hooks = (data.analytics.topHooks ?? []).filter((h) => inPlatforms(h.platform, platforms));
      const rows: HookRow[] = hooks.slice(0, input.limit).map((h) => ({
        hook: clipText(h.hook, TITLE_MAX),
        platform: h.platform,
        views: hasViews(h.platform) ? Math.round(h.views) : NOT_MEASURED,
        likes: Math.round(h.likes),
        url: h.url ?? null,
        postId: h.postId,
      }));
      notes.push("Hook types are assigned by pattern matching on the title", "Hook types are lifetime and across all platforms; top hooks are ranked by views");
      return envelope(data, "all time", filters, notes, { section: "hooks", topic: null, rows, hookTypes, totalItems: hooks.length });
    }
    case "viral": {
      const viral = ((data.analytics.viralPosts ?? []) as RawViral[]).filter((v) => inPlatforms(v.platform, platforms));
      const rows: ViralRow[] = viral.slice(0, input.limit).map((v) => ({
        id: v.id,
        title: clipText(v.title, TITLE_MAX),
        platform: v.platform,
        date: dateOf(byId.get(v.id), v.date),
        views: Math.round(v.views),
        multiplier: typeof v.multiplier === "number" ? round2(v.multiplier) : null,
        avgViewsForPlatform: typeof v.avgViewsForPlatform === "number" ? Math.round(v.avgViewsForPlatform) : null,
        url: v.url ?? null,
      }));
      notes.push(
        "Viral means views at least 3x the platform's average; Threads and LinkedIn cannot qualify because they report no views",
        "YouTube dominates the viral list because its average is small",
      );
      return envelope(data, "all time", filters, notes, { section: "viral", topic: null, rows, totalItems: viral.length });
    }
    case "cross_posts": {
      const items = ((data.analytics.crossPosts ?? []) as RawCrossPost[]).filter(
        (c) => platforms === null || c.platforms.some((p) => platforms.includes(p)),
      );
      const rows: CrossPostRow[] = items.slice(0, input.limit).map((c) => {
        const legs: CrossPostLeg[] = c.posts.map((leg) => {
          const post = byId.get(leg.id);
          const viewsReported = post ? postHasViews(post) : hasViews(leg.platform);
          return {
            id: leg.id,
            platform: leg.platform,
            date: dateOf(post, leg.date),
            reach: post ? reachOf(post) : viewsReported ? Math.round(leg.views) : Math.round(leg.likes),
            reachMetric: viewsReported ? "views" : "likes",
            url: leg.url ?? post?.url ?? null,
          };
        });
        let best: Platform | null = isPlatform(c.bestPlatform) ? c.bestPlatform : null;
        if (best === null) {
          const viewed = legs.filter((l) => l.reachMetric === "views");
          best = viewed.length ? viewed.reduce((a, b) => (b.reach > a.reach ? b : a)).platform : null;
        }
        return { title: clipText(c.title, TITLE_MAX), platforms: c.platforms, bestPlatform: best, legs };
      });
      notes.push(
        "Cross posts are grouped by the opening of the title; bestPlatform is the leg with the most views",
        "Threads and LinkedIn legs report no views, so their reach is likes and they never win on views",
      );
      return envelope(data, "all time", filters, notes, { section: "cross_posts", topic: null, rows, totalItems: items.length });
    }
  }
}
