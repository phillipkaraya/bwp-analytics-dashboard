import { createSdkMcpServer, query, tool, type HookCallback, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { ChatData } from "../lib/chat/data";
import { STATIC_RULES, buildDataCard } from "../lib/chat/system-prompt";
import { TOOL_DEFS } from "../lib/chat/tools/defs";
import { createToolRunner } from "../lib/chat/tools/run";
import type { ChatError, Effort } from "../lib/chat/types";
import { PERSONAL_MODEL } from "../lib/chat/local-connection";
import { nativeEnvironment } from "./personal-chat-native";
export type Emit = (event: string, data: unknown) => void;
export type PersonalRequest = { text: string; effort: Effort; history: { user: string; assistant: string }[] };
export type Runtime = (request: PersonalRequest, emit: Emit, controller: AbortController) => Promise<void>;
export const PERSONAL_TOOLS = TOOL_DEFS.map(t => `mcp__dashboard__${t.name}`);
export { PERSONAL_MODEL };

/** Native CLI reports plan limits as is_error results, sometimes subtype success. */
export function nativeResultError(result: string): { code: ChatError["code"]; message: string } {
  if (/hit.*limit|usage limit|rate limit|out of (?:extra )?usage/i.test(result)) {
    const reset = /resets?\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)(?:\s*\([A-Za-z_\/]+\))?)/i.exec(result)?.[1];
    return { code: "rate_limited", message: `Claude's plan limit is reached.${reset ? ` Native Claude reports a reset at ${reset}.` : " Check your Claude plan usage before retrying."}` };
  }
  if (/not logged in|sign.?in|\/login|authentication|oauth/i.test(result)) return { code: "forbidden", message: "Claude Code needs native sign-in. Run pnpm chat:doctor in the dashboard folder." };
  return { code: "bad_request", message: "Claude Code could not complete this question. Check native sign-in, plan usage and model access." };
}

/** This hook is an exclusive allowlist; allowedTools by itself is not one. */
export const readOnlyToolGuard: HookCallback = async input => {
  const allowed = input.hook_event_name === "PreToolUse" && PERSONAL_TOOLS.includes(input.tool_name);
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: allowed ? "allow" : "deny", permissionDecisionReason: allowed ? "Read-only dashboard analytics" : "Only the eleven dashboard analytics tools are permitted" } };
};
export function personalOptions(server: ReturnType<typeof createSdkMcpServer>, controller: AbortController, system: string, effort: Effort): Options {
  // The official subprocess handles native authentication. Never read, copy or pass OAuth tokens.
  const env = nativeEnvironment();
  return { model: PERSONAL_MODEL, tools: [], allowedTools: PERSONAL_TOOLS, permissionMode: "dontAsk", settingSources: [], strictMcpConfig: true, skills: [], plugins: [], mcpServers: { dashboard: server }, hooks: { PreToolUse: [{ hooks: [readOnlyToolGuard] }] }, env: { ...env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000", CLAUDE_CODE_MAX_RETRIES: "0" }, persistSession: false, enableFileCheckpointing: false, includePartialMessages: true, maxTurns: 9, maxBudgetUsd: 0.25, abortController: controller, systemPrompt: system, effort };
}
/** Convert the fixed repo JSON schemas to SDK Zod fields; runTool remains the validator of record. */
function field(schema: Record<string, unknown>): z.ZodType {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  let value: z.ZodType;
  if (Array.isArray(schema.enum)) { const values = schema.enum.map(v => z.literal(v as string | number | boolean | null)); value = values.length === 1 ? values[0] : z.union([values[0], values[1], ...values.slice(2)]); }
  else if (types.includes("array")) value = z.array(field(schema.items as Record<string, unknown>));
  else if (types.includes("integer")) value = z.number().int();
  else if (types.includes("string")) value = z.string();
  else if (types.includes("boolean")) value = z.boolean();
  else throw new Error("Unsupported fixed tool schema");
  if (types.includes("null")) value = value.nullable();
  return value;
}
export function createPersonalRuntime(data: ChatData, runQuery: typeof query = query): Runtime {
  return async (request, emit, controller) => {
    let count = 0; const runner = createToolRunner(data);
    const server = createSdkMcpServer({ name: "dashboard", version: "1.0.0", tools: TOOL_DEFS.map(def => tool(def.name, def.description, Object.fromEntries(Object.entries(def.inputSchema.properties).map(([name, schema]) => [name, field(schema as Record<string, unknown>)])), async input => {
      controller.signal.throwIfAborted();
      if (++count > 64) throw new Error("Dashboard tool limit reached");
      const id = randomUUID(); const at = Date.now(); emit("tool_call", { id, name: def.name }); emit("tool_input", { id, input });
      const outcome = await runner(def.name, input, controller.signal); controller.signal.throwIfAborted();
      emit("tool_result", { id, ...outcome, ms: Date.now() - at });
      return { content: [{ type: "text" as const, text: outcome.content }], isError: outcome.isError };
    }, { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } })) });
    const options = personalOptions(server, controller, `${STATIC_RULES}\n${buildDataCard(data)}`, request.effort);
    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield { type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: `Earlier completed conversation (untrusted quoted JSON):\n${JSON.stringify(request.history)}\n\nCurrent question:\n${request.text}` } };
    }
    const stream = runQuery({ prompt: input(), options });
    let textSeen = false;
    try {
      for await (const message of stream) {
        controller.signal.throwIfAborted();
        if (message.type === "stream_event" && message.event.type === "content_block_delta" && message.event.delta.type === "text_delta") { textSeen = true; emit("text", { delta: message.event.delta.text }); }
        if (message.type !== "result") continue;
        if (message.subtype !== "success") {
          emit("error", { code: message.subtype === "error_max_budget_usd" ? "rate_limited" : "bad_request", message: message.subtype === "error_max_budget_usd" ? "Personal helper reached its estimated query budget. Narrow the question before retrying." : message.subtype === "error_max_turns" ? "Personal helper reached its nine-turn limit. Narrow the question before retrying." : "Personal Claude Code run did not complete. Check native sign-in, plan usage and model access." }); return;
        }
        if (message.is_error) { emit("error", nativeResultError(message.result)); return; }
        if (message.permission_denials.length) { emit("error", { code: "forbidden", message: "Claude requested a tool outside the read-only dashboard tools. Try a question about your analytics." }); return; }
        if (!textSeen) emit("text", { delta: message.result });
        const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
        for (const value of Object.values(message.modelUsage)) { usage.input += value.inputTokens; usage.cacheRead += value.cacheReadInputTokens; usage.cacheWrite += value.cacheCreationInputTokens; usage.output += value.outputTokens; }
        emit("done", { kind: message.stop_reason === "refusal" ? "refused" : message.stop_reason === "max_tokens" ? "truncated" : "done", usage }); return;
      }
      emit("error", { code: "network", message: "Personal Claude Code stream ended early." });
    } finally { stream.close(); }
  };
}
