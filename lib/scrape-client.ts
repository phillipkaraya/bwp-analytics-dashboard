// Client for the local scraper service (port 5556). Returns null / false
// when the service is offline so the UI degrades cleanly.

export const SCRAPER_URL = "http://localhost:5556";

/** "incremental" stops at the first page of posts it already has;
 *  "full" re-pages everything and refreshes metrics on every post. */
export type ScrapeMode = "incremental" | "full";

export interface StartScrapeOptions {
  platforms?: string[];
  mode?: ScrapeMode;
  /** "all", "personal" or "brand". The service treats a request without it
   *  as the personal pages, which is all it knew before accounts. */
  account?: string;
}

export interface ScrapeJob {
  id: string;
  status: "queued" | "running" | "complete" | "error";
  mode?: ScrapeMode;
  platforms: string[];
  startedAt: string;
  etaSeconds: number;
  currentPlatform: string | null;
  progress: number;
  completedAt?: string;
  error?: string;
  /** Per-platform failures. A job is still "complete" when at least one
   *  platform succeeded, so the UI must read this to report a partial run. */
  errors?: Record<string, string> | null;
  isStub?: boolean;
}

export interface ScraperHealth {
  ok: boolean;
  version: string;
}

export async function pingScraper(): Promise<ScraperHealth | null> {
  try {
    const res = await fetch(`${SCRAPER_URL}/ping`, {
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    return (await res.json()) as ScraperHealth;
  } catch {
    return null;
  }
}

export async function startScrape(
  opts: StartScrapeOptions = {},
): Promise<ScrapeJob | null> {
  try {
    const res = await fetch(`${SCRAPER_URL}/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(opts.platforms ? { platforms: opts.platforms } : {}),
        mode: opts.mode ?? "incremental",
        ...(opts.account ? { account: opts.account } : {}),
      }),
    });
    if (!res.ok) return null;
    return (await res.json()) as ScrapeJob;
  } catch {
    return null;
  }
}

export async function getScrapeStatus(jobId: string): Promise<ScrapeJob | null> {
  try {
    const res = await fetch(
      `${SCRAPER_URL}/scrape-status?id=${encodeURIComponent(jobId)}`,
      { cache: "no-store" },
    );
    if (!res.ok) return null;
    return (await res.json()) as ScrapeJob;
  } catch {
    return null;
  }
}
