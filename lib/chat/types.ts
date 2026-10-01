// Provider seam and shared shapes for the in-dashboard assistant.
// No import from @anthropic-ai/sdk anywhere in this file: the UI, the tools
// and the transcript all speak these types, and only providers/anthropic-key.ts
// knows the SDK exists.

import type { Platform } from "../types";

export type ProviderId = "anthropic-key" | "local-cli";
export type Effort = "medium" | "high";

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required: string[]; // every property name, always
  additionalProperties: false;
}
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
}

export interface ToolOutcome {
  content: string; // JSON text
  isError: boolean;
}
export type ToolRunner = (name: string, input: unknown, signal?: AbortSignal) => Promise<ToolOutcome>;

export interface SendHandlers {
  onRestart?(keepChars: number, dropToolIds: string[]): void;
  onThinking(): void;
  onText(delta: string): void;
  onToolCall(call: { id: string; name: string; input: unknown | null }): void; // input null at content_block_start
  onToolInput(id: string, input: unknown): void;
  onToolResult(id: string, outcome: ToolOutcome, ms: number): void;
  onUsage?(u: Usage): void;
}
export interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export type TurnEnd =
  | { kind: "done" }
  | { kind: "refused" }
  | { kind: "aborted" }
  | { kind: "truncated" }
  | { kind: "tool_cap" }
  | { kind: "error"; error: ChatError };

export interface ChatError extends Error {
  code:
    | "no_key"
    | "bad_key"
    | "forbidden"
    | "rate_limited"
    | "overloaded"
    | "server"
    | "network"
    | "bad_request"
    | "context"
    | "unknown";
  retryAfterSec?: number;
  status?: number;
}

/** Never holds the key. The key has its own storage item (settings.ts). */
export interface ChatSettings {
  v: 1;
  provider: ProviderId;
  effort: Effort;
  showUsage: boolean;
}

export type Readiness =
  | { ok: true }
  | { ok: false; reason: "no_key" | "unavailable" | "offline"; detail?: string };

export interface ChatSession {
  readonly provider: ProviderId;
  send(userText: string, handlers: SendHandlers, signal: AbortSignal): Promise<TurnEnd>;
  reset(): void; // drops private history, re-pins the clock and the data card
  resume(turns: ChatTurn[]): void; // rebuilds text-only history from a stored transcript
}

export interface ChatProvider {
  id: ProviderId;
  label: string; // "Anthropic API key" | "Local CLI (Claude, Codex or Gemini)"
  needsKey: boolean;
  readiness(deps: { getKey(): string | null; isLocalhost: boolean }): Promise<Readiness>;
  validateKey?(key: string): Promise<"ok" | "rejected" | "offline" | "blocked" | "limited">;
  createSession(args: {
    settings: ChatSettings;
    getKey(): string | null;
    system: { rules: string; dataCard: () => string }; // dataCard() is re-evaluated per send for the version check
    tools: ToolDef[];
    runTool: ToolRunner;
    fetch?: typeof fetch;
  }): ChatSession;
}

export interface ToolTrace {
  id: string;
  name: string;
  input: unknown;
  label: string;
  result: string | null;
  isError: boolean;
  ms: number | null;
  status: "running" | "done" | "error";
}
export interface ChatTurn {
  id: string;
  at: string;
  user: string;
  assistant: string; // final text, citations kept in the stored text
  traces: ToolTrace[];
  end: TurnEnd["kind"] | null; // null while streaming
  usage?: Usage;
  error?: { code: ChatError["code"]; message: string; retryAfterSec?: number };
}

// Tool output shapes (section 2.1)

/** One post as every post-returning tool reports it. Never a whole Post:
 *  no caption beyond the title clip, no thumbnail, no raw fields. */
export interface PostRow {
  rank: number;
  id: string;
  platform: Platform;
  type: string | null;
  date: string;
  title: string; // clipped to 90 chars
  reach: number;
  reachMetric: "views" | "likes";
  views: number | "not measured";
  likes: number;
  comments: number;
  shares: number | null; // TikTok shares, Threads reposts and LinkedIn reposts
  saves: number | null; // null outside TikTok
  engagementRate: number | "not measured"; // toNum(), 2 dp
  topics: string[]; // vault.byPost[id] ?? []
  url: string | null;
}

export type ToolWindow = { days: number; start: string; end: string } | "all time";

export type ToolEnvelope<T> = {
  ok: true;
  asOf: { posts: string; comments: string | null }; // date part of analytics.dataAsOf, else newest post date
  window: ToolWindow;
  filters: Record<string, unknown>; // echo of the validated input
  notes: string[]; // caveats the model must relay when it uses the rows
} & T;
