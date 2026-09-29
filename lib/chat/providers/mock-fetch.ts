// Dev-only scripted fetch for the Anthropic provider (section 1.1, decision
// table: "Browser mock is a fetch replacement returning scripted SSE
// Responses").
//
// mockAnthropicFetch(scenario) returns a fetch-compatible function that
// answers POST /v1/messages with SSE bodies in the real event format
// (message_start, content_block_start/delta/stop for thinking, text and
// tool_use with input_json_delta, message_delta with stop_reason and usage,
// message_stop) and /v1/messages/count_tokens with JSON. The real SDK parses
// them, so the provider's stream handling and error classes are exercised
// end to end without a network.
//
// Loaded only by dynamic import inside an `if (process.env.NODE_ENV !==
// "production")` branch, so nothing here reaches the static export. The
// CHAT_MOCK_SENTINEL constant exists so a grep over out/ proves that.
//
// Every request body the mock receives is appended to `mockRequests` so tests
// can assert the request shape. Auth headers are never recorded.

export const CHAT_MOCK_SENTINEL = "CHAT_MOCK_SENTINEL";

export type MockScenario =
  | "ok"
  | "slow"
  | "401"
  | "403"
  | "429"
  | "400"
  | "500"
  | "529"
  | "offline"
  | "refusal"
  | "max_tokens"
  | "nokey";

export const MOCK_SCENARIOS: readonly MockScenario[] = [
  "ok",
  "slow",
  "401",
  "403",
  "429",
  "400",
  "500",
  "529",
  "offline",
  "refusal",
  "max_tokens",
  "nokey",
];

export function isMockScenario(value: unknown): value is MockScenario {
  return typeof value === "string" && (MOCK_SCENARIOS as readonly string[]).includes(value);
}

export interface RecordedRequest {
  url: string;
  method: string;
  /** Lower-cased header names; x-api-key and authorization are replaced by "[present]". */
  headers: Record<string, string>;
  body: unknown; // parsed JSON when the body was JSON, else the raw string
  at: number;
}

export const mockRequests: RecordedRequest[] = [];

export function clearMockRequests(): void {
  mockRequests.length = 0;
}

/** The unverifiable figure the ok scenario slips into its answer, so the
 *  grounding underline has something to catch in the browser test. */
export const MOCK_UNVERIFIED_NUMBER = "2,048";

// SSE building blocks

export interface SseEvent {
  event: string;
  data: unknown;
}

const encoder = new TextEncoder();

export function sseText(events: readonly SseEvent[]): string {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
}

