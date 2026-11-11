"use client";

import { useEffect, useMemo, useState } from "react";
import {
  loadAllPosts,
  loadContentVault,
  loadFollowerHistory,
  loadScrapeState,
} from "@/lib/data";
import { WINDOW_OPTIONS, pickWindow, scopePlatforms, type WindowDays } from "@/lib/derive";
import { useAccountScope } from "@/lib/account";
import type { AccountScope, ContentVault, FollowerSnapshot, Post, ScrapeState } from "@/lib/types";
import { PageHero } from "@/components/layout/page-hero";
import { AccountSwitch } from "@/components/layout/account-switch";
import { Hero } from "./hero";
import { PlatformStatusRow } from "./platform-status";
import { TopicsRibbon } from "./topics-ribbon";
import { PostActivity } from "./post-activity";
import { FollowerHistory } from "./follower-history";
import { PlatformCharts } from "./platform-charts";
import { TopPosts } from "./top-posts";

const WINDOW_STORAGE_KEY = "bwp_overview_window";

/** Everything the Overview draws for one account scope, loaded together so
 *  followers, posts and topics never come from two different accounts. */
interface Loaded {
  scope: AccountScope;
  posts: Post[];
  scrape: ScrapeState;
  history: FollowerSnapshot[];
  vault: ContentVault;
}

export function Overview() {
  const [scope] = useAccountScope();
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      loadAllPosts(scope),
      loadScrapeState(scope),
      loadFollowerHistory(scope),
      loadContentVault(scope),
    ])
      .then(([posts, scrape, history, vault]) => {
        if (!cancelled) setLoaded({ scope, posts, scrape, history, vault });
      })
      .catch(() => {
        /* the loaders fall back to empty data; nothing to surface here */
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  const posts = useMemo(() => loaded?.posts ?? [], [loaded]);

  // One window for the hero and the top-posts table so they reconcile.
  // Phil's last choice is remembered per browser; until he makes one the
  // shortest window with posts is picked. Storage can be absent or throw
  // (private window, blocked site data), so every touch is guarded.
  // Read once, lazily: the prerender has no window (the throw is caught and
  // yields null), and the hero is not drawn until the data has loaded, so the
  // client's stored value never disagrees with anything already on screen.
  const [chosen, setChosen] = useState<WindowDays | null>(() => {
    try {
      const v = Number(window.localStorage.getItem(WINDOW_STORAGE_KEY));
      return (WINDOW_OPTIONS as readonly number[]).includes(v) ? (v as WindowDays) : null;
    } catch {
      return null;
    }
  });
  const days = useMemo(() => chosen ?? pickWindow(posts), [chosen, posts]);
  function pickDays(d: WindowDays) {
    setChosen(d);
    try {
      localStorage.setItem(WINDOW_STORAGE_KEY, String(d));
    } catch {
      /* not persisted this time; the choice still applies to this page */
    }
  }

  if (!loaded) {
    return <PageHero eyebrow="Loading data" title="Overview" controls={<AccountSwitch />} />;
  }

  // Draw the scope that actually loaded, so a switch in flight keeps showing
  // one consistent account until the next one arrives.
  const { scrape, history, vault } = loaded;
  const shown = loaded.scope;
  const platforms = scopePlatforms(shown);

  return (
    <>
      <Hero
        posts={posts}
        scrape={scrape}
        history={history}
        days={days}
        onDays={pickDays}
        scope={shown}
        platforms={platforms}
      />
      <div className="mx-auto max-w-[1500px] space-y-8 px-6 py-8">
        <PlatformStatusRow posts={posts} scrape={scrape} history={history} platforms={platforms} />
        {vault.categories.length > 0 && <TopicsRibbon vault={vault} />}
        <PostActivity posts={posts} />
        <FollowerHistory history={history} ordinal={2} platforms={platforms} />
        <PlatformCharts posts={posts} platforms={platforms} />
        <TopPosts key={shown} posts={posts} days={days} platforms={platforms} />
      </div>
    </>
  );
}
