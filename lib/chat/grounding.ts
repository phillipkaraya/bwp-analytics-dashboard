// Client-side grounding tripwire (section 2.5, point 3).
//
// After a turn ends, every number in the turn's tool results and in the data
// card becomes an accepted string; the assistant text is tokenised for numeric
// tokens, and any token the data never contained is flagged so the renderer
// can underline it. A tripwire for the eye, not a blocker.
//
// Relative imports only: tsx runs this in Node without the Next alias.

import { fmt, fmtShort } from "../format";

/** A numeric token in prose: 1094, 1,094, 3.49, 3.49%, 1.1K, 12M.
 *  Not matched: digits glued to letters or underscores (post ids, "10th",
 *  "v2.1"), and the fragments of a longer number. */
export const NUMBER_TOKEN_RE = new RegExp(
  "(?<![\\w.])\\d(?:[\\d,]*\\d)?(?:\\.\\d+)?(?:[KM](?![A-Za-z]))?%?(?![\\w])",
  "g",
);

const CITATION_RE = /\[\[post:[^\]]*\]\]/g;
const LINK_RE = /\[[^\]]*\]\([^)]*\)/g;
const YEAR_RE = /^(?:19|20)\d\d$/;

/** Canonical form used for set membership: no thousands separators, no
 *  percent sign, uppercase K and M. */
export function normalizeToken(token: string): string {
  return token.replace(/,/g, "").replace(/%$/, "").toUpperCase();
}

function digitsIn(token: string): number {
  return (token.match(/\d/g) ?? []).length;
}

/** Tokens worth checking: three or more digits, or any percent or decimal.
 *  Years, day-of-month numbers and ordinals below 100 never qualify. */
export function isCheckable(token: string): boolean {
  const bare = token.replace(/%$/, "");
  if (YEAR_RE.test(bare)) return false;
  return digitsIn(bare) >= 3 || token.endsWith("%") || bare.includes(".");
}

export function numericTokens(text: string): string[] {
  return text.match(NUMBER_TOKEN_RE) ?? [];
}

function addNumber(set: Set<string>, n: number): void {
  if (!Number.isFinite(n)) return;
  for (const v of [n, Math.abs(n)]) {
    set.add(normalizeToken(String(v)));
    set.add(normalizeToken(v.toFixed(0)));
    set.add(normalizeToken(v.toFixed(1)));
    set.add(normalizeToken(v.toFixed(2)));
    set.add(normalizeToken(fmt(v)));
    set.add(normalizeToken(fmtShort(v)));
  }
}

function addText(set: Set<string>, text: string): void {
  for (const token of numericTokens(text)) set.add(normalizeToken(token));
}

function walk(value: unknown, set: Set<string>, depth: number): void {
  if (depth > 12 || value === null || value === undefined) return;
  if (typeof value === "number") {
    addNumber(set, value);
    return;
  }
  if (typeof value === "string") {
    addText(set, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, set, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) walk(item, set, depth + 1);
  }
}

/** Every number the assistant was allowed to see this turn, in every form the
 *  style rules let it write: raw, thousands separated, fmt, fmtShort, and
 *  percentages at 0, 1 and 2 decimals. `results` are the raw JSON strings of
 *  the turn's tool results; a string that is not JSON is scanned as text. */
export function acceptedNumbers(results: readonly string[], dataCard: string): Set<string> {
  const set = new Set<string>();
  for (const raw of results) {
    if (typeof raw !== "string" || raw.length === 0) continue;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (parsed === null) addText(set, raw);
    else walk(parsed, set, 0);
  }
  addText(set, dataCard);
  return set;
}

/** Numeric tokens in the assistant text that the data never contained, in
 *  order of first appearance, deduplicated. Skipped: years, tokens under three
 *  digits with no percent or decimal, numbers the creator typed in the
 *  question, and numbers inside a markdown link or a citation. */
export function flagNumbers(text: string, accepted: ReadonlySet<string>, question: string): string[] {
  const asked = new Set(numericTokens(question ?? "").map(normalizeToken));
  const clean = (text ?? "").replace(CITATION_RE, " ").replace(LINK_RE, " ");
  const flagged: string[] = [];
  const seen = new Set<string>();
  for (const token of numericTokens(clean)) {
    if (!isCheckable(token)) continue;
    const key = normalizeToken(token);
    if (asked.has(key) || accepted.has(key)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    flagged.push(token);
  }
  return flagged;
}
