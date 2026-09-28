// Client-side PIN gate using SHA-256.
// The hash comes from NEXT_PUBLIC_DASHBOARD_PIN_HASH at build time: .env.local on
// your Mac, the DASHBOARD_PIN_HASH repository secret on GitHub Pages.
// There is deliberately no fallback in a production build. Without a hash the
// site shows a "PIN not set" screen instead of a lock anyone could open, and the
// deploy workflow refuses to publish.

export const PIN_STORAGE_KEY = "bwp_auth";

// Development only (`pnpm dev` before .env.local exists): the PIN is 0000.
// Never used by `pnpm build`, so it can't reach a published site.
export const DEV_PIN = "0000";
const DEV_PIN_HASH =
  "9af15b336e6a9619928537df30b2e6a2376569fcf9d7e773eccede65606529a0";

function envHash(): string {
  // GitHub Actions interpolates an unset secret to an empty string.
  return process.env.NEXT_PUBLIC_DASHBOARD_PIN_HASH?.trim().toLowerCase() ?? "";
}

export function usingDevPin(): boolean {
  return !envHash() && process.env.NODE_ENV === "development";
}

export function getExpectedHash(): string | null {
  const hash = envHash();
  if (hash) return hash;
  return usingDevPin() ? DEV_PIN_HASH : null;
}

export function pinConfigured(): boolean {
  return getExpectedHash() !== null;
}

export async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifyPin(pin: string): Promise<boolean> {
  const expected = getExpectedHash();
  if (!expected) return false;
  return (await sha256(pin)) === expected;
}

// Same-tab sessionStorage writes do not fire the "storage" event, so the
// gate subscribes here and mark/sign-out notify explicitly.
const listeners = new Set<() => void>();

export function subscribeAuth(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function notify(): void {
  for (const l of listeners) l();
}

export function isAuthenticated(): boolean {
  if (typeof window === "undefined") return false;
  return sessionStorage.getItem(PIN_STORAGE_KEY) === "true";
}

export function markAuthenticated(): void {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(PIN_STORAGE_KEY, "true");
  notify();
}

export function signOut(): void {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(PIN_STORAGE_KEY);
  notify();
}
