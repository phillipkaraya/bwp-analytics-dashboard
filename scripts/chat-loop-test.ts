// Loop test for the Anthropic provider with a fake fetch (spec section 7,
// step 3). No network, no real key: the key is "sk-ant-test-" plus forty x,
// the SDK is the real one with maxRetries 0, and every request body it
// produces is recorded by the mock so the request shape can be asserted.
//
// Run: cd <repo> && pnpm exec tsx --test scripts/chat-loop-test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import { makeChatData } from "../lib/chat/data";
import {
  CHAT_MODEL,
  MAX_OUTPUT_TOKENS,
  MAX_TOOL_ITERATIONS,
  RETRY_OUTPUT_TOKENS,
  SDK_VERSION,
  TOOL_BUDGET_MESSAGE,
  anthropicKeyProvider,
  collapseToText,
  createAnthropicKeyProvider,
  parseRetryAfter,
} from "../lib/chat/providers/anthropic-key";
import { PROVIDERS, createSession, getProvider } from "../lib/chat/providers/index";
import { localCliProvider } from "../lib/chat/providers/local-cli";
import {
  CHAT_MOCK_SENTINEL,
  MOCK_SCENARIOS,
  MOCK_TOOL_CALL,
  clearMockRequests,
  messageEnd,
  messageStart,
  mockAnthropicFetch,
  mockRequests,
  scriptedFetch,
  sseResponse,
  textEvents,
  textTurn,
  toolTurn,
  type RecordedRequest,
} from "../lib/chat/providers/mock-fetch";
import { STATIC_RULES } from "../lib/chat/system-prompt";
import { TOOL_DEFS } from "../lib/chat/tools/defs";
import type { ChatSettings, ChatTurn, SendHandlers, ToolOutcome, ToolRunner, Usage } from "../lib/chat/types";

const TEST_KEY = "sk-ant-test-" + "x".repeat(40);
const CARD_A = "DATA CARD (what the dashboard holds right now)\nToday: 2026-09-28\nPosts: 2103 rows.";
const CARD_B = "DATA CARD (what the dashboard holds right now)\nToday: 2026-09-29\nPosts: 2103 rows.";
const SETTINGS: ChatSettings = { v: 1, provider: "anthropic-key", effort: "medium", showUsage: true };

const STUB_ROWS = [
  { rank: 1, id: "ig_1_1", platform: "instagram", date: "2026-09-18", title: "Made 5,000 websites", reach: 1094, reachMetric: "views" },
  { rank: 2, id: "ig_2_1", platform: "instagram", date: "2026-09-16", title: "A carousel", reach: 391, reachMetric: "likes" },
];

interface Rec {
  handlers: SendHandlers;
  events: string[];
  text: string;
  toolCalls: Array<{ id: string; name: string; input: unknown }>;
  toolInputs: Array<{ id: string; input: unknown }>;
  toolResults: Array<{ id: string; outcome: ToolOutcome; ms: number }>;
  usage: Usage[];
}

function recorder(onText?: (delta: string, rec: Rec) => void): Rec {
  const rec: Rec = {
    events: [],
    text: "",
    toolCalls: [],
    toolInputs: [],
    toolResults: [],
    usage: [],
    handlers: {
      onThinking: () => rec.events.push("thinking"),
      onText: (delta) => {
        rec.text += delta;
        rec.events.push("text");
        onText?.(delta, rec);
      },
      onToolCall: (call) => {
        rec.events.push("tool_call");
        rec.toolCalls.push(call);
      },
      onToolInput: (id, input) => {
        rec.events.push("tool_input");
        rec.toolInputs.push({ id, input });
      },
      onToolResult: (id, outcome, ms) => {
        rec.events.push("tool_result");
        rec.toolResults.push({ id, outcome, ms });
      },
      onUsage: (u) => rec.usage.push(u),
    },
  };
  return rec;
}

function stubRunner(): ToolRunner & { calls: Array<{ name: string; input: unknown }> } {
  const calls: Array<{ name: string; input: unknown }> = [];
  const run = (async (name: string, input: unknown): Promise<ToolOutcome> => {
    calls.push({ name, input });
    return { content: JSON.stringify({ ok: true, rows: STUB_ROWS }), isError: false };
  }) as ToolRunner & { calls: typeof calls };
  run.calls = calls;
  return run;
}

