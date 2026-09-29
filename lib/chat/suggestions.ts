// Data-aware suggestion chips (section 4.3).
//
// suggestions(data) picks the smallest window that holds at least five posts
// so the first chip never leads the assistant into a two-post window, and
// hides chips whose data is absent (no hashtags, no comment questions).
//
// Relative imports only: tsx runs this in Node without the Next alias.

import type { ChatData } from "./data";
import { applyFilters } from "./tools/rows";

/** Windows tried in order for the chip window. */
export const SUGGESTION_WINDOWS: readonly number[] = [30, 60, 90, 180, 365];
export const MIN_POSTS_FOR_WINDOW = 5;
export const MAX_SUGGESTIONS = 8;

/** The "Ask next" rotation, minus the ones already sent. */
export const FOLLOW_UPS: readonly string[] = [
  "Show the top 10 as a table",
  "Same for TikTok",
  "Widen to 365 days",
  "What should I do next?",
];

/** Smallest window with at least five posts, or null for all time. */
export function pickSuggestionWindow(data: ChatData): number | null {
  const now = data.now();
  for (const days of SUGGESTION_WINDOWS) {
    if (applyFilters(data.posts, { days }, now).length >= MIN_POSTS_FOR_WINDOW) return days;
  }
  return null;
}

export function suggestions(data: ChatData): string[] {
  const now = data.now();
  const days = pickSuggestionWindow(data);
  const span = days === null ? "of all time" : `in the last ${days} days`;
  const reels = applyFilters(data.posts, { days, platforms: ["instagram"], types: ["reel"] }, now).length;
  const postsWithHashtags = data.posts.filter(
    (p) => typeof p.hashtags === "string" && p.hashtags.trim().length > 0,
  ).length;
  const questionCount = Number(data.analytics.questionCount ?? 0) || 0;
  const commentCount = Object.values(data.analytics.commentSentiment ?? {}).reduce<number>(
    (sum, v) => sum + (typeof v === "number" ? v : 0),
    0,
  );

  const chips: string[] = [];
  chips.push(`Best posts ${span}`);
  chips.push(reels > 0 ? `Best reels ${span}` : `Best short form videos ${span}`);
  chips.push("Which platform grew the most?");
  if (days !== null) chips.push(`Compare the last ${days} days with the ${days} before`);
  chips.push("When is the best time to post?");
  chips.push("Which hooks get the most views?");
  if (postsWithHashtags > 0) chips.push("Which hashtags are working?");
  if (questionCount > 0 && commentCount > 0) chips.push("What are people asking in the comments?");
  chips.push("Which topics pull the most views?");
  return chips.slice(0, MAX_SUGGESTIONS);
}

/** Two "Ask next" chips not sent yet in this chat. */
export function followUps(sent: readonly string[], count = 2): string[] {
  const used = new Set(sent.map((s) => s.trim().toLowerCase()));
  return FOLLOW_UPS.filter((f) => !used.has(f.toLowerCase())).slice(0, count);
}
