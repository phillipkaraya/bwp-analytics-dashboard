// comment_insights (section 2.3, tool 10).
//
// sentiment with no platform filter, top_questions and top_commenters read
// the precomputed analytics sections and never open the 2.6 MB comments
// file; sentiment per platform, for_post and search load it through
// data.comments() (memoized). needsComments() tells the runner which calls
// will load it so it can fire the "Loading comments" hint first. Comment
// text is clipped to 160 characters and is data, never instructions.

import type { Comment, HighValueComment, Platform } from "../../types";
import { PLATFORMS, sentimentBreakdown, toNum } from "../../derive";
import { asOf, peekComments, postKey, type ChatData } from "../data";
import type { ToolEnvelope } from "../types";
import { COMMENT_TEXT_MAX, TITLE_MAX, clipText, emptyEnvelope, envelope, sortByValue } from "./rows";
import type { CommentInsightsInput, CommentKind } from "./validate";
import { searchTerms } from "./posts";

export interface SentimentCounts {
  positive: number;
  neutral: number;
  negative: number;
  question: number;
  total: number;
}
export interface PlatformSentimentRow extends SentimentCounts {
  platform: Platform;
}
export interface QuestionRow {
  text: string;
  username: string;
  platform: Platform;
  likes: number;
  date: string | null;
  postTitle: string | null;
  postUrl: string | null;
}
export interface CommenterRow {
  username: string;
  count: number;
  platforms: Platform[];
}
export interface CommentRow {
  username: string;
  text: string;
  likes: number;
  date: string;
  sentiment: "positive" | "neutral" | "negative";
  isQuestion: boolean;
  platform: Platform;
  postId: string | null;
  postTitle: string | null;
}

export interface CommentInsightsResult {
  kind: CommentKind;
  counts: Record<string, number>;
  byPlatform?: PlatformSentimentRow[];
  rows: QuestionRow[] | CommenterRow[] | CommentRow[];
}

/** Whether this call will open the comments file. The runner fires its
 *  loading hint when this is true and nothing is loaded yet. */
export function needsComments(data: ChatData, name: string, input: unknown): boolean {
  if (data.posts.length === 0) return false;
  if (name === "post_detail") return true;
  if (name !== "comment_insights") return false;
  const obj = input && typeof input === "object" ? (input as { kind?: unknown; platforms?: unknown }) : {};
  if (obj.kind === "for_post" || obj.kind === "search") return true;
  if (obj.kind === "sentiment") {
    return (Array.isArray(obj.platforms) && obj.platforms.length > 0) || !data.analytics.commentSentiment;
  }
  return false;
}

function countsOf(comments: readonly Comment[]): SentimentCounts {
  return { ...sentimentBreakdown([...comments]), total: comments.length };
}

function inPlatforms(platform: Platform, platforms: readonly Platform[] | null): boolean {
  return platforms === null || platforms.includes(platform);
}

function commentRow(c: Comment, byKey: Map<string, PostRef>): CommentRow {
  const post = typeof c.postId === "string" ? byKey.get(postKey(c.postId)) : undefined;
  return {
    username: c.username,
    text: clipText(c.text, COMMENT_TEXT_MAX),
    likes: toNum(c.likes),
    date: c.date,
    sentiment: c.sentiment ?? "neutral",
    isQuestion: !!c.isQuestion,
    platform: c.platform,
    postId: post?.id ?? null,
    postTitle: post?.title ?? null,
  };
}

interface PostRef {
  id: string;
  title: string;
  date: string;
  url: string | null;
}

function postIndex(data: ChatData): Map<string, PostRef> {
  const byKey = new Map<string, PostRef>();
  for (const p of data.posts) {
    const key = postKey(p.id);
    if (!byKey.has(key)) byKey.set(key, { id: p.id, title: clipText(p.title || p.caption, TITLE_MAX) || "(no title)", date: p.date, url: p.url ?? null });
  }
  return byKey;
}

