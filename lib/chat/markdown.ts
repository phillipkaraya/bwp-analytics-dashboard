// Markdown subset renderer for assistant text (section 4.5), no dependency,
// no HTML passthrough. Paragraphs, **bold**, `code`, hyphen bullets, numbered
// lists, http(s) links, pipe tables, demoted headings. Everything else is
// escaped text, so "<img onerror>" in model output renders literally.
//
// Citations [[post:ID]] are removed from the text and collected per block;
// the caller supplies ctx.cards to render a card rail after that block.
// Numeric tokens in ctx.flagged get the dotted warn underline.
//
// Relative imports only for repo modules; React's createElement keeps this a
// .ts file the tools scripts can import without JSX.

import { createElement, Fragment, type ReactNode } from "react";
import type { Platform } from "../types";
import { NUMBER_TOKEN_RE } from "./grounding";

export const CITATION_RE = /\[\[post:([^\]\s]+)\]\]/g;
export const FLAG_TITLE = "This number is not in the data the assistant was given";

const PLATFORM_WORDS: Record<string, Platform> = {
  instagram: "instagram",
  ig: "instagram",
  tiktok: "tiktok",
  tt: "tiktok",
  youtube: "youtube",
  yt: "youtube",
  threads: "threads",
  th: "threads",
  linkedin: "linkedin",
  li: "linkedin",
};

export interface RenderContext {
  /** Tokens flagged by grounding.flagNumbers, exactly as they appear. */
  flagged?: ReadonlySet<string> | null;
  /** Card rail for the citations found in one block. Return null to skip. */
  cards?: (ids: string[], key: string) => ReactNode;
  /** Platform word in a table cell, rendered as a badge. */
  platformBadge?: (platform: Platform) => ReactNode;
}

// Text helpers

/** Display-time voice fix: " em dash " and " en dash " become ", ", a bare
 *  dash becomes ",", and a spaced double hyphen becomes ", ". The stored
 *  transcript is untouched. */
export function normalizeVoice(text: string): string {
  return text
    .replace(/(\d[\d,]*(?:\.\d+)?%?)\s*[\u2014\u2013]\s*(\d)/g, "$1 to $2")
    .replace(/(Sep \d+)\s*[\u2014\u2013]\s*(Sep \d+)/g, "$1 to $2")
    .replace(/ [\u2014\u2013] /g, ", ")
    .replace(/[\u2014\u2013]/g, ",")
    .replace(/ -{2} /g, ", ");
}

/** While streaming, hold back markers that have not closed yet: a trailing
 *  "[[post:" without its "]]" is cut, and an odd trailing "**" is dropped so
 *  the text after it shows as plain text until the bold closes. An open table
 *  row (a "|" line with no closing pipe) is left in place: the block parser
 *  renders it as a plain paragraph until the row closes. */
export function holdIncompleteMarkers(text: string): string {
  let out = text;
  const lastOpen = out.lastIndexOf("[[");
  if (lastOpen !== -1 && out.indexOf("]]", lastOpen) === -1) {
    out = out.slice(0, lastOpen);
  }
  const lastBreak = out.lastIndexOf("\n\n");
  const tail = out.slice(lastBreak + 1);
  const marks = tail.match(/\*\*/g);
  if (marks && marks.length % 2 === 1) {
    const idx = out.lastIndexOf("**");
    out = out.slice(0, idx) + out.slice(idx + 2);
  }
  return out;
}

/** Remove every [[post:ID]] token and return the unique ids in order. */
export function extractCitations(text: string): { text: string; ids: string[] } {
  const ids: string[] = [];
  const seen = new Set<string>();
  const clean = text.replace(CITATION_RE, (_m, id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
    return "";
  });
  return { text: clean.replace(/[ \t]{2,}/g, " ").replace(/ +([.,;:!?])/g, "$1"), ids };
}

// Block parsing

type Block =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; lines: string[] }
  | { kind: "bullets"; items: string[] }
  | { kind: "numbered"; items: string[] }
  | { kind: "table"; header: string[]; rows: string[][] };

const HEADING_RE = /^\s{0,3}#{1,6}\s+(.*)$/;
const BULLET_RE = /^\s*[-*•]\s+(.*)$/;
const NUMBERED_RE = /^\s*\d{1,3}[.)]\s+(.*)$/;
const SEPARATOR_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function isTableRow(line: string): boolean {
  return line.trim().startsWith("|");
}

function closedRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length > 1;
}

function splitCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", text: heading[1] });
      i += 1;
      continue;
    }
    if (BULLET_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = BULLET_RE.exec(lines[i]);
        if (!m) break;
        items.push(m[1]);
        i += 1;
      }
      blocks.push({ kind: "bullets", items });
      continue;
    }
    if (NUMBERED_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = NUMBERED_RE.exec(lines[i]);
        if (!m) break;
        items.push(m[1]);
        i += 1;
      }
      blocks.push({ kind: "numbered", items });
      continue;
    }
    if (closedRow(line) && i + 1 < lines.length && SEPARATOR_RE.test(lines[i + 1]) && isTableRow(lines[i + 1])) {
      const header = splitCells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && closedRow(lines[i])) {
        rows.push(splitCells(lines[i]));
        i += 1;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    const para: string[] = [line];
    i += 1;
    while (i < lines.length) {
      const next = lines[i];
      if (next.trim() === "" || HEADING_RE.test(next) || BULLET_RE.test(next) || NUMBERED_RE.test(next)) break;
      if (closedRow(next) && i + 1 < lines.length && SEPARATOR_RE.test(lines[i + 1])) break;
      para.push(next);
      i += 1;
    }
    blocks.push({ kind: "paragraph", lines: para });
  }
  return blocks;
}

// Inline rendering

const INLINE_RE = /(\*\*[^*\n]+?\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;

function renderNumbers(text: string, ctx: RenderContext, keyPrefix: string): ReactNode[] {
  const flagged = ctx.flagged;
  if (!flagged || flagged.size === 0 || text.length === 0) return [text];
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  const re = new RegExp(NUMBER_TOKEN_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const token = m[0];
    if (!flagged.has(token)) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      createElement(
        "span",
        { key: `${keyPrefix}-f${n++}`, className: "underline decoration-dotted decoration-warn", title: FLAG_TITLE },
        token,
      ),
    );
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderInline(text: string, ctx: RenderContext, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  const re = new RegExp(INLINE_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    if (m.index > last) out.push(...renderNumbers(text.slice(last, m.index), ctx, `${keyPrefix}-t${n}`));
    const key = `${keyPrefix}-i${n++}`;
    if (raw.startsWith("**")) {
      out.push(
        createElement("strong", { key, className: "font-semibold text-ink" }, ...renderNumbers(raw.slice(2, -2), ctx, key)),
      );
    } else if (raw.startsWith("`")) {
      out.push(createElement("code", { key, className: "rounded bg-muted px-1 font-mono text-[12px] text-ink" }, raw.slice(1, -1)));
    } else {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(raw);
      if (link) {
        out.push(
          createElement(
            "a",
            {
              key,
              href: link[2],
              target: "_blank",
              rel: "noopener noreferrer",
              className: "break-words text-brand underline underline-offset-2 hover:text-brand-deep",
            },
            link[1],
          ),
        );
      } else {
        out.push(raw);
      }
    }
    last = m.index + raw.length;
  }
  if (last < text.length) out.push(...renderNumbers(text.slice(last), ctx, `${keyPrefix}-t${n}`));
  return out;
}

function renderLines(lines: string[], ctx: RenderContext, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push(createElement("br", { key: `${keyPrefix}-br${i}` }));
    out.push(...renderInline(line, ctx, `${keyPrefix}-l${i}`));
  });
  return out;
}

const NUMERIC_CELL_RE = /^[\d,.]+[KM%]?$/;

function renderCell(text: string, ctx: RenderContext, key: string, header: boolean): ReactNode {
  const numeric = NUMERIC_CELL_RE.test(text);
  const platform = PLATFORM_WORDS[text.toLowerCase()];
  const className = header
    ? "px-2 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted"
    : numeric
      ? "px-2 py-1.5 text-right tabular"
      : "px-2 py-1.5";
  const content: ReactNode =
    !header && platform && ctx.platformBadge ? ctx.platformBadge(platform) : renderInline(text, ctx, key);
  return createElement(header ? "th" : "td", { key, className, scope: header ? "col" : undefined }, content);
}

