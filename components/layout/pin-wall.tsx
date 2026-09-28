"use client";

import { useEffect, useRef, useState } from "react";
import {
  DEV_PIN,
  markAuthenticated,
  pinConfigured,
  usingDevPin,
  verifyPin,
} from "@/lib/auth";

interface PinWallProps {
  onSuccess: () => void;
}

const DIGITS = 4;

export function PinWall({ onSuccess }: PinWallProps) {
  const [values, setValues] = useState<string[]>(Array(DIGITS).fill(""));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
      inputs.current[0]?.focus();
    }
  }

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

  if (!pinConfigured()) {
    return (
      <div className="fixed inset-0 z-50 grid place-items-center bg-background">
        <div className="w-full max-w-md px-6 text-center">
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-muted">
            Build With Phil
          </p>
          <h1 className="font-display mt-3 text-3xl font-medium leading-tight text-ink">
            No PIN set for this site
          </h1>
          <p className="mt-4 text-sm text-ink-muted">
            Add your PIN hash as the <code>DASHBOARD_PIN_HASH</code> repository
            secret on bwp-analytics-dashboard, then rerun the deploy. Running locally,
            put it in <code>.env.local</code> instead.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background">
      <div className="w-full max-w-sm px-6">
        <div className="mb-12 text-center">
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-muted">
            Build With Phil
          </p>
          <h1 className="font-display mt-3 text-4xl font-medium leading-tight text-ink">
            Social Media
            <br />
            <em className="font-display italic text-brand">Analytics</em>
          </h1>
          <p className="mt-4 text-sm text-ink-muted">
            Enter access PIN to continue
          </p>
          {usingDevPin() && (
            <p className="mt-2 font-mono text-xs text-ink-muted">
              Development PIN: {DEV_PIN} (until you add .env.local)
            </p>
          )}
        </div>

        <div className="flex justify-center gap-3" aria-label="PIN entry">
          {values.map((v, i) => (
            <input
              key={i}
              ref={(el) => {
                inputs.current[i] = el;
              }}
              value={v}
              onChange={(e) => handleChange(i, e.target.value)}
              onKeyDown={(e) => handleKey(i, e)}
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={1}
              autoComplete="off"
              disabled={busy}
              aria-label={`PIN digit ${i + 1}`}
              data-error={!!error}
              className="h-14 w-12 rounded-md border border-border bg-card text-center font-mono text-2xl font-semibold text-ink shadow-sm outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/30 data-[error=true]:border-negative data-[error=true]:text-negative"
            />
          ))}
        </div>

        <div className="mt-6 h-5 text-center text-sm text-negative">
          {error}
        </div>
      </div>
    </div>
  );
}