function makeSession(
  fetchImpl: typeof fetch,
  opts: { dataCard?: () => string; runTool?: ToolRunner; getKey?: () => string | null; effort?: "medium" | "high" } = {},
) {
  return anthropicKeyProvider.createSession({
    settings: { ...SETTINGS, effort: opts.effort ?? "medium" },
    getKey: opts.getKey ?? (() => TEST_KEY),
    system: { rules: STATIC_RULES, dataCard: opts.dataCard ?? (() => CARD_A) },
    tools: TOOL_DEFS,
    runTool: opts.runTool ?? stubRunner(),
    fetch: fetchImpl,
    maxRetries: 0,
  });
}

type Body = {
  model: string;
  max_tokens: number;
  thinking: { type: string };
  output_config: { effort: string };
  system: Array<{ type: string; text: string; cache_control?: { type: string } }>;
  tools: Array<{ name: string; strict?: boolean; input_schema: { additionalProperties?: boolean } }>;
  messages: Array<{ role: string; content: Array<Record<string, unknown>> | string }>;
};

function bodyOf(req: RecordedRequest): Body {
  assert.ok(req.body && typeof req.body === "object", "request body is JSON");
  return req.body as Body;
}

function blocksOf(m: Body["messages"][number]): Array<Record<string, unknown>> {
  return typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
}

function assertShape(req: RecordedRequest, expect: { effort?: string; maxTokens?: number; card?: string } = {}) {
  const body = bodyOf(req);
  assert.equal(req.method, "POST");
  assert.ok(req.url.endsWith("/v1/messages"), `url ${req.url}`);
  assert.equal(body.model, CHAT_MODEL);
  assert.equal(body.max_tokens, expect.maxTokens ?? MAX_OUTPUT_TOKENS);
  assert.equal(body.thinking.type, "adaptive");
  assert.equal(body.output_config.effort, expect.effort ?? "medium");
  assert.equal(body.system.length, 2);
  assert.equal(body.system[0].text, STATIC_RULES);
  assert.equal(body.system[0].cache_control, undefined);
  assert.equal(body.system[1].cache_control?.type, "ephemeral");
  if (expect.card) assert.equal(body.system[1].text, expect.card);
  assert.deepEqual(
    body.tools.map((t) => t.name),
    TOOL_DEFS.map((t) => t.name),
  );
  for (const t of body.tools) {
    assert.equal(t.strict, true, `${t.name} strict`);
    assert.equal(t.input_schema.additionalProperties, false, `${t.name} additionalProperties`);
  }
  assert.equal(body.messages[0].role, "user");
  let marked = 0;
  let lastUserTextIndex = -1;
  body.messages.forEach((m, i) => {
    for (const b of blocksOf(m)) {
      if (m.role === "user" && b.type === "text") lastUserTextIndex = i;
      if (b.cache_control) {
        assert.equal(m.role, "user");
        assert.equal(b.type, "text");
        marked += 1;
        assert.equal(i, lastUserTextIndex, "the marker sits on the newest user text block");
      }
    }
  });
  assert.equal(marked, 1, "exactly one user text block carries cache_control");
  assert.ok(!JSON.stringify(body).includes(TEST_KEY), "the key never appears in the body");
  assert.ok(!JSON.stringify(body).includes("sk-ant-"), "no key-shaped string in the body");
  assert.equal(req.headers["anthropic-dangerous-direct-browser-access"], undefined, "no browser header in Node");
  assert.equal(req.headers["x-api-key"], "[present]", "the mock never records the key");
  return body;
}

function lastMessage(req: RecordedRequest) {
  const body = bodyOf(req);
  return body.messages[body.messages.length - 1];
}

test("constants and sentinel", () => {
  assert.equal(CHAT_MODEL, "claude-opus-5-5");
  assert.equal(MAX_OUTPUT_TOKENS, 8000);
  assert.equal(RETRY_OUTPUT_TOKENS, 16000);
  assert.equal(MAX_TOOL_ITERATIONS, 8);
  assert.equal(SDK_VERSION, "0.129.0");
  assert.equal(CHAT_MOCK_SENTINEL, "CHAT_MOCK_SENTINEL");
  assert.equal(MOCK_SCENARIOS.length, 12);
  assert.equal(anthropicKeyProvider.id, "anthropic-key");
  assert.equal(anthropicKeyProvider.needsKey, true);
});

