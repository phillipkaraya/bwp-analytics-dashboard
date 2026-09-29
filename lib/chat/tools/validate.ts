// Hand validator for tool inputs (section 2.1, executor rule 1).
//
// Strict tool use guarantees the shape; this file guards what the schema
// cannot express: integer ranges, array lengths, string lengths, window
// counts and cross-field rules. It never throws: a failure is returned as
// { ok: false, error } and the runner turns that into an is_error tool result.

import type { Platform } from "../../types";
import { PLATFORM_ENUM, TYPE_ENUM, DAYS_ENUM, WINDOW_ENUM, TOOL_DEFS } from "./defs";

export type Days = 7 | 30 | 60 | 90 | 180 | 365 | null;
export type WindowLength = 7 | 30 | 60 | 90 | 180 | 365;
export type PostTypeArg =
  | "shortform"
  | "reel"
  | "video"
  | "short"
  | "carousel"
  | "post"
  | "image"
  | "article";
export type PlatformsArg = Platform[] | null;
export type TypesArg = PostTypeArg[] | null;

export type TopPostsMetric = "reach" | "views" | "likes" | "comments" | "shares" | "saves" | "engagementRate";
export type SortOrder = "desc" | "asc";
export type PostingGroupBy = "cell" | "day" | "hour";
export type InsightSection = "topics" | "hooks" | "viral" | "cross_posts";
export type CommentKind = "sentiment" | "top_questions" | "top_commenters" | "for_post" | "search";

export interface TopPostsInput {
  days: Days;
  platforms: PlatformsArg;
  types: TypesArg;
  metric: TopPostsMetric;
  order: SortOrder;
  limit: number;
}
export interface WindowSummaryInput {
  windows: WindowLength[];
  platforms: PlatformsArg;
  types: TypesArg;
}
export interface PlatformBreakdownInput {
  days: Days;
}
export interface MonthlyTrendInput {
  months: number;
  platforms: PlatformsArg;
  types: TypesArg;
}
export interface PostingTimesInput {
  days: Days;
  platforms: PlatformsArg;
  groupBy: PostingGroupBy;
  minCount: number;
  limit: number;
}
export interface SearchPostsInput {
  query: string;
  days: Days;
  platforms: PlatformsArg;
  limit: number;
}
export interface HashtagStatsInput {
  tags: string[] | null;
  days: Days;
  platforms: PlatformsArg;
  limit: number;
}
export interface ContentInsightsInput {
  section: InsightSection;
  topic: string | null;
  platforms: PlatformsArg;
  limit: number;
}
export type FollowerGrowthInput = Record<string, never>;
export interface CommentInsightsInput {
  kind: CommentKind;
  postId: string | null;
  query: string | null;
  platforms: PlatformsArg;
  limit: number;
}
export interface PostDetailInput {
  idOrUrl: string;
}

export interface ToolInputs {
  top_posts: TopPostsInput;
  window_summary: WindowSummaryInput;
  platform_breakdown: PlatformBreakdownInput;
  monthly_trend: MonthlyTrendInput;
  posting_times: PostingTimesInput;
  search_posts: SearchPostsInput;
  hashtag_stats: HashtagStatsInput;
  content_insights: ContentInsightsInput;
  follower_growth: FollowerGrowthInput;
  comment_insights: CommentInsightsInput;
  post_detail: PostDetailInput;
}
export type ToolName = keyof ToolInputs;
export type ToolInput = ToolInputs[ToolName];

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const LIMIT_RANGE = { min: 1, max: 25 } as const;
export const MONTHS_RANGE = { min: 1, max: 24 } as const;
export const MIN_COUNT_RANGE = { min: 2, max: 20 } as const;
export const MAX_ARRAY = 5;
export const MAX_STRING = 200;
export const WINDOWS_RANGE = { min: 1, max: 4 } as const;

const TOOL_NAME_SET = new Set<string>(TOOL_DEFS.map((t) => t.name));

export function isToolName(name: string): name is ToolName {
  return TOOL_NAME_SET.has(name);
}

class Invalid extends Error {}

