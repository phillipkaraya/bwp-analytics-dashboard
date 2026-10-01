// The 11 tool definitions in their fixed order (section 2.3), plus the short
// chip labels the trace UI shows for a call (section 4.4).
//
// Plain JSON only (ToolDef), no Zod, no SDK import: scripts/export-tool-defs.ts
// writes these to defs.json for the future MCP twin. Every schema lists every
// property in required, sets additionalProperties false, and carries no
// minimum, maximum, minLength, maxLength or maxItems (strict tool use rejects
// those); the ranges live in validate.ts.

import type { Platform } from "../../types";
import { platformLabel } from "../../format";
import type { JsonSchemaObject, ToolDef } from "../types";

export const PLATFORM_ENUM = ["instagram", "tiktok", "youtube", "threads", "linkedin"] as const;
export const TYPE_ENUM = ["shortform", "reel", "video", "short", "carousel", "post", "image", "article"] as const;
export const DAYS_ENUM = [7, 30, 60, 90, 180, 365] as const;
export const WINDOW_ENUM = [7, 30, 60, 90, 180, 365] as const;

export const PLATFORMS_ARG = {
  type: ["array", "null"],
  items: { type: "string", enum: [...PLATFORM_ENUM] },
  description: "Limit to these platforms (at most 5). null means all five.",
};
export const DAYS_ARG = {
  type: ["integer", "null"],
  enum: [...DAYS_ENUM, null],
  description: "Rolling window in days ending today. null means all time.",
};
export const TYPES_ARG = {
  type: ["array", "null"],
  items: { type: "string", enum: [...TYPE_ENUM] },
  description:
    "Post types. reel is Instagram, video is TikTok, short is YouTube; shortform means all three together. null means all types.",
};
export const LIMIT_ARG = { type: "integer", description: "Rows to return, 1 to 25." };

function schema(properties: Record<string, unknown>): JsonSchemaObject {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "top_posts",
    description:
      "Rank posts within a rolling window by a metric. Use for best reels, best posts, top performers, worst performers, most saved, most commented. Reach is views where the post reports them and likes otherwise; each row says which.",
    inputSchema: schema({
      days: DAYS_ARG,
      platforms: PLATFORMS_ARG,
      types: TYPES_ARG,
      metric: {
        type: "string",
        enum: ["reach", "views", "likes", "comments", "shares", "saves", "engagementRate"],
      },
      order: { type: "string", enum: ["desc", "asc"] },
      limit: LIMIT_ARG,
    }),
  },
  {
    name: "window_summary",
    description:
      "Totals for one to four rolling windows, each with the immediately preceding window of the same length and percent change already computed. Use for 'how did the last 30 days go', 'compare 30, 60 and 90 days', 'is engagement up or down'.",
    inputSchema: schema({
      windows: {
        type: "array",
        items: { type: "integer", enum: [...WINDOW_ENUM] },
        description: "1 to 4 window lengths in days, e.g. [30, 90]",
      },
      platforms: PLATFORMS_ARG,
      types: TYPES_ARG,
    }),
  },
  {
    name: "platform_breakdown",
    description:
      "One row per platform: post count, views, likes, comments, engagement, followers now, last posted, posting cadence. Use for 'which platform is doing best', 'how often do I post on TikTok', 'which platforms are quiet'.",
    inputSchema: schema({ days: DAYS_ARG }),
  },
  {
    name: "monthly_trend",
    description:
      "Calendar-month series of posts, views, likes, comments and engagement rate, most recent last. Months with no posts appear as zero rows. Use for trends over time.",
    inputSchema: schema({
      months: { type: "integer", description: "How many most recent calendar months, 1 to 24." },
      platforms: PLATFORMS_ARG,
      types: TYPES_ARG,
    }),
  },
  {
    name: "posting_times",
    description:
      "Which weekdays and hours have performed best. Lifetime by default; pass days for a recent window. Hours are the post's own clock; the time zone is not recorded. Slots with fewer than minCount posts are hidden.",
    inputSchema: schema({
      days: DAYS_ARG,
      platforms: PLATFORMS_ARG,
      groupBy: { type: "string", enum: ["cell", "day", "hour"] },
      minCount: {
        type: "integer",
        description: "Ignore slots with fewer posts than this, 2 to 20. The dashboard uses 3.",
      },
      limit: LIMIT_ARG,
    }),
  },
  {
    name: "search_posts",
    description:
      "Find posts whose title, caption or hashtags contain all the words given. Use to locate a specific post or all posts about a subject before ranking them.",
    inputSchema: schema({
      query: { type: "string", description: "One or more words; a #tag matches hashtags." },
      days: DAYS_ARG,
      platforms: PLATFORMS_ARG,
      limit: LIMIT_ARG,
    }),
  },
  {
    name: "hashtag_stats",
    description:
      "Hashtag performance. With tags null: the top hashtags used 3 or more times, ranked by average views. With tags: uses, average reach and platforms for those specific tags, plus each tag's top post. YouTube posts carry no hashtags.",
    inputSchema: schema({
      tags: {
        type: ["array", "null"],
        items: { type: "string" },
        description: "Specific tags with or without #, at most 5. null for the top list.",
      },
      days: DAYS_ARG,
      platforms: PLATFORMS_ARG,
      limit: LIMIT_ARG,
    }),
  },
  {
    name: "content_insights",
    description:
      "Lifetime content patterns from the Insights tab. topics: content categories with counts and average views, or one category's top posts. hooks: opening-line types and the top hooks. viral: posts at 3x their platform average. cross_posts: the same idea posted on several platforms and which platform won.",
    inputSchema: schema({
      section: { type: "string", enum: ["topics", "hooks", "viral", "cross_posts"] },
      topic: {
        type: ["string", "null"],
        description:
          "With section topics: a category slug such as comedy or finance to list its top posts. null for the category list.",
      },
      platforms: PLATFORMS_ARG,
      limit: LIMIT_ARG,
    }),
  },
  {
    name: "follower_growth",
    description:
      "Current follower counts per platform and every stored snapshot, with the change between the last two snapshots and since the first. Use for 'which platform grew', 'how many followers do I have'.",
    inputSchema: schema({}),
  },
  {
    name: "comment_insights",
    description:
      "Audience comments; the snapshot ends on the comments as-of date. sentiment: positive, neutral, negative and question counts, overall or per platform. top_questions: the most liked questions people asked. top_commenters: usernames who comment most. for_post: comments on one post id. search: comments containing words.",
    inputSchema: schema({
      kind: { type: "string", enum: ["sentiment", "top_questions", "top_commenters", "for_post", "search"] },
      postId: { type: ["string", "null"], description: "With kind for_post: the post id from an earlier result." },
      query: { type: ["string", "null"], description: "With kind search: words to match." },
      platforms: PLATFORMS_ARG,
      limit: LIMIT_ARG,
    }),
  },
  {
    name: "post_detail",
    description:
      "Everything the dashboard knows about one post: metrics, topics, how it compares with its platform average, comment count and top comments. Pass the post id from an earlier result or the post URL.",
    inputSchema: schema({
      idOrUrl: {
        type: "string",
        description: "A post id such as ig_3988981312806879246_5251656103, or its URL.",
      },
    }),
  },
];

