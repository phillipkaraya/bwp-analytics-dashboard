"use client";

// One turn: the user bubble and the assistant bubble (section 4.4). Inside
// the assistant bubble, in order: tool trace, text with card rails after the
// paragraphs that cite them, footer line, then the error or stop block.

import { useMemo, type ReactNode } from "react";
import { PlatformBadge } from "@/components/charts/platform-badge";
import { Button } from "@/components/ui/button";
import { PLATFORMS } from "@/lib/derive";
import type { Platform, Post } from "@/lib/types";
import type { ContentVault } from "@/lib/types";
import type { ChatTurn, ToolTrace as ToolTraceItem } from "@/lib/chat/types";
import type { TurnMeta } from "@/lib/chat/use-chat";
import { extractCitations, holdIncompleteMarkers, normalizeVoice, renderMarkdown } from "@/lib/chat/markdown";
import { toRow } from "@/lib/chat/tools/rows";
import { PostCardRail, type CardData } from "./post-card";
import { StateBlock, type StateTone } from "./state-block";
import { ToolTrace } from "./tool-trace";

export const CONTINUE_TEXT = "Continue from where you stopped.";

// Card resolution

const PLATFORM_SET = new Set<string>(PLATFORMS);

/** Every row-shaped object in a tool result that names a post: PostRow, a
 *  post_detail post, a cross-post leg, a viral post. Keyed by id, first
 *  occurrence wins so the ranked row beats a nested mention. */
function collectRows(value: unknown, out: Map<string, Record<string, unknown>>, depth = 0): void {
  if (depth > 8 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectRows(item, out, depth + 1);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.id === "string" && typeof obj.platform === "string" && PLATFORM_SET.has(obj.platform)) {
    if (!out.has(obj.id)) out.set(obj.id, obj);
  }
  for (const v of Object.values(obj)) collectRows(v, out, depth + 1);
}

function rowToCard(row: Record<string, unknown>, post: Post | undefined): CardData | null {
  const id = String(row.id);
  const platform = row.platform as Platform;
  let reach: number | null = null;
  let reachMetric: "views" | "likes" = "views";
  if (typeof row.reach === "number" && (row.reachMetric === "views" || row.reachMetric === "likes")) {
    reach = row.reach;
    reachMetric = row.reachMetric;
  } else if (typeof row.views === "number") {
    reach = row.views;
    reachMetric = "views";
  } else if (typeof row.likes === "number") {
    reach = row.likes;
    reachMetric = "likes";
  }
  if (reach === null) return null;
  return {
    id,
    platform,
    date: typeof row.date === "string" ? row.date : (post?.date ?? ""),
    title: typeof row.title === "string" ? row.title : (post?.title ?? post?.caption ?? ""),
    reach,
    reachMetric,
    url: typeof row.url === "string" ? row.url : (post?.url ?? null),
    thumbnailUrl: post?.thumbnailUrl ?? null,
  };
}

function postToCard(post: Post, vault: ContentVault): CardData {
  const row = toRow(post, 0, vault);
  return {
    id: post.id,
    platform: post.platform,
    date: row.date,
    title: row.title,
    reach: row.reach,
    reachMetric: row.reachMetric,
    url: row.url,
    thumbnailUrl: post.thumbnailUrl ?? null,
  };
}

interface ParsedResults {
  /** Post-shaped rows across every result, by id. */
  byId: Map<string, Record<string, unknown>>;
  /** The `rows` array of the last post-returning result, for "From the data". */
  lastRows: Record<string, unknown>[];
}

function parseResults(traces: readonly ToolTraceItem[]): ParsedResults {
  const byId = new Map<string, Record<string, unknown>>();
  let lastRows: Record<string, unknown>[] = [];
  for (const trace of traces) {
    if (trace.isError || typeof trace.result !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trace.result);
    } catch {
      continue;
    }
    collectRows(parsed, byId);
    const rows = (parsed as { rows?: unknown })?.rows;
    if (Array.isArray(rows)) {
      const postRows = rows.filter(
        (r): r is Record<string, unknown> =>
          !!r && typeof r === "object" && typeof (r as { id?: unknown }).id === "string" && "reachMetric" in r,
      );
      if (postRows.length > 0) lastRows = postRows;
    }
  }
  return { byId, lastRows };
}

// Copy for the end states (section 1.5)

