/** Connector regression tests. No credentials or model requests. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { request } from "node:http";
import { createSdkMcpServer, type HookCallback, type query } from "@anthropic-ai/claude-agent-sdk";
import { createPersonalHelper, validRequest } from "./personal-chat-helper";
import { createPersonalRuntime, nativeResultError, personalOptions, PERSONAL_TOOLS, readOnlyToolGuard, type Runtime } from "./personal-chat-runtime";
import { nativeEnvironment } from "./personal-chat-native";
import { makeChatData } from "../lib/chat/data";
import { allowedDashboardOrigin, checkLocalHelper, connectLocalHelper, disconnectLocalHelper, getLocalConnection, PERSONAL_MODEL } from "../lib/chat/local-connection";
import { boundedHistory, localCliProvider } from "../lib/chat/providers/local-cli";
import { readSse } from "../lib/chat/providers/sse";
import type { ChatTurn, SendHandlers } from "../lib/chat/types";
import { describeEnd } from "../components/chat/chat-message";

const ORIGIN = "https://phillipkaraya.github.io";
const question = { text: "How did IG do?", effort: "medium", history: [] };
const INFO = { protocol: 1, chat: true, mode: "claude", model: PERSONAL_MODEL, signedIn: true };
const CODE = "a".repeat(32), TOKEN = "b".repeat(64); // synthetic fixtures only
const json = (value: unknown, status = 200) => Response.json(value, { status });
const goodRuntime: Runtime = async (_request, emit) => { emit("text", { delta: "Fixture answer" }); emit("done", { kind: "done" }); };
async function listening(runtime = goodRuntime, options: Parameters<typeof createPersonalHelper>[3] = {}) {
  const helper = createPersonalHelper(runtime, "mock", 0, options);
  await new Promise<void>(resolve => helper.server.listen(0, "127.0.0.1", resolve));
  const address = helper.server.address(); assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const pair = async (origin = ORIGIN) => {
    const response = await fetch(`${url}/connect`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ code: helper.connectionCode }) });
    assert.equal(response.status, 200);
    return (await response.json()).token as string;
  };
  return { ...helper, url, pair };
}
function handlers(output: string[] = []): SendHandlers {
  return { onThinking() {}, onText(delta) { output.push(delta); }, onToolCall() {}, onToolInput() {}, onToolResult() {} };
}
function session(fetchImpl: typeof fetch) {
  return localCliProvider.createSession({ settings: { v: 1, provider: "local-cli", effort: "medium", showUsage: true }, getKey: () => null, system: { rules: "", dataCard: () => "" }, tools: [], runTool: async () => ({ content: "{}", isError: false }), fetch: fetchImpl });
}
function stream(frames: string, fragment = 3): Response {
  const bytes = new TextEncoder().encode(frames);
  return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += fragment) c.enqueue(bytes.slice(i, i + fragment)); c.close(); } }), { headers: { "Content-Type": "text/event-stream" } });
}
async function syntheticPair(fetchImpl: typeof fetch = async () => json({ ...INFO, token: TOKEN })) {
  disconnectLocalHelper(); await connectLocalHelper(CODE, fetchImpl);
}

test("only the live dashboard and fixed local origins may request the helper", () => {
  assert.ok(allowedDashboardOrigin(ORIGIN)); assert.ok(allowedDashboardOrigin("http://localhost:3114"));
  for (const origin of [undefined, "null", "https://evil.test", `${ORIGIN}.evil.test`, "http://localhost:8888"]) assert.equal(allowedDashboardOrigin(origin), false);
});
test("pairing is required; its token is origin-bound and never returned by ping", async () => {
  const h = await listening();
  try {
    assert.equal((await fetch(`${h.url}/ping`, { headers: { Origin: ORIGIN } })).status, 403);
    assert.equal((await fetch(`${h.url}/connect`, { headers: { Origin: ORIGIN } })).status, 403);
    const page = await fetch(`${h.url}/connect`); assert.equal(page.status, 200); assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.ok((await page.text()).includes(h.connectionCode));
    const token = await h.pair();
    const ping = await fetch(`${h.url}/ping`, { headers: { Origin: ORIGIN, "X-BWP-Session": token } });
    const info = await ping.json(); assert.equal(info.mode, "mock"); assert.equal("token" in info, false);
    assert.equal((await fetch(`${h.url}/ping`, { headers: { Origin: "http://localhost:3114", "X-BWP-Session": token } })).status, 403);
    assert.equal((await fetch(`${h.url}/ping`, { headers: { Origin: "https://evil.test", "X-BWP-Session": token } })).status, 403);
    const hostileHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${h.url}/ping`, { headers: { Host: "evil.test", Origin: ORIGIN, "X-BWP-Session": token } }, res => { res.resume(); resolve(res.statusCode); }); req.on("error", reject); req.end();
    });
    assert.equal(hostileHost, 403);
    const response = await fetch(`${h.url}/chat`, { method: "POST", headers: { Origin: ORIGIN, "X-BWP-Session": token, "Content-Type": "application/json" }, body: JSON.stringify(question) });
    assert.ok((await response.text()).includes("Fixture answer"));
  } finally { await h.close(); }
});
test("private-network preflight is exact-origin and header-restricted", async () => {
  const h = await listening();
  try {
    const headers = { Origin: ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-bwp-session", "Access-Control-Request-Private-Network": "true" };
    const response = await fetch(`${h.url}/chat`, { method: "OPTIONS", headers }); assert.equal(response.status, 204); assert.equal(response.headers.get("Access-Control-Allow-Private-Network"), "true");
    assert.equal((await fetch(`${h.url}/chat`, { method: "OPTIONS", headers: { ...headers, "Access-Control-Request-Headers": "authorization" } })).status, 403);
  } finally { await h.close(); }
});
test("invalid pairing attempts are rate-limited and a restart invalidates old tokens", async () => {
  const h = await listening(); const token = await h.pair();
  try {
    for (let i = 0; i < 10; i++) assert.equal((await fetch(`${h.url}/connect`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ code: "invalid" }) })).status, 403);
    assert.equal((await fetch(`${h.url}/connect`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ code: h.connectionCode }) })).status, 429);
  } finally { await h.close(); }
  const next = await listening();
  try { assert.equal((await fetch(`${next.url}/ping`, { headers: { Origin: ORIGIN, "X-BWP-Session": token } })).status, 403); }
  finally { await next.close(); }
});
test("request shape rejects injected options, excess history and oversized text", () => {
  assert.ok(validRequest(question));
  for (const value of [{ ...question, model: "other" }, { ...question, text: "x".repeat(8001) }, { ...question, text: " " }, { ...question, effort: "max" }, { ...question, history: Array(13).fill({ user: "x", assistant: "y" }) }, { ...question, history: [{ user: "x", assistant: "y", command: "shell" }] }]) assert.equal(validRequest(value), false);
});
test("oversized HTTP bodies and malformed JSON never reach the model", async () => {
  let calls = 0; const h = await listening(async () => { calls++; });
  try {
    const token = await h.pair();
    const send = (body: string) => fetch(`${h.url}/chat`, { method: "POST", headers: { Origin: ORIGIN, "X-BWP-Session": token, "Content-Type": "application/json" }, body });
    assert.equal((await send("x".repeat(120_001))).status, 413);
    assert.equal((await send("{broken")).status, 400);
    assert.equal((await send(JSON.stringify({ ...question, command: "Bash" }))).status, 400);
    assert.equal(calls, 0);
  } finally { await h.close(); }
});
test("native weekly limit is clear and distinct from sign-in or denied tools", () => {
  const error = nativeResultError("You've hit your weekly limit · resets 11am (America/New_York)");
  assert.equal(error.code, "rate_limited"); assert.match(error.message, /11am \(America\/New_York\)/);
  assert.equal(nativeResultError("Not logged in · Please run /login").code, "forbidden");
  const block = describeEnd({ id: "fixture", at: "", user: "x", assistant: "", traces: [], end: "error", error }, "local-cli");
  assert.equal(block?.eyebrow, "Claude plan limit"); assert.match(block?.text ?? "", /11am/); assert.equal(block?.action, null);
});
test("deadline aborts the model, ends SSE and releases the busy slot", async () => {
  let aborted = false;
  const h = await listening(async (_r, _e, c) => { await new Promise<void>(resolve => c.signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true })); }, { timeoutMs: 30 });
  try {
    const token = await h.pair();
    const send = () => fetch(`${h.url}/chat`, { method: "POST", headers: { Origin: ORIGIN, "X-BWP-Session": token, "Content-Type": "application/json" }, body: JSON.stringify(question) });
    const first = await send(); assert.equal((await send()).status, 429);
    assert.ok((await first.text()).includes("timed out")); assert.ok(aborted);
    const next = await send(); assert.equal(next.status, 200); await next.text();
  } finally { await h.close(); }
});
test("disconnecting the browser aborts the active helper request", async () => {
  let notify!: () => void; const aborted = new Promise<void>(resolve => { notify = resolve; });
  const h = await listening(async (_r, _e, c) => { await new Promise<void>(resolve => c.signal.addEventListener("abort", () => { notify(); resolve(); }, { once: true })); });
  try {
    const token = await h.pair(); const controller = new AbortController();
    await fetch(`${h.url}/chat`, { method: "POST", signal: controller.signal, headers: { Origin: ORIGIN, "X-BWP-Session": token, "Content-Type": "application/json" }, body: JSON.stringify(question) });
    controller.abort(); await Promise.race([aborted, new Promise((_, reject) => setTimeout(() => reject(new Error("Model did not stop")), 1500))]);
  } finally { await h.close(); }
});
test("no native request starts without successful native sign-in", async () => {
  let calls = 0;
  const h = createPersonalHelper(async () => { calls++; }, "claude", 0, { checkSignedIn: async () => false });
  await new Promise<void>(resolve => h.server.listen(0, "127.0.0.1", resolve));
  const address = h.server.address(); assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/connect`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ code: h.connectionCode }) }); assert.equal(response.status, 401); assert.equal(calls, 0);
  } finally { await h.close(); }
});
test("late Connect completion cannot restore a disconnected session", async () => {
  let release!: (value: Response) => void;
  const pending = connectLocalHelper(CODE, () => new Promise<Response>(resolve => { release = resolve; }));
  disconnectLocalHelper(); release(json({ ...INFO, token: TOKEN }));
  await assert.rejects(pending, { name: "AbortError" }); assert.equal(getLocalConnection(), null);
});
test("a restarted helper clears client pairing; no pairing means no network request", async () => {
  disconnectLocalHelper(); let requests = 0;
  const fetchImpl: typeof fetch = async () => { requests++; return json({}, 403); };
  assert.equal(await checkLocalHelper(fetchImpl), null); assert.equal(requests, 0);
  await syntheticPair(); assert.equal(await checkLocalHelper(fetchImpl), null); assert.equal(getLocalConnection(), null);
});
test("client decodes fragmented UTF-8 SSE and replays only completed turns", async () => {
  await syntheticPair(); const bodies: Array<{ history: unknown[] }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/ping")) return json(INFO);
    bodies.push(JSON.parse(String(init?.body)));
    return stream('event: text\ndata: {"delta":"Hello 👋"}\n\nevent: done\ndata: {"kind":"done"}\n\n', 1);
  };
  const s = session(fetchImpl), output: string[] = [];
  s.resume(["done", "aborted", "error", "truncated", "refused"].map((end, i) => ({ id: String(i), at: "", user: `u${i}`, assistant: `a${i}`, traces: [], end } as ChatTurn)));
  assert.equal((await s.send("first", handlers(output), new AbortController().signal)).kind, "done"); assert.equal(output.join(""), "Hello 👋"); assert.equal(bodies[0].history.length, 1);
  await s.send("second", handlers(), new AbortController().signal); assert.equal(bodies[1].history.length, 2); disconnectLocalHelper();
});
test("Stop and reset settle without adding partial text to later history", async () => {
  await syntheticPair(); let chatCalls = 0, nextHistory: unknown[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/ping")) return json(INFO);
    chatCalls++; nextHistory = JSON.parse(String(init?.body)).history;
    return stream('event: text\ndata: {"delta":"partial"}\n\nevent: done\ndata: {"kind":"done"}\n\n');
  };
  const s = session(fetchImpl); const controller = new AbortController();
  assert.equal((await s.send("stop", handlersWithStop(() => { controller.abort(); s.reset(); }), controller.signal)).kind, "aborted");
  await s.send("fresh", handlers(), new AbortController().signal); assert.equal(nextHistory.length, 0); assert.equal(chatCalls, 2);
  const already = new AbortController(); already.abort(); assert.equal((await s.send("ignored", handlers(), already.signal)).kind, "aborted"); assert.equal(chatCalls, 2); disconnectLocalHelper();
});
function handlersWithStop(stop: () => void): SendHandlers { return { ...handlers(), onText: stop }; }
test("history is bounded by encoded bytes, including Unicode and JSON escaping", () => {
  const result = boundedHistory(Array.from({ length: 12 }, () => ({ user: "😀".repeat(4000), assistant: "\\".repeat(16000) })));
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).length <= 65_100); assert.ok(result.length > 0 && result.length < 12);
});
test("malformed or interrupted SSE cannot complete a turn", async () => {
  await assert.rejects(async () => { for await (const frame of readSse(stream('event: text\ndata: {"delta":"unfinished"}'), new AbortController().signal)) void frame; }, /inside a frame/);
});
test("native runtime disables file/shell/web tools and credential overrides", async () => {
  const options = personalOptions(createSdkMcpServer({ name: "dashboard", tools: [] }), new AbortController(), "fixture", "medium");
  assert.deepEqual(options.tools, []); assert.deepEqual(options.allowedTools, PERSONAL_TOOLS); assert.equal(PERSONAL_TOOLS.length, 11);
  assert.deepEqual(options.settingSources, []); assert.equal(options.permissionMode, "dontAsk"); assert.equal(options.persistSession, false); assert.equal(options.maxTurns, 9); assert.equal(options.maxBudgetUsd, 0.25);
  for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"]) assert.equal(key in nativeEnvironment(), false);
  for (const name of ["Bash", "Read", "Write", "WebFetch", "mcp__other__summarize_metrics", ...PERSONAL_TOOLS]) {
    const result = await readOnlyToolGuard({ hook_event_name: "PreToolUse", tool_name: name } as Parameters<HookCallback>[0], undefined, { signal: new AbortController().signal });
    assert.equal("hookSpecificOutput" in result && result.hookSpecificOutput && "permissionDecision" in result.hookSpecificOutput ? result.hookSpecificOutput.permissionDecision : undefined, PERSONAL_TOOLS.includes(name) ? "allow" : "deny");
  }
});
test("SDK success/refusal/budget/weekly-limit results retain the provider contract and close the stream", async () => {
  const data = makeChatData({ posts: [], analytics: {}, vault: { generatedAt: "", totalPosts: 0, categories: [], byPost: {} }, history: [], scrape: { followers: { instagram: 0, tiktok: 0, youtube: 0, threads: 0, linkedin: 0 } } });
  for (const [subtype, stop, expected] of [["success", "end_turn", "done"], ["success", "refusal", "refused"], ["error_max_budget_usd", "end_turn", "error"], ["success", "end_turn", "quota"]]) {
    let closed = false; const events: Array<[string, unknown]> = [];
    const fake = (() => Object.assign((async function* () { yield { type: "result", subtype, is_error: expected === "quota", permission_denials: [], stop_reason: stop, result: expected === "quota" ? "You've hit your weekly limit · resets 11am (America/New_York)" : "Fixture", modelUsage: {} }; })(), { close() { closed = true; } })) as unknown as typeof query;
    await createPersonalRuntime(data, fake)({ ...question, effort: "medium" }, (name, value) => events.push([name, value]), new AbortController());
    assert.ok(closed); const last = events.at(-1)!;
    assert.equal(last[0], ["error", "quota"].includes(expected) ? "error" : "done");
    if (expected === "quota") { assert.equal((last[1] as { code: string }).code, "rate_limited"); assert.equal(events.some(e => e[0] === "text"), false); }
    else if (expected !== "error") assert.equal((last[1] as { kind: string }).kind, expected);
  }
});