export const TOOL_NAMES: readonly string[] = TOOL_DEFS.map((t) => t.name);

export function getToolDef(name: string): ToolDef | undefined {
  return TOOL_DEFS.find((t) => t.name === name);
}

// Chip labels

type Obj = Record<string, unknown>;

function asObject(input: unknown): Obj | null {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Obj) : null;
}

function daysLabel(days: unknown): string {
  return typeof days === "number" ? `${days} days` : "all time";
}

function platformsLabel(platforms: unknown): string | null {
  if (!Array.isArray(platforms) || platforms.length === 0) return null;
  const labels = platformLabel as Record<string, string>;
  return platforms.map((p) => labels[String(p)] ?? String(p)).join(", ");
}

function clip(text: unknown, max: number): string {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function join(parts: Array<string | null | undefined | false>): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" · ");
}

const SECTION_WORDS: Record<string, string> = {
  topics: "topics",
  hooks: "hooks",
  viral: "viral posts",
  cross_posts: "cross posts",
};
const KIND_WORDS: Record<string, string> = {
  sentiment: "sentiment",
  top_questions: "top questions",
  top_commenters: "top commenters",
  for_post: "for post",
  search: "search",
};

/** Short chip label for a tool call, e.g. "Top posts · 180 days · Instagram",
 *  "Windows · 30, 90", "Followers", "Comments · sentiment". With input null
 *  (content_block_start, input not known yet) only the tool word is shown. */
export function describeCall(name: string, input: unknown): string {
  const obj = asObject(input);
  switch (name) {
    case "top_posts":
      return join([
        "Top posts",
        obj && daysLabel(obj.days),
        obj && platformsLabel(obj.platforms),
        obj && typeof obj.metric === "string" && obj.metric !== "reach" && `by ${obj.metric}`,
      ]);
    case "window_summary":
      return join([
        "Windows",
        obj && Array.isArray(obj.windows) && obj.windows.length > 0 && obj.windows.join(", "),
        obj && platformsLabel(obj.platforms),
      ]);
    case "platform_breakdown":
      return join(["Platforms", obj && daysLabel(obj.days)]);
    case "monthly_trend":
      return join([
        "Monthly trend",
        obj && typeof obj.months === "number" && `${obj.months} months`,
        obj && platformsLabel(obj.platforms),
      ]);
    case "posting_times":
      return join([
        "Posting times",
        obj && daysLabel(obj.days),
        obj && platformsLabel(obj.platforms),
        obj && typeof obj.groupBy === "string" && obj.groupBy !== "cell" && `by ${obj.groupBy}`,
      ]);
    case "search_posts":
      return join([
        "Search",
        obj && typeof obj.query === "string" && `"${clip(obj.query, 30)}"`,
        obj && typeof obj.days === "number" && daysLabel(obj.days),
        obj && platformsLabel(obj.platforms),
      ]);
    case "hashtag_stats":
      return join([
        "Hashtags",
        obj &&
          Array.isArray(obj.tags) &&
          obj.tags.length > 0 &&
          obj.tags.map((t) => (String(t).startsWith("#") ? String(t) : `#${String(t)}`)).join(", "),
        obj && typeof obj.days === "number" && daysLabel(obj.days),
        obj && platformsLabel(obj.platforms),
      ]);
    case "content_insights":
      return join([
        "Insights",
        obj && typeof obj.section === "string" && (SECTION_WORDS[obj.section] ?? obj.section),
        obj && typeof obj.topic === "string" && obj.topic.length > 0 && clip(obj.topic, 30),
        obj && platformsLabel(obj.platforms),
      ]);
    case "follower_growth":
      return "Followers";
    case "comment_insights":
      return join([
        "Comments",
        obj &&
          typeof obj.kind === "string" &&
          (obj.kind === "search" && typeof obj.query === "string"
            ? `search "${clip(obj.query, 30)}"`
            : (KIND_WORDS[obj.kind] ?? obj.kind)),
        obj && platformsLabel(obj.platforms),
      ]);
    case "post_detail":
      return "Post detail";
    default:
      return name;
  }
}

/** Platform labels for anything else that needs them in the same order. */
export const PLATFORM_ORDER: readonly Platform[] = PLATFORM_ENUM;