function renderTable(block: Extract<Block, { kind: "table" }>, ctx: RenderContext, key: string): ReactNode {
  const width = block.header.length;
  const rows = block.rows.map((cells, r) => {
    const padded = cells.length >= width ? cells.slice(0, width) : [...cells, ...Array(width - cells.length).fill("")];
    return createElement(
      "tr",
      { key: `${key}-r${r}`, className: "border-b border-border even:bg-muted/30 last:border-b-0" },
      ...padded.map((cell, c) => renderCell(cell, ctx, `${key}-r${r}c${c}`, false)),
    );
  });
  return createElement(
    "div",
    { key, className: "my-2 -mx-1 overflow-x-auto" },
    createElement(
      "table",
      { className: "data-table tabular w-full text-xs" },
      createElement(
        "thead",
        null,
        createElement(
          "tr",
          { className: "border-y border-border bg-muted/40 text-left" },
          ...block.header.map((cell, c) => renderCell(cell, ctx, `${key}-hc${c}`, true)),
        ),
      ),
      createElement("tbody", null, ...rows),
    ),
  );
}

function blockText(block: Block): string {
  switch (block.kind) {
    case "heading":
      return block.text;
    case "paragraph":
      return block.lines.join("\n");
    case "bullets":
    case "numbered":
      return block.items.join("\n");
    case "table":
      return [block.header.join("|"), ...block.rows.map((r) => r.join("|"))].join("\n");
  }
}

function stripCitations(block: Block): { block: Block; ids: string[] } {
  const ids: string[] = [];
  const seen = new Set<string>();
  const strip = (s: string) => {
    const r = extractCitations(s);
    for (const id of r.ids) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    return r.text;
  };
  let out: Block;
  switch (block.kind) {
    case "heading":
      out = { kind: "heading", text: strip(block.text) };
      break;
    case "paragraph":
      out = { kind: "paragraph", lines: block.lines.map(strip) };
      break;
    case "bullets":
      out = { kind: "bullets", items: block.items.map(strip) };
      break;
    case "numbered":
      out = { kind: "numbered", items: block.items.map(strip) };
      break;
    case "table":
      out = { kind: "table", header: block.header.map(strip), rows: block.rows.map((r) => r.map(strip)) };
      break;
  }
  return { block: out, ids };
}

/** Render assistant text to React nodes. Every block with citations is
 *  followed by ctx.cards(ids). Text that is only citations renders nothing. */
export function renderMarkdown(text: string, ctx: RenderContext = {}): ReactNode {
  const blocks = parseBlocks(text ?? "");
  const nodes: ReactNode[] = [];
  blocks.forEach((raw, b) => {
    const key = `b${b}`;
    const { block, ids } = stripCitations(raw);
    const empty = blockText(block).trim().length === 0;
    if (!empty) {
      switch (block.kind) {
        case "heading":
          nodes.push(
            createElement("p", { key, className: "font-display font-semibold text-ink mt-3" }, ...renderInline(block.text, ctx, key)),
          );
          break;
        case "paragraph":
          nodes.push(createElement("p", { key, className: "my-1.5 break-words" }, ...renderLines(block.lines, ctx, key)));
          break;
        case "bullets":
          nodes.push(
            createElement(
              "ul",
              { key, className: "my-1.5 list-disc space-y-0.5 pl-5" },
              ...block.items.map((item, i) => createElement("li", { key: `${key}-${i}` }, ...renderInline(item, ctx, `${key}-${i}`))),
            ),
          );
          break;
        case "numbered":
          nodes.push(
            createElement(
              "ol",
              { key, className: "my-1.5 list-decimal space-y-0.5 pl-5" },
              ...block.items.map((item, i) => createElement("li", { key: `${key}-${i}` }, ...renderInline(item, ctx, `${key}-${i}`))),
            ),
          );
          break;
        case "table":
          nodes.push(renderTable(block, ctx, key));
          break;
      }
    }
    if (ids.length > 0 && ctx.cards) {
      const rail = ctx.cards(ids, `${key}-cards`);
      if (rail) nodes.push(createElement(Fragment, { key: `${key}-cards` }, rail));
    }
  });
  return createElement(Fragment, null, ...nodes);
}
