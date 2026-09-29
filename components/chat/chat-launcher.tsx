"use client";

// The header pill that opens the panel (section 4.1). Same recipe as the
// status pill beside it; icon-only below sm so the header row fits at 375px.

import { MessageSquareTextIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useChatContext } from "./chat-root";

export function ChatLauncher({ tone = "dark" }: { tone?: "light" | "dark" }) {
  const { open, toggle, chat, launcherRef, isMac } = useChatContext();
  const dark = tone === "dark";
  const busy = chat.streaming && !open;
  return (
    <button
      ref={launcherRef}
      type="button"
      onClick={toggle}
      aria-label="Ask the dashboard"
      aria-haspopup="dialog"
      aria-expanded={open}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] transition outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        dark
          ? open
            ? "border-white/40 text-white"
            : "border-white/15 text-white/75 hover:border-white/40 hover:text-white"
          : open
            ? "border-brand/50 text-ink"
            : "border-border text-ink-muted hover:border-brand/50 hover:text-ink",
      )}
    >
      {busy && <span aria-hidden className="size-1.5 rounded-full bg-brand motion-safe:animate-pulse" />}
      <MessageSquareTextIcon className="size-3.5" aria-hidden />
      <span className="hidden sm:inline">Ask</span>
      <span className={cn("hidden lg:inline", dark ? "text-white/40" : "text-ink-muted/70")} aria-hidden>
        {isMac ? "⌘K" : "Ctrl K"}
      </span>
    </button>
  );
}