interface EndBlock {
  tone: StateTone;
  eyebrow: string;
  text: string;
  mono?: boolean;
  action: "retry" | "editKey" | "newChat" | "rest" | null;
}

function describeEnd(turn: ChatTurn): EndBlock | null {
  switch (turn.end) {
    case null:
    case "done":
      return null;
    case "refused":
      return {
        tone: "neutral",
        eyebrow: "Declined",
        text: "The assistant declined that one. Try asking about the numbers directly.",
        action: null,
      };
    case "aborted":
      return { tone: "neutral", eyebrow: "Stopped", text: "You stopped this answer.", action: null };
    case "truncated":
      return { tone: "warn", eyebrow: "Cut short", text: "The answer hit its length limit.", action: "rest" };
    case "tool_cap":
      return {
        tone: "neutral",
        eyebrow: "Lookup budget used",
        text: "The assistant used its lookup budget for this question and answered with what it had.",
        action: null,
      };
    case "error": {
      const err = turn.error;
      switch (err?.code) {
        case "no_key":
          return { tone: "negative", eyebrow: "No key", text: "Add your Anthropic API key to ask questions.", action: "editKey" };
        case "bad_key":
          return {
            tone: "negative",
            eyebrow: "Key not accepted",
            text: "Anthropic rejected that key. Check it in the console or paste a new one.",
            action: "editKey",
          };
        case "forbidden":
          return {
            tone: "negative",
            eyebrow: "Not allowed",
            text: "This account cannot complete the request. Check credits, workspace permissions and model access in the Anthropic console.",
            action: "editKey",
          };
        case "rate_limited":
          return {
            tone: "warn",
            eyebrow: "Slow down",
            text: `Anthropic is rate limiting this key. Try again ${
              typeof err.retryAfterSec === "number" && err.retryAfterSec > 0
                ? `in ${Math.ceil(err.retryAfterSec)} seconds.`
                : "in a moment."
            }`,
            action: "retry",
          };
        case "overloaded":
          return { tone: "warn", eyebrow: "Busy", text: "Anthropic is busy right now. Try again shortly.", action: "retry" };
        case "server":
          return {
            tone: "warn",
            eyebrow: "Server error",
            text: "Anthropic returned an error. Nothing is wrong on your side.",
            action: "retry",
          };
        case "network":
          return {
            tone: "warn",
            eyebrow: "Offline",
            text: "Could not reach api.anthropic.com. Check the connection and any ad blocker, then try again.",
            action: "retry",
          };
        case "bad_request":
          return {
            tone: "negative",
            eyebrow: "Request refused",
            text: normalizeVoice(err.message || "Anthropic refused the request."),
            mono: true,
            action: "retry",
          };
        case "context":
          return {
            tone: "warn",
            eyebrow: "Long conversation",
            text: "This chat is too long to continue. Start a new chat.",
            action: "newChat",
          };
        default:
          return {
            tone: "warn",
            eyebrow: "Something went wrong",
            text: normalizeVoice(err?.message || "The request did not complete. Try again."),
            action: "retry",
          };
      }
    }
  }
}

// Bubble

interface ChatMessageProps {
  turn: ChatTurn;
  meta?: TurnMeta;
  /** This is the turn currently streaming. */
  live: boolean;
  /** Extra running chip on the live turn (comments loading). */
  hint?: string | null;
  showUsage: boolean;
  postsById: ReadonlyMap<string, Post>;
  vault: ContentVault | null;
  onRetry: () => void;
  onEditKey: () => void;
  onNewChat: () => void;
  onSend: (text: string) => void;
}

const DOT_DELAYS = ["0ms", "150ms", "300ms"];