test("text only: deltas in order, done, usage reported", async () => {
  clearMockRequests();
  const fetchImpl = scriptedFetch(() => sseResponse(textTurn("Hello there, creator. Two posts fell in the window.")));
  const session = makeSession(fetchImpl);
  const rec = recorder();
  const end = await session.send("How many posts?", rec.handlers, new AbortController().signal);
  assert.deepEqual(end, { kind: "done" });
  assert.equal(rec.text, "Hello there, creator. Two posts fell in the window.");
  assert.equal(rec.events[0], "thinking");
  assert.ok(rec.events.slice(1).every((e) => e === "text"));
  assert.equal(rec.usage.length, 1);
  assert.deepEqual(rec.usage[0], { input: 1200, cacheRead: 3400, cacheWrite: 0, output: 380 });
  assert.equal(mockRequests.length, 1);
  const body = assertShape(mockRequests[0], { card: CARD_A });
  assert.equal(body.messages.length, 1);
  assert.deepEqual(blocksOf(body.messages[0]), [{ type: "text", text: "How many posts?", cache_control: { type: "ephemeral" } }]);
  // The session keeps the full assistant message, thinking signature included.
  assert.equal(session.messages.length, 2);
  const assistant = session.messages[1];
  assert.equal(assistant.role, "assistant");
  const kinds = (assistant.content as Array<{ type: string }>).map((b) => b.type);
  assert.deepEqual(kinds, ["thinking", "text"]);
});

test("one tool round: tool_result carries the runner's JSON, final text streams", async () => {
  clearMockRequests();
  const runTool = stubRunner();
  const session = makeSession(mockAnthropicFetch("ok"), { runTool });
  const rec = recorder();
  const end = await session.send("Best posts in the last 180 days", rec.handlers, new AbortController().signal);
  assert.deepEqual(end, { kind: "done" });
  assert.equal(mockRequests.length, 2);
  assert.equal(runTool.calls.length, 1);
  assert.equal(runTool.calls[0].name, "top_posts");
  assert.deepEqual(runTool.calls[0].input, MOCK_TOOL_CALL.input);

  // Handlers: the chip appears before the input is known, then the input, then the result.
  assert.deepEqual(rec.toolCalls, [{ id: MOCK_TOOL_CALL.id, name: "top_posts", input: null }]);
  assert.deepEqual(rec.toolInputs, [{ id: MOCK_TOOL_CALL.id, input: MOCK_TOOL_CALL.input }]);
  assert.equal(rec.toolResults.length, 1);
  assert.equal(rec.toolResults[0].id, MOCK_TOOL_CALL.id);
  assert.equal(rec.toolResults[0].outcome.isError, false);
  assert.ok(rec.events.indexOf("tool_call") < rec.events.indexOf("tool_input"));
  assert.ok(rec.events.indexOf("tool_input") < rec.events.indexOf("tool_result"));
  assert.equal(rec.usage.length, 2);

  // What the model said before the call and the answer after it are separate
  // paragraphs in the streamed text; the break is emitted, not just implied.
  assert.ok(rec.text.startsWith("Let me look at the last 180 days.\n\n"), JSON.stringify(rec.text.slice(0, 60)));

  // Second request: assistant turn replayed whole, then one tool_result with the matching id.
  assertShape(mockRequests[0], { card: CARD_A });
  const body2 = assertShape(mockRequests[1], { card: CARD_A });
  assert.equal(body2.messages.length, 3);
  const assistantBlocks = blocksOf(body2.messages[1]);
  assert.deepEqual(
    assistantBlocks.map((b) => b.type),
    ["thinking", "text", "tool_use"],
  );
  assert.equal((assistantBlocks[0] as { signature?: string }).signature, "sig_mock_0");
  assert.deepEqual(assistantBlocks[2].input, MOCK_TOOL_CALL.input);
  const results = blocksOf(body2.messages[2]);
  assert.equal(results.length, 1);
  assert.equal(results[0].type, "tool_result");
  assert.equal(results[0].tool_use_id, MOCK_TOOL_CALL.id);
  assert.equal(results[0].content, JSON.stringify({ ok: true, rows: STUB_ROWS }));
  assert.equal(results[0].is_error, undefined);

  // Final text cites the ids the runner returned and carries the planted number.
  assert.ok(rec.text.startsWith("Let me look at the last 180 days."));
  assert.ok(rec.text.includes("[[post:ig_1_1]]"));
  assert.ok(rec.text.includes("[[post:ig_2_1]]"));
  assert.ok(rec.text.includes("2,048"));
  assert.ok(!/[\u2014\u2013]|-{2}/.test(rec.text), "no dashes in the canned answer");
});

