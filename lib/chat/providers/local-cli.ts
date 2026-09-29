// Local CLI provider (section 1.6): a stub today, with the contract the
// local helper will implement written down here so components/chat never
// has to change when it lands.
//
// Future contract
//   POST ${SCRAPER_URL}/chat
//   body: { sessionId: string, text: string, effort: "medium" | "high" }
//   response: text/event-stream, one JSON object per `data:` line, events:
//     thinking     {}                                          -> handlers.onThinking()
//     text         { delta: string }                           -> handlers.onText(delta)
//     tool_call    { id: string, name: string }                -> handlers.onToolCall({ id, name, input: null })
//     tool_input   { id: string, input: unknown }              -> handlers.onToolInput(id, input)
//     tool_result  { id: string, content: string, isError: boolean, ms: number }
//                                                              -> handlers.onToolResult(id, { content, isError }, ms)
//     done         { kind: "done" | "refused" | "truncated" | "tool_cap", usage?: Usage }
//     error        { code: ChatError["code"], message: string, retryAfterSec?: number }
//   The helper runs the same tool set (lib/chat/tools/defs.json) over
//   public/data/*.json on disk through MCP, so `runTool` is unused on this
//   path and the tool trace, cards and citations render exactly as they do
//   for the API-key provider. GET ${SCRAPER_URL}/ping advertises `chat: true`
//   in its body once the helper supports the route; until then readiness()
//   reports unavailable and the settings card stays disabled.
//
// Relative imports only: tsx runs this in Node without the Next alias.

import { SCRAPER_URL } from "../../scrape-client";
import type { ChatError, ChatProvider, ChatSession, Readiness, TurnEnd } from "../types";

export const LOCAL_CLI_PING_TIMEOUT_MS = 1500;
export const LOCAL_CLI_UNAVAILABLE = "Needs the local helper. Coming in a later update.";

function chatError(code: ChatError["code"], message: string): ChatError {
  const err = new Error(message) as ChatError;
  err.name = "ChatError";
  err.code = code;
  return err;
}

/** True when the helper's ping body advertises the chat route. */
export async function pingLocalChat(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${SCRAPER_URL}/ping`, {
      cache: "no-store",
      signal: AbortSignal.timeout(LOCAL_CLI_PING_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { chat?: unknown };
    return body?.chat === true;
  } catch {
    return false;
  }
}

class LocalCliSession implements ChatSession {
  readonly provider = "local-cli" as const;

  async send(): Promise<TurnEnd> {
    return { kind: "error", error: chatError("unknown", LOCAL_CLI_UNAVAILABLE) };
  }

  reset(): void {
    // No private history yet.
  }

  resume(): void {
    // No private history yet.
  }
}

export const localCliProvider: ChatProvider = {
  id: "local-cli",
  label: "Local CLI (Claude, Codex or Gemini)",
  needsKey: false,
  async readiness(deps): Promise<Readiness> {
    if (!deps.isLocalhost) return { ok: false, reason: "unavailable", detail: "Local only." };
    const ready = await pingLocalChat();
    return ready ? { ok: true } : { ok: false, reason: "unavailable", detail: LOCAL_CLI_UNAVAILABLE };
  },
  createSession(): ChatSession {
    return new LocalCliSession();
  },
};
