// Typed JSON loaders. Files live in /public/data/.
// On client side, we fetch with credentials omitted; on the server during static
// build, we read directly from the filesystem so SWR isn't needed at build time.

import type {
  Post,
  Comment,
  FollowerSnapshot,
  ScrapeState,
  FollowData,
  AnalyticsBundle,
  ContentVault,
} from "./types";

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

export async function loadAllPosts(): Promise<Post[]> {
  const [ig, tt, yt, th, li] = await Promise.all([
    loadPosts.instagram(),
    loadPosts.tiktok(),
    loadPosts.youtube(),
    loadPosts.threads(),
    loadPosts.linkedin(),
  ]);
  return [...ig, ...tt, ...yt, ...th, ...li];
}

export const loadComments = () =>
  fetchJson<Comment[]>(dataPaths.comments, { fallback: [] });

export const loadAnalytics = () =>
  fetchJson<AnalyticsBundle>(dataPaths.analytics, { fallback: {} });

export const loadFollowData = () =>
  fetchJson<FollowData>(dataPaths.followData, {
    fallback: {
      instagram: { followers: 0, following: 0, dontFollowBack: [], fans: [], mutual: [] },
      tiktok: { followers: 0, following: 0, dontFollowBack: [], fans: [], mutual: [] },
    },
  });

export const loadScrapeState = () =>
  fetchJson<ScrapeState>(dataPaths.scrapeState, {
    fallback: {
      followers: { instagram: 0, tiktok: 0, youtube: 0, threads: 0, linkedin: 0 },
    },
  });

export const loadFollowerHistory = () =>
  fetchJson<FollowerSnapshot[]>(dataPaths.followerHistory, { fallback: [] });

export const loadContentVault = () =>
  fetchJson<ContentVault>(dataPaths.contentVault, {
    fallback: { generatedAt: "", totalPosts: 0, categories: [], byPost: {} },
  });
