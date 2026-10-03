/** Personal loopback connector, paired explicitly from dashboard settings. */
import type { ChatError, ChatProvider, ChatSession, ChatTurn, SendHandlers, TurnEnd, Usage } from "../types";
import { checkLocalHelper, disconnectLocalHelper, getLocalConnection, LOCAL_CHAT_URL, localChatError } from "../local-connection";
import { readSse } from "./sse";
export { LOCAL_CHAT_URL };
export const LOCAL_CLI_UNAVAILABLE = "Connect the local Claude helper in Settings. If it restarted, copy its new connection code.";
type History = { user: string; assistant: string }[];
export function boundedHistory(history: History): History {
  const result: History = [];
  let bytes = 0;
  // Leave room for the current 8,000-character question and JSON framing.
  for (const turn of history.slice(-12).reverse()) {
    if (turn.user.length > 8000 || turn.assistant.length > 16000) break;
    const size = new TextEncoder().encode(JSON.stringify(turn)).length;
    if (bytes + size > 65_000) break;
    bytes += size; result.unshift(turn);
  }
  return result;
}
function usage(value: unknown): value is Usage {
  return !!value && typeof value === "object" && ["input", "cacheRead", "cacheWrite", "output"].every(k => typeof (value as Record<string, unknown>)[k] === "number" && Number.isFinite((value as Record<string, number>)[k]) && (value as Record<string, number>)[k] >= 0);
}
class LocalCliSession implements ChatSession {
  readonly provider = "local-cli" as const;
  private history: History = [];
  private epoch = 0;
  private activeController: AbortController | null = null;
  constructor(private args: Parameters<ChatProvider["createSession"]>[0]) {}
  reset() { this.epoch++; this.activeController?.abort(); this.history = []; }
  resume(turns: ChatTurn[]) { this.reset(); this.history = boundedHistory(turns.filter(t => t.end === "done" && t.assistant.trim()).map(t => ({ user: t.user, assistant: t.assistant }))); }
  async send(text: string, h: SendHandlers, signal: AbortSignal): Promise<TurnEnd> {
    this.activeController?.abort();
    const epoch = ++this.epoch;
    const controller = new AbortController(); this.activeController = controller;
    const stop = () => controller.abort();
    signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop();
    const timer = setTimeout(stop, 95_000);
    const active = () => { controller.signal.throwIfAborted(); if (epoch !== this.epoch) throw new DOMException("Superseded", "AbortError"); };
    const fetchImpl = this.args.fetch ?? fetch;
    try {
      active();
      if (!text.trim() || text.length > 8000) throw localChatError("bad_request", "Ask a question of up to 8,000 characters.");
      const connection = getLocalConnection();
      if (!connection) throw localChatError("forbidden", LOCAL_CLI_UNAVAILABLE);
      h.onThinking();
      if (!await checkLocalHelper(fetchImpl, controller.signal)) { active(); throw localChatError("network", LOCAL_CLI_UNAVAILABLE); }
      active();
      if (getLocalConnection() !== connection) throw localChatError("forbidden", LOCAL_CLI_UNAVAILABLE);
      const response = await fetchImpl(`${LOCAL_CHAT_URL}/chat`, { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json", "X-BWP-Session": connection.token }, body: JSON.stringify({ text, effort: this.args.settings.effort, history: boundedHistory(this.history) }) });
      if (!response.ok) {
        if (response.status === 403) disconnectLocalHelper();
        throw localChatError(response.status === 429 ? "rate_limited" : response.status === 400 || response.status === 413 ? "bad_request" : "network", response.status === 429 ? "The connector is answering another question. Wait for it to finish or press Stop." : response.status === 403 ? LOCAL_CLI_UNAVAILABLE : `The local connector could not accept this question (${response.status}).`);
      }
      let answer = "";
      for await (const frame of readSse(response, controller.signal)) {
        active(); const data = JSON.parse(frame.data);
        if (!data || typeof data !== "object") throw new Error("Invalid connector frame");
        if (frame.event === "text") { if (typeof data.delta !== "string") throw new Error("Invalid text frame"); answer += data.delta; h.onText(data.delta); }
        else if (frame.event === "thinking") h.onThinking();
        else if (frame.event === "tool_call") { if (typeof data.id !== "string" || typeof data.name !== "string") throw new Error("Invalid tool frame"); h.onToolCall({ id: data.id, name: data.name, input: null }); }
        else if (frame.event === "tool_input") { if (typeof data.id !== "string") throw new Error("Invalid tool frame"); h.onToolInput(data.id, data.input); }
        else if (frame.event === "tool_result") { if (typeof data.id !== "string" || typeof data.content !== "string" || typeof data.isError !== "boolean" || typeof data.ms !== "number") throw new Error("Invalid result frame"); h.onToolResult(data.id, { content: data.content, isError: data.isError }, data.ms); }
        else if (frame.event === "error") throw localChatError(["forbidden", "rate_limited", "bad_request", "network", "unknown"].includes(data.code) ? data.code as ChatError["code"] : "unknown", typeof data.message === "string" ? data.message : "The local Claude run failed.");
        else if (frame.event === "done") {
          if (usage(data.usage)) h.onUsage?.(data.usage);
          if (!["done", "refused", "truncated", "tool_cap"].includes(data.kind)) throw new Error("Unexpected helper completion");
          if (data.kind === "done") this.history = boundedHistory([...this.history, { user: text, assistant: answer }]);
          return { kind: data.kind };
        }
      }
      throw localChatError("network", "The local connector stream ended early. Retry the question.");
    } catch (error) {
      if (signal.aborted || epoch !== this.epoch) return { kind: "aborted" };
      return { kind: "error", error: error instanceof Error && "code" in error ? error as ChatError : localChatError("network", controller.signal.aborted ? "The local query timed out. Try a narrower question." : "The local connector could not complete this answer. Check its status in Settings.") };
    } finally { clearTimeout(timer); signal.removeEventListener("abort", stop); if (this.activeController === controller) this.activeController = null; }
  }
}
export const localCliProvider: ChatProvider = {
  id: "local-cli", label: "Local Claude Code", needsKey: false,
  async readiness() { return await checkLocalHelper() ? { ok: true } : { ok: false, reason: "unavailable", detail: LOCAL_CLI_UNAVAILABLE }; },
  createSession(args) { return new LocalCliSession(args); },
};
