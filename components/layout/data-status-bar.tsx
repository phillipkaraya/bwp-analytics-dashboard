"use client";

import { useEffect, useState } from "react";
import { loadScrapeState } from "@/lib/data";
import type { ScrapeState } from "@/lib/types";
import { relativeTime } from "@/lib/format";
import { signOut } from "@/lib/auth";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrapeDialog } from "./scrape-dialog";

const STALE_AFTER_MS = 7 * 86_400_000;

interface Freshness {
  last?: string;
  stale: boolean;
}

export function DataStatusBar({ tone = "light" }: { tone?: "light" | "dark" }) {
  // Freshness is derived once from the fetched state, so render stays pure
  // (no Date.now() in the render path).
  const [fresh, setFresh] = useState<Freshness | null>(null);
  // The per-platform state is handed to the Refresh dialog so each platform
  // toggle can show its own post count and last run.
  const [state, setState] = useState<ScrapeState | null>(null);
  const [open, setOpen] = useState(false);
  const dark = tone === "dark";

  useEffect(() => {
    let live = true;
    loadScrapeState()
      .then((s) => {
        if (!live) return;
        setState(s);
        const last = [
          s.instagram?.lastScrapedDate,
          s.tiktok?.lastScrapedDate,
          s.youtube?.lastScrapedDate,
          s.threads?.lastScrapedDate,
          s.linkedin?.lastScrapedDate,
          s.lastAutoCheck,
        ]
          .filter((d): d is string => !!d)
          .sort()
          .reverse()[0];
        const stale = last
          ? Date.now() - new Date(last).getTime() > STALE_AFTER_MS
          : true;
        setFresh({ last, stale });
      })
      .catch(() => {
        if (live) setFresh({ stale: true });
      });
    return () => {
      live = false;
    };
  }, []);

  const stale = fresh?.stale ?? true;

  return (
    <div className="flex items-center gap-3">
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] transition",
            dark
              ? "border-white/15 text-white/75 hover:border-white/40 hover:text-white"
              : "border-border text-ink-muted hover:border-brand/50 hover:text-ink",
          )}
          aria-label="Data status and actions"
        >
          <span
            aria-hidden
            className={cn(
              "inline-block h-1.5 w-1.5 rounded-full",
              fresh === null ? "bg-current opacity-40" : stale ? "bg-warn" : "bg-positive",
            )}
          />
          <span>
            {fresh === null
              ? "checking"
              : `${stale ? "Stale" : "Live"} · ${fresh.last ? relativeTime(fresh.last) : "never"}`}
          </span>
          <span aria-hidden className="opacity-60">
            ▾
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuItem onClick={() => setOpen(true)}>Refresh data</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              signOut();
              window.location.reload();
            }}
          >
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ScrapeDialog
        open={open}
        onOpenChange={setOpen}
        lastScrapedDate={fresh?.last}
        state={state}
      />
    </div>
  );
}