type Obj = Record<string, unknown>;

function objectOf(input: unknown): Obj {
  if (input === null || input === undefined) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new Invalid("input must be an object");
  return input as Obj;
}

function readDays(obj: Obj, key = "days"): Days {
  const v = obj[key];
  if (v === undefined || v === null) return null;
  if (typeof v === "number" && (DAYS_ENUM as readonly number[]).includes(v)) return v as Days;
  throw new Invalid(`${key} must be one of ${DAYS_ENUM.join(", ")} or null`);
}

function readEnum<T extends string>(obj: Obj, key: string, allowed: readonly T[]): T {
  const v = obj[key];
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  throw new Invalid(`${key} must be one of ${allowed.join(", ")}`);
}

function readInt(obj: Obj, key: string, range: { min: number; max: number }): number {
  const v = obj[key];
  if (typeof v === "number" && Number.isInteger(v) && v >= range.min && v <= range.max) return v;
  throw new Invalid(`${key} must be an integer from ${range.min} to ${range.max}`);
}

function readString(obj: Obj, key: string, nullable: boolean): string | null {
  const v = obj[key];
  if (v === undefined || v === null) {
    if (nullable) return null;
    throw new Invalid(`${key} is required`);
  }
  if (typeof v !== "string") throw new Invalid(`${key} must be a string`);
  const s = v.trim();
  if (s.length > MAX_STRING) throw new Invalid(`${key} must be at most ${MAX_STRING} characters`);
  if (!s) {
    if (nullable) return null;
    throw new Invalid(`${key} must not be empty`);
  }
  return s;
}

function readEnumArray<T extends string>(obj: Obj, key: string, allowed: readonly T[]): T[] | null {
  const v = obj[key];
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) throw new Invalid(`${key} must be an array or null`);
  if (v.length > MAX_ARRAY) throw new Invalid(`${key} holds at most ${MAX_ARRAY} entries`);
  const out: T[] = [];
  for (const item of v) {
    if (typeof item !== "string" || !(allowed as readonly string[]).includes(item)) {
      throw new Invalid(`${key} entries must be one of ${allowed.join(", ")}`);
    }
    if (!out.includes(item as T)) out.push(item as T);
  }
  return out.length ? out : null; // an empty list means no filter
}

function readTags(obj: Obj): string[] | null {
  const v = obj.tags;
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) throw new Invalid("tags must be an array or null");
  if (v.length > MAX_ARRAY) throw new Invalid(`tags holds at most ${MAX_ARRAY} entries`);
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") throw new Invalid("tags entries must be strings");
    const s = item.trim();
    if (s.length > MAX_STRING) throw new Invalid(`tags entries must be at most ${MAX_STRING} characters`);
    if (s && !out.includes(s)) out.push(s);
  }
  return out.length ? out : null;
}

function readWindows(obj: Obj): WindowLength[] {
  const v = obj.windows;
  if (!Array.isArray(v)) throw new Invalid("windows must be an array of 1 to 4 window lengths");
  if (v.length < WINDOWS_RANGE.min || v.length > WINDOWS_RANGE.max) {
    throw new Invalid(`windows must hold ${WINDOWS_RANGE.min} to ${WINDOWS_RANGE.max} entries`);
  }
  const out: WindowLength[] = [];
  for (const item of v) {
    if (typeof item !== "number" || !(WINDOW_ENUM as readonly number[]).includes(item)) {
      throw new Invalid(`windows entries must be one of ${WINDOW_ENUM.join(", ")}`);
    }
    if (!out.includes(item as WindowLength)) out.push(item as WindowLength);
  }
  return out;
}

const METRICS: readonly TopPostsMetric[] = ["reach", "views", "likes", "comments", "shares", "saves", "engagementRate"];
const ORDERS: readonly SortOrder[] = ["desc", "asc"];
const GROUP_BYS: readonly PostingGroupBy[] = ["cell", "day", "hour"];
const SECTIONS: readonly InsightSection[] = ["topics", "hooks", "viral", "cross_posts"];
const KINDS: readonly CommentKind[] = ["sentiment", "top_questions", "top_commenters", "for_post", "search"];

