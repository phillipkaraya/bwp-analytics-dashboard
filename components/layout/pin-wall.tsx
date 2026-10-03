"use client";

import { useEffect, useRef, useState } from "react";
import {
  DEV_PIN,
  markAuthenticated,
  pinConfigured,
  usingDevPin,
  verifyPin,
} from "@/lib/auth";
import { DEFAULT_BPM } from "@/lib/gate/pulse";
import { PLATFORM_COLORS, PLATFORM_NAMES, type SceneName } from "@/lib/gate/scenes";
import { GateScene } from "./gate-scene";

interface PinWallProps {
  onSuccess: () => void;
}

const DIGITS = 4;

const SCENE_CAPTION: Record<SceneName, string> = {
  reactions: "Reactions",
  levels: "Levels",
  rings: "Rings",
};

/**
 * The front door: a navy canvas that moves on a posting-rhythm pulse (see
 * lib/gate), the brand, the headline, and four PIN cells whose glow rides
 * the kick. Enter submits. The dashboard behind is the light palette, so
 * unlocking reads as the room lighting up.
 */
export function PinWall({ onSuccess }: PinWallProps) {
  const [values, setValues] = useState<string[]>(Array(DIGITS).fill(""));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scene, setScene] = useState<SceneName>("reactions");
  const inputs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    inputs.current[0]?.focus();
  }, []);

  async function trySubmit(pin: string) {
    if (pin.length !== DIGITS) return;
    setBusy(true);
    const ok = await verifyPin(pin);
    setBusy(false);
    if (ok) {
      markAuthenticated();
      onSuccess();
    } else {
      setError("Incorrect PIN");
      setValues(Array(DIGITS).fill(""));
    }
  }

  // Refocus after the re-render that re-enables the cells. Calling focus()
  // inside trySubmit lands while the inputs are still disabled and is lost.
  useEffect(() => {
    if (error) inputs.current[0]?.focus();
  }, [error]);

  function handleChange(idx: number, raw: string) {
    const digit = raw.replace(/\D/g, "").slice(-1);
    const next = [...values];
    next[idx] = digit;
    setValues(next);
    setError(null);
    if (digit && idx < DIGITS - 1) inputs.current[idx + 1]?.focus();
    if (next.every((d) => d.length === 1)) trySubmit(next.join(""));
  }

  function handleKey(idx: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !values[idx] && idx > 0) {
      inputs.current[idx - 1]?.focus();
    }
    if (e.key === "Enter" && values.every((d) => d.length === 1)) {
      trySubmit(values.join(""));
    }
  }

  const configured = pinConfigured();

  return (
    <GateScene onScene={setScene}>
      <header className="absolute left-0 right-0 top-0 flex items-center justify-between px-6 pt-[max(1.25rem,env(safe-area-inset-top))] sm:px-8">
        <div className="flex items-baseline gap-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-white/60">
            Build With Phil
          </p>
          <span aria-hidden className="h-3 w-px bg-white/25" />
          <span className="font-display text-sm font-medium">Analytics</span>
        </div>
        <p className="hidden font-mono text-[10px] uppercase tracking-[0.2em] text-white/45 sm:block">
          {SCENE_CAPTION[scene]} · {DEFAULT_BPM} BPM
        </p>
      </header>

      <main className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
        {configured ? (
          <>
            <h1
              className="rise font-display text-[2.6rem] font-semibold leading-[0.95] tracking-[-0.03em] sm:text-6xl lg:text-7xl"
              style={{ "--rise-delay": "40ms" } as React.CSSProperties}
            >
              Social Media
              <br />
              <em className="italic text-[#6aa6ff]">Analytics</em>
            </h1>
            <p
              className="rise mt-6 font-mono text-[11px] uppercase tracking-[0.2em] text-white/60"
              style={{ "--rise-delay": "120ms" } as React.CSSProperties}
            >
              Enter access PIN
            </p>
            {usingDevPin() && (
              <p className="mt-2 font-mono text-xs text-white/50">
                Development PIN: {DEV_PIN} (until you add .env.local)
              </p>
            )}

            <div
              className="rise mt-7 flex justify-center gap-3"
              aria-label="PIN entry"
              style={{ "--rise-delay": "200ms" } as React.CSSProperties}
            >
              {values.map((v, i) => (
                <input
                  key={i}
                  ref={(el) => {
                    inputs.current[i] = el;
                  }}
                  value={v}
                  onChange={(e) => handleChange(i, e.target.value)}
                  onKeyDown={(e) => handleKey(i, e)}
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={1}
                  autoComplete="off"
                  disabled={busy}
                  aria-label={`PIN digit ${i + 1}`}
                  data-error={!!error}
                  className="tabular h-16 w-13 rounded-lg border border-white/20 bg-white/[0.06] text-center font-mono text-3xl font-semibold text-white outline-none backdrop-blur-sm transition-colors focus:border-[#6aa6ff] focus:bg-white/10 data-[error=true]:border-[#ff6b6b] data-[error=true]:text-[#ff8a8a]"
                  // The kick shows in the glow, never the geometry, so the cells never shift.
                  style={{
                    boxShadow:
                      "0 0 calc(36px * var(--kick)) calc(2px * var(--kick)) rgba(30,111,217,calc(0.55 * var(--kick)))",
                  }}
                />
              ))}
            </div>

            <div className="mt-5 h-5 text-sm text-[#ff8a8a]" role="status">
              {error}
            </div>
          </>
        ) : (
          <div className="max-w-md">
            <h1 className="font-display text-4xl font-semibold leading-tight tracking-[-0.02em]">
              No PIN set for this site
            </h1>
            <p className="mt-4 text-sm text-white/65">
              Add your PIN hash as the <code className="font-mono text-white/85">DASHBOARD_PIN_HASH</code>{" "}
              repository secret on bwp-analytics-dashboard, then rerun the deploy. Running
              locally, put it in <code className="font-mono text-white/85">.env.local</code> instead.
            </p>
          </div>
        )}
      </main>

      <footer className="absolute bottom-0 left-0 right-0 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-6 pb-[max(1.25rem,env(safe-area-inset-bottom))] font-mono text-[10px] uppercase tracking-[0.18em] text-white/50 sm:px-8">
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {PLATFORM_NAMES.map((name, i) => (
            <li key={name} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: PLATFORM_COLORS[i] }}
              />
              {name}
            </li>
          ))}
        </ul>
        <span className="hidden sm:inline">Enter submits</span>
      </footer>
    </GateScene>
  );
}
