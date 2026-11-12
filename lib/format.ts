// Number, date, and platform helpers — ports of v1's fmt() and platformBadge().

import type { Platform } from "./types";

export function fmt(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

/** Display-size variant of fmt(): drops the decimal once a value has three
 *  leading digits ("545K", "128M") so hero numerals never exceed five glyphs. */
export function fmtShort(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  const a = Math.abs(n);
  if (a >= 100_000_000) return Math.round(n / 1_000_000) + "M";
  if (a >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (a >= 100_000) return Math.round(n / 1_000) + "K";
  if (a >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

export function fmtPct(
  n: number | undefined | null,
  digits = 1,
): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  return n.toFixed(digits) + "%";
}

/** Date-only strings ("2026-03-28") are calendar dates, not instants. The
 *  Date constructor treats them as UTC midnight, which renders as the day
 *  before anywhere west of Greenwich, so parse them as local dates. */
export function parseDate(input: string | Date): Date {
  if (input instanceof Date) return input;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(input);
}

export function fmtDate(input: string | Date | undefined): string {
  if (!input) return "—";
  const d = parseDate(input);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function relativeTime(input: string | Date | undefined): string {
  if (!input) return "—";
  const d = parseDate(input);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export const platformLabel: Record<Platform, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  threads: "Threads",
  linkedin: "LinkedIn",
  facebook: "Facebook",
  x: "X",
};

export const platformShort: Record<Platform, string> = {
  instagram: "IG",
  tiktok: "TT",
  youtube: "YT",
  threads: "TH",
  linkedin: "LI",
  facebook: "FB",
  x: "X",
};

export const platformColor: Record<Platform, string> = {
  instagram: "var(--ig)",
  tiktok: "var(--tt)",
  youtube: "var(--yt)",
  threads: "var(--th)",
  linkedin: "var(--li)",
  facebook: "var(--fb)",
  x: "var(--x)",
};

/**
 * Optical left shift for a display-size numeral so its ink, not its glyph box,
 * sits on the left edge of the label beneath it.
 *
 * Measured on the system font at weight 600: every digit carries about 0.045em
 * of left side bearing. A leading "1" is the special case. Its flag hangs left
 * of the stem, and the eye reads the stem as the edge of the number, so the
 * value slides further until the stem (0.225em from the origin) lands on the
 * label's edge (Phil, 2026-09-04: "the part that is the straight line down").
 * Apply as style={{ marginLeft: numeralShift(value) }}.
 */
export function numeralShift(value: unknown): string {
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  return text.trim().startsWith("1") ? "-0.225em" : "-0.045em";
}
