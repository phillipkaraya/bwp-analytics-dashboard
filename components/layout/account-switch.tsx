"use client";

import { ACCOUNT_SCOPES, accountLabel } from "@/lib/derive";
import { useAccountScope } from "@/lib/account";
import { cn } from "@/lib/utils";

/**
 * All Pages / Phillip Karaya / Build With Phil, on the eyebrow row of every
 * tab's hero (PageHero `controls`). Same pill as the Overview's window switch.
 * The choice lives in lib/account.ts, so it follows Phil from tab to tab.
 */
export function AccountSwitch({ className }: { className?: string }) {
  const [scope, setScope] = useAccountScope();
  return (
    <div
      role="radiogroup"
      aria-label="Pages shown"
      className={cn("inline-flex rounded-full bg-white/10 p-0.5 ring-1 ring-white/15", className)}
    >
      {ACCOUNT_SCOPES.map((s) => {
        const on = s === scope;
        return (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => setScope(s)}
            className={cn(
              // Tighter on a phone so the three names fit inside the 327px column.
              "whitespace-nowrap rounded-full px-2 py-1 font-mono text-[10px] uppercase tracking-[0.1em] transition sm:px-2.5 sm:tracking-[0.16em]",
              on ? "bg-white text-ink" : "text-white/70 hover:text-white",
            )}
          >
            {accountLabel[s]}
          </button>
        );
      })}
    </div>
  );
}
