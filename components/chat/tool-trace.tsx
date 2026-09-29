"use client";

// Tool trace chips (section 4.4): one chip per call with a status dot,
// expandable to the pretty JSON the model received. This is the audit trail.

import { useId, useState } from "react";
import type { ToolTrace as ToolTraceItem } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

const CHIP =
  "inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted";

function prettyResult(result: string | null): string | null {
  if (result === null) return null;
  try {
    return JSON.stringify(JSON.parse(result), null, 2);
  } catch {
    return result;
  }
}

function TraceChip({ trace }: { trace: ToolTraceItem }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const pretty = open ? prettyResult(trace.result) : null;
  return (
    <div className="max-w-full">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className={cn(CHIP, "max-w-full transition hover:text-ink outline-none focus-visible:ring-3 focus-visible:ring-ring/50")}
        title={trace.ms !== null ? `${trace.name} · ${trace.ms} ms` : trace.name}
      >
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            trace.status === "running" && "bg-brand motion-safe:animate-pulse",
            trace.status === "done" && "bg-positive",
            trace.status === "error" && "bg-negative",
          )}
        />
        <span className="truncate normal-case tracking-[0.1em]">{trace.label}</span>
        {trace.status === "running" && <span className="sr-only">, running</span>}
        {trace.status === "error" && <span className="sr-only">, failed</span>}
      </button>
      {open && (
        <div id={panelId}>
          {pretty !== null ? (
            <pre className="mt-2 max-h-64 overflow-x-auto rounded bg-ink/90 px-3 py-2 font-mono text-[11px] text-white">
              {pretty}
            </pre>
          ) : (
            <p className="mt-2 font-mono text-[11px] text-ink-muted">
              {trace.status === "running" ? "Waiting for the result…" : "Result not kept after the page reloaded."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

interface ToolTraceProps {
  traces: readonly ToolTraceItem[];
  /** Show the single "Thinking…" chip: streaming with nothing else to show. */
  thinking?: boolean;
  /** An extra running chip, e.g. "Loading comments (2.6 MB)…". */
  hint?: string | null;
}

export function ToolTrace({ traces, thinking, hint }: ToolTraceProps) {
  if (traces.length === 0 && !thinking && !hint) return null;
  return (
    <div className="mb-2 flex flex-wrap items-start gap-1.5">
      {traces.map((trace) => (
        <TraceChip key={trace.id} trace={trace} />
      ))}
      {hint && (
        <span className={CHIP} role="status">
          <span aria-hidden className="size-1.5 rounded-full bg-brand motion-safe:animate-pulse" />
          <span className="normal-case tracking-[0.1em]">{hint}</span>
        </span>
      )}
      {thinking && (
        <span className={CHIP}>
          <span aria-hidden className="size-1.5 rounded-full bg-brand motion-safe:animate-pulse" />
          <span className="normal-case tracking-[0.1em]">Thinking…</span>
        </span>
      )}
    </div>
  );
}
