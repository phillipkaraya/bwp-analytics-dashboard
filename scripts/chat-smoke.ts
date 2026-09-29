// Real API smoke test for the in-dashboard assistant (spec section 7, step 4).
//
// The key arrives ONLY as an environment variable, injected by the resolver:
// from the repo root run `secret-sync run ANTHROPIC_API_KEY`, then a double
// hyphen, then `pnpm chat:smoke`. The script refuses any key-shaped argv,
// never prints the key, the headers or a request body, and exits 1 when an
// assertion fails.
//
// It builds the same rules, data card and tools the browser uses from
// public/data on disk, runs three turns in one conversation, streams the
// answers to stdout, prints each tool call with its input, duration and
// result size, then the usage per request and per turn. Asserts: every turn
// ends `done` with at least one tool call; every [[post:ID]] id exists in
// that turn's tool results; no em dash, en dash or double hyphen in any
// answer; the grounding check flags nothing; cacheRead > 0 on every request
// after the first. Run it twice back to back to confirm the second run's
// first request also reads cache.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { makeChatData, type ChatData } from "../lib/chat/data";
import { acceptedNumbers, flagNumbers } from "../lib/chat/grounding";
import { CITATION_RE } from "../lib/chat/markdown";
import { CHAT_MODEL, SDK_VERSION } from "../lib/chat/providers/anthropic-key";
import { createSession } from "../lib/chat/providers/index";
import { buildDataCard } from "../lib/chat/system-prompt";
import { describeCall } from "../lib/chat/tools/defs";
import { createToolRunner } from "../lib/chat/tools/run";
import type { ChatSettings, SendHandlers, ToolOutcome, Usage } from "../lib/chat/types";
import type { Comment, Post } from "../lib/types";

const ROOT = resolve(__dirname, "..");
const DATA_DIR = resolve(ROOT, "public/data");
const PLATFORM_FILES = ["instagram", "tiktok", "youtube", "threads", "linkedin"] as const;
const KEY_ENV_NAMES = ["ANTHROPIC_API_KEY_BWP_CHAT", "ANTHROPIC_API_KEY"] as const;
const KEY_SHAPE = /^sk-ant-/;
const DASH_RE = /\u2014|\u2013| -{2} /;

const QUESTIONS = [
  "Best posts in the last 180 days",
  "Which platform grew the most?",
  "Compare the last 90 days with the 90 before",
] as const;

const SETTINGS: ChatSettings = { v: 1, provider: "anthropic-key", effort: "medium", showUsage: true };

interface ToolRecord {
  id: string;
  name: string;
  input: unknown;
  startedAt: number;
  ms: number | null;
  outcome: ToolOutcome | null;
}

interface TurnRecord {
  question: string;
  text: string;
  tools: ToolRecord[];
  usage: Usage[];
}

const failures: string[] = [];

function fail(message: string): void {
  failures.push(message);
  process.stdout.write(`\nFAIL: ${message}\n`);
}

