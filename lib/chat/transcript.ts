// sessionStorage mirror of the UI transcript (section 4.10).
//
// Stored as { v: 1, turns, updatedAt }. Raw tool-result JSON is kept only for
// the last two turns; older traces are reduced to their label and status.
// Capped at 40 turns. Never holds the key. Cleared by New chat, Forget key and
// sign out.

import type { ChatTurn, ToolTrace } from "./types";

export const TRANSCRIPT_KEY = "bwp_chat_transcript_v1";
export const TRANSCRIPT_MAX_TURNS = 40;
/** Turns (from the newest) that keep their raw tool-result JSON. */
export const TRANSCRIPT_RAW_TURNS = 2;

interface StoredTranscript {
  v: 1;
  turns: ChatTurn[];
  updatedAt: string;
}

function session(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function slimTrace(t: ToolTrace): ToolTrace {
  return {
    id: t.id,
    name: t.name,
    input: null,
    label: t.label,
    result: null,
    isError: t.isError,
    ms: null,
    status: t.status,
  };
}

/** Apply the 4.10 trim: newest 40 turns, raw results on the last two only,
 *  and a turn that was still streaming is stored as aborted so a reload never
 *  shows a bubble that streams forever. */
export function trimTurns(turns: ChatTurn[]): ChatTurn[] {
  const kept = turns.slice(-TRANSCRIPT_MAX_TURNS);
  const rawFrom = Math.max(0, kept.length - TRANSCRIPT_RAW_TURNS);
  return kept.map((turn, i) => {
    const traces = i >= rawFrom ? turn.traces : turn.traces.map(slimTrace);
    return {
      ...turn,
      traces: traces.map((t) => (t.status === "running" ? { ...t, status: "error" as const } : t)),
      end: turn.end ?? "aborted",
    };
  });
}

function isTurn(v: unknown): v is ChatTurn {
  if (!v || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  return typeof t.id === "string" && typeof t.user === "string" && typeof t.assistant === "string";
}

export function readTranscript(): ChatTurn[] {
  const s = session();
  if (!s) return [];
  try {
    const raw = s.getItem(TRANSCRIPT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return [];
    const stored = parsed as Partial<StoredTranscript>;
    if (stored.v !== 1 || !Array.isArray(stored.turns)) return [];
    return stored.turns.filter(isTurn).map((t) => ({
      ...t,
      at: typeof t.at === "string" ? t.at : "",
      traces: Array.isArray(t.traces) ? t.traces : [],
      end: t.end ?? "aborted",
    }));
  } catch {
    return [];
  }
}

export function writeTranscript(turns: ChatTurn[]): void {
  const s = session();
  if (!s) return;
  const payload: StoredTranscript = {
    v: 1,
    turns: trimTurns(turns),
    updatedAt: new Date().toISOString(),
  };
  try {
    s.setItem(TRANSCRIPT_KEY, JSON.stringify(payload));
  } catch {
    // Quota or blocked storage: the in-memory transcript is still the truth.
  }
}

export function clearTranscript(): void {
  const s = session();
  if (!s) return;
  try {
    s.removeItem(TRANSCRIPT_KEY);
  } catch {
    // Nothing to clear when storage is blocked.
  }
}