test("tool budget: 8 rounds run, the tenth request carries the is_error budget result, then tool_cap", async () => {
  clearMockRequests();
  const runTool = stubRunner();
  let n = 0;
  const fetchImpl = scriptedFetch(() => {
    n += 1;
    return sseResponse(toolTurn([{ id: `toolu_${n}`, name: "top_posts", input: MOCK_TOOL_CALL.input }]));
  });
  const session = makeSession(fetchImpl, { runTool });
  const rec = recorder();
  const end = await session.send("Keep digging", rec.handlers, new AbortController().signal);
  assert.deepEqual(end, { kind: "tool_cap" });
  assert.equal(mockRequests.length, 10, "exactly 10 requests");
  assert.equal(runTool.calls.length, MAX_TOOL_ITERATIONS, "8 tool rounds ran");
  assert.equal(rec.toolResults.length, 9, "8 real results plus one budget result reached the UI");
  const budget = rec.toolResults[8];
  assert.equal(budget.outcome.isError, true);
  assert.equal(budget.outcome.content, TOOL_BUDGET_MESSAGE);

  const ninth = blocksOf(lastMessage(mockRequests[8]));
  assert.equal(ninth[0].type, "tool_result");
  assert.equal(ninth[0].is_error, undefined, "the ninth request carries a real result");
  const tenth = blocksOf(lastMessage(mockRequests[9]));
  assert.equal(tenth[0].type, "tool_result");
  assert.equal(tenth[0].tool_use_id, "toolu_9");
  assert.equal(tenth[0].is_error, true);
  assert.equal(tenth[0].content, TOOL_BUDGET_MESSAGE);
  for (const req of mockRequests) assertShape(req);

  // The unanswered tenth tool_use is not kept, so the next send is legal.
  const last = session.messages[session.messages.length - 1];
  assert.equal(last.role, "user");
});

test("refusal with a partial tool_use runs no tool and rolls the turn back", async () => {
  clearMockRequests();
  const runTool = stubRunner();
  const session = makeSession(mockAnthropicFetch("refusal"), { runTool });
  const rec = recorder();
  const end = await session.send("Rank something", rec.handlers, new AbortController().signal);
  assert.deepEqual(end, { kind: "refused" });
  assert.equal(runTool.calls.length, 0);
  assert.equal(mockRequests.length, 1);
  assert.equal(rec.toolCalls.length, 1, "the chip still appeared");
  assert.equal(rec.toolResults.length, 0);
  assert.equal(session.messages.length, 0, "nothing from the refused turn stays in history");
});

test("max_tokens with tool_use re-issues once at 16000, then truncated", async () => {
  clearMockRequests();
  const runTool = stubRunner();
  const session = makeSession(mockAnthropicFetch("max_tokens"), { runTool });
  const rec = recorder();
  const end = await session.send("Rank something", rec.handlers, new AbortController().signal);
  assert.deepEqual(end, { kind: "truncated" });
  assert.equal(mockRequests.length, 2);
  assert.equal(runTool.calls.length, 0, "a truncated tool input never runs");
  assertShape(mockRequests[0], { maxTokens: MAX_OUTPUT_TOKENS });
  assertShape(mockRequests[1], { maxTokens: RETRY_OUTPUT_TOKENS });
  assert.equal(bodyOf(mockRequests[1]).messages.length, 1, "the same request, not a longer history");
});

test("max_tokens on plain text returns truncated and keeps the text", async () => {
  clearMockRequests();
  const fetchImpl = scriptedFetch(() => sseResponse(textTurn("This answer stops mid", { stop: "max_tokens" })));
  const session = makeSession(fetchImpl);
  const rec = recorder();
  const end = await session.send("Tell me everything", rec.handlers, new AbortController().signal);
  assert.deepEqual(end, { kind: "truncated" });
  assert.equal(mockRequests.length, 1);
  assert.equal(rec.text, "This answer stops mid");
  assert.equal(session.messages.length, 2);
  assert.deepEqual(session.messages[1], { role: "assistant", content: [{ type: "text", text: "This answer stops mid" }] });
});

