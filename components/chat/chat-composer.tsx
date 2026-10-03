"use client";

// The composer (section 4.2, point 4, and 4.9): auto-growing textarea, Send
// swapped for Stop while streaming, hint and usage row, the "Ask next" chips
// after the first answer, and the 40-turn nudge.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { ArrowUpIcon, SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fmt } from "@/lib/format";
import type { Usage } from "@/lib/chat/types";
import { TRANSCRIPT_MAX_TURNS } from "@/lib/chat/transcript";
import { SuggestionChips } from "./suggestion-chips";

const MAX_ROWS = 5;
const LINE_PX = 20;
const PAD_PX = 16;

interface ChatComposerProps {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  streaming: boolean;
  /** No dataset yet: Send disabled, placeholder "Loading data…". */
  loading: boolean;
  /** Empty data or no session: the composer is inert. */
  disabled: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  onNewChat: () => void;
  lastQuestion: string | null;
  askNext: readonly string[];
  turnCount: number;
  showUsage: boolean;
  lastUsage: Usage | undefined;
  sessionUsage: Usage;
  usageUrl?: string;
}

export function ChatComposer({
  textareaRef,
  streaming,
  loading,
  disabled,
  onSend,
  onStop,
  onNewChat,
  lastQuestion,
  askNext,
  turnCount,
  showUsage,
  lastUsage,
  sessionUsage,
  usageUrl = "https://console.anthropic.com/settings/usage",
}: ChatComposerProps) {
  const [value, setValue] = useState("");
  const composingRef = useRef(false);
  const inert = loading || disabled;
  const canSend = !inert && !streaming && value.trim().length > 0;

  const grow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = LINE_PX * MAX_ROWS + PAD_PX;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [textareaRef]);

  useEffect(() => {
    grow();
  }, [value, grow]);

  const submit = useCallback(() => {
    const text = value.trim();
    if (!text || inert || streaming) return;
    onSend(text);
    setValue("");
    const el = textareaRef.current;
    if (el) el.style.height = "auto";
  }, [value, inert, streaming, onSend, textareaRef]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter") {
      if (e.nativeEvent.isComposing || composingRef.current) return;
      if (e.shiftKey && !(e.metaKey || e.ctrlKey)) return; // newline
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === "ArrowUp" && value === "" && lastQuestion) {
      e.preventDefault();
      setValue(lastQuestion);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) el.setSelectionRange(el.value.length, el.value.length);
      });
    }
  };

  const total = sessionUsage.input + sessionUsage.cacheRead + sessionUsage.cacheWrite + sessionUsage.output;
  const usageLine =
    showUsage && lastUsage
      ? `${fmt(lastUsage.input)} in · ${fmt(lastUsage.cacheRead)} cached · ${fmt(lastUsage.output)} out · chat ${fmt(total)}`
      : null;

  return (
    <div className="border-t border-border bg-card px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      {turnCount >= TRANSCRIPT_MAX_TURNS && (
        <div className="mb-3 rounded-md border border-border bg-muted/40 p-3 text-sm text-ink-soft">
          <p>This chat is getting long. Start a new chat to keep answers focused.</p>
          <div className="mt-2">
            <Button variant="outline" size="xs" onClick={onNewChat}>
              New chat
            </Button>
          </div>
        </div>
      )}
      {askNext.length > 0 && !streaming && !inert && (
        <div className="mb-2.5 flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">Ask next</span>
          <SuggestionChips items={askNext} onPick={onSend} size="xs" layout="wrap" label="Ask next" />
        </div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          disabled={inert}
          placeholder={loading ? "Loading data…" : "Ask about your posts…"}
          aria-label="Your question"
          className="w-full min-w-0 resize-none rounded-lg border border-input bg-transparent px-2.5 py-2 text-base leading-5 transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
        />
        <div className="shrink-0 py-0.5">
          {streaming ? (
            <Button variant="outline" size="icon" aria-label="Stop" onClick={onStop}>
              <SquareIcon />
            </Button>
          ) : (
            <Button size="icon" aria-label="Send" disabled={!canSend} onClick={submit}>
              <ArrowUpIcon />
            </Button>
          )}
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-3 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">
        <span className="hidden sm:inline">Enter to send · Shift+Enter for a new line</span>
        {usageLine && (
          <span className="tabular ml-auto normal-case tracking-[0.1em]">
            {usageLine}
            {" · "}
            <a
              href={usageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-ink"
            >
              usage
            </a>
          </span>
        )}
      </div>
    </div>
  );
}
