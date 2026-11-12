import { BarChart } from "@/components/charts/bar-chart";
import { Numbered } from "@/components/charts/numbered";
import { Section } from "@/components/charts/section";
import { fmt, fmtPct, platformColor, platformLabel, platformShort } from "@/lib/format";
import { PLATFORMS, byPlatform, hasViews, totals, avgEngagementRate } from "@/lib/derive";
import type { Platform, Post } from "@/lib/types";

// Keyed by the bar's label, with and without the "(likes)" suffix a viewless
// platform carries. Built from PLATFORMS so a new platform is never colourless.
const PLATFORM_COLOR: Record<string, string> = Object.fromEntries(
  PLATFORMS.flatMap((p) => [
    [platformLabel[p], platformColor[p]],
    [`${platformLabel[p]} (likes)`, platformColor[p]],
  ]),
);

// Phone-width fallback for the x axis: "LinkedIn (likes)" becomes "LI".
const PLATFORM_SHORT: Record<string, string> = Object.fromEntries(
  PLATFORMS.flatMap((p) => [
    [platformLabel[p], platformShort[p]],
    [`${platformLabel[p]} (likes)`, platformShort[p]],
  ]),
);

export function PlatformCharts({
  posts,
  platforms = PLATFORMS,
}: {
  posts: Post[];
  /** The platforms of the account in view; every platform by default. */
  platforms?: Platform[];
}) {
  const grouped = byPlatform(posts, (p) => p.platform);
  const engagementData = platforms.map((p) => ({
    platform: platformLabel[p],
    rate: Number(avgEngagementRate(grouped[p]).toFixed(2)),
  }));

  // Name the viewless platforms actually on screen, so the note never
  // mentions Threads on a page that only shows Facebook.
  const viewless = platforms.filter((p) => !hasViews(p)).map((p) => platformLabel[p]);
  const viewlessNames =
    viewless.length > 1 ? `${viewless.slice(0, -1).join(", ")} and ${viewless[viewless.length - 1]}` : viewless[0];
  const verb = (one: string, many: string) => (viewless.length > 1 ? many : one);
  const engagementHint = viewless.length
    ? `Average % per post. ${viewlessNames} ${verb("is", "are")} measured against followers, since ${verb("it publishes", "they publish")} no view count.`
    : "Average % per post, measured against views.";
  const reachHint = viewless.length
    ? `Lifetime views. ${viewlessNames} ${verb("counts", "count")} likes, since ${verb("it publishes", "they publish")} no view count.`
    : "Lifetime views.";

  // Viewless platforms (Threads, LinkedIn, Facebook) get a likes bar that says so.
  const viewsData = platforms.map((p) => ({
    platform: hasViews(p) ? platformLabel[p] : `${platformLabel[p]} (likes)`,
    views: hasViews(p) ? totals(grouped[p]).views : totals(grouped[p]).likes,
  }));

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Numbered n={3}>
        <Section kicker="By platform"
          title="Engagement Rate" hint={engagementHint}>
          <BarChart
            data={engagementData}
            xKey="platform"
            yKey="rate"
            colorMap={PLATFORM_COLOR}
            shortLabels={PLATFORM_SHORT}
            yFormatter={(v) => fmtPct(v, 1)}
          />
        </Section>
      </Numbered>
      <Numbered n={4}>
        <Section kicker="By platform"
          title="Reach" hint={reachHint}>
          <BarChart
            data={viewsData}
            xKey="platform"
            yKey="views"
            colorMap={PLATFORM_COLOR}
            shortLabels={PLATFORM_SHORT}
            yFormatter={(v) => fmt(v)}
          />
        </Section>
      </Numbered>
    </div>
  );
}