test("error mapping: 401, 403, 429 with retry-after, 400, 500, 529, offline", async () => {
  const cases: Array<{ scenario: "401" | "403" | "429" | "400" | "500" | "529" | "offline"; code: string; status?: number }> = [
    { scenario: "401", code: "bad_key", status: 401 },
    { scenario: "403", code: "forbidden", status: 403 },
    { scenario: "429", code: "rate_limited", status: 429 },
    { scenario: "400", code: "bad_request", status: 400 },
    { scenario: "500", code: "server", status: 500 },
    { scenario: "529", code: "overloaded", status: 529 },
    { scenario: "offline", code: "network" },
  ];
  for (const c of cases) {
    clearMockRequests();
    const session = makeSession(mockAnthropicFetch(c.scenario));
    const rec = recorder();
    const end = await session.send("Anything", rec.handlers, new AbortController().signal);
    assert.equal(end.kind, "error", c.scenario);
    if (end.kind !== "error") return;
    assert.equal(end.error.code, c.code, c.scenario);
    assert.equal(end.error.status, c.status, c.scenario);
    if (c.scenario === "429") assert.equal(end.error.retryAfterSec, 7);
    assert.ok(!end.error.message.includes(TEST_KEY));
    assert.equal(mockRequests.length, 1, `${c.scenario}: maxRetries 0 means one request`);
    assert.equal(session.messages.length, 0, `${c.scenario}: the failed user message is rolled back`);
  }
});

test("bad request carries the API's own message", async () => {
  const session = makeSession(mockAnthropicFetch("400"));
  const end = await session.send("Anything", recorder().handlers, new AbortController().signal);
  assert.equal(end.kind, "error");
  if (end.kind === "error") assert.ok(end.error.message.includes("cannot be empty"));
});

test("no key: no request is made", async () => {
  clearMockRequests();
  const session = makeSession(mockAnthropicFetch("ok"), { getKey: () => null });
  const end = await session.send("Anything", recorder().handlers, new AbortController().signal);
  assert.equal(end.kind, "error");
  if (end.kind === "error") assert.equal(end.error.code, "no_key");
  assert.equal(mockRequests.length, 0);
});

test("abort mid-stream returns aborted with the text so far", async () => {
  clearMockRequests();
  const controller = new AbortController();
  const session = makeSession(mockAnthropicFetch("slow", { delayMs: 15 }));
  const rec = recorder((_delta, r) => {
    if (r.text.length >= 12) controller.abort();
  });
  const end = await session.send("Slowly please", rec.handlers, controller.signal);
  assert.deepEqual(end, { kind: "aborted" });
  assert.ok(rec.text.length >= 12, `partial text kept: ${JSON.stringify(rec.text)}`);
  assert.ok(rec.text.length < "Let me look at the last 180 days.".length + 1);
  assert.equal(mockRequests.length, 1);
  // The partial answer stays as a text-only turn so the next question can refer to it.
  assert.equal(session.messages.length, 2);
  assert.equal(session.messages[1].role, "assistant");

  // An already-aborted signal makes no request at all.
  clearMockRequests();
  const pre = new AbortController();
  pre.abort();
  const end2 = await makeSession(mockAnthropicFetch("ok")).send("x", recorder().handlers, pre.signal);
  assert.deepEqual(end2, { kind: "aborted" });
  assert.equal(mockRequests.length, 0);
});

