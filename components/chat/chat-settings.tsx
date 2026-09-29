"use client";

// Settings and key screen (section 4.7). Replaces the body and composer when
// the gear is pressed or when the provider needs a key and none is saved.
// The key only ever lives in the input field here and in its storage item;
// this screen shows the masked tail and never the value.

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Effort, ProviderId } from "@/lib/chat/types";
import { cn } from "@/lib/utils";
import { StateBlock } from "./state-block";
import { useChatContext } from "./chat-root";

/** Printed in the footer so a rename is a one-line fix. Mirrors CHAT_MODEL
 *  in lib/chat/providers/anthropic-key.ts and the pinned SDK version. */
export const CHAT_MODEL_LABEL = "claude-opus-5-5";
export const SDK_VERSION_LABEL = "@anthropic-ai/sdk 0.129.0";

const KEY_PREFIX = "sk-ant-";
const KEY_MIN_LENGTH = 40;
const CONSOLE_URL = "https://console.anthropic.com/settings/keys";

type TestState = "idle" | "testing" | "ok" | "rejected" | "offline";

const EYEBROW = "font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted";

const PROVIDER_HINTS: Record<ProviderId, string> = {
  "anthropic-key": "Pay per question on your own account",
  "local-cli": "Needs the local helper. Coming in a later update.",
};

const PROVIDER_LABELS: Record<ProviderId, string> = {
  "anthropic-key": "Anthropic API key",
  "local-cli": "Local CLI (Claude, Codex or Gemini)",
};

