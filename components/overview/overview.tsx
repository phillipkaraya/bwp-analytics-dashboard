"use client";

import { useEffect, useMemo, useState } from "react";
import {
  loadAllPosts,
  loadContentVault,
  loadFollowerHistory,
  loadScrapeState,
} from "@/lib/data";
import { WINDOW_OPTIONS, pickWindow, type WindowDays } from "@/lib/derive";
import type { ContentVault, FollowerSnapshot, Post, ScrapeState } from "@/lib/types";
import { PageHero } from "@/components/layout/page-hero";
import { Hero } from "./hero";
import { PlatformStatusRow } from "./platform-status";
import { TopicsRibbon } from "./topics-ribbon";
import { PostActivity } from "./post-activity";
import { FollowerHistory } from "./follower-history";
import { PlatformCharts } from "./platform-charts";
import { TopPosts } from "./top-posts";

const WINDOW_STORAGE_KEY = "bwp_overview_window";

export function Overview() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [scrape, setScrape] = useState<ScrapeState | null>(null);
  const [history, setHistory] = useState<FollowerSnapshot[]>([]);
  const [vault, setVault] = useState<ContentVault | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      loadAllPosts(),
      loadScrapeState(),
      loadFollowerHistory(),
      loadContentVault(),
    ])
      .then(([p, s, h, v]) => {
        if (cancelled) return;
        setPosts(p);
        setScrape(s);
        setHistory(h);
        setVault(v);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  if (loading || !scrape) {
    return <PageHero eyebrow="Loading data" title="Overview" />;
  }

  return (
    <>
      <Hero posts={posts} scrape={scrape} history={history} days={days} onDays={pickDays} />
      <div className="mx-auto max-w-[1500px] space-y-8 px-6 py-8">
        <PlatformStatusRow posts={posts} scrape={scrape} history={history} />
        {vault && vault.categories.length > 0 && <TopicsRibbon vault={vault} />}
        <PostActivity posts={posts} />
        <FollowerHistory history={history} ordinal={2} />
        <PlatformCharts posts={posts} />
        <TopPosts posts={posts} days={days} />
      </div>
    </>
  );
}
