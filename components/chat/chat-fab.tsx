"use client";

// Phone-only floating button (section 4.1): the header pill scrolls away on
// long pages, so this is the entry point once it has. Hidden while the panel
// is open.

import { MessageSquareTextIcon } from "lucide-react";
import { useChatContext } from "./chat-root";

export function ChatFab() {
  const { open, setOpen, chat } = useChatContext();
  if (open) return null;
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Ask the dashboard"
      aria-haspopup="dialog"
      className="sm:hidden fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-40 inline-flex items-center gap-2 rounded-full bg-[var(--ink)] px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.16em] text-white shadow-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {chat.streaming && <span aria-hidden className="size-1.5 rounded-full bg-brand motion-safe:animate-pulse" />}
      <MessageSquareTextIcon className="size-3.5" aria-hidden />
      Ask
    </button>
  );
}
