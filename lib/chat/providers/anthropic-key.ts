// The Anthropic API-key provider (sections 1.1, 1.3, 1.5 and the loop rules).
//
// This is the only file in lib/chat that knows @anthropic-ai/sdk exists. The
// SDK itself is loaded by dynamic import on the first send so it stays out of
// every page bundle; only its version constant is imported statically (a one
// line module). Everything model-facing lives here: the request shape, the
// two cache breakpoints, the tool loop with its 8-iteration budget, the
// stop_reason branching, the data-card version check that collapses history
// to text-only turns, and toChatError(), the single place SDK error classes
// become ChatError codes.
//
// Never log, print or embed the key. It is read through getKey() at send
// time and handed straight to the SDK client.

import type Anthropic from "@anthropic-ai/sdk";
import { VERSION } from "@anthropic-ai/sdk/version";
import type {
  ChatError,
  ChatProvider,
  ChatSession,
  ChatTurn,
  Readiness,
  SendHandlers,
  ToolDef,
  ToolOutcome,
  TurnEnd,
  Usage,
} from "../types";

export const CHAT_MODEL = "claude-opus-5-5";
export const MAX_OUTPUT_TOKENS = 8000;
/** The one-time re-issue ceiling when a tool_use block was cut off at max_tokens. */
export const RETRY_OUTPUT_TOKENS = 16000;
export const MAX_TOOL_ITERATIONS = 8;
/** Text-only turns kept when the context window overflows. */
export const CONTEXT_COLLAPSE_TURNS = 8;
export const SDK_VERSION: string = VERSION;
export const CLIENT_TIMEOUT_MS = 90_000;
export const KEY_PROBE_TIMEOUT_MS = 15_000;

export const TOOL_BUDGET_MESSAGE =
  "Tool budget for this question is used up. Answer with what you already have and say what you could not check.";

type SdkModule = typeof import("@anthropic-ai/sdk");
type SdkClient = InstanceType<SdkModule["default"]>;

type CreateSessionArgs = Parameters<ChatProvider["createSession"]>[0];

/** Extra knobs for tests and the dev mock: none of them ship in the UI path. */
export interface AnthropicSessionOptions {
  /** SDK retries on 429, 5xx and connection errors. 2 in the app, 0 in tests. */
  maxRetries?: number;
  timeoutMs?: number;
}

export interface AnthropicProviderOptions extends AnthropicSessionOptions {
  /** Fetch override for the dev mock; a session's own `fetch` wins over it. */
  fetch?: typeof fetch;
}

let sdkPromise: Promise<SdkModule> | null = null;

/** Dynamic import, memoized. A failed load clears the memo so a later send
 *  can try again (a flaky network on the first click must not be permanent). */
function loadSdk(): Promise<SdkModule> {
  if (!sdkPromise) {
    sdkPromise = import("@anthropic-ai/sdk").catch((err: unknown) => {
      sdkPromise = null;
      throw err;
    });
  }
  return sdkPromise;
}

function inBrowser(): boolean {
  return typeof window !== "undefined";
}

// Errors

export function makeChatError(
  code: ChatError["code"],
  message: string,
  extra: { status?: number; retryAfterSec?: number } = {},
): ChatError {
  const err = new Error(message) as ChatError;
  err.name = "ChatError";
  err.code = code;
  if (extra.status !== undefined) err.status = extra.status;
  if (extra.retryAfterSec !== undefined) err.retryAfterSec = extra.retryAfterSec;
  return err;
}

function headerValue(headers: unknown, name: string): string | null {
  if (!headers) return null;
  const h = headers as { get?: (n: string) => string | null } & Record<string, unknown>;
  if (typeof h.get === "function") {
    const v = h.get(name);
    return typeof v === "string" ? v : null;
  }
  const direct = h[name] ?? h[name.toLowerCase()];
  return typeof direct === "string" ? direct : null;
}

/** Seconds to wait from a retry-after header (integer seconds or an HTTP
 *  date), or retry-after-ms. Undefined when absent or unparseable. */
