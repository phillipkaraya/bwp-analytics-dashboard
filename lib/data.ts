// Typed JSON loaders. Files live in /public/data/.
// On client side, we fetch with credentials omitted; on the server during static
// build, we read directly from the filesystem so SWR isn't needed at build time.

import type {
  Account,
  AccountScope,
  Post,
  Platform,
  Comment,
  FollowerSnapshot,
  ScrapeState,
  FollowData,
  AnalyticsBundle,
  ContentVault,
} from "./types";
import {
  ACCOUNTS,
  ACCOUNT_PLATFORMS,
  DEFAULT_ACCOUNT,
  mergeFollowerHistory,
  scopedScrapeState,
} from "./derive";

type FetchOpts = { fallback?: unknown };

// Share successful loads between the dashboard tabs and the assistant.
// A refresh reloads the page; a failed load is removed so it can be retried.
const pendingData = new Map<string, Promise<unknown>>();
function sharedJson(path: string): Promise<unknown> {
  const existing = pendingData.get(path);
  if (existing) return existing;
  const pending = fetch(path, { cache: "no-store", credentials: "omit" })
    .then((res) => {
      if (!res.ok) throw new Error(`${res.status} ${path}`);
      return res.json();
    }).catch((err: unknown) => {
      pendingData.delete(path);
      throw err;
    });
  pendingData.set(path, pending);
  return pending;
}

async function fetchJson<T>(path: string, opts: FetchOpts = {}): Promise<T> {
  try {
    return (await sharedJson(path)) as T;
  } catch (err) {
    if (opts.fallback !== undefined) return opts.fallback as T;
    throw err;
  }
}

// In production, GitHub Pages serves the site at /<basePath>/ — raw fetch()
// calls don't get auto-prefixed by Next.js, so we have to do it ourselves.
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const DATA_BASE = `${BASE_PATH}/data`;

export const dataPaths = {
  instagram: `${DATA_BASE}/instagram_posts.json`,
  tiktok: `${DATA_BASE}/tiktok_posts.json`,
  youtube: `${DATA_BASE}/youtube_posts.json`,
  threads: `${DATA_BASE}/threads_posts.json`,
  linkedin: `${DATA_BASE}/linkedin_posts.json`,
  comments: `${DATA_BASE}/comments.json`,
  analytics: `${DATA_BASE}/analytics.json`,
  followData: `${DATA_BASE}/follow_data.json`,
  scrapeState: `${DATA_BASE}/scrape_state.json`,
  followerHistory: `${DATA_BASE}/follower_history.json`,
  contentVault: `${DATA_BASE}/content_vault.json`,
} as const;

export const loadPosts = {
  instagram: () => fetchJson<Post[]>(dataPaths.instagram, { fallback: [] }),
  tiktok: () => fetchJson<Post[]>(dataPaths.tiktok, { fallback: [] }),
  youtube: () => fetchJson<Post[]>(dataPaths.youtube, { fallback: [] }),
  threads: () => fetchJson<Post[]>(dataPaths.threads, { fallback: [] }),
  linkedin: () => fetchJson<Post[]>(dataPaths.linkedin, { fallback: [] }),
};

// --- Accounts ---------------------------------------------------------------
// The personal files keep the names above. Every other account's files carry
// its name: brand_instagram_posts.json, analytics.brand.json and so on (see
// data_file() in scrape/handles.py and scoped_file() in scrape/analyze.py).

/** Posts file of one platform of one account. */
export function postsPath(platform: Platform, account: Account = DEFAULT_ACCOUNT): string {
  const prefix = account === DEFAULT_ACCOUNT ? "" : `${account}_`;
  return `${DATA_BASE}/${prefix}${platform}_posts.json`;
}

/** analytics.json for every account together, analytics.<account>.json for one. */
function scopedPath(base: string, scope: AccountScope): string {
  return scope === "all" ? base : base.replace(/\.json$/, `.${scope}.json`);
}

/** One account's posts on every platform it has, each stamped with the account. */
async function loadAccountPosts(account: Account): Promise<Post[]> {
  const lists = await Promise.all(
    ACCOUNT_PLATFORMS[account].map((p) =>
      fetchJson<Post[]>(postsPath(p, account), { fallback: [] }),
    ),
  );
  return lists.flat().map((p) => (p.account === account ? p : { ...p, account }));
}

/** Posts of the chosen scope: every account by default, or one of them. */
export async function loadAllPosts(scope: AccountScope = "all"): Promise<Post[]> {
  const accounts = scope === "all" ? ACCOUNTS : [scope];
  return (await Promise.all(accounts.map(loadAccountPosts))).flat();
}

export const loadComments = () =>
  fetchJson<Comment[]>(dataPaths.comments, { fallback: [] });

export const loadAnalytics = (scope: AccountScope = "all") =>
  fetchJson<AnalyticsBundle>(scopedPath(dataPaths.analytics, scope), { fallback: {} });

export const loadFollowData = () =>
  fetchJson<FollowData>(dataPaths.followData, {
    fallback: {
      instagram: { followers: 0, following: 0, dontFollowBack: [], fans: [], mutual: [] },
      tiktok: { followers: 0, following: 0, dontFollowBack: [], fans: [], mutual: [] },
    },
  });

/** scrape_state.json as the scope sees it. With no scope, the raw file. */
export async function loadScrapeState(scope?: AccountScope): Promise<ScrapeState> {
  const raw = await fetchJson<ScrapeState>(dataPaths.scrapeState, {
    fallback: {
      followers: { instagram: 0, tiktok: 0, youtube: 0, threads: 0, linkedin: 0 },
    },
  });
  return scope ? scopedScrapeState(raw, scope) : raw;
}

const accountHistory = (account: Account) =>
  fetchJson<FollowerSnapshot[]>(
    account === DEFAULT_ACCOUNT
      ? dataPaths.followerHistory
      : scopedPath(dataPaths.followerHistory, account),
    { fallback: [] },
  );

/** Follower series of one account, or of every account added together. The
 *  default stays the personal series, the only one there was before accounts. */
export async function loadFollowerHistory(
  scope: AccountScope = DEFAULT_ACCOUNT,
): Promise<FollowerSnapshot[]> {
  if (scope !== "all") return accountHistory(scope);
  return mergeFollowerHistory(await Promise.all(ACCOUNTS.map(accountHistory)));
}

export const loadContentVault = (scope: AccountScope = "all") =>
  fetchJson<ContentVault>(scopedPath(dataPaths.contentVault, scope), {
    fallback: { generatedAt: "", totalPosts: 0, categories: [], byPost: {} },
  });