function validateByName(name: ToolName, obj: Obj): ToolInput {
  switch (name) {
    case "top_posts":
      return {
        days: readDays(obj),
        platforms: readEnumArray(obj, "platforms", PLATFORM_ENUM),
        types: readEnumArray(obj, "types", TYPE_ENUM),
        metric: readEnum(obj, "metric", METRICS),
        order: readEnum(obj, "order", ORDERS),
        limit: readInt(obj, "limit", LIMIT_RANGE),
      } satisfies TopPostsInput;
    case "window_summary":
      return {
        windows: readWindows(obj),
        platforms: readEnumArray(obj, "platforms", PLATFORM_ENUM),
        types: readEnumArray(obj, "types", TYPE_ENUM),
      } satisfies WindowSummaryInput;
    case "platform_breakdown":
      return { days: readDays(obj) } satisfies PlatformBreakdownInput;
    case "monthly_trend":
      return {
        months: readInt(obj, "months", MONTHS_RANGE),
        platforms: readEnumArray(obj, "platforms", PLATFORM_ENUM),
        types: readEnumArray(obj, "types", TYPE_ENUM),
      } satisfies MonthlyTrendInput;
    case "posting_times":
      return {
        days: readDays(obj),
        platforms: readEnumArray(obj, "platforms", PLATFORM_ENUM),
        groupBy: readEnum(obj, "groupBy", GROUP_BYS),
        minCount: readInt(obj, "minCount", MIN_COUNT_RANGE),
        limit: readInt(obj, "limit", LIMIT_RANGE),
      } satisfies PostingTimesInput;
    case "search_posts":
      return {
        query: readString(obj, "query", false) as string,
        days: readDays(obj),
        platforms: readEnumArray(obj, "platforms", PLATFORM_ENUM),
        limit: readInt(obj, "limit", LIMIT_RANGE),
      } satisfies SearchPostsInput;
    case "hashtag_stats":
      return {
        tags: readTags(obj),
        days: readDays(obj),
        platforms: readEnumArray(obj, "platforms", PLATFORM_ENUM),
        limit: readInt(obj, "limit", LIMIT_RANGE),
      } satisfies HashtagStatsInput;
    case "content_insights":
      return {
        section: readEnum(obj, "section", SECTIONS),
        topic: readString(obj, "topic", true),
        platforms: readEnumArray(obj, "platforms", PLATFORM_ENUM),
        limit: readInt(obj, "limit", LIMIT_RANGE),
      } satisfies ContentInsightsInput;
    case "follower_growth":
      return {} as FollowerGrowthInput;
    case "comment_insights": {
      const kind = readEnum(obj, "kind", KINDS);
      const postId = readString(obj, "postId", true);
      const query = readString(obj, "query", true);
      if (kind === "for_post" && !postId) throw new Invalid("postId is required when kind is for_post");
      if (kind === "search" && !query) throw new Invalid("query is required when kind is search");
      return {
        kind,
        postId,
        query,
        platforms: readEnumArray(obj, "platforms", PLATFORM_ENUM),
        limit: readInt(obj, "limit", LIMIT_RANGE),
      } satisfies CommentInsightsInput;
    }
    case "post_detail":
      return { idOrUrl: readString(obj, "idOrUrl", false) as string } satisfies PostDetailInput;
  }
}

/** Validate a tool call. Missing nullable fields read as null; missing
 *  required fields, out-of-range numbers, oversized arrays or strings, and
 *  unknown tools all return { ok: false, error }. Never throws. */
export function validateInput<N extends ToolName>(name: N, input: unknown): ValidationResult<ToolInputs[N]>;
export function validateInput(name: string, input: unknown): ValidationResult<ToolInput>;
export function validateInput(name: string, input: unknown): ValidationResult<ToolInput> {
  if (!isToolName(name)) return { ok: false, error: `unknown tool "${name}"` };
  try {
    return { ok: true, value: validateByName(name, objectOf(input)) };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, error: err.message };
    return { ok: false, error: "invalid input" };
  }
}