export function parseRetryAfter(headers: unknown, now: number = Date.now()): number | undefined {
  const ms = headerValue(headers, "retry-after-ms");
  if (ms && /^\d+(\.\d+)?$/.test(ms.trim())) {
    const n = Math.ceil(parseFloat(ms) / 1000);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const raw = headerValue(headers, "retry-after");
  if (!raw) return undefined;
  const text = raw.trim();
  if (/^\d+$/.test(text)) return parseInt(text, 10);
  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/** The API's own message when the SDK carried one, else the SDK message. */
function apiMessage(err: { message: string; error?: unknown }): string {
  const body = err.error as { error?: { message?: unknown }; message?: unknown } | undefined;
  const nested = body?.error?.message ?? body?.message;
  if (typeof nested === "string" && nested.trim()) return nested;
  return err.message;
}

/** instanceof on the SDK classes, most specific first, never string matching.
 *  The single console.warn allowed in lib/chat lives here, for an SDK error
 *  no branch maps; it prints the class name and status only. */
export function toChatError(err: unknown, sdk: SdkModule): ChatError {
  if (err instanceof sdk.APIError && err.type) {
    const codes: Record<string, ChatError["code"]> = {
      overloaded_error: "overloaded", api_error: "server", rate_limit_error: "rate_limited",
      invalid_request_error: "bad_request", authentication_error: "bad_key", permission_error: "forbidden",
      billing_error: "forbidden", not_found_error: "forbidden",
    };
    const code = codes[err.type];
    if (code) return makeChatError(code, apiMessage(err), { status: err.status, retryAfterSec: parseRetryAfter(err.headers) });
  }
  if (err instanceof sdk.APIUserAbortError) {
    return makeChatError("unknown", "The request was stopped.");
  }
  if (err instanceof sdk.AuthenticationError) {
    return makeChatError("bad_key", apiMessage(err), { status: err.status });
  }
  if (err instanceof sdk.PermissionDeniedError) {
    return makeChatError("forbidden", apiMessage(err), { status: err.status });
  }
  if (err instanceof sdk.RateLimitError) {
    return makeChatError("rate_limited", apiMessage(err), {
      status: err.status,
      retryAfterSec: parseRetryAfter(err.headers),
    });
  }
  if (err instanceof sdk.BadRequestError) {
    return makeChatError("bad_request", apiMessage(err), { status: err.status });
  }
  if (err instanceof sdk.InternalServerError) {
    const code = err.status === 529 ? "overloaded" : "server";
    return makeChatError(code, apiMessage(err), { status: err.status, retryAfterSec: parseRetryAfter(err.headers) });
  }
  if (err instanceof sdk.APIConnectionError) {
    // APIConnectionTimeoutError extends this class, so timeouts land here too.
    return makeChatError("network", err.message);
  }
  if (err instanceof sdk.NotFoundError || (err instanceof sdk.APIError && err.status === 402)) {
    return makeChatError("forbidden", apiMessage(err), { status: err.status });
  }
  if (err instanceof sdk.APIError) {
    console.warn(err.constructor.name, err.status, err.type);
    return makeChatError("unknown", apiMessage(err), { status: typeof err.status === "number" ? err.status : undefined });
  }
  const message = err instanceof Error ? err.message : "Unexpected error";
  return makeChatError("unknown", message);
}

// History helpers

type Block = Anthropic.ContentBlockParam;
type TextBlock = Anthropic.TextBlockParam;

function userText(text: string, marked: boolean): Anthropic.MessageParam {
  const block: TextBlock = { type: "text", text };
  if (marked) block.cache_control = { type: "ephemeral" };
  return { role: "user", content: [block] };
}

function assistantText(text: string): Anthropic.MessageParam {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function blocksOf(m: Anthropic.MessageParam): Block[] {
  return typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
}

function isUserText(m: Anthropic.MessageParam): boolean {
  return m.role === "user" && blocksOf(m).some((b) => b.type === "text");
}

function textOf(m: Anthropic.MessageParam): string {
  return blocksOf(m)
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n\n")
    .trim();
}

/** Response blocks to request params. Thinking blocks keep their signatures,
 *  redacted thinking keeps its data, tool_use keeps id, name and input. Server
 *  tool blocks never occur here (no server tools) and are dropped. */
export function toAssistantParams(content: ReadonlyArray<Anthropic.ContentBlock>): Block[] {
  const out: Block[] = [];
  for (const b of content) {
    switch (b.type) {
      case "text":
        out.push({ type: "text", text: b.text });
        break;
      case "thinking":
        out.push({ type: "thinking", thinking: b.thinking, signature: b.signature });
        break;
      case "redacted_thinking":
        out.push({ type: "redacted_thinking", data: b.data });
        break;
      case "tool_use":
        out.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
        break;
      default:
        break;
    }
  }
  return out;
}

/** Collapse an SDK history to text-only turns: one user text message and one
 *  assistant text message per turn, no thinking, no tool blocks. A turn's
 *  assistant text is every text block the assistant produced in that turn, in
 *  order, which matches what the UI transcript stores. Turns with no assistant
 *  text are dropped. The newest user text block keeps the cache marker. */
export function collapseToText(history: ReadonlyArray<Anthropic.MessageParam>, keepTurns?: number): Anthropic.MessageParam[] {
  const turns: Array<{ user: string; assistant: string[] }> = [];
  let current: { user: string; assistant: string[] } | null = null;
  for (const m of history) {
    if (isUserText(m)) {
      current = { user: textOf(m), assistant: [] };
      turns.push(current);
    } else if (m.role === "assistant" && current) {
      const t = textOf(m);
      if (t) current.assistant.push(t);
    }
  }
  const complete = turns.filter((t) => t.user && t.assistant.length > 0);
  const kept = keepTurns === undefined ? complete : keepTurns <= 0 ? [] : complete.slice(-keepTurns);
  const out: Anthropic.MessageParam[] = [];
  kept.forEach((t, i) => {
    out.push(userText(t.user, i === kept.length - 1));
    out.push(assistantText(t.assistant.join("\n\n")));
  });
  return out;
}

function stripUserMarkers(history: Anthropic.MessageParam[]): void {
  for (const m of history) {
    if (m.role !== "user" || typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "text" && b.cache_control) delete b.cache_control;
    }
  }
}

function usageOf(u: Anthropic.Usage): Usage {
  return {
    input: u.input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
  };
}

// Stop is immediate even for a tool that does not implement cancellation.
function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("The request was stopped."));
    if (signal.aborted) { pending.catch(() => {}); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

// Session

interface Deps {
  args: CreateSessionArgs;
  options: AnthropicProviderOptions;
}

class AnthropicKeySession implements ChatSession {
  readonly provider = "anthropic-key" as const;

  private history: Anthropic.MessageParam[] = [];
  private dataCard: string;
  private readonly tools: Anthropic.Tool[];
  private epoch = 0;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(private readonly deps: Deps) {
    const { args, options } = deps;
    this.dataCard = args.system.dataCard();
    this.tools = args.tools.map((t: ToolDef) => ({
      name: t.name,
      description: t.description,
      // JsonSchemaObject is a closed interface; the SDK's InputSchema carries an
      // index signature. The spread makes a plain object that satisfies both.
      input_schema: { ...t.inputSchema },
      strict: true,
    }));
    this.fetchImpl = args.fetch ?? options.fetch;
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeoutMs ?? CLIENT_TIMEOUT_MS;
  }

  /** The SDK history as the next request would send it (tests only). */
  get messages(): ReadonlyArray<Anthropic.MessageParam> {
    return this.history;
  }

  reset(): void {
    this.epoch += 1;
    this.history = [];
    this.dataCard = this.deps.args.system.dataCard();
  }

  resume(turns: ChatTurn[]): void {
    this.epoch += 1;
    const out: Anthropic.MessageParam[] = [];
    const usable = turns.filter((t) => t.end !== "refused" && t.end !== "error" && t.user.trim() && t.assistant.trim());
    usable.forEach((t, i) => {
      out.push(userText(t.user, i === usable.length - 1));
      out.push(assistantText(t.assistant));
    });
    this.history = out;
    this.dataCard = this.deps.args.system.dataCard();
  }

  private clientFor(sdk: SdkModule, key: string): SdkClient {
    return new sdk.default({
      apiKey: key,
      dangerouslyAllowBrowser: inBrowser(),
      maxRetries: this.maxRetries,
      timeout: this.timeoutMs,
      fetch: this.fetchImpl,
    });
  }

  private params(maxTokens: number): Anthropic.MessageStreamParams {
    return {
      model: CHAT_MODEL,
      max_tokens: maxTokens,
      thinking: { type: "adaptive" },
      output_config: { effort: this.deps.args.settings.effort },
      tools: this.tools,
      system: [
        { type: "text", text: this.deps.args.system.rules },
        { type: "text", text: this.dataCard, cache_control: { type: "ephemeral" } },
      ],
      messages: this.history,
    };
  }

  private appendUser(text: string): void {
    stripUserMarkers(this.history);
    this.history.push(userText(text, true));
  }

  private async runTools(
    blocks: Anthropic.ToolUseBlock[],
    handlers: SendHandlers,
    signal: AbortSignal,
    stale: () => boolean,
  ): Promise<Anthropic.ToolResultBlockParam[]> {
    const { runTool } = this.deps.args;
    return Promise.all(
      blocks.map(async (b) => {
        const t0 = Date.now();
        let outcome: ToolOutcome;
        try {
          outcome = await withAbort(runTool(b.name, b.input, signal), signal);
        } catch (err: unknown) {
          if (signal.aborted || stale()) throw err;
          const message = err instanceof Error ? err.message : "Tool failed";
          outcome = { content: JSON.stringify({ error: message }), isError: true };
        }
        const ms = Date.now() - t0;
        if (signal.aborted || stale()) throw new Error("The request was stopped.");
        handlers.onToolResult(b.id, outcome, ms);
        const result: Anthropic.ToolResultBlockParam = {
          type: "tool_result",
          tool_use_id: b.id,
          content: outcome.content || "{}",
        };
        if (outcome.isError) result.is_error = true;
        return result;
      }),
    );
  }

  private budgetResults(blocks: Anthropic.ToolUseBlock[], handlers: SendHandlers): Anthropic.ToolResultBlockParam[] {
    const outcome: ToolOutcome = { content: TOOL_BUDGET_MESSAGE, isError: true };
    return blocks.map((b) => {
      handlers.onToolResult(b.id, outcome, 0);
      return { type: "tool_result", tool_use_id: b.id, content: TOOL_BUDGET_MESSAGE, is_error: true };
    });
  }

  async send(userTextIn: string, handlers: SendHandlers, signal: AbortSignal): Promise<TurnEnd> {
    const epoch = this.epoch;
    const stale = () => epoch !== this.epoch;
    const key = this.deps.args.getKey();
    if (!key) {
      return { kind: "error", error: makeChatError("no_key", "Add your Anthropic API key to ask questions.") };
    }
    if (signal.aborted) return { kind: "aborted" };

    let sdk: SdkModule;
    try {
      sdk = await loadSdk();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Could not load the Anthropic SDK.";
      return { kind: "error", error: makeChatError("network", message) };
    }
    if (stale() || signal.aborted) return { kind: "aborted" };
    const client = this.clientFor(sdk, key);

    // Data-card version check: a changed card means the cached prefix and the
    // system prompt differ from what earlier thinking blocks were made under,
    // so the history becomes text-only turns before the card is adopted.
    const card = this.deps.args.system.dataCard();
    if (card !== this.dataCard) {
      this.history = collapseToText(this.history);
      this.dataCard = card;
    }

    const snapshot = this.history.slice();
    this.appendUser(userTextIn);

    let toolRounds = 0;
    let budgetDelivered = false;
    let maxTokens = MAX_OUTPUT_TOKENS;
    let bumped = false;
    let contextCollapsed = false;
    let streamedText = "";
    let breakPending = false;
    let roundText = "";
    const turnToolIds: string[] = [];

    const finishPartial = (text = roundText): void => {
      // Keep what the model said as a text-only assistant turn so the next
      // question can refer to it; never replay a half-made thinking block.
      const t = text.trim();
      if (t) this.history.push(assistantText(t));
    };

    const abort = (): TurnEnd => {
      if (!stale()) {
        this.history = snapshot;
        this.appendUser(userTextIn);
        finishPartial(streamedText);
      }
      return { kind: "aborted" };
    };

    while (true) {
      if (stale()) return { kind: "aborted" };
      if (signal.aborted) return abort();
      const roundStart = streamedText.length;
      const roundToolIds: string[] = [];
      const roundBreakPending: boolean = breakPending;
      roundText = "";

      let message: Anthropic.Message;
      try {
        const stream = client.messages.stream(this.params(maxTokens), { signal });
        stream.on("text", (delta) => {
          if (stale() || signal.aborted) return;
          if (breakPending) {
            // Text said before a tool call would otherwise run straight into
            // the text said after it; open a new paragraph once per round.
            breakPending = false;
            if (streamedText.length > 0 && !/\n\s*$/.test(streamedText)) {
              streamedText += "\n\n";
              handlers.onText("\n\n");
            }
          }
          streamedText += delta;
          roundText += delta;
          handlers.onText(delta);
        });
        stream.on("streamEvent", (event) => {
          if (stale() || signal.aborted || event.type !== "content_block_start") return;
          const b = event.content_block;
          if (b.type === "thinking" || b.type === "redacted_thinking") handlers.onThinking();
          else if (b.type === "tool_use") {
            roundToolIds.push(b.id);
            turnToolIds.push(b.id);
            handlers.onToolCall({ id: b.id, name: b.name, input: null });
          }
        });
        stream.on("contentBlock", (block) => {
          if (stale() || signal.aborted) return;
          if (block.type === "tool_use") handlers.onToolInput(block.id, block.input);
        });
        message = await stream.finalMessage();
      } catch (err: unknown) {
        if (stale()) return { kind: "aborted" };
        if (err instanceof sdk.APIUserAbortError || signal.aborted) return abort();
        this.history = snapshot;
        return { kind: "error", error: toChatError(err, sdk) };
      }

      if (stale()) return { kind: "aborted" };
      if (signal.aborted) return abort();
      if (handlers.onUsage) handlers.onUsage(usageOf(message.usage));

      const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const stop = message.stop_reason;

      if (stop === "refusal") {
        // Never run that turn's tools; a refusal can cut a tool_use off mid input.
        this.history = snapshot;
        return { kind: "refused" };
      }

      if (stop === "max_tokens") {
        if (toolUses.length > 0 && !bumped) {
          // Thinking counts toward max_tokens; re-issue the same request once
          // with more room rather than running a truncated tool input.
          bumped = true;
          maxTokens = RETRY_OUTPUT_TOKENS;
          streamedText = streamedText.slice(0, roundStart);
          breakPending = roundBreakPending;
          handlers.onRestart?.(roundStart, roundToolIds);
          continue;
        }
        finishPartial();
        return { kind: "truncated" };
      }

      if (stop === "model_context_window_exceeded") {
        if (!contextCollapsed) {
          contextCollapsed = true;
          const kept = collapseToText(snapshot, CONTEXT_COLLAPSE_TURNS);
          this.history = kept;
          this.appendUser(userTextIn);
          streamedText = "";
          breakPending = false;
          handlers.onRestart?.(0, turnToolIds.splice(0));
          continue;
        }
        this.history = snapshot;
        return {
          kind: "error",
          error: makeChatError("context", "This chat is too long to continue. Start a new chat."),
        };
      }

      if (stop === "pause_turn") {
        this.history.push({ role: "assistant", content: toAssistantParams(message.content) });
        return { kind: "done" };
      }

      if (toolUses.length === 0) {
        // end_turn, stop_sequence, or anything else with no tool call: done.
        this.history.push({ role: "assistant", content: toAssistantParams(message.content) });
        return { kind: "done" };
      }

      // tool_use (or any stop that left tool_use blocks to answer)
      if (toolRounds < MAX_TOOL_ITERATIONS) {
        toolRounds += 1;
        this.history.push({ role: "assistant", content: toAssistantParams(message.content) });
        let results: Anthropic.ToolResultBlockParam[];
        try {
          results = await this.runTools(toolUses, handlers, signal, stale);
        } catch (err) {
          if (stale()) return { kind: "aborted" };
          if (signal.aborted) return abort();
          this.history = snapshot;
          return { kind: "error", error: toChatError(err, sdk) };
        }
        if (stale()) return { kind: "aborted" };
        if (signal.aborted) return abort();
        this.history.push({ role: "user", content: results });
        breakPending = true;
        continue;
      }
      if (!budgetDelivered) {
        budgetDelivered = true;
        this.history.push({ role: "assistant", content: toAssistantParams(message.content) });
        this.history.push({ role: "user", content: this.budgetResults(toolUses, handlers) });
        breakPending = true;
        continue;
      }
      // The model asked for tools again after the budget message: stop here.
      // The unanswered tool_use is not kept, so the next send is legal.
      finishPartial();
      return { kind: "tool_cap" };
    }
  }
}

// Provider

async function probeKey(key: string, options: AnthropicProviderOptions): Promise<"ok" | "rejected" | "offline" | "blocked" | "limited"> {
  let sdk: SdkModule;
  try {
    sdk = await loadSdk();
  } catch {
    return "offline";
  }
  const client = new sdk.default({
    apiKey: key,
    dangerouslyAllowBrowser: inBrowser(),
    maxRetries: 0,
    timeout: options.timeoutMs ?? KEY_PROBE_TIMEOUT_MS,
    fetch: options.fetch,
  });
  try {
    await client.messages.countTokens({ model: CHAT_MODEL, messages: [{ role: "user", content: "ping" }] });
    return "ok";
  } catch (err: unknown) {
    if (err instanceof sdk.AuthenticationError || err instanceof sdk.PermissionDeniedError) return "rejected";
    if (err instanceof sdk.APIConnectionError) return "offline";
    if (err instanceof sdk.RateLimitError) return "limited";
    if (err instanceof sdk.APIError) return "blocked";
    return "offline";
  }
}

/** Build the provider. The default export below is what the app uses; the
 *  dev mock and the tests build one with a fetch override and maxRetries 0. */
export function createAnthropicKeyProvider(options: AnthropicProviderOptions = {}): ChatProvider & {
  createSession(args: CreateSessionArgs & AnthropicSessionOptions): AnthropicKeySession;
} {
  return {
    id: "anthropic-key",
    label: "Anthropic API key",
    needsKey: true,
    async readiness(deps): Promise<Readiness> {
      return deps.getKey() ? { ok: true } : { ok: false, reason: "no_key" };
    },
    validateKey(key: string) {
      return probeKey(key, options);
    },
    createSession(args: CreateSessionArgs & AnthropicSessionOptions): AnthropicKeySession {
      const merged: AnthropicProviderOptions = {
        ...options,
        maxRetries: args.maxRetries ?? options.maxRetries,
        timeoutMs: args.timeoutMs ?? options.timeoutMs,
      };
      return new AnthropicKeySession({ args, options: merged });
    },
  };
}

export const anthropicKeyProvider = createAnthropicKeyProvider();

export type { AnthropicKeySession };
