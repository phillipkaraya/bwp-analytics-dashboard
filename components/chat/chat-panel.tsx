"use client";

// The slide-over panel (section 4.2): head, scrolling body with the message
// log, empty state with data-aware chips, the settings screen, and the
// composer. Mounted once inside ChatRoot, so the transcript survives route
// changes; the Dialog itself only renders while open.

import { useCallback, useEffect, useMemo, useState } from "react";
import { RotateCcwIcon, Settings2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { asOf } from "@/lib/chat/data";
import { followUps, suggestions } from "@/lib/chat/suggestions";
import { parseDate } from "@/lib/format";
import { ChatComposer } from "./chat-composer";
import { ChatMessage } from "./chat-message";
import { useChatContext } from "./chat-root";
import { ChatSettingsScreen } from "./chat-settings";
import { StateBlock } from "./state-block";
import { SuggestionChips } from "./suggestion-chips";

const BOTTOM_THRESHOLD = 48;

const CONTENT_CLASS =
  "top-0 right-0 left-auto flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none p-0 sm:w-[440px] lg:w-[480px] sm:max-w-none data-open:slide-in-from-right data-closed:slide-out-to-right data-open:zoom-in-100 data-closed:zoom-out-100 duration-200";

function monthDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = parseDate(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function ChatPanel() {
  const ctx = useChatContext();
  const {
    open,
    setOpen,
    showSettings,
    setShowSettings,
    settings,
    provider,
    data,
    dataError,
    postsById,
    session,
    hasKey,
    chat,
    returnFocusRef,
    textareaRef,
    loadingHint,
  } = ctx;

  const [atBottom, setAtBottom] = useState(true);
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null);

  const viewport = useCallback(
    (): HTMLElement | null => bodyEl?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null,
    [bodyEl],
  );

  // Scrolling fires the scroll listener below, which updates atBottom.
  const scrollToBottom = useCallback(() => {
    const el = viewport();
    if (el) el.scrollTop = el.scrollHeight;
  }, [viewport]);

  // Track whether the reader is at the bottom of the log.
  useEffect(() => {
    if (!open) return;
    const el = viewport();
    if (!el) return;
    const onScroll = () => {
      setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD);
    };
    const frame = requestAnimationFrame(onScroll);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", onScroll);
    };
  }, [open, viewport, showSettings]);

  // Auto-scroll while streaming only when already at the bottom.
  useEffect(() => {
    if (!open || !chat.streaming || !atBottom) return;
    const el = viewport();
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, chat.turns, chat.streaming, atBottom, viewport]);

  // A newly sent question always scrolls into view.
  const turnCount = chat.turns.length;
  useEffect(() => {
    if (open) scrollToBottom();
  }, [open, turnCount, scrollToBottom]);

  const dates = useMemo(() => (data ? asOf(data) : null), [data]);
  const freshness = !data
    ? dataError
      ? "Data did not load"
      : "Loading data…"
    : data.rawPostCount === 0
      ? "No data yet"
      : [
          dates?.posts && dates.posts !== "none" ? `Posts to ${monthDay(dates.posts)}` : null,
          dates?.comments ? `Comments to ${monthDay(dates.comments)}` : null,
          `${data.rawPostCount.toLocaleString("en-US")} posts`,
        ]
          .filter((s): s is string => !!s)
          .join(" · ");

  const chips = useMemo(() => (data && data.posts.length > 0 ? suggestions(data) : []), [data]);
  const sent = useMemo(() => chat.turns.map((t) => t.user), [chat.turns]);
  const askNext = useMemo(() => (chat.turns.length > 0 ? followUps(sent) : []), [chat.turns.length, sent]);

  const emptyData = !!data && data.posts.length === 0;
  const needsKey = !!provider?.needsKey && !hasKey;
  const settingsView = showSettings || (needsKey && !!data);
  const lastTurn = chat.turns[chat.turns.length - 1];
  const composerDisabled = !session || emptyData || dataError || needsKey;

  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (!next && details.reason === "escape-key" && chat.streaming) {
          // Escape stops the stream first; the next press closes.
          details.cancel();
          chat.stop();
          return;
        }
        setOpen(next);
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={CONTENT_CLASS}
        initialFocus={textareaRef}
        finalFocus={returnFocusRef}
        aria-label="Ask the dashboard"
      >
        <div className="bg-[var(--ink)] text-white px-5 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-white/60">Ask the dashboard</span>
            <div className="ml-auto flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-white/75 hover:bg-white/10 hover:text-white"
                aria-label="Assistant settings"
                aria-pressed={showSettings}
                onClick={() => setShowSettings(!showSettings)}
              >
                <Settings2Icon />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-white/75 hover:bg-white/10 hover:text-white"
                aria-label="New chat"
                onClick={() => {
                  chat.newChat();
                  setShowSettings(false);
                  textareaRef.current?.focus();
                }}
              >
                <RotateCcwIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-white/75 hover:bg-white/10 hover:text-white"
                aria-label="Close"
                onClick={() => setOpen(false)}
              >
                <XIcon />
              </Button>
            </div>
          </div>
          <DialogTitle className="font-display text-lg font-medium leading-none text-white mt-2">
            Ask your <em className="italic text-white">Analytics</em>
          </DialogTitle>
          <DialogDescription className="mt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-white/50">
            {freshness}
          </DialogDescription>
        </div>

        <div role="status" aria-live="polite" className="sr-only">
          {chat.announce}
        </div>

        {settingsView ? (
          <ScrollArea className="min-h-0 flex-1">
            <ChatSettingsScreen />
          </ScrollArea>
        ) : (
          <>
            <div ref={setBodyEl} className="relative flex min-h-0 flex-1 flex-col">
              <ScrollArea className="min-h-0 flex-1">
                <div className="px-5 py-4 space-y-5">
                  {dataError && (
                    <StateBlock tone="warn" eyebrow="No data" role="alert">
                      Dashboard data did not load. Reload the page.
                    </StateBlock>
                  )}
                  {emptyData && (
                    <StateBlock tone="neutral" eyebrow="No data yet">
                      Run your first data pull and come back. The assistant only answers from your own numbers.
                    </StateBlock>
                  )}
                  {chat.turns.length === 0 && !dataError && !emptyData && (
                    <div className="space-y-4">
                      <p className="text-sm text-ink-soft max-w-prose">
                        Ask about your best posts, growth, posting times or what people are saying. Every number comes
                        from the data on this dashboard.
                      </p>
                      <SuggestionChips items={chips} onPick={chat.send} disabled={composerDisabled || !data} />
                    </div>
                  )}
                  <div role="log" aria-live="polite" aria-relevant="additions" aria-busy={chat.streaming} className="space-y-5">
                    {chat.turns.map((turn, i) => (
                      <ChatMessage
                        key={turn.id}
                        turn={turn}
                        meta={chat.meta[turn.id]}
                        live={chat.streaming && i === chat.turns.length - 1}
                        hint={chat.streaming ? loadingHint : null}
                        showUsage={settings.showUsage}
                        postsById={postsById}
                        vault={data?.vault ?? null}
                        onRetry={chat.retry}
                        onEditKey={() => setShowSettings(true)}
                        onNewChat={chat.newChat}
                        onSend={chat.send}
                      />
                    ))}
                  </div>
                </div>
              </ScrollArea>
              {!atBottom && chat.turns.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    scrollToBottom();
                    setAtBottom(true);
                  }}
                  className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-ink px-3 py-1 text-xs text-white shadow outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  Jump to latest
                </button>
              )}
            </div>
            <ChatComposer
              textareaRef={textareaRef}
              streaming={chat.streaming}
              loading={!data && !dataError}
              disabled={composerDisabled}
              onSend={chat.send}
              onStop={chat.stop}
              onNewChat={chat.newChat}
              lastQuestion={lastTurn?.user ?? null}
              askNext={askNext}
              turnCount={chat.turns.length}
              showUsage={settings.showUsage}
              lastUsage={lastTurn?.usage}
              sessionUsage={chat.sessionUsage}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