test("data-card change between sends collapses history to text-only turns", async () => {
  clearMockRequests();
  let card = CARD_A;
  const session = makeSession(mockAnthropicFetch("ok"), { dataCard: () => card });
  const rec1 = recorder();
  assert.deepEqual(await session.send("Best posts", rec1.handlers, new AbortController().signal), { kind: "done" });
  assert.equal(mockRequests.length, 2);
  assert.ok(session.messages.some((m) => blocksOf(m as Body["messages"][number]).some((b) => b.type === "tool_use")));

  card = CARD_B;
  const rec2 = recorder();
  assert.deepEqual(await session.send("And on TikTok?", rec2.handlers, new AbortController().signal), { kind: "done" });
  assert.equal(mockRequests.length, 4);
  const body = assertShape(mockRequests[2], { card: CARD_B });
  const types = body.messages.flatMap((m) => blocksOf(m).map((b) => b.type));
  assert.ok(!types.includes("thinking"), "no thinking blocks after the collapse");
  assert.ok(!types.includes("tool_use"), "no tool_use blocks after the collapse");
  assert.ok(!types.includes("tool_result"), "no tool_result blocks after the collapse");
  assert.deepEqual(
    body.messages.map((m) => m.role),
    ["user", "assistant", "user"],
  );
  // The two rounds' text blocks are joined with a blank line, exactly as the
  // UI streamed them (the stream emits the same break between rounds).
  const lead = "Let me look at the last 180 days.";
  assert.ok(rec1.text.startsWith(`${lead}\n\n`));
  assert.equal((blocksOf(body.messages[1])[0] as { text: string }).text, rec1.text);
  assert.equal((blocksOf(body.messages[2])[0] as { text: string }).text, "And on TikTok?");

  // Same card again: history is append-only, thinking blocks come back.
  const rec3 = recorder();
  assert.deepEqual(await session.send("And YouTube?", rec3.handlers, new AbortController().signal), { kind: "done" });
  const body3 = assertShape(mockRequests[5], { card: CARD_B });
  const types3 = body3.messages.flatMap((m) => blocksOf(m).map((b) => b.type));
  assert.ok(types3.includes("thinking"));
  assert.ok(types3.includes("tool_result"));
});

test("effort high is passed through and cache markers move to the newest user block", async () => {
  clearMockRequests();
  const fetchImpl = scriptedFetch(() => sseResponse(textTurn("ok")));
  const session = makeSession(fetchImpl, { effort: "high" });
  await session.send("one", recorder().handlers, new AbortController().signal);
  await session.send("two", recorder().handlers, new AbortController().signal);
  assertShape(mockRequests[0], { effort: "high" });
  const body = assertShape(mockRequests[1], { effort: "high" });
  assert.equal(body.messages.length, 3);
  assert.equal(blocksOf(body.messages[0])[0].cache_control, undefined);
  assert.deepEqual(blocksOf(body.messages[2])[0].cache_control, { type: "ephemeral" });
});

test("resume(turns) rebuilds text-only history; reset() drops it", async () => {
  clearMockRequests();
  const fetchImpl = scriptedFetch(() => sseResponse(textTurn("ok")));
  const session = makeSession(fetchImpl);
  const turn = (id: string, user: string, assistant: string): ChatTurn => ({
    id,
    at: "2026-09-28T12:00:00Z",
    user,
    assistant,
    traces: [],
    end: "done",
  });
  session.resume([turn("1", "first", "answer one"), turn("2", "aborted early", ""), turn("3", "third", "answer three")]);
  assert.equal(session.messages.length, 4, "the turn with no assistant text is skipped");
  await session.send("fourth", recorder().handlers, new AbortController().signal);
  const body = assertShape(mockRequests[0]);
  assert.deepEqual(
    body.messages.map((m) => [m.role, (blocksOf(m)[0] as { text: string }).text]),
    [
      ["user", "first"],
      ["assistant", "answer one"],
      ["user", "third"],
      ["assistant", "answer three"],
      ["user", "fourth"],
    ],
  );
  session.reset();
  assert.equal(session.messages.length, 0);
  await session.send("fresh", recorder().handlers, new AbortController().signal);
  assert.equal(bodyOf(mockRequests[1]).messages.length, 1);
});

