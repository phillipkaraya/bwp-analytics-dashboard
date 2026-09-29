// follower_growth (section 2.3, tool 9): current counts from scrape_state,
// every stored snapshot, the change between the last two (followerDeltas)
// and since the first. Counts are rounded scrapes and the notes say so.

import type { FollowerSnapshot, Platform } from "../../types";
import { PLATFORMS, followerDeltas, toNum } from "../../derive";
import type { ChatData } from "../data";
import type { ToolEnvelope } from "../types";
import { DAY, EMPTY_DATA_NOTE, envelope } from "./rows";
import type { FollowerGrowthInput } from "./validate";

export interface SnapshotRow {
  date: string;
  instagram: number;
  tiktok: number;
  youtube: number;
  threads: number;
  linkedin: number | null;
}
export interface DeltaBlock {
  from: string | null;
  to: string | null;
  days: number | null;
  byPlatform: Record<Platform, number | null>;
  total: number | null;
}
export interface FollowerGrowthResult {
  current: Record<Platform, number>;
  snapshots: SnapshotRow[];
  latestDelta: DeltaBlock;
  sinceFirst: DeltaBlock;
}

function nullPlatforms(): Record<Platform, number | null> {
  return { instagram: null, tiktok: null, youtube: null, threads: null, linkedin: null };
}

function daysBetween(a: string, b: string): number | null {
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round((tb - ta) / DAY);
}

function deltaBetween(from: FollowerSnapshot, to: FollowerSnapshot): DeltaBlock {
  const byPlatform = nullPlatforms();
  let total = 0;
  let any = false;
  for (const p of PLATFORMS) {
    if (from[p] === undefined || to[p] === undefined) continue;
    const d = toNum(to[p]) - toNum(from[p]);
    byPlatform[p] = d;
    total += d;
    any = true;
  }
  return { from: from.date, to: to.date, days: daysBetween(from.date, to.date), byPlatform, total: any ? total : null };
}

export function runFollowerGrowth(data: ChatData, input: FollowerGrowthInput): ToolEnvelope<FollowerGrowthResult> {
  const filters: Record<string, unknown> = { ...input };
  const current = {} as Record<Platform, number>;
  for (const p of PLATFORMS) current[p] = Math.round(toNum(data.scrape.followers?.[p]));

  const sorted = [...data.history].filter((h) => h && typeof h.date === "string" && h.date).sort((a, b) => a.date.localeCompare(b.date));
  const snapshots: SnapshotRow[] = sorted.map((h) => ({
    date: h.date,
    instagram: toNum(h.instagram),
    tiktok: toNum(h.tiktok),
    youtube: toNum(h.youtube),
    threads: toNum(h.threads),
    linkedin: h.linkedin === undefined ? null : toNum(h.linkedin),
  }));

  const notes: string[] = [];
  if (data.posts.length === 0) notes.push(EMPTY_DATA_NOTE);

  let latestDelta: DeltaBlock = { from: null, to: null, days: null, byPlatform: nullPlatforms(), total: null };
  let sinceFirst: DeltaBlock = { from: null, to: null, days: null, byPlatform: nullPlatforms(), total: null };
  if (sorted.length >= 2) {
    const deltas = followerDeltas(sorted);
    const last = sorted[sorted.length - 1];
    const prev = sorted[sorted.length - 2];
    latestDelta = {
      from: deltas.since,
      to: last.date,
      days: deltas.since ? daysBetween(deltas.since, last.date) : null,
      byPlatform: deltas.byPlatform,
      total: deltas.total,
    };
    sinceFirst = deltaBetween(sorted[0], last);
    const known = PLATFORMS.map((p) => deltas.byPlatform[p]).filter((d): d is number => d !== null);
    if (known.length > 0 && known.every((d) => d === 0)) {
      notes.push(`No change between the last two snapshots (${prev.date} and ${last.date})`);
    }
    const missing = PLATFORMS.filter((p) => sorted[0][p] === undefined && last[p] !== undefined);
    if (missing.length) notes.push(`${missing.join(", ")} first appears in the snapshot of ${sorted.find((h) => missing.every((p) => h[p] !== undefined))?.date ?? last.date}, so its change since the first snapshot is null`);
  } else if (sorted.length === 1) {
    notes.push("Only one snapshot exists, so there is no change to report yet");
  } else {
    notes.push("No follower snapshots are stored yet");
  }

  notes.push("Counts are rounded as the platforms display them");
  if (sorted.length > 0) notes.push(`Only ${sorted.length} ${sorted.length === 1 ? "snapshot exists" : "snapshots exist"}; the earliest is ${sorted[0].date}`);

  return envelope(data, "all time", filters, notes, { current, snapshots, latestDelta, sinceFirst });
}
