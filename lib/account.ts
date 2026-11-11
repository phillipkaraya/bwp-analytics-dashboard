"use client";

// The account switch's choice, shared by every tab and remembered per browser.
// A module-level value with subscribers, so the switch and the page that reads
// it stay in step without a provider; the dashboard store only holds creators.

import { useSyncExternalStore } from "react";
import { isAccountScope } from "./derive";
import type { AccountScope } from "./types";

const STORAGE_KEY = "bwp_account";
const DEFAULT_SCOPE: AccountScope = "all";

let current: AccountScope | null = null;
const listeners = new Set<() => void>();

// Storage can be absent or throw (private window, blocked site data), so every
// touch is guarded, the same way the Overview guards its window choice.
function read(): AccountScope {
  if (current) return current;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    current = isAccountScope(v) ? v : DEFAULT_SCOPE;
  } catch {
    current = DEFAULT_SCOPE;
  }
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setAccountScope(scope: AccountScope): void {
  current = scope;
  try {
    window.localStorage.setItem(STORAGE_KEY, scope);
  } catch {
    /* not persisted this time; the choice still applies to this page */
  }
  listeners.forEach((l) => l());
}

/** The chosen scope and its setter. The prerender has no storage, so it
 *  renders every account and the browser's choice applies after hydration. */
export function useAccountScope(): [AccountScope, (scope: AccountScope) => void] {
  const scope = useSyncExternalStore(subscribe, read, () => DEFAULT_SCOPE);
  return [scope, setAccountScope];
}
