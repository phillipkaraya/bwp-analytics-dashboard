"use client";

import { Section } from "@/components/charts/section";
import { useState } from "react";
import { fmt, platformLabel } from "@/lib/format";
import { StaleNote } from "@/components/layout/stale-note";
import type { FollowData, Platform } from "@/lib/types";
import { cn } from "@/lib/utils";

interface FollowBackProps {
  data: FollowData;
}

// The platforms follow_data.json covers. It is the March 2026 snapshot of the
// personal pages, so platforms added since then have no tab here.
const TABS = ["instagram", "tiktok", "youtube", "threads", "linkedin"] as const satisfies readonly Platform[];
type FollowPlatform = (typeof TABS)[number];

export function DoesntFollowBack({ data }: FollowBackProps) {
  const [active, setActive] = useState<FollowPlatform>("instagram");
  const platformData = data[active];
  const list = platformData?.dontFollowBack ?? [];
  const scrapedAt = platformData?.scrapedAt ?? undefined;

  return (
    <Section
      title="Doesn't Follow Back"
      hint="Accounts you follow that do not follow you back"
      action={
        <div className="flex flex-wrap gap-1 rounded border border-border p-0.5">
          {TABS.map((t) => {
            const count = data[t]?.dontFollowBack?.length ?? 0;
            return (
              <button
                key={t}
                onClick={() => setActive(t)}
                className={cn(
                  "rounded px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition",
                  active === t
                    ? "bg-brand text-white"
                    : "text-ink-muted hover:text-ink",
                )}
              >
                {platformLabel[t]} · {fmt(count)}
              </button>
            );
          })}
        </div>
      }
      bodyClassName="-mx-5 max-h-[420px] overflow-auto"
    >
      {scrapedAt && (
        <StaleNote
          date={scrapedAt}
          label="Follow data"
          detail="Follows and unfollows since then are not reflected."
          className="mx-5 mb-3 -mt-1"
        />
      )}
      {list.length === 0 ? (
        <div className="py-8 text-center text-sm text-ink-muted">
          {platformData?.note || "No data for this platform yet."}
        </div>
      ) : (
        <table className="data-table tabular w-full text-sm">
          <thead className="sticky top-0 bg-card">
            <tr className="border-y border-border bg-muted/40 text-left">
              <th className="px-5 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">
                Username
              </th>
              <th className="px-2 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">
                Display name
              </th>
              <th className="px-5 py-2 text-right font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">
                Verified
              </th>
            </tr>
          </thead>
          <tbody>
            {list.slice(0, 100).map((u) => (
              <tr
                key={u.id || u.username}
                className="border-b border-border even:bg-muted/30 last:border-b-0 hover:bg-muted/40"
              >
                <td className="px-5 py-1.5 font-mono text-brand">
                  @{u.username}
                </td>
                <td className="max-w-[200px] truncate px-2 py-1.5 text-ink-soft">
                  {u.fullName ?? "—"}
                </td>
                <td className="px-5 py-1.5 text-right text-ink-muted">
                  {u.isVerified ? "✓" : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {list.length > 100 && (
        <div className="border-t border-border px-5 py-2 text-center text-[11px] text-ink-muted">
          Showing 100 of {fmt(list.length)}.
        </div>
      )}
    </Section>
  );
}
