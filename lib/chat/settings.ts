// Key item and versioned settings slice for the assistant.
//
// The API key lives in its own localStorage item, never inside the settings
// JSON, never in Zustand, never in React state beyond the input field. It is
// read at send time through getKey(). When site storage throws (private
// windows, blocked storage), both fall back to module-level memory for the
// life of the tab, and storageBlocked() reports that so the settings copy can
// say "the key lasts until you close the tab".
//
// Every storage access is wrapped in try/catch and guarded by typeof window,
// so this module is safe to import from Node scripts.

import type { ChatSettings, Effort, ProviderId } from "./types";

export const API_KEY_STORAGE_KEY = "bwp_chat_api_key";
export const SETTINGS_STORAGE_KEY = "bwp_chat_settings_v1";

export const DEFAULT_SETTINGS: ChatSettings = {
  v: 1,
  provider: "anthropic-key",
  effort: "medium",
  showUsage: true,
};

const PROVIDER_IDS: readonly ProviderId[] = ["anthropic-key", "local-cli"];
const EFFORTS: readonly Effort[] = ["medium", "high"];

let memKey: string | null = null;
let memSettings: ChatSettings | null = null;
let blocked = false;

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    const s = window.localStorage;
    if (!s) {
      blocked = true;
      return null;
    }
    return s;
  } catch {
    blocked = true;
    return null;
  }
}

function readItem(key: string): string | null | undefined {
  const s = storage();
  if (!s) return undefined; // undefined: storage unavailable, use memory
  try {
    const v = s.getItem(key);
    blocked = false;
    return v;
  } catch {
    blocked = true;
    return undefined;
  }
}

function writeItem(key: string, value: string): boolean {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(key, value);
    blocked = false;
    return true;
  } catch {
    blocked = true;
    return false;
  }
}

function removeItem(key: string): void {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(key);
  } catch {
    blocked = true;
  }
}

/** True when this browser blocks site storage and values live in memory
 *  only. Probes with a throwaway write so the answer is current. */
export function storageBlocked(): boolean {
  if (typeof window === "undefined") return false;
  const probe = "__bwp_chat_probe__";
  if (!writeItem(probe, "1")) return true;
  removeItem(probe);
  return blocked;
}

// Key

export function getKey(): string | null {
  const stored = readItem(API_KEY_STORAGE_KEY);
  if (typeof stored === "string" && stored.length > 0) return stored;
  return memKey;
}

export function setKey(key: string): void {
  const value = key.trim();
  if (!value) {
    forgetKey();
    return;
  }
  if (writeItem(API_KEY_STORAGE_KEY, value)) {
    memKey = null;
  } else {
    memKey = value;
  }
}

export function forgetKey(): void {
  memKey = null;
  removeItem(API_KEY_STORAGE_KEY);
}

/** "ends in 1234" for the settings screen. Never returns more than the last
 *  four characters. */
export function maskKey(key: string): string {
  const tail = key.trim().slice(-4);
  return `ends in ${tail || "????"}`;
}

// Settings

/** Build a fresh, key-free settings object from unknown input. Unknown or
 *  invalid fields fall back to the defaults. */
export function normalizeSettings(input: unknown): ChatSettings {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const provider = PROVIDER_IDS.includes(obj.provider as ProviderId)
    ? (obj.provider as ProviderId)
    : DEFAULT_SETTINGS.provider;
  const effort = EFFORTS.includes(obj.effort as Effort) ? (obj.effort as Effort) : DEFAULT_SETTINGS.effort;
  const showUsage = typeof obj.showUsage === "boolean" ? obj.showUsage : DEFAULT_SETTINGS.showUsage;
  return { v: 1, provider, effort, showUsage };
}

export function readSettings(): ChatSettings {
  const stored = readItem(SETTINGS_STORAGE_KEY);
  if (stored === undefined) return memSettings ?? { ...DEFAULT_SETTINGS };
  if (stored === null) return { ...DEFAULT_SETTINGS };
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || (parsed as { v?: unknown }).v !== 1) {
      return { ...DEFAULT_SETTINGS };
    }
    return normalizeSettings(parsed);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeSettings(settings: ChatSettings): void {
  const clean = normalizeSettings(settings);
  if (!writeItem(SETTINGS_STORAGE_KEY, JSON.stringify(clean))) {
    memSettings = clean;
  }
}
