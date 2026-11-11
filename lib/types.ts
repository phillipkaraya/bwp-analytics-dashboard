// Shared types — mirror the JSON shapes in /public/data/*.

export type Platform = "instagram" | "tiktok" | "youtube" | "threads" | "linkedin";

/** Which set of pages a post belongs to: Phil's own profiles ("personal") or
 *  the Build With Phil pages ("brand"). Mirrors ACCOUNTS in scrape/handles.py. */
export type Account = "personal" | "brand";
/** What the account switch can show: one account, or every account together. */
export type AccountScope = "all" | Account;

export interface Post {
  id: string;
  platform: Platform;
  /** Stamped by the loader from the file the post came from, never stored. */
  account?: Account;
  type?: string; // reel | carousel | story | video | short | post
  date: string; // YYYY-MM-DD
  time?: string; // HH:MM
  title?: string;
  caption?: string;
  hashtags?: string;
  thumbnailUrl?: string;
  url?: string;
  duration?: string;
  views: number;
  likes: number;
  comments: number;
  shares?: number;
  saves?: number;
  engagementRate?: string | number; // stringified in raw JSON
  /** Set by the studio pass: likes and comments were counted, so a zero is real. */
  engagementMeasured?: boolean;
  notes?: string;
}

export interface Comment {
  id: string;
  postId?: string;
  platform: Platform;
  username: string;
  text: string;
  likes: number;
  date: string;
  /** Labeled by scrape/sentiment.py. A question is a separate flag so a
   *  comment can be both positive and a question. */
  sentiment?: "positive" | "neutral" | "negative";
  isQuestion?: boolean;
  sentimentSource?: "llm" | "lexicon";
  /** Unreliable in the snapshot; never used. */
  replied?: boolean;
}

/** One day's follower counts. A platform is absent when the account was not
 *  on it, or was not scraped there, on that day (LinkedIn joined 2026-09-05;
 *  the brand pages cover fewer platforms than the personal ones). */
export type FollowerSnapshot = { date: string } & Partial<Record<Platform, number>>;

/** One account's scrape status: follower counts plus a block per platform. */
export type AccountScrapeState = {
  followers?: Partial<Record<Platform, number>>;
  followersUpdated?: Partial<Record<Platform, string>>;
} & Partial<Record<Platform, PlatformScrapeState>>;

/** scrape_state.json. The personal account sits at the top level, where it
 *  always has; every other account has the same shape under `accounts`. */
export type ScrapeState = {
  followers: Partial<Record<Platform, number>>;
  followersUpdated?: Partial<Record<Platform, string>>;
  lastAutoCheck?: string;
  needsRefresh?: boolean;
  accounts?: Partial<Record<Account, AccountScrapeState>>;
} & Partial<Record<Platform, PlatformScrapeState>>;

export interface PlatformScrapeState {
  status?: string;
  totalScraped?: number;
  lastScrapedDate?: string;
  lastPostId?: string;
}

export interface FollowData {
  instagram: PlatformFollowData;
  tiktok: PlatformFollowData;
  youtube?: PlatformFollowData;
  threads?: PlatformFollowData;
  summary?: Record<string, unknown>;
  linkedin?: PlatformFollowData;
}

export interface HeatmapCell {
  count: number;
  avgEngagement: number;
  avgViews: number;
}

export interface BestPostingTime {
  day: number;
  hour: number;
  count: number;
  avgEngagement: number;
  avgViews: number;
}

export interface ViralPost {
  id: string;
  title: string;
  platform: Platform;
  views: number;
  likes?: number;
  comments?: number;
  url?: string;
  multiplier?: number;
  avgViewsForPlatform?: number;
}

export interface HashtagStat {
  tag: string;
  count: number;
  avgViews: number;
  avgLikes: number;
  avgEngagement: number;
  totalViews: number;
}

export interface CrossPostItem {
  title: string;
  platforms: Platform[];
  posts: Array<{
    id: string;
    platform: Platform;
    views: number;
    likes: number;
    url?: string;
  }>;
}

export interface HookTypeStat {
  type: string;
  count: number;
  avgViews: number;
  avgLikes: number;
  avgEngagement: number;
  totalViews: number;
  topPost?: string;
}

export interface TopHook {
  hook: string;
  postId: string;
  platform: Platform;
  views: number;
  likes: number;
  engagement: number;
  url?: string;
}

export interface TopCommenter {
  username: string;
  count: number;
  platforms: Platform[];
}

export interface HighValueComment {
  id: string;
  postId?: string;
  platform: Platform;
  username: string;
  text: string;
  likes: number;
  isQuestion?: boolean;
  date?: string;
  postUrl?: string;
}

export interface GrowthMonth {
  month: string;
  posts: number;
  views: number;
  likes: number;
  comments: number;
}

export interface CrossPlatformUser {
  username: string;
  platforms: Platform[];
  commentCount: number;
  totalLikes: number;
}

export interface AudienceOverlap {
  crossPlatformUsers: CrossPlatformUser[];
  totalUniqueUsers: number;
  platformBreakdown: Record<string, number>;
}

export interface FunnelStage {
  views: number;
  likes: number;
  comments: number;
  shares?: number;
}

export interface AnalyticsBundle {
  generatedAt?: string; // ISO, written by scrape/analyze.py
  /** Absent on the every-account bundle (analytics.json); the account name on
   *  analytics.<account>.json. */
  scope?: Account;
  dataAsOf?: { posts?: string; comments?: string };
  postingHeatmap?: HeatmapCell[][];
  bestPostingTimes?: BestPostingTime[];
  contentCategories?: Record<string, { count: number; avgViews: number; avgEngagement: number }>;
  viralPosts?: ViralPost[];
  platformAverages?: Record<Platform, { avgViews: number; avgLikes: number; avgComments: number; avgEngagement: number }>;
  engagementFunnel?: Record<Platform, FunnelStage>;
  audienceOverlap?: AudienceOverlap;
  topCommenters?: TopCommenter[];
  highValueComments?: HighValueComment[];
  hashtagPerformance?: HashtagStat[];
  growthVelocity?: GrowthMonth[];
  crossPosts?: CrossPostItem[];
  topHooks?: TopHook[];
  hookTypes?: HookTypeStat[];
  /** Number of comments flagged as questions (all of them, not "unreplied"). */
  questionCount?: number;
  commentSentiment?: Record<string, number>;
  /** How labels were produced: counts by "llm" | "lexicon". */
  sentimentSources?: Record<string, number>;
  [key: string]: unknown;
}

export interface FollowUser {
  id: string;
  username: string;
  fullName?: string;
  isVerified?: boolean;
}

export interface PlatformFollowData {
  scrapedAt?: string | null;
  following?: number | null;
  followers?: number;
  dontFollowBack?: FollowUser[];
  fans?: FollowUser[];
  mutual?: FollowUser[];
  note?: string;
}

// Content Vault — produced by scrape/analyze.py from scrape/categories.json.
export interface VaultCategory {
  slug: string;
  label: string;
  count: number;
  totalViews: number;
  avgViews: number;
  platforms: Partial<Record<Platform, number>>;
  postIds: string[]; // sorted by views desc
}

export interface ContentVault {
  generatedAt: string;
  totalPosts: number;
  categories: VaultCategory[]; // sorted by count desc
  byPost: Record<string, string[]>; // postId -> category slugs
}

export interface CreatorRecord {
  id: string;
  handle: string;
  platform: Platform;
  niche: string;
  followers: number;
  followersChange?: number;
  followers7d?: number;
}