function readJson<T>(file: string, fallback: T): T {
  const path = resolve(DATA_DIR, file);
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function loadDataset(): ChatData {
  const posts: Post[] = PLATFORM_FILES.flatMap((p) => readJson<Post[]>(`${p}_posts.json`, []));
  return makeChatData({
    posts,
    analytics: readJson("analytics.json", {}),
    vault: readJson("content_vault.json", { generatedAt: "", totalPosts: 0, categories: [], byPost: {} }),
    history: readJson("follower_history.json", []),
    scrape: readJson("scrape_state.json", {
      followers: { instagram: 0, tiktok: 0, youtube: 0, threads: 0, linkedin: 0 },
    }),
    comments: () => Promise.resolve(readJson<Comment[]>("comments.json", [])),
  });
}

/** The key is read once, from the environment only, and handed to the
 *  session through a closure. It is never assigned to anything printable. */
function resolveKey(): (() => string | null) | null {
  for (const arg of process.argv.slice(2)) {
    if (KEY_SHAPE.test(arg.trim())) {
      process.stdout.write("Refusing to run: a key-shaped argument was passed. The key must come from the environment.\n");
      return null;
    }
  }
  const name = KEY_ENV_NAMES.find((n) => typeof process.env[n] === "string" && process.env[n]!.length > 0);
  if (!name) {
    process.stdout.write(
      [
        "No key in the environment. Store one once with:",
        "  secret-sync set ANTHROPIC_API_KEY_BWP_CHAT",
        "then run this script through secret-sync run so the value reaches it as an environment variable.",
        "",
      ].join("\n"),
    );
    return null;
  }
  process.stdout.write(`Key source: ${name} (value not shown)\n`);
  return () => process.env[name] ?? null;
}

function sumUsage(list: readonly Usage[]): Usage {
  return list.reduce(
    (acc, u) => ({
      input: acc.input + u.input,
      cacheRead: acc.cacheRead + u.cacheRead,
      cacheWrite: acc.cacheWrite + u.cacheWrite,
      output: acc.output + u.output,
    }),
    { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  );
}

function fmtUsage(u: Usage): string {
  return `${u.input} in · ${u.cacheRead} cached · ${u.cacheWrite} cache write · ${u.output} out`;
}

function citationIds(text: string): string[] {
  const ids: string[] = [];
  for (const m of text.matchAll(CITATION_RE)) ids.push(m[1]);
  return ids;
}

function checkTurn(turn: TurnRecord, index: number): void {
  const label = `turn ${index + 1}`;
  if (turn.tools.length === 0) fail(`${label}: no tool call was made`);
  const results = turn.tools.map((t) => t.outcome?.content ?? "");
  for (const id of citationIds(turn.text)) {
    const quoted = JSON.stringify(id);
    if (!results.some((r) => r.includes(quoted))) fail(`${label}: citation ${id} is not in any tool result`);
  }
  if (DASH_RE.test(turn.text)) fail(`${label}: the answer contains an em dash, an en dash or a double hyphen`);
  const flagged = flagNumbers(turn.text, acceptedNumbers(results, buildDataCard(data)), turn.question);
  if (flagged.length > 0) fail(`${label}: grounding flagged ${flagged.map((f) => JSON.stringify(f)).join(", ")}`);
}

let data: ChatData;

async function main(): Promise<number> {
  const getKey = resolveKey();
  if (!getKey) return 1;

  data = loadDataset();
  process.stdout.write(`Model ${CHAT_MODEL} · SDK ${SDK_VERSION} · ${data.rawPostCount} post rows\n`);
  if (data.posts.length === 0) {
    process.stdout.write("public/data holds no posts; nothing to smoke test.\n");
    return 1;
  }

  const session = createSession(SETTINGS, data, { getKey, runTool: createToolRunner(data) });
  const allUsage: Usage[] = [];
  const turns: TurnRecord[] = [];

  for (const [i, question] of QUESTIONS.entries()) {
    const turn: TurnRecord = { question, text: "", tools: [], usage: [] };
    turns.push(turn);
    process.stdout.write(`\n=== Turn ${i + 1}: ${question}\n`);
    let streaming = false;

    const handlers: SendHandlers = {
      onThinking: () => {
        process.stdout.write("[thinking]\n");
      },
      onText: (delta) => {
        if (!streaming) {
          streaming = true;
          process.stdout.write("\n");
        }
        turn.text += delta;
        process.stdout.write(delta);
      },
      onToolCall: (call) => {
        turn.tools.push({ id: call.id, name: call.name, input: call.input, startedAt: Date.now(), ms: null, outcome: null });
        process.stdout.write(`[tool] ${call.name}\n`);
      },
      onToolInput: (id, input) => {
        const rec = turn.tools.find((t) => t.id === id);
        if (rec) rec.input = input;
        const name = rec?.name ?? "tool";
        process.stdout.write(`[input] ${describeCall(name, input)} ${JSON.stringify(input)}\n`);
      },
      onToolResult: (id, outcome, ms) => {
        const rec = turn.tools.find((t) => t.id === id);
        if (rec) {
          rec.outcome = outcome;
          rec.ms = ms;
        }
        process.stdout.write(
          `[result] ${rec?.name ?? id} · ${ms} ms · ${outcome.content.length} chars${outcome.isError ? " · error" : ""}\n`,
        );
      },
      onUsage: (u) => {
        turn.usage.push(u);
        allUsage.push(u);
        const n = allUsage.length;
        process.stdout.write(`[usage] request ${n}: ${fmtUsage(u)}\n`);
        if (n > 1 && u.cacheRead <= 0) fail(`request ${n} read nothing from cache`);
      },
    };

    const end = await session.send(question, handlers, new AbortController().signal);
    process.stdout.write(`\n[end] ${end.kind}${end.kind === "error" ? ` · ${end.error.code}: ${end.error.message}` : ""}\n`);
    if (end.kind !== "done") fail(`turn ${i + 1} ended ${end.kind}, expected done`);
    process.stdout.write(`[turn usage] ${fmtUsage(sumUsage(turn.usage))}\n`);
    checkTurn(turn, i);
  }

  process.stdout.write(`\n[session usage] ${fmtUsage(sumUsage(allUsage))} · ${allUsage.length} requests\n`);
  if (failures.length > 0) {
    process.stdout.write(`\n${failures.length} check(s) failed:\n${failures.map((f) => `  ${f}`).join("\n")}\n`);
    return 1;
  }
  process.stdout.write("\nAll checks passed.\n");
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    process.stdout.write(`\nSmoke test crashed: ${message}\n`);
    process.exitCode = 1;
  });
