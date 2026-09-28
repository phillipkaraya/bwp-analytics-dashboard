// Shared types — mirror the JSON shapes in /public/data/*.

export type Platform = "instagram" | "tiktok" | "youtube" | "threads" | "linkedin";

export interface Post {
  id: string;
  platform: Platform;
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

export interface FollowerSnapshot {
  date: string; // YYYY-MM-DD
  instagram: number;
  tiktok: number;
  youtube: number;
  threads: number;
  /** Added 2026-09-05; older snapshots do not carry it. */
  linkedin?: number;
}

export interface ScrapeState {
  followers: Record<Platform, number>;
  lastAutoCheck?: string;
  needsRefresh?: boolean;
  instagram?: PlatformScrapeState;
  tiktok?: PlatformScrapeState;
  youtube?: PlatformScrapeState;
  threads?: PlatformScrapeState;
  linkedin?: PlatformScrapeState;
}

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
