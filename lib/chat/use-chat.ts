// The turn loop the panel drives (section 5, lib/chat/use-chat.ts).
//
// Owns the provider-neutral transcript (ChatTurn[]), the AbortController of
// the live turn, requestAnimationFrame buffering of text deltas so the DOM
// updates at most once per frame, the grounding check after each turn, and
// the sessionStorage mirror through ./transcript. The ChatSession itself is
// created by ChatRoot (through lib/chat/providers) and handed in; a new
// session identity is resumed from the stored turns.
//
// Relative imports only: tsx runs this in Node without the Next alias.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatData } from "./data";
import { acceptedNumbers, flagNumbers, groundingResults } from "./grounding";
import { describeCall } from "./tools/defs";
import { clearTranscript, readTranscript, writeTranscript } from "./transcript";
import type { ChatError, ChatSession, ChatTurn, SendHandlers, ToolTrace, TurnEnd, Usage } from "./types";

export type ChatStatus = "idle" | "thinking" | "tools" | "streaming";

/** Per-turn facts the transcript type does not carry: wall time and the
 *  grounding flags. Never persisted. */
export interface TurnMeta {
  ms: number | null;
  flags: string[];
}

export interface UseChatArgs {
  data: ChatData | null;
  session: ChatSession | null;
  /** The data card the session was built with, for the grounding check. */
  dataCard: () => string;
}

export interface UseChatResult {
  turns: ChatTurn[];
  streaming: boolean;
  status: ChatStatus;
  meta: Record<string, TurnMeta>;
  /** Text for the visually hidden live region. */
  announce: string;
  sessionUsage: Usage;
  send(text: string): void;
  stop(): void;
  retry(): void;
  newChat(): void;
}

export const EMPTY_USAGE: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

export function addUsage(a: Usage | undefined, b: Usage): Usage {
  const base = a ?? EMPTY_USAGE;
  return {
    input: base.input + (b.input || 0),
    cacheRead: base.cacheRead + (b.cacheRead || 0),
    cacheWrite: base.cacheWrite + (b.cacheWrite || 0),
    output: base.output + (b.output || 0),
  };
}

export function newTurnId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // fall through
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isChatError(err: unknown): err is ChatError {
  return !!err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string";
}

/** A thrown value from session.send becomes an error end so the UI always
 *  gets a TurnEnd. Providers return TurnEnd; this is the safety net. */
export function endFromThrown(err: unknown): TurnEnd {
  if (isChatError(err)) return { kind: "error", error: err };
  const error = new Error(err instanceof Error ? err.message : "Something went wrong.") as ChatError;
  error.code = "unknown";
  return { kind: "error", error };
}

