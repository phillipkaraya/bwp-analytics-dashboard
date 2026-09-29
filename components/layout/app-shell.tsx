import { Nav } from "./nav";
import { DataStatusBar } from "./data-status-bar";
import { ChatRoot } from "@/components/chat/chat-root";
import { ChatLauncher } from "@/components/chat/chat-launcher";
import { ChatFab } from "@/components/chat/chat-fab";
import { ChatPanel } from "@/components/chat/chat-panel";

/**
 * Every tab opens on a dark hero band (PageHero), so the header lives inside
 * that band on all pages: brand, segmented nav, live status. Pages own their
 * content container below the band.
 *
 * AppShell stays a server component; ChatRoot is the client boundary that
 * holds the assistant's state, and the launcher, FAB and panel read it.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <ChatRoot>
      <div className="min-h-screen bg-background">
        <header className="bg-[var(--ink)] text-white">
          <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-8 gap-y-3 px-6 py-3">
            <div className="flex items-baseline gap-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-white/60">
                Build With Phil
              </p>
              <span aria-hidden className="h-3 w-px bg-white/25" />
              <h1 className="font-display text-base font-medium leading-none">
                Social Media <em className="italic text-white">Analytics</em>
              </h1>
            </div>
            <div className="order-last w-full sm:order-none sm:w-auto sm:flex-1">
              <Nav tone="dark" />
            </div>
            <div className="ml-auto flex items-center gap-3">
              <ChatLauncher tone="dark" />
              <DataStatusBar tone="dark" />
            </div>
          </div>
        </header>
        <main className="page-texture">{children}</main>
        <ChatFab />
        <ChatPanel />
      </div>
    </ChatRoot>
  );
}
