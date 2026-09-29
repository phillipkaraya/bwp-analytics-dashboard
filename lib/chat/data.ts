// The dataset the assistant's tools run over (section 1.7).
//
// getChatData() is a module memo over the same loaders the pages use, built on
// first panel open. makeChatData(raw, now) is the pure builder for Node scripts
// and tests. followData and followerProjections are deleted at build so no
// tool can ever return them; rows with an empty date are dropped, as derive.ts
// does; comments load lazily on the first comment tool and are memoized.
//
// Relative imports only: tsx runs this in Node without the Next alias.

import type {
  AnalyticsBundle,
  Comment,
  ContentVault,
  FollowerSnapshot,
  Post,
  ScrapeState,
} from "../types";
import {
  loadAllPosts,
  loadAnalytics,
  loadComments,
  loadContentVault,
  loadFollowerHistory,
  loadScrapeState,
} from "../data";

export interface ChatData {
  posts: Post[]; // rows with an empty date dropped, as derive.ts does
  rawPostCount: number; // what the Overview hero counts
  analytics: AnalyticsBundle; // followData and followerProjections deleted at build
  vault: ContentVault;
  history: FollowerSnapshot[];
  scrape: ScrapeState;
  comments: () => Promise<Comment[]>; // lazy, memoized: the 2.6 MB file loads only when a comment tool needs it
  now: () => number; // pinned per session; injectable in tests
}

export interface RawChatData {
  posts: Post[];
  analytics: AnalyticsBundle;
  vault: ContentVault;
  history: FollowerSnapshot[];
  scrape: ScrapeState;
  /** An array for tests, or a loader for the lazy path. Absent means none. */
  comments?: Comment[] | (() => Promise<Comment[]>);
}

const STRIPPED_ANALYTICS_KEYS = ["followData", "followerProjections"] as const;

const EMPTY_VAULT: ContentVault = { generatedAt: "", totalPosts: 0, categories: [], byPost: {} };
const EMPTY_SCRAPE: ScrapeState = {
  followers: { instagram: 0, tiktok: 0, youtube: 0, threads: 0, linkedin: 0 },
};

/** Shallow copy without the sections no tool may expose. */
export function stripAnalytics(analytics: AnalyticsBundle | null | undefined): AnalyticsBundle {
  const out: AnalyticsBundle = { ...(analytics ?? {}) };
  for (const key of STRIPPED_ANALYTICS_KEYS) delete out[key];
  return out;
}

/** The same gate derive.ts applies: a date that parses. */
export function hasDate(p: Post): boolean {
  return typeof p.date === "string" && p.date.length > 0 && Number.isFinite(new Date(p.date).getTime());
}

/** Comments already loaded for a dataset, so asOf() can stay synchronous. */
const loadedComments = new WeakMap<ChatData, Comment[]>();

export function makeChatData(raw: RawChatData, now: () => number = () => Date.now()): ChatData {
  const rawPosts = Array.isArray(raw.posts) ? raw.posts : [];
  const source = raw.comments;
  let pending: Promise<Comment[]> | null = null;

  const data: ChatData = {
    posts: rawPosts.filter(hasDate),
    rawPostCount: rawPosts.length,
    analytics: stripAnalytics(raw.analytics),
    vault: raw.vault ?? EMPTY_VAULT,
    history: Array.isArray(raw.history) ? raw.history : [],
    scrape: raw.scrape ?? EMPTY_SCRAPE,
    comments: () => {
      if (!pending) {
        pending = Promise.resolve()
          .then(() => (typeof source === "function" ? source() : (source ?? [])))
          .then((list) => {
            const arr = Array.isArray(list) ? list : [];
            loadedComments.set(data, arr);
            return arr;
          })
          .catch((err: unknown) => {
            pending = null; // a failed load may be retried by the next tool call
            throw err;
          });
      }
      return pending;
    },
    now,
  };
  return data;
}

/** The loaded comments, or null when no comment tool has run yet. */
export function peekComments(data: ChatData): Comment[] | null {
  return loadedComments.get(data) ?? null;
}

let memo: Promise<ChatData> | null = null;

/** Module memo: built once per page, shared by every panel open. A rejected
 *  load clears the memo so a later open can try again. */
export function getChatData(): Promise<ChatData> {
  if (!memo) {
    memo = Promise.all([
      loadAllPosts(),
      loadAnalytics(),
      loadContentVault(),
      loadFollowerHistory(),
      loadScrapeState(),
    ])
      .then(([posts, analytics, vault, history, scrape]) =>
        makeChatData({ posts, analytics, vault, history, scrape, comments: loadComments }),
      )
      .catch((err: unknown) => {
        memo = null;
        throw err;
      });
  }
  return memo;
}

/** Forget the memo (after a data refresh, or in tests). */
export function resetChatData(): void {
  memo = null;
}

/** Comment postIds carry no owner suffix ("ig_<mediaId>") while Instagram
 *  post ids do ("ig_<mediaId>_<ownerId>"); the first two parts match both. */
export const postKey = (id: string) => id.split("_").slice(0, 2).join("_");

/** "2026-09-21" from "2026-09-21T21:28:42+00:00", or null. */
export function datePart(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return m ? m[1] : null;
}

/** Newest YYYY-MM-DD among rows that have one, or null. */
export function newestDate(rows: ReadonlyArray<{ date?: string }>): string | null {
  let best: string | null = null;
  for (const r of rows) {
    const d = datePart(r.date);
    if (d && (best === null || d > best)) best = d;
  }
  return best;
}

/** As-of dates for every envelope: the date part of analytics.dataAsOf, else
 *  the newest post (or loaded comment) date. comments is null when there is
 *  nothing to say. posts is "none" only when no post and no as-of exists. */
export function asOf(data: ChatData): { posts: string; comments: string | null } {
  const posts = datePart(data.analytics.dataAsOf?.posts) ?? newestDate(data.posts) ?? "none";
  const loaded = peekComments(data);
  const comments =
    datePart(data.analytics.dataAsOf?.comments) ?? (loaded && loaded.length ? newestDate(loaded) : null);
  return { posts, comments };
}