export function ChatMessage({
  turn,
  meta,
  live,
  hint,
  showUsage,
  postsById,
  vault,
  onRetry,
  onEditKey,
  onNewChat,
  onSend,
}: ChatMessageProps) {
  const parsed = useMemo(() => parseResults(turn.traces), [turn.traces]);
  const flagged = useMemo(() => new Set(meta?.flags ?? []), [meta]);

  const resolveCards = useMemo(
    () =>
      (ids: string[]): CardData[] => {
        const out: CardData[] = [];
        for (const id of ids) {
          const post = postsById.get(id);
          const row = parsed.byId.get(id);
          const card = row ? rowToCard(row, post) : post && vault ? postToCard(post, vault) : null;
          if (card) out.push(card);
        }
        return out;
      },
    [parsed, postsById, vault],
  );

  const voiced = normalizeVoice(turn.assistant);
  const text = live ? holdIncompleteMarkers(voiced) : voiced;
  const hasCitations = extractCitations(turn.assistant).ids.length > 0;
  const hasText = text.trim().length > 0;

  const rendered: ReactNode = useMemo(
    () =>
      renderMarkdown(text, {
        flagged,
        platformBadge: (platform) => <PlatformBadge platform={platform} size="sm" />,
        cards: (ids) => {
          const cards = resolveCards(ids);
          return cards.length > 0 ? <PostCardRail cards={cards} /> : null;
        },
      }),
    [text, flagged, resolveCards],
  );

  const fromData = useMemo(() => {
    if (live || hasCitations || turn.end === null || parsed.lastRows.length === 0) return [];
    return parsed.lastRows
      .slice(0, 3)
      .map((row) => rowToCard(row, postsById.get(String(row.id))))
      .filter((c): c is CardData => c !== null);
  }, [live, hasCitations, turn.end, parsed, postsById]);

  const end = describeEnd(turn);
  const usage = turn.usage;
  const cachedPct =
    usage && usage.input + usage.cacheRead + usage.cacheWrite > 0
      ? Math.round((usage.cacheRead / (usage.input + usage.cacheRead + usage.cacheWrite)) * 100)
      : null;
  const lookups = turn.traces.length;
  const footer =
    !live && turn.end !== null && showUsage
      ? [
          `${lookups} ${lookups === 1 ? "lookup" : "lookups"}`,
          meta?.ms != null ? `${(meta.ms / 1000).toFixed(1)}s` : null,
          cachedPct !== null ? `${cachedPct}% cached` : null,
        ]
          .filter((s): s is string => !!s)
          .join(" · ")
      : null;

  const showDots = live && !hasText && turn.traces.length === 0 && turn.end === null;
  const showThinkingChip = live && !hasText && turn.traces.length === 0;

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg rounded-tr-sm bg-brand-soft px-3.5 py-2.5 text-sm text-ink whitespace-pre-wrap break-words">
          {turn.user}
        </div>
      </div>
      <div className="flex justify-start">
        <div className="max-w-[95%] min-w-0 rounded-lg rounded-bl-sm bg-card px-4 py-3 text-sm text-ink-soft ring-1 ring-foreground/5 rise">
          <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">Assistant</div>
          <ToolTrace traces={turn.traces} thinking={showThinkingChip} hint={live ? hint : null} />
          {showDots && (
            <span className="inline-flex gap-1" aria-hidden>
              {DOT_DELAYS.map((delay) => (
                <span
                  key={delay}
                  className="size-1.5 rounded-full bg-ink-muted motion-safe:animate-pulse"
                  style={{ animationDelay: delay }}
                />
              ))}
            </span>
          )}
          {hasText && (
            <div className="break-words [&>p:first-child]:mt-0 [&>p:last-child]:mb-0">
              {rendered}
              {live && (
                <span aria-hidden className="ml-0.5 text-brand motion-safe:animate-pulse">
                  ▍
                </span>
              )}
            </div>
          )}
          {fromData.length > 0 && <PostCardRail cards={fromData} eyebrow="From the data" />}
          {footer && (
            <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted/80">{footer}</div>
          )}
          {end && (
            <StateBlock
              tone={end.tone}
              eyebrow={end.eyebrow}
              mono={end.mono}
              className="mt-3"
              action={
                end.action === "retry" ? (
                  <Button variant="outline" size="xs" onClick={onRetry}>
                    Retry
                  </Button>
                ) : end.action === "editKey" ? (
                  <Button variant="outline" size="xs" onClick={onEditKey}>
                    Edit key
                  </Button>
                ) : end.action === "newChat" ? (
                  <Button variant="outline" size="xs" onClick={onNewChat}>
                    New chat
                  </Button>
                ) : end.action === "rest" ? (
                  <button
                    type="button"
                    onClick={() => onSend(CONTINUE_TEXT)}
                    className="shrink-0 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-ink-soft transition outline-none hover:border-brand/50 hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    Ask for the rest
                  </button>
                ) : undefined
              }
            >
              {end.text}
            </StateBlock>
          )}
        </div>
      </div>
    </div>
  );
}