export function ChatSettingsScreen() {
  const { settings, updateSettings, providers, provider, hasKey, keyMask, keyBlocked, saveKey, forgetSavedKey, setShowSettings } =
    useChatContext();
  const [keyInput, setKeyInput] = useState("");
  const [show, setShow] = useState(false);
  const [test, setTest] = useState<TestState>("idle");
  const [editing, setEditing] = useState(false);
  const doneTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (doneTimer.current !== null) window.clearTimeout(doneTimer.current);
    },
    [],
  );

  const trimmed = keyInput.trim();
  const canSave = trimmed.startsWith(KEY_PREFIX) && trimmed.length >= KEY_MIN_LENGTH && test !== "testing";
  const needsKey = !!provider?.needsKey;
  const showKeyForm = needsKey && (!hasKey || editing);

  const onSave = async () => {
    if (!canSave) return;
    setTest("testing");
    const result = await saveKey(trimmed);
    setTest(result);
    if (result === "ok" || result === "offline") {
      setKeyInput("");
      setShow(false);
      setEditing(false);
    }
    if (result === "ok") {
      doneTimer.current = window.setTimeout(() => setShowSettings(false), 600);
    }
  };

  const providerIds: ProviderId[] =
    providers.length > 0 ? providers.map((p) => p.id) : (["anthropic-key", "local-cli"] as ProviderId[]);

  return (
    <div className="space-y-6 px-5 py-4">
      <section className="space-y-2">
        <div className={EYEBROW}>Provider</div>
        <div className="grid gap-2" role="radiogroup" aria-label="Provider">
          {providerIds.map((id) => {
            const on = settings.provider === id;
            const disabled = id === "local-cli";
            const meta = providers.find((p) => p.id === id);
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={disabled}
                onClick={() => updateSettings({ provider: id })}
                className={cn(
                  "rounded-md border p-3 text-left transition outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  on ? "border-brand bg-brand-soft" : "border-border bg-muted/40 hover:border-brand/50",
                  disabled && "opacity-60",
                )}
              >
                <div className="text-sm font-medium text-ink">{meta?.label ?? PROVIDER_LABELS[id]}</div>
                <div className="mt-0.5 text-xs text-ink-muted">{PROVIDER_HINTS[id]}</div>
              </button>
            );
          })}
        </div>
      </section>

      {needsKey && (
        <section className="space-y-3">
          <div className={EYEBROW}>API key</div>
          {showKeyForm ? (
            <>
              <h3 className="font-display text-lg font-semibold tracking-[-0.02em] text-ink">Your key stays in this browser</h3>
              <p className="text-sm text-ink-soft">
                Create a key just for this dashboard in the Anthropic console and set a monthly spend limit on it. The key is
                saved only in this browser, it is sent straight to api.anthropic.com and nowhere else, and Sign out does not
                remove it. You can forget it here at any time.
              </p>
              <p className="text-sm">
                <a
                  href={CONSOLE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand underline underline-offset-2 hover:text-brand-deep"
                >
                  Create a key at console.anthropic.com
                </a>
              </p>
              {keyBlocked && (
                <p className="text-xs text-ink-muted">
                  This browser blocks site storage, so the key lasts until you close the tab.
                </p>
              )}
              <div className="flex items-center gap-2">
                <Input
                  type={show ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="sk-ant-…"
                  aria-label="Anthropic API key"
                  value={keyInput}
                  onChange={(e) => {
                    setKeyInput(e.target.value);
                    if (test !== "testing") setTest("idle");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void onSave();
                    }
                  }}
                />
                <Button variant="ghost" size="xs" type="button" onClick={() => setShow((v) => !v)}>
                  {show ? "Hide" : "Show"}
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" type="button" disabled={!canSave} onClick={() => void onSave()}>
                  Save and test
                </Button>
                {editing && hasKey && (
                  <Button variant="ghost" size="sm" type="button" onClick={() => setEditing(false)}>
                    Keep the saved key
                  </Button>
                )}
              </div>
              {test === "testing" && (
                <StateBlock tone="brand" eyebrow="Testing" role="status">
                  Testing the key…
                </StateBlock>
              )}
              {test === "rejected" && (
                <StateBlock tone="negative" eyebrow="Rejected" role="alert">
                  Anthropic rejected that key. Check it in the console and paste it again.
                </StateBlock>
              )}
            </>
          ) : null}
          {test === "ok" && (
            <StateBlock tone="positive" eyebrow="Accepted" role="status">
              Key accepted. Nothing was charged for this test.
            </StateBlock>
          )}
          {test === "offline" && (
            <StateBlock tone="warn" eyebrow="Offline" role="status">
              Could not reach Anthropic to test it. The key was saved anyway.
            </StateBlock>
          )}
          {hasKey && !editing && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono text-xs text-ink-soft">Key saved · {keyMask ?? "ends in ????"}</span>
              <Button
                variant="ghost"
                size="xs"
                type="button"
                onClick={() => {
                  setEditing(true);
                  setTest("idle");
                }}
              >
                Change key
              </Button>
              <Button
                variant="ghost"
                size="xs"
                type="button"
                className="text-negative hover:text-negative"
                onClick={() => {
                  forgetSavedKey();
                  setTest("idle");
                  setEditing(false);
                }}
              >
                Forget key
              </Button>
            </div>
          )}
          {hasKey && !editing && keyBlocked && (
            <p className="text-xs text-ink-muted">This browser blocks site storage, so the key lasts until you close the tab.</p>
          )}
        </section>
      )}

      <section className="space-y-2">
        <div className={EYEBROW}>Effort</div>
        <Tabs value={settings.effort} onValueChange={(v) => updateSettings({ effort: v as Effort })}>
          <TabsList aria-label="Effort">
            <TabsTrigger value="medium">Medium</TabsTrigger>
            <TabsTrigger value="high">High</TabsTrigger>
          </TabsList>
        </Tabs>
        <p className="text-xs text-ink-muted">High thinks longer and costs more. Changing it restarts the cached prefix once.</p>
      </section>

      <section className="space-y-2">
        <button
          type="button"
          role="checkbox"
          aria-checked={settings.showUsage}
          onClick={() => updateSettings({ showUsage: !settings.showUsage })}
          className="flex w-full items-center gap-3 rounded-md border border-border px-3 py-2 text-left transition outline-none hover:border-brand/50 focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <span
            aria-hidden
            className={cn(
              "flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] leading-none",
              settings.showUsage ? "border-brand bg-brand text-white" : "border-border bg-card",
            )}
          >
            {settings.showUsage ? "✓" : ""}
          </span>
          <span className="text-sm text-ink">Show usage</span>
          <span className="ml-auto text-xs text-ink-muted">tokens per answer and per chat</span>
        </button>
      </section>

      <p className="font-mono text-[10px] text-ink-muted">
        {CHAT_MODEL_LABEL} · {SDK_VERSION_LABEL}
      </p>
    </div>
  );
}

export { ChatSettingsScreen as ChatSettings };