interface UsageShape {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

const DEFAULT_USAGE: UsageShape = {
  input_tokens: 1200,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 3400,
  output_tokens: 1,
};

let messageCounter = 0;

export function messageStart(usage: Partial<UsageShape> = {}): SseEvent {
  messageCounter += 1;
  return {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: `msg_mock_${messageCounter}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          ...DEFAULT_USAGE,
          ...usage,
          output_tokens: 1,
          service_tier: "standard",
        },
      },
    },
  };
}

export function messageEnd(
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "pause_turn" | "model_context_window_exceeded",
  usage: Partial<UsageShape> = {},
): SseEvent[] {
  const u = { ...DEFAULT_USAGE, output_tokens: 380, ...usage };
  return [
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: {
          output_tokens: u.output_tokens,
          input_tokens: u.input_tokens,
          cache_creation_input_tokens: u.cache_creation_input_tokens,
          cache_read_input_tokens: u.cache_read_input_tokens,
        },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

/** An adaptive-thinking block as Opus 5.5 streams it by default: empty
 *  thinking text, a signature, nothing else. */
export function thinkingEvents(index: number): SseEvent[] {
  return [
    {
      event: "content_block_start",
      data: { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } },
    },
    {
      event: "content_block_delta",
      data: { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: "" } },
    },
    {
      event: "content_block_delta",
      data: { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig_mock_" + index } },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index } },
  ];
}

/** Split text into word-sized deltas so the UI sees real streaming. */
export function splitText(text: string, size = 12): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [""];
}

export function textEvents(index: number, text: string): SseEvent[] {
  return [
    {
      event: "content_block_start",
      data: { type: "content_block_start", index, content_block: { type: "text", text: "" } },
    },
    ...splitText(text).map((piece) => ({
      event: "content_block_delta",
      data: { type: "content_block_delta", index, delta: { type: "text_delta", text: piece } },
    })),
    { event: "content_block_stop", data: { type: "content_block_stop", index } },
  ];
}

export interface MockToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** A tool_use block with its input streamed as input_json_delta chunks.
 *  `truncateAt` drops the JSON tail to imitate a cut-off (refusal, max_tokens). */
export function toolUseEvents(index: number, call: MockToolCall, truncateAt?: number): SseEvent[] {
  let json = JSON.stringify(call.input);
  if (truncateAt !== undefined) json = json.slice(0, truncateAt);
  const chunks = splitText(json, 9);
  return [
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
      },
    },
    ...chunks.map((partial) => ({
      event: "content_block_delta",
      data: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: partial } },
    })),
    { event: "content_block_stop", data: { type: "content_block_stop", index } },
  ];
}

/** A whole streamed message that ends in end_turn (or the stop given). */
export function textTurn(
  text: string,
  opts: { stop?: "end_turn" | "max_tokens"; usage?: Partial<UsageShape>; thinking?: boolean } = {},
): SseEvent[] {
  const events = [messageStart(opts.usage)];
  let index = 0;
  if (opts.thinking !== false) {
    events.push(...thinkingEvents(index));
    index += 1;
  }
  events.push(...textEvents(index, text));
  events.push(...messageEnd(opts.stop ?? "end_turn", opts.usage));
  return events;
}

/** A whole streamed message that asks for one or more tools. */
export function toolTurn(
  calls: MockToolCall[],
  opts: {
    text?: string;
    stop?: "tool_use" | "max_tokens" | "refusal";
    truncateAt?: number;
    usage?: Partial<UsageShape>;
    thinking?: boolean;
  } = {},
): SseEvent[] {
  const events = [messageStart(opts.usage)];
  let index = 0;
  if (opts.thinking !== false) {
    events.push(...thinkingEvents(index));
    index += 1;
  }
  if (opts.text) {
    events.push(...textEvents(index, opts.text));
    index += 1;
  }
  calls.forEach((call, i) => {
    const last = i === calls.length - 1;
    events.push(...toolUseEvents(index, call, last ? opts.truncateAt : undefined));
    index += 1;
  });
  events.push(...messageEnd(opts.stop ?? "tool_use", opts.usage));
  return events;
}

// Responses

function abortError(): Error {
  return typeof DOMException !== "undefined"
    ? new DOMException("The operation was aborted.", "AbortError")
    : Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
}

/** One SSE event per chunk, `delayMs` apart. Honours the request signal the
 *  way a real fetch does: an abort errors the pending read. */
function delayedStream(chunks: string[], delayMs: number, signal?: AbortSignal | null): ReadableStream<Uint8Array> {
  let i = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  const onAbort = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!finished && ctrl) {
      finished = true;
      ctrl.error(abortError());
    }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      ctrl = controller;
      if (signal?.aborted) onAbort();
    },
    pull(controller) {
      return new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timer = null;
          if (finished) return resolve();
          if (i >= chunks.length) {
            finished = true;
            controller.close();
          } else {
            controller.enqueue(encoder.encode(chunks[i++]));
          }
          resolve();
        }, delayMs);
      });
    },
    cancel() {
      finished = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  });
}

export function sseResponse(events: readonly SseEvent[], opts: { delayMs?: number; signal?: AbortSignal | null } = {}): Response {
  const headers = { "content-type": "text/event-stream; charset=utf-8", "request-id": "req_mock" };
  if (!opts.delayMs) return new Response(sseText(events), { status: 200, headers });
  const chunks = events.map((e) => sseText([e]));
  const stream = delayedStream(chunks, opts.delayMs, opts.signal);
  return new Response(stream, { status: 200, headers });
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "request-id": "req_mock", ...headers },
  });
}

const ERROR_TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  429: "rate_limit_error",
  500: "api_error",
  529: "overloaded_error",
};

const ERROR_MESSAGES: Record<number, string> = {
  400: "messages.0.content.0.text: cannot be empty (mock)",
  401: "invalid x-api-key (mock)",
  403: "This key does not have access to the requested model (mock)",
  429: "This request would exceed your organization's rate limit (mock)",
  500: "Internal server error (mock)",
  529: "Overloaded (mock)",
};

export function errorResponse(status: number, headers: Record<string, string> = {}): Response {
  return jsonResponse(
    status,
    { type: "error", error: { type: ERROR_TYPES[status] ?? "api_error", message: ERROR_MESSAGES[status] ?? "Error (mock)" } },
    headers,
  );
}

// Request recording and dispatch

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function recordHeaders(input: string | URL | Request, init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const source = init?.headers ?? (input instanceof Request ? input.headers : undefined);
  if (!source) return out;
  const h = new Headers(source);
  h.forEach((value, name) => {
    const key = name.toLowerCase();
    out[key] = key === "x-api-key" || key === "authorization" ? "[present]" : value;
  });
  return out;
}

async function readBody(input: string | URL | Request, init?: RequestInit): Promise<unknown> {
  let raw: string | null = null;
  const body = init?.body;
  if (typeof body === "string") raw = body;
  else if (body instanceof Uint8Array) raw = new TextDecoder().decode(body);
  else if (body && input instanceof Request) raw = await input.clone().text();
  else if (input instanceof Request) raw = await input.clone().text();
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export type Responder = (req: RecordedRequest, index: number, init?: RequestInit) => Response | Promise<Response>;

/** A fetch that records every request and hands it to `responder`. The
 *  index is the number of requests this fetch has seen so far. */
export function scriptedFetch(responder: Responder): typeof fetch {
  let count = 0;
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const req: RecordedRequest = {
      url: requestUrl(input),
      method,
      headers: recordHeaders(input, init),
      body: await readBody(input, init),
      at: Date.now(),
    };
    mockRequests.push(req);
    const index = count;
    count += 1;
    return responder(req, index, init);
  };
  return impl as typeof fetch;
}

// Scenario content

interface RowLike {
  id?: unknown;
  title?: unknown;
  platform?: unknown;
  date?: unknown;
  reach?: unknown;
  reachMetric?: unknown;
}

/** Rows from the tool_result blocks in the newest user message, so the
 *  canned answer cites ids the runner really returned. */
export function rowsFromRequest(body: unknown): RowLike[] {
  const messages = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const last = messages[messages.length - 1] as { role?: unknown; content?: unknown };
  if (last.role !== "user" || !Array.isArray(last.content)) return [];
  const rows: RowLike[] = [];
  for (const block of last.content as Array<{ type?: unknown; content?: unknown }>) {
    if (block.type !== "tool_result" || typeof block.content !== "string") continue;
    try {
      const parsed = JSON.parse(block.content) as { rows?: unknown };
      if (Array.isArray(parsed.rows)) rows.push(...(parsed.rows as RowLike[]));
    } catch {
      // not JSON: nothing to cite
    }
  }
  return rows;
}

export function hasToolResult(body: unknown): boolean {
  const messages = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const last = messages[messages.length - 1] as { role?: unknown; content?: unknown };
  return (
    last.role === "user" &&
    Array.isArray(last.content) &&
    (last.content as Array<{ type?: unknown }>).some((b) => b.type === "tool_result")
  );
}

const PLATFORM_WORD: Record<string, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  threads: "Threads",
  linkedin: "LinkedIn",
};

function fmtDate(value: unknown): string {
  if (typeof value !== "string") return "an unknown date";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return value;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[parseInt(m[2], 10) - 1] ?? m[2]} ${parseInt(m[3], 10)} ${m[1]}`;
}

function fmtInt(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US") : "n/a";
}

export const MOCK_TOOL_CALL: MockToolCall = {
  id: "toolu_mock_top_posts",
  name: "top_posts",
  input: { days: 180, platforms: null, types: null, metric: "reach", order: "desc", limit: 5 },
};

/** The final answer of the ok scenario: cites the first two ids the runner
 *  returned and adds one figure (2,048) that no tool produced. */
export function okAnswer(rows: RowLike[]): string {
  const top = rows.slice(0, 2);
  if (top.length === 0) {
    return `No posts came back for the last 180 days across all platforms, so there is nothing to rank yet. The dashboard reports ${MOCK_UNVERIFIED_NUMBER} rows in total, which is a figure this mock made up on purpose.`;
  }
  const line = (r: RowLike, lead: string) => {
    const platform = PLATFORM_WORD[String(r.platform)] ?? String(r.platform ?? "the platform");
    const metric = typeof r.reachMetric === "string" ? r.reachMetric : "views";
    return `${lead} "${String(r.title ?? "(no title)")}" [[post:${String(r.id ?? "")}]] on ${platform}, ${fmtDate(r.date)}, ${fmtInt(r.reach)} ${metric}.`;
  };
  const parts = [`**Best posts in the last 180 days across all platforms.**`, line(top[0], "First was")];
  if (top[1]) parts.push(line(top[1], "Next came"));
  parts.push(
    `Together they reached about ${MOCK_UNVERIFIED_NUMBER} people, a figure this mock invented so the grounding check has something to flag.`,
    `Suggestion: post the next reel on the same weekday as the top one, since that is the slot with the higher number here.`,
  );
  return parts.join(" ");
}

/** The scripted fetch for one scenario. */
export function mockAnthropicFetch(scenario: MockScenario, opts: { delayMs?: number } = {}): typeof fetch {
  const delayMs = scenario === "slow" ? (opts.delayMs ?? 120) : 0;

  return scriptedFetch(async (req, _index, init) => {
    const url = req.url;
    const isCount = url.includes("/v1/messages/count_tokens");
    const isMessages = !isCount && url.includes("/v1/messages");

    if (scenario === "offline") throw new TypeError("fetch failed");
    if (scenario === "401" || scenario === "nokey") return errorResponse(401);
    if (scenario === "403") return errorResponse(403);

    if (isCount) return jsonResponse(200, { input_tokens: 3 });
    if (!isMessages) return jsonResponse(404, { type: "error", error: { type: "not_found_error", message: "mock" } });

    switch (scenario) {
      case "429":
        return errorResponse(429, { "retry-after": "7" });
      case "400":
        return errorResponse(400);
      case "500":
        return errorResponse(500);
      case "529":
        return errorResponse(529);
      case "refusal":
        return sseResponse(toolTurn([MOCK_TOOL_CALL], { stop: "refusal", truncateAt: 14 }), { signal: init?.signal });
      case "max_tokens":
        return sseResponse(toolTurn([MOCK_TOOL_CALL], { stop: "max_tokens", truncateAt: 30 }), { signal: init?.signal });
      case "ok":
      case "slow": {
        const signal = init?.signal;
        if (hasToolResult(req.body)) {
          const rows = rowsFromRequest(req.body);
          return sseResponse(textTurn(okAnswer(rows), { usage: { cache_read_input_tokens: 5200 } }), { delayMs, signal });
        }
        return sseResponse(toolTurn([MOCK_TOOL_CALL], { text: "Let me look at the last 180 days." }), { delayMs, signal });
      }
      default:
        return errorResponse(500);
    }
  });
}
