// The tool executor (section 2.1): validate, dispatch, size cap, error
// envelope. createToolRunner(data, hooks) returns the ToolRunner the provider
// calls for every tool_use block. It never throws: validation failures and
// tool errors come back as { isError: true, content: '{"error":"…"}' }.
// hooks.onCommentsLoading fires before the first load of the comments file
// so the UI can show its "Loading comments" hint.

import type { ChatData } from "../data";
import { peekComments } from "../data";
import type { ToolEnvelope, ToolOutcome, ToolRunner } from "../types";
import { needsComments, runCommentInsights } from "./comments";
import { runFollowerGrowth } from "./followers";
import { runHashtagStats } from "./hashtags";
import { runContentInsights } from "./insights";
import { runPostDetail, runSearchPosts, runTopPosts } from "./posts";
import { runPostingTimes } from "./times";
import { validateInput, type ToolInputs, type ToolName } from "./validate";
import { runMonthlyTrend, runPlatformBreakdown, runWindowSummary } from "./windows";

export interface ToolRunnerHooks {
  /** Fired once, before the first comments file load of this runner. */
  onCommentsLoading?: () => void;
}

/** JSON.stringify(result).length must stay at or under this. */
export const TOOL_RESULT_MAX_CHARS = 8000;

export type AnyEnvelope = ToolEnvelope<object>;

type Runner<N extends ToolName> = (data: ChatData, input: ToolInputs[N]) => AnyEnvelope | Promise<AnyEnvelope>;

const RUNNERS: { [N in ToolName]: Runner<N> } = {
  top_posts: runTopPosts,
  window_summary: runWindowSummary,
  platform_breakdown: runPlatformBreakdown,
  monthly_trend: runMonthlyTrend,
  posting_times: runPostingTimes,
  search_posts: runSearchPosts,
  hashtag_stats: runHashtagStats,
  content_insights: runContentInsights,
  follower_growth: runFollowerGrowth,
  comment_insights: runCommentInsights,
  post_detail: runPostDetail,
};

/** Run one validated tool. Throws on a tool error (the runner catches). */
export async function runTool<N extends ToolName>(data: ChatData, name: N, input: ToolInputs[N]): Promise<AnyEnvelope> {
  const run = RUNNERS[name] as Runner<N>;
  return run(data, input);
}

export function truncationNote(rows: number): string {
  return `truncated to ${rows} rows; ask for a narrower window or platform`;
}

/** The top-level array to cut when the result is too large: the longest one
 *  apart from notes. */
function mainArrayKey(env: Record<string, unknown>): string | null {
  let best: string | null = null;
  let size = 0;
  for (const [key, value] of Object.entries(env)) {
    if (key === "notes" || !Array.isArray(value)) continue;
    if (value.length > size) {
      best = key;
      size = value.length;
    }
  }
  return best;
}

/** Serialise an envelope under the size cap, cutting the main array from the
 *  tail and adding the truncation note when it does not fit as is. */
export function capResult(env: AnyEnvelope, max: number = TOOL_RESULT_MAX_CHARS): { content: string; truncatedTo: number | null } {
  const full = JSON.stringify(env);
  if (full.length <= max) return { content: full, truncatedTo: null };
  const record = env as unknown as Record<string, unknown>;
  const key = mainArrayKey(record);
  if (key === null) return { content: full, truncatedTo: null };
  const rows = record[key] as unknown[];
  const baseNotes = Array.isArray(env.notes) ? env.notes : [];
  for (let n = rows.length; n >= 0; n -= 1) {
    const cut = { ...record, [key]: rows.slice(0, n), notes: [...baseNotes, truncationNote(n)] };
    const text = JSON.stringify(cut);
    if (text.length <= max || n === 0) return { content: text, truncatedTo: n };
  }
  return { content: full, truncatedTo: null };
}

export function errorOutcome(message: string): ToolOutcome {
  return { isError: true, content: JSON.stringify({ error: message }) };
}

function messageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "tool failed";
}

export function createToolRunner(data: ChatData, hooks?: ToolRunnerHooks): ToolRunner {
  let hinted = false;
  return async (name, input) => {
    const checked = validateInput(name, input);
    if (!checked.ok) return errorOutcome(checked.error);
    try {
      if (!hinted && hooks?.onCommentsLoading && needsComments(data, name, checked.value) && peekComments(data) === null) {
        hinted = true;
        hooks.onCommentsLoading();
      }
      const env = await runTool(data, name as ToolName, checked.value as never);
      return { isError: false, content: capResult(env).content };
    } catch (err) {
      return errorOutcome(messageOf(err));
    }
  };
}