test("model_context_window_exceeded collapses to the last 8 text-only turns and retries once", async () => {
  clearMockRequests();
  let n = 0;
  const fetchImpl = scriptedFetch(() => {
    n += 1;
    if (n === 1) return sseResponse([messageStart(), ...messageEnd("model_context_window_exceeded")]);
    return sseResponse(textTurn("short answer"));
  });
  const session = makeSession(fetchImpl);
  const turns: ChatTurn[] = [];
  for (let i = 1; i <= 12; i++) {
    turns.push({ id: String(i), at: "", user: `q${i}`, assistant: `a${i}`, traces: [], end: "done" });
  }
  session.resume(turns);
  const rec = recorder();
  const end = await session.send("q13", rec.handlers, new AbortController().signal);
  assert.deepEqual(end, { kind: "done" });
  assert.equal(mockRequests.length, 2);
  assert.equal(bodyOf(mockRequests[0]).messages.length, 25);
  const body = assertShape(mockRequests[1]);
  assert.equal(body.messages.length, 17, "8 turns plus the new question");
  assert.equal((blocksOf(body.messages[0])[0] as { text: string }).text, "q5");
  assert.equal((blocksOf(body.messages[16])[0] as { text: string }).text, "q13");

  // Twice in a row is the context error.
  clearMockRequests();
  const always = scriptedFetch(() => sseResponse([messageStart(), ...messageEnd("model_context_window_exceeded")]));
  const s2 = makeSession(always);
  const end2 = await s2.send("q", recorder().handlers, new AbortController().signal);
  assert.equal(end2.kind, "error");
  if (end2.kind === "error") assert.equal(end2.error.code, "context");
  assert.equal(mockRequests.length, 2);
});

test("pause_turn pushes the assistant message and continues", async () => {
  clearMockRequests();
  let n = 0;
  const fetchImpl = scriptedFetch(() => {
    n += 1;
    if (n === 1) return sseResponse([messageStart(), ...textEvents(0, "part one. "), ...messageEnd("pause_turn")]);
    return sseResponse(textTurn("part two."));
  });
  const session = makeSession(fetchImpl);
  const rec = recorder();
  const end = await session.send("go", rec.handlers, new AbortController().signal);
  assert.deepEqual(end, { kind: "done" });
  assert.equal(rec.text, "part one. part two.");
  assert.equal(mockRequests.length, 2);
  assert.deepEqual(
    bodyOf(mockRequests[1]).messages.map((m) => m.role),
    ["user", "assistant"],
  );
});

test("a tool that throws becomes an is_error tool_result and the loop continues", async () => {
  clearMockRequests();
  let n = 0;
  const fetchImpl = scriptedFetch(() => {
    n += 1;
    if (n === 1) return sseResponse(toolTurn([MOCK_TOOL_CALL]));
    return sseResponse(textTurn("I could not fetch that."));
  });
  const runTool: ToolRunner = async () => {
    throw new Error("boom");
  };
  const session = makeSession(fetchImpl, { runTool });
  const rec = recorder();
  const end = await session.send("go", rec.handlers, new AbortController().signal);
  assert.deepEqual(end, { kind: "done" });
  assert.equal(rec.toolResults[0].outcome.isError, true);
  const result = blocksOf(lastMessage(mockRequests[1]))[0];
  assert.equal(result.is_error, true);
  assert.equal(result.content, JSON.stringify({ error: "boom" }));
});

test("validateKey probes count_tokens: ok, rejected, offline", async () => {
  clearMockRequests();
  const okProvider = createAnthropicKeyProvider({ fetch: mockAnthropicFetch("ok") });
  assert.equal(await okProvider.validateKey?.(TEST_KEY), "ok");
  assert.equal(mockRequests.length, 1);
  assert.ok(mockRequests[0].url.endsWith("/v1/messages/count_tokens"));
  const body = bodyOf(mockRequests[0]) as unknown as { model: string; messages: unknown[] };
  assert.equal(body.model, CHAT_MODEL);
  assert.deepEqual(body.messages, [{ role: "user", content: "ping" }]);
  assert.equal(mockRequests[0].headers["anthropic-dangerous-direct-browser-access"], undefined);

  assert.equal(await createAnthropicKeyProvider({ fetch: mockAnthropicFetch("401") }).validateKey?.(TEST_KEY), "rejected");
  assert.equal(await createAnthropicKeyProvider({ fetch: mockAnthropicFetch("403") }).validateKey?.(TEST_KEY), "rejected");
  assert.equal(await createAnthropicKeyProvider({ fetch: mockAnthropicFetch("offline") }).validateKey?.(TEST_KEY), "offline");
  assert.equal(await createAnthropicKeyProvider({ fetch: mockAnthropicFetch("429") }).validateKey?.(TEST_KEY), "ok");
});

