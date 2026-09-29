"use client";

// Suggestion chips (section 4.3): the data-aware starters in the empty state
// and the smaller "Ask next" row above the composer. Clicking sends the text.

import { cn } from "@/lib/utils";

interface SuggestionChipsProps {
  items: readonly string[];
  onPick: (text: string) => void;
  disabled?: boolean;
  /** "sm" is the empty-state size, "xs" the Ask next row. */
  size?: "sm" | "xs";
  /** Wrap on desktop and scroll on phones (empty state), or always wrap. */
  layout?: "responsive" | "wrap";
  label?: string;
  className?: string;
}

export function SuggestionChips({
  items,
  onPick,
  disabled,
  size = "sm",
  layout = "responsive",
  label,
  className,
}: SuggestionChipsProps) {
  if (items.length === 0) return null;
  return (
    <div
      role="group"
      aria-label={label ?? "Suggested questions"}
      className={cn(
        layout === "responsive"
          ? "-mx-5 flex flex-nowrap gap-2 overflow-x-auto px-5 sm:mx-0 sm:flex-wrap sm:px-0"
          : "flex flex-wrap gap-2",
        className,
      )}
    >
      {items.map((text) => (
        <button
          key={text}
          type="button"
          disabled={disabled}
          onClick={() => onPick(text)}
          className={cn(
            "shrink-0 rounded-full border border-border bg-card text-ink-soft transition outline-none hover:border-brand/50 hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
            size === "sm" ? "px-3 py-1.5 text-xs" : "px-2.5 py-1 text-[11px]",
          )}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
