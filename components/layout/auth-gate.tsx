"use client";

import { useSyncExternalStore } from "react";
import { isAuthenticated, subscribeAuth } from "@/lib/auth";
import { GATE_BG } from "./gate-scene";
import { PinWall } from "./pin-wall";

// null = not yet known (server render and the first hydration pass);
// afterwards it mirrors sessionStorage through subscribeAuth().
function getSnapshot(): boolean | null {
  return isAuthenticated();
}
function getServerSnapshot(): boolean | null {
  return null;
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const authed = useSyncExternalStore(subscribeAuth, getSnapshot, getServerSnapshot);

  if (authed === null) {
    return (
      // Same navy as the gate, so there is no light flash before the scene draws.
      <div className="fixed inset-0 grid place-items-center" style={{ backgroundColor: GATE_BG }}>
        <div className="font-mono text-xs uppercase tracking-[0.22em] text-white/50">
          Loading
        </div>
      </div>
    );
  }

  // PinWall calls markAuthenticated(), which notifies the store; nothing
  // else to do on success.
  if (!authed) return <PinWall onSuccess={() => undefined} />;

  return <>{children}</>;
}