test("readiness reports no_key without a key", async () => {
  assert.deepEqual(await anthropicKeyProvider.readiness({ getKey: () => null, isLocalhost: true }), { ok: false, reason: "no_key" });
  assert.deepEqual(await anthropicKeyProvider.readiness({ getKey: () => TEST_KEY, isLocalhost: false }), { ok: true });
});

test("parseRetryAfter handles seconds, dates and retry-after-ms", () => {
  assert.equal(parseRetryAfter(new Headers({ "retry-after": "7" })), 7);
  assert.equal(parseRetryAfter({ "retry-after": "12" }), 12);
  assert.equal(parseRetryAfter(new Headers({ "retry-after-ms": "2500" })), 3);
  const now = Date.parse("2026-09-28T12:00:00Z");
  assert.equal(parseRetryAfter(new Headers({ "retry-after": "Mon, 28 Sep 2026 12:00:30 GMT" }), now), 30);
  assert.equal(parseRetryAfter(new Headers({ "retry-after": "garbage" })), undefined);
  assert.equal(parseRetryAfter(new Headers()), undefined);
  assert.equal(parseRetryAfter(undefined), undefined);
});

test("collapseToText keeps every text block of a turn and drops tool blocks", () => {
  const out = collapseToText([
    { role: "user", content: [{ type: "text", text: "q1", cache_control: { type: "ephemeral" } }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "s" },
        { type: "text", text: "looking" },
        { type: "tool_use", id: "t1", name: "top_posts", input: {} },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }] },
    { role: "assistant", content: [{ type: "text", text: "answer" }] },
    { role: "user", content: [{ type: "text", text: "q2" }] },
  ]);
  assert.deepEqual(out, [
    { role: "user", content: [{ type: "text", text: "q1", cache_control: { type: "ephemeral" } }] },
    { role: "assistant", content: [{ type: "text", text: "looking\n\nanswer" }] },
  ]);
  assert.equal(collapseToText(out, 0).length, 0);
});

test("providers index: registry, getProvider, createSession over a dataset", async () => {
  assert.deepEqual(
    PROVIDERS.map((p) => p.id),
    ["anthropic-key", "local-cli"],
  );
  assert.equal(getProvider("local-cli").id, "local-cli");
  assert.equal(getProvider("anthropic-key").id, "anthropic-key");

  clearMockRequests();
  const data = makeChatData(
    {
      posts: [],
      analytics: {},
      vault: { generatedAt: "", totalPosts: 0, categories: [], byPost: {} },
      history: [],
      scrape: { followers: { instagram: 0, tiktok: 0, youtube: 0, threads: 0, linkedin: 0 } },
      comments: [],
    },
    () => Date.parse("2026-09-28T12:00:00Z"),
  );
  const session = createSession(SETTINGS, data, {
    getKey: () => TEST_KEY,
    runTool: stubRunner(),
    fetch: scriptedFetch(() => sseResponse(textTurn("no data yet"))),
    provider: createAnthropicKeyProvider({ maxRetries: 0 }),
  });
  assert.equal(session.provider, "anthropic-key");
  const end = await session.send("How many posts?", recorder().handlers, new AbortController().signal);
  assert.deepEqual(end, { kind: "done" });
  const body = assertShape(mockRequests[0]);
  assert.ok(body.system[1].text.startsWith("DATA CARD"));
  assert.ok(body.system[1].text.includes("Today: 2026-09-28"));
  assert.ok(body.system[1].text.includes("Posts: 0 rows."));
});

test("local-cli stub: unavailable readiness, send returns an unknown error", async () => {
  assert.equal(localCliProvider.id, "local-cli");
  assert.equal(localCliProvider.needsKey, false);
  const off = await localCliProvider.readiness({ getKey: () => null, isLocalhost: false });
  assert.equal(off.ok, false);
  if (!off.ok) assert.equal(off.reason, "unavailable");
  const session = localCliProvider.createSession({
    settings: { ...SETTINGS, provider: "local-cli" },
    getKey: () => null,
    system: { rules: STATIC_RULES, dataCard: () => CARD_A },
    tools: TOOL_DEFS,
    runTool: stubRunner(),
  });
  const end = await session.send("x", recorder().handlers, new AbortController().signal);
  assert.equal(end.kind, "error");
  if (end.kind === "error") assert.equal(end.error.code, "unknown");
});