export async function runCommentInsights(data: ChatData, input: CommentInsightsInput): Promise<ToolEnvelope<CommentInsightsResult>> {
  const filters: Record<string, unknown> = { ...input };
  if (data.posts.length === 0) {
    return emptyEnvelope(data, "all time", filters, { kind: input.kind, counts: {}, rows: [] });
  }
  const platforms = input.platforms;
  const notes: string[] = [];
  const dates = asOf(data);
  if (dates.comments) notes.push(`Comments were last collected on ${dates.comments}; posts run to ${dates.posts}`);

  const finish = (body: CommentInsightsResult, loaded: readonly Comment[] | null): ToolEnvelope<CommentInsightsResult> => {
    const noLinkedIn = loaded
      ? !loaded.some((c) => c.platform === "linkedin")
      : data.analytics.audienceOverlap?.platformBreakdown?.linkedin === 0;
    if (noLinkedIn && (platforms === null || platforms.includes("linkedin"))) notes.push("LinkedIn has no comments in the snapshot");
    return envelope(data, "all time", filters, notes, body);
  };

  switch (input.kind) {
    case "sentiment": {
      const precomputed = data.analytics.commentSentiment;
      if (platforms === null && precomputed) {
        const positive = toNum(precomputed.positive);
        const neutral = toNum(precomputed.neutral);
        const negative = toNum(precomputed.negative);
        const counts: SentimentCounts = {
          positive,
          neutral,
          negative,
          question: toNum(data.analytics.questionCount),
          total: positive + neutral + negative,
        };
        notes.push("Sentiment labels come from the dashboard's classifier; question is counted independently of sentiment");
        return finish({ kind: "sentiment", counts: { ...counts }, rows: [] }, null);
      }
      const all = await data.comments();
      const selected = all.filter((c) => inPlatforms(c.platform, platforms));
      const byPlatform: PlatformSentimentRow[] = PLATFORMS.filter((p) => inPlatforms(p, platforms)).map((platform) => ({
        platform,
        ...countsOf(selected.filter((c) => c.platform === platform)),
      }));
      notes.push("Sentiment labels come from the dashboard's classifier; question is counted independently of sentiment");
      return finish({ kind: "sentiment", counts: { ...countsOf(selected) }, byPlatform, rows: [] }, all);
    }
    case "top_questions": {
      const all = (data.analytics.highValueComments ?? []) as Array<HighValueComment & { postTitle?: unknown }>;
      const selected = all.filter((c) => inPlatforms(c.platform, platforms));
      const byKey = postIndex(data);
      const rows: QuestionRow[] = selected.slice(0, input.limit).map((c) => {
        const post = c.postId ? byKey.get(postKey(c.postId)) : undefined;
        return {
          text: clipText(c.text, COMMENT_TEXT_MAX), username: c.username, platform: c.platform,
          likes: toNum(c.likes), date: c.date ?? null,
          postTitle: post?.title ?? (typeof c.postTitle === "string" && c.postTitle.trim() ? clipText(c.postTitle, TITLE_MAX) : null),
          postUrl: post?.url ?? (c.postUrl || null),
        };
      });
      notes.push("Ranked by likes on the comment; the dashboard keeps the top 50 questions");
      return finish(
        { kind: "top_questions", counts: { questions: toNum(data.analytics.questionCount), listed: rows.length, available: selected.length }, rows },
        null,
      );
    }
    case "top_commenters": {
      const all = data.analytics.topCommenters ?? [];
      const selected = all.filter((c) => platforms === null || c.platforms.some((p) => platforms.includes(p)));
      const rows: CommenterRow[] = selected.slice(0, input.limit).map((c) => ({
        username: c.username,
        count: c.count,
        platforms: c.platforms,
      }));
      notes.push("count is comments across the whole snapshot; the dashboard keeps the top 30 commenters");
      return finish({ kind: "top_commenters", counts: { listed: rows.length, available: selected.length }, rows }, null);
    }
    case "for_post": {
      const key = postKey(input.postId ?? "");
      const byKey = postIndex(data);
      const post = byKey.get(key);
      if (!post) throw new Error(`No post matches "${clipText(input.postId ?? "", 80)}". Pass an id from an earlier result.`);
      const all = await data.comments();
      const mine = all.filter((c) => typeof c.postId === "string" && postKey(c.postId) === key);
      const rows = sortByValue(mine, (c) => toNum(c.likes), "desc", (c) => c.id)
        .slice(0, input.limit)
        .map((c) => commentRow(c, byKey));
      const counts = countsOf(mine);
      if (mine.length === 0 && dates.comments && post.date > dates.comments) {
        notes.push("This post is newer than the comment snapshot, so no comments are loaded for it");
      }
      if (mine.length > rows.length) notes.push(`Showing the ${rows.length} most liked of ${mine.length} comments`);
      return finish({ kind: "for_post", counts: { comments: mine.length, ...counts }, rows }, all);
    }
    case "search": {
      const terms = searchTerms(input.query ?? "");
      const all = await data.comments();
      const byKey = postIndex(data);
      const matched = all.filter((c) => inPlatforms(c.platform, platforms) && terms.length > 0 && terms.every((t) => c.text.toLowerCase().includes(t)));
      const rows = sortByValue(matched, (c) => toNum(c.likes), "desc", (c) => c.id)
        .slice(0, input.limit)
        .map((c) => commentRow(c, byKey));
      if (matched.length > rows.length) notes.push(`Showing the ${rows.length} most liked of ${matched.length} matches`);
      if (matched.length === 0) notes.push("No comment contains every word; try fewer words");
      return finish({ kind: "search", counts: { matches: matched.length, ...countsOf(matched) }, rows }, all);
    }
  }
}

/** True when the comments file has already been loaded for this dataset. */
export function commentsLoaded(data: ChatData): boolean {
  return peekComments(data) !== null;
}
