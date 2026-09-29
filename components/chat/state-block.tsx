"use client";

// The bordered eyebrow-plus-sentence block (section 4.4), extracted from the
// Refresh dialog's recipe: warn for retryable trouble, negative for a key or
// request problem, neutral for declined, stopped and tool cap, brand while
// testing, positive when the key is accepted.

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type StateTone = "warn" | "negative" | "neutral" | "brand" | "positive";

const BOX: Record<StateTone, string> = {
  warn: "rounded-md border border-warn/40 bg-warn-soft p-3 text-sm text-ink-soft",
  negative: "rounded-md border border-negative/40 bg-negative-soft p-3 text-sm text-ink",
  neutral: "rounded-md border border-border bg-muted/40 p-3 text-sm text-ink-soft",
  brand: "rounded-md border border-brand/40 bg-brand-soft p-3 text-sm text-brand-deep",
  positive: "rounded-md border border-positive/40 bg-positive-soft p-3 text-sm text-ink",
};

const EYEBROW: Record<StateTone, string> = {
  warn: "text-warn",
  negative: "text-negative",
  neutral: "text-ink-muted",
  brand: "text-brand",
  positive: "text-positive",
};

interface StateBlockProps {
  tone: StateTone;
  eyebrow?: string;
  children: ReactNode;
  action?: ReactNode;
  mono?: boolean;
  className?: string;
  role?: "status" | "alert";
}

export function StateBlock({ tone, eyebrow, children, action, mono, className, role }: StateBlockProps) {
  return (
    <div className={cn(BOX[tone], className)} role={role}>
      {eyebrow && (
        <div className={cn("font-mono text-[10px] uppercase tracking-[0.18em]", EYEBROW[tone])}>{eyebrow}</div>
      )}
      <div className={cn(eyebrow && "mt-1.5", mono && "font-mono text-xs break-words")}>{children}</div>
      {action && <div className="mt-2.5 flex flex-wrap gap-2">{action}</div>}
    </div>
  );
}