export function useChat({ data, session, dataCard }: UseChatArgs): UseChatResult {
  // The stored transcript seeds the state. readTranscript() is guarded for
  // Node and returns [] there; in the app this hook only mounts inside the
  // client-only PIN gate, so there is no server markup to mismatch.
  const [turns, setTurns] = useState<ChatTurn[]>(() => readTranscript());
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [meta, setMeta] = useState<Record<string, TurnMeta>>({});
  const [announce, setAnnounce] = useState("");

  const turnsRef = useRef<ChatTurn[]>(turns);
  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);
  const liveIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pendingRef = useRef("");
  /** Mirror of the live turn's text and traces, so the grounding check at the
   *  end never has to read React state. */
  const liveRef = useRef<{ assistant: string; traces: Map<string, ToolTrace> }>({ assistant: "", traces: new Map() });
  const rafRef = useRef<number | null>(null);
  const resumedRef = useRef<ChatSession | null>(null);
  const streaming = status !== "idle";

  // A new session identity rebuilds its text-only history from the turns.
  useEffect(() => {
    if (!session) return;
    if (resumedRef.current === session) return;
    resumedRef.current = session;
    const done = turnsRef.current.filter((t) => t.end !== null);
    if (done.length > 0) session.resume(done);
  }, [session]);

  // Mirror to sessionStorage between turns, never per delta.
  useEffect(() => {
    if (streaming) return;
    if (turns.length === 0) {
      clearTranscript();
      return;
    }
    writeTranscript(turns);
  }, [turns, streaming]);

  const patchTurn = useCallback((id: string, patch: (turn: ChatTurn) => ChatTurn) => {
    setTurns((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx === -1) return prev;
      const next = prev.slice();
      next[idx] = patch(prev[idx]);
      return next;
    });
  }, []);

  const flush = useCallback(() => {
    rafRef.current = null;
    const id = liveIdRef.current;
    const chunk = pendingRef.current;
    if (!id || chunk.length === 0) return;
    pendingRef.current = "";
    patchTurn(id, (t) => ({ ...t, assistant: t.assistant + chunk }));
  }, [patchTurn]);

  const scheduleFlush = useCallback(() => {
    if (rafRef.current !== null) return;
    if (typeof requestAnimationFrame === "function") {
      rafRef.current = requestAnimationFrame(flush);
    } else {
      rafRef.current = -1;
      setTimeout(flush, 16);
    }
  }, [flush]);

  useEffect(
    () => () => {
      if (rafRef.current !== null && typeof cancelAnimationFrame === "function" && rafRef.current >= 0) {
        cancelAnimationFrame(rafRef.current);
      }
      abortRef.current?.abort();
    },
    [],
  );

  const send = useCallback(
    (raw: string) => {
      const text = (raw ?? "").trim();
      if (!text || !session || !data || liveIdRef.current) return;

      const id = newTurnId();
      const started = Date.now();
      const turn: ChatTurn = {
        id,
        at: new Date(started).toISOString(),
        user: text,
        assistant: "",
        traces: [],
        end: null,
      };
      liveIdRef.current = id;
      pendingRef.current = "";
      liveRef.current = { assistant: "", traces: new Map() };
      setTurns((prev) => [...prev, turn]);
      setStatus("thinking");
      setAnnounce("Thinking");

      const controller = new AbortController();
      abortRef.current = controller;

      const current = () => liveIdRef.current === id && abortRef.current === controller;
      const handlers: SendHandlers = {
        onRestart: (keepChars, dropToolIds) => {
          if (!current()) return;
          flush();
          liveRef.current.assistant = liveRef.current.assistant.slice(0, keepChars);
          for (const traceId of dropToolIds) liveRef.current.traces.delete(traceId);
          patchTurn(id, (t) => ({ ...t, assistant: t.assistant.slice(0, keepChars), traces: t.traces.filter((x) => !dropToolIds.includes(x.id)) }));
          setStatus("thinking");
        },
        onThinking: () => { if (current()) setStatus((s) => (s === "streaming" ? s : "thinking")); },
        onText: (delta) => {
          if (!current() || !delta) return;
          pendingRef.current += delta;
          liveRef.current.assistant += delta;
          setStatus("streaming");
          scheduleFlush();
        },
        onToolCall: (call) => {
          if (!current()) return;
          flush();
          const label = describeCall(call.name, call.input);
          const trace: ToolTrace = {
            id: call.id,
            name: call.name,
            input: call.input,
            label,
            result: null,
            isError: false,
            ms: null,
            status: "running",
          };
          liveRef.current.traces.set(call.id, trace);
          patchTurn(id, (t) => ({ ...t, traces: [...t.traces.filter((x) => x.id !== call.id), trace] }));
          setStatus("tools");
          setAnnounce(`Looking up ${label.toLowerCase()}`);
        },
        onToolInput: (traceId, input) => {
          if (!current()) return;
          const live = liveRef.current.traces.get(traceId);
          if (live) liveRef.current.traces.set(traceId, { ...live, input, label: describeCall(live.name, input) });
          patchTurn(id, (t) => ({
            ...t,
            traces: t.traces.map((x) =>
              x.id === traceId ? { ...x, input, label: describeCall(x.name, input) } : x,
            ),
          }));
        },
        onToolResult: (traceId, outcome, ms) => {
          if (!current()) return;
          const live = liveRef.current.traces.get(traceId);
          if (live) {
            liveRef.current.traces.set(traceId, {
              ...live,
              result: outcome.content,
              isError: outcome.isError,
              ms,
              status: outcome.isError ? "error" : "done",
            });
          }
          patchTurn(id, (t) => ({
            ...t,
            traces: t.traces.map((x) =>
              x.id === traceId
                ? {
                    ...x,
                    result: outcome.content,
                    isError: outcome.isError,
                    ms,
                    status: outcome.isError ? "error" : "done",
                  }
                : x,
            ),
          }));
        },
        onUsage: (u) => {
          if (!current()) return;
          patchTurn(id, (t) => ({ ...t, usage: addUsage(t.usage, u) }));
        },
      };

      const finish = (end: TurnEnd) => {
        if (!current()) return;
        flush();
        const ms = Date.now() - started;
        const live = liveRef.current;
        const results = groundingResults(turnsRef.current, live.traces.values());
        let flags: string[] = [];
        try {
          flags = flagNumbers(live.assistant, acceptedNumbers(results, dataCard()), text);
        } catch {
          flags = [];
        }
        setMeta((m) => ({ ...m, [id]: { ms, flags } }));
        patchTurn(id, (t) => ({
          ...t,
          traces: t.traces.map((x) => (x.status === "running" ? { ...x, status: "error" as const } : x)),
          end: end.kind,
          error:
            end.kind === "error"
              ? { code: end.error.code, message: end.error.message, retryAfterSec: end.error.retryAfterSec }
              : undefined,
        }));
        liveIdRef.current = null;
        abortRef.current = null;
        setStatus("idle");
        setAnnounce(end.kind === "done" ? "Answer ready" : "Stopped");
      };

      session
        .send(text, handlers, controller.signal)
        .then(finish)
        .catch((err: unknown) => finish(endFromThrown(err)));
    },
    [session, data, dataCard, flush, scheduleFlush, patchTurn],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const retry = useCallback(() => {
    if (liveIdRef.current) return;
    const last = turnsRef.current[turnsRef.current.length - 1];
    if (!last) return;
    setTurns((prev) => prev.slice(0, -1));
    setMeta((m) => {
      const next = { ...m };
      delete next[last.id];
      return next;
    });
    // Let the removal commit before the new turn is appended.
    setTimeout(() => send(last.user), 0);
  }, [send]);

  const newChat = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    liveIdRef.current = null;
    pendingRef.current = "";
    if (rafRef.current !== null && typeof cancelAnimationFrame === "function" && rafRef.current >= 0) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    liveRef.current = { assistant: "", traces: new Map() };
    turnsRef.current = [];
    setTurns([]);
    setMeta({});
    setStatus("idle");
    setAnnounce("");
    clearTranscript();
    session?.reset();
    resumedRef.current = session;
  }, [session]);

  const sessionUsage = useMemo(
    () => turns.reduce<Usage>((sum, t) => (t.usage ? addUsage(sum, t.usage) : sum), EMPTY_USAGE),
    [turns],
  );

  return { turns, streaming, status, meta, announce, sessionUsage, send, stop, retry, newChat };
}
