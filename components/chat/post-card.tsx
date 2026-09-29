"use client";

// Post cards (section 4.6). A card never shows a number the tool did not
// return: reach plus its metric word ("391 likes", "1.1K views"). The
// thumbnail comes from the dataset by id, never from a tool result, and a
// failed image swaps to the platform's soft block.

import { useState } from "react";
import type { Platform } from "@/lib/types";
import { fmtDate, fmtShort, platformShort } from "@/lib/format";
import { PlatformBadge } from "@/components/charts/platform-badge";
import { cn } from "@/lib/utils";

export interface CardData {
  id: string;
  platform: Platform;
  date: string;
  title: string;
  reach: number;
  reachMetric: "views" | "likes";
  url: string | null;
  thumbnailUrl: string | null;
}

const SOFT_BLOCK: Record<Platform, string> = {
  instagram: "bg-[color-mix(in_oklab,var(--ig)_15%,transparent)] text-[color:var(--ig)]",
  tiktok: "bg-[color-mix(in_oklab,var(--tt)_10%,transparent)] text-[color:var(--tt)]",
  youtube: "bg-[color-mix(in_oklab,var(--yt)_15%,transparent)] text-[color:var(--yt)]",
  threads: "bg-[color-mix(in_oklab,var(--th)_10%,transparent)] text-[color:var(--th)]",
  linkedin: "bg-[color-mix(in_oklab,var(--li)_14%,transparent)] text-[color:var(--li)]",
};

export function PostCard({ card, className }: { card: CardData; className?: string }) {
  const [broken, setBroken] = useState(false);
  const showImage = !!card.thumbnailUrl && !broken;
  const body = (
    <>
      <div className="size-14 shrink-0 overflow-hidden rounded-md bg-muted">
        {showImage ? (
          // Instagram and TikTok CDNs refuse hotlinks with a referrer, and the
          // repo already renders these with a plain img (images.unoptimized).
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={card.thumbnailUrl ?? undefined}
            alt=""
            referrerPolicy="no-referrer"
            loading="lazy"
            decoding="async"
            className="size-full object-cover"
            onError={() => setBroken(true)}
          />
        ) : (
          <div
            aria-hidden
            className={cn(
              "flex size-full items-center justify-center font-mono text-xs uppercase tracking-[0.14em]",
              SOFT_BLOCK[card.platform],
            )}
          >
            {platformShort[card.platform]}
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-sm font-medium text-ink">{card.title || "(no title)"}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">
          <PlatformBadge platform={card.platform} size="sm" />
          <span aria-hidden>·</span>
          <span>{card.date ? fmtDate(card.date) : "no date"}</span>
          <span aria-hidden>·</span>
          <span className="tabular">
            {fmtShort(card.reach)} {card.reachMetric}
          </span>
        </div>
      </div>
    </>
  );
  const classes = cn(
    "card card-hover flex gap-3 rounded-lg p-2.5 focus-visible:ring-3 focus-visible:ring-ring/50 outline-none",
    className,
  );
  if (card.url) {
    return (
      <a href={card.url} target="_blank" rel="noopener noreferrer" className={classes}>
        {body}
      </a>
    );
  }
  return <div className={classes}>{body}</div>;
}

/** A rail of cards: a two-column grid from sm up, a snap-scrolling row on
 *  phones (bleeding into the panel's 20px gutters). */
export function PostCardRail({ cards, eyebrow }: { cards: CardData[]; eyebrow?: string }) {
  if (cards.length === 0) return null;
  return (
    <div className="mt-2">
      {eyebrow && (
        <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">{eyebrow}</div>
      )}
      <div className="-mx-5 flex snap-x snap-mandatory gap-2 overflow-x-auto px-5 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0">
        {cards.map((card) => (
          <PostCard key={card.id} card={card} className="min-w-[260px] snap-start sm:min-w-0" />
        ))}
      </div>
    </div>
  );
}
