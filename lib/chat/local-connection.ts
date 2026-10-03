/** Process-only connection to the personal helper. Never persisted or logged. */
import type { ChatError } from "./types";

export const LOCAL_CHAT_URL = "http://127.0.0.1:5557";
/** Let the pinned native CLI resolve the Sonnet version available to this login. */
export const PERSONAL_MODEL = "sonnet";
export const PERSONAL_MODEL_LABEL = "Claude Sonnet";
export const DASHBOARD_ORIGIN = "https://phillipkaraya.github.io";
export const LOCAL_DASHBOARD_ORIGINS = [3000, 3111, 3114].flatMap(port => [
  `http://localhost:${port}`, `http://127.0.0.1:${port}`,
]);
export function allowedDashboardOrigin(origin: string | undefined): boolean {
  return origin === DASHBOARD_ORIGIN || LOCAL_DASHBOARD_ORIGINS.includes(origin ?? "");
}
export interface LocalHelperInfo {
  mode: "mock" | "claude";
  model: string | null;
  signedIn: boolean;
}
export interface LocalConnection extends LocalHelperInfo { token: string }
let connection: LocalConnection | null = null;
let generation = 0;
const listeners = new Set<() => void>();
export const getLocalConnection = () => connection;
export const subscribeLocalConnection = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
function updateConnection(next: LocalConnection | null) {
  connection = next;
  for (const listener of listeners) listener();
}
export function disconnectLocalHelper() { generation++; updateConnection(null); }
export function localChatError(code: ChatError["code"], message: string): ChatError {
  const error = new Error(message) as ChatError;
  error.name = "ChatError";
  error.code = code;
  return error;
}
function helperInfo(value: unknown): LocalHelperInfo | null {
  if (!value || typeof value !== "object") return null;
  const info = value as Record<string, unknown>;
  if (info.protocol !== 1 || info.chat !== true || !["mock", "claude"].includes(String(info.mode)) || typeof info.signedIn !== "boolean") return null;
  if (info.mode === "claude" && info.model !== PERSONAL_MODEL) return null;
  return { mode: info.mode as LocalHelperInfo["mode"], model: typeof info.model === "string" ? info.model : null, signedIn: info.signedIn };
}
/** Called only by Connect, so loading the dashboard makes no LAN request. */
export async function connectLocalHelper(code: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<LocalHelperInfo> {
  const ticket = ++generation;
  const clean = code.trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(clean)) throw localChatError("bad_request", "Copy the connection code from the helper's local page.");
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
  let response: Response;
  try {
    response = await fetchImpl(`${LOCAL_CHAT_URL}/connect`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: clean }), signal: requestSignal,
    });
  } catch {
    throw localChatError("network", "Could not reach the connector. Start it on this Mac and allow local network access if your browser asks.");
  }
  if (!response.ok) {
    if (response.status === 401) throw localChatError("forbidden", "Claude Code needs native sign-in. Run pnpm chat:doctor in the dashboard folder.");
    if (response.status === 429) throw localChatError("rate_limited", "Too many connection attempts. Wait a minute and try again.");
    throw localChatError("forbidden", "That connection code is no longer valid. Open the helper's local page and copy its current code.");
  }
  const value = await response.json();
  const info = helperInfo(value);
  if (!info || (info.mode === "claude" && !info.signedIn) || typeof value.token !== "string" || !/^[a-f0-9]{64}$/.test(value.token)) throw localChatError("bad_request", "Update the local helper and try connecting again.");
  requestSignal.throwIfAborted();
  if (ticket !== generation) throw new DOMException("Connection cancelled", "AbortError");
  updateConnection({ ...info, token: value.token });
  return info;
}
export async function checkLocalHelper(fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<LocalHelperInfo | null> {
  const current = connection;
  if (!current) return null;
  try {
    const response = await fetchImpl(`${LOCAL_CHAT_URL}/ping`, {
      headers: { "X-BWP-Session": current.token }, cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000),
    });
    const info = response.ok ? helperInfo(await response.json()) : null;
    if (!info || (info.mode === "claude" && !info.signedIn)) {
      if (connection === current) updateConnection(null);
      return null;
    }
    return info;
  } catch {
    if (!signal?.aborted && connection === current) updateConnection(null);
    return null;
  }
}
