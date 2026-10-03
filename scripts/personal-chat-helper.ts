/** Personal Claude connector. All listeners stay on IPv4 loopback. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeChatData, type RawChatData } from "../lib/chat/data";
import { allowedDashboardOrigin, PERSONAL_MODEL } from "../lib/chat/local-connection";
import { createPersonalRuntime, type PersonalRequest, type Runtime } from "./personal-chat-runtime";
import { nativeSignedIn } from "./personal-chat-native";

export function validRequest(value: unknown): value is PersonalRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as PersonalRequest;
  return Object.keys(item).every(k => ["text", "effort", "history"].includes(k)) && typeof item.text === "string" && item.text.trim().length > 0 && item.text.length <= 8000 && ["medium", "high"].includes(item.effort) && Array.isArray(item.history) && item.history.length <= 12 && item.history.every(t => t && typeof t === "object" && !Array.isArray(t) && Object.keys(t).every(k => ["user", "assistant"].includes(k)) && typeof t.user === "string" && typeof t.assistant === "string" && t.user.length <= 8000 && t.assistant.length <= 16000);
}
async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > limit) { req.resume(); throw Object.assign(new Error("Request too large"), { status: 413 }); }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function matches(value: unknown, expected: string): boolean {
  return typeof value === "string" && value.length === expected.length && timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}
function pairingPage(code: string): string {
  // Only random hexadecimal text is inserted. Inline scripts are deliberately absent.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Build With Phil · Local connector</title><link rel="stylesheet" href="/connect.css"><script src="/connect.js" defer></script></head><body><main><h1>Connect your dashboard</h1><p>Copy this code into Ask the dashboard → Settings → Local Claude Code.</p><label for="connection-code">Private connection code</label><input type="password" id="connection-code" value="${code}" readonly autocomplete="off" spellcheck="false"><button id="copy-code" type="button">Copy connection code</button><p id="copy-status" role="status"></p><p>The code changes when the connector restarts.</p><p><a href="https://phillipkaraya.github.io/bwp-analytics-dashboard/" target="_blank" rel="noopener noreferrer">Open the dashboard</a></p></main></body></html>`;
}
const PAIRING_CSS = "body{background:#151724;color:#FBFAF8;font:16px Arial,sans-serif;margin:0;padding:40px 20px}main{max-width:620px;margin:40px auto}h1{font-size:30px}p{line-height:1.6}label{display:block;margin:24px 0 8px}input{box-sizing:border-box;width:100%;padding:14px;background:#FBFAF8;color:#151724;border:2px solid #7EA9F0;border-radius:6px;font:16px monospace}button{padding:12px 18px;margin-top:12px;background:#7EA9F0;color:#151724;border:0;border-radius:6px;font-weight:bold;cursor:pointer}a{color:#7EA9F0}";
const PAIRING_JS = "document.getElementById('copy-code').addEventListener('click',async()=>{const input=document.getElementById('connection-code'),status=document.getElementById('copy-status');try{await navigator.clipboard.writeText(input.value);status.textContent='Copied. Paste it into your dashboard settings.'}catch{input.focus();input.select();status.textContent='Press Command+C (or Ctrl+C) to copy, then paste into your dashboard.'}})";

export function createPersonalHelper(runtime: Runtime, mode: "mock" | "claude", port = 5557, options: { checkSignedIn?: () => Promise<boolean>; signedIn?: boolean; timeoutMs?: number } = {}) {
  const connectionCode = randomBytes(16).toString("hex");
  const sessions = new Map<string, string>(); // token → exact requesting origin
  const controllers = new Set<AbortController>();
  let busy = false, signedIn = options.signedIn ?? mode === "mock";
  let attempts = 0, attemptWindow = Date.now();
  const info = () => ({ protocol: 1, chat: true, mode, model: mode === "claude" ? PERSONAL_MODEL : null, signedIn });
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
    const address = server.address();
    const boundPort = typeof address === "object" && address ? address.port : port;
    const origin = req.headers.origin;
    if (req.headers.host !== `127.0.0.1:${boundPort}`) { res.writeHead(403).end(); return; }
    // A top-level local page reveals the code only to the person on this Mac.
    if (req.method === "GET" && !origin && ["/connect", "/connect.css", "/connect.js"].includes(req.url ?? "")) {
      res.setHeader("X-Frame-Options", "DENY"); res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      res.setHeader("Content-Type", req.url === "/connect" ? "text/html; charset=utf-8" : req.url === "/connect.js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8");
      res.end(req.url === "/connect" ? pairingPage(connectionCode) : req.url === "/connect.js" ? PAIRING_JS : PAIRING_CSS); return;
    }
    if (!allowedDashboardOrigin(origin)) { res.writeHead(403).end(); return; }
    res.setHeader("Access-Control-Allow-Origin", origin!); res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") {
      const headers = String(req.headers["access-control-request-headers"] ?? "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
      const method = req.headers["access-control-request-method"];
      if (!["GET", "POST"].includes(String(method)) || !["/connect", "/ping", "/chat"].includes(req.url ?? "") || headers.some(h => !["content-type", "x-bwp-session"].includes(h))) { res.writeHead(403).end(); return; }
      res.setHeader("Access-Control-Allow-Methods", "GET, POST"); res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-BWP-Session");
      if (req.headers["access-control-request-private-network"] === "true") res.setHeader("Access-Control-Allow-Private-Network", "true");
      res.writeHead(204).end(); return;
    }
    if (req.method === "POST" && req.url === "/connect" && req.headers["content-type"] === "application/json") {
      if (Date.now() - attemptWindow > 60_000) { attempts = 0; attemptWindow = Date.now(); }
      if (attempts >= 10) { res.writeHead(429, { "Retry-After": "60" }).end(); return; }
      try {
        const value = await readBody(req, 256) as Record<string, unknown>;
        if (!value || Object.keys(value).length !== 1 || !matches(value.code, connectionCode)) { attempts++; res.writeHead(403).end(); return; }
        signedIn = mode === "mock" || await (options.checkSignedIn ?? nativeSignedIn)();
        if (!signedIn) { res.writeHead(401).end(); return; }
        const token = randomBytes(32).toString("hex");
        for (const [previous, owner] of sessions) if (owner === origin) sessions.delete(previous);
        sessions.set(token, origin!); attempts = 0;
        res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ...info(), token }));
      } catch (error) { res.writeHead(error && typeof error === "object" && "status" in error ? Number(error.status) : 400).end(); }
      return;
    }
    const token = req.headers["x-bwp-session"];
    if (typeof token !== "string" || sessions.get(token) !== origin) { res.writeHead(403).end(); return; }
    if (req.method === "GET" && req.url === "/ping") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(info())); return; }
    if (req.method !== "POST" || req.url !== "/chat" || req.headers["content-type"] !== "application/json") { res.writeHead(403).end(); return; }
    if (busy) { res.writeHead(429, { "Retry-After": "2" }).end(); return; }
    busy = true;
    const controller = new AbortController(); controllers.add(controller);
    let terminal = false;
    const emit = (event: string, data: unknown) => {
      if (controller.signal.aborted || res.destroyed || terminal) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (event === "done" || event === "error") terminal = true;
    };
    const timeout = setTimeout(() => {
      if (res.headersSent) emit("error", { code: "network", message: "The local query timed out. Try a narrower question." });
      else res.writeHead(408);
      controller.abort(); res.end();
    }, options.timeoutMs ?? 90_000);
    res.on("close", () => controller.abort());
    try {
      const value = await readBody(req, 120_000);
      controller.signal.throwIfAborted();
      if (!validRequest(value)) { res.writeHead(400).end(); return; }
      res.writeHead(200, { "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" }); emit("thinking", {});
      await runtime(value, emit, controller);
      if (!terminal) emit("error", { code: "network", message: "The local Claude run ended before completing its answer." });
    } catch (error) {
      if (!res.headersSent) res.writeHead(error && typeof error === "object" && "status" in error ? Number(error.status) : 400);
      else emit("error", { code: "network", message: "Claude Code could not finish. Check native sign-in, plan usage and model access with pnpm chat:doctor." });
    } finally { clearTimeout(timeout); controllers.delete(controller); busy = false; res.end(); }
  });
  server.requestTimeout = 95_000; server.headersTimeout = 5000;
  const close = async () => { for (const controller of controllers) controller.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  return { server, close, connectionCode };
}
const mockRuntime: Runtime = async (_request, emit) => {
  emit("text", { delta: "Connector test response. No Claude model request was made. Restart without --mock to ask about your dashboard data." });
  emit("done", { kind: "done" });
};
export async function readData(): Promise<RawChatData> {
  const root = await realpath(fileURLToPath(new URL("../public/data/", import.meta.url)));
  const load = async (name: string) => {
    const file = await realpath(resolve(root, name));
    if (!file.startsWith(root + sep)) throw new Error("Data file outside fixed root");
    const content = await readFile(file);
    if (content.byteLength > 12_000_000) throw new Error("Data file too large");
    return JSON.parse(content.toString());
  };
  const posts = (await Promise.all(["instagram", "tiktok", "youtube", "threads", "linkedin"].map(p => load(`${p}_posts.json`)))).flat();
  return { posts, analytics: await load("analytics.json"), vault: await load("content_vault.json"), scrape: await load("scrape_state.json"), history: await load("follower_history.json"), comments: () => load("comments.json") };
}
async function main() {
  const mode = process.argv.includes("--mock") ? "mock" : "claude";
  const signedIn = mode === "mock" || await nativeSignedIn();
  if (!signedIn) throw new Error("Native sign-in required");
  if (mode === "claude") await readData();
  const runtime: Runtime = mode === "claude" ? async (request, emit, controller) => {
    // Reload fixed analytics for each question, including a scrape made after startup.
    await createPersonalRuntime(makeChatData(await readData()))(request, emit, controller);
  } : mockRuntime;
  const helper = createPersonalHelper(runtime, mode, 5557, { signedIn });
  helper.server.on("error", () => { console.error("Connector could not listen on 127.0.0.1:5557. Check whether another connector is already running."); process.exitCode = 1; });
  helper.server.listen(5557, "127.0.0.1", () => console.log(`Local Claude connector: http://127.0.0.1:5557/connect (${mode}). Open this local page to pair your dashboard. The private code is never logged.`));
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void helper.close().then(() => process.exit(0)); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main().catch(() => {
  console.error("Connector startup failed. Run pnpm chat:doctor and check the dashboard's public/data files."); process.exitCode = 1;
});
