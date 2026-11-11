"use client";

import { useEffect, useState } from "react";
import { loadAnalytics, loadContentVault, loadFollowData } from "@/lib/data";
import type { AccountScope, AnalyticsBundle, ContentVault, FollowData } from "@/lib/types";
import { accountLabel, scopePlatforms } from "@/lib/derive";
import { useAccountScope } from "@/lib/account";
import { AccountSwitch } from "@/components/layout/account-switch";
import { platformLabel } from "@/lib/format";
import { Numbered } from "@/components/charts/numbered";
import { PostingHeatmap } from "./heatmap";
import { TopicsCard } from "./topics-card";
import { EngagementFunnel } from "./funnel";
import { ViralPosts } from "./viral-posts";
import { GrowthVelocity } from "./growth";
import { HashtagPerformance } from "./hashtags";
import { CrossPosts } from "./cross-posts";
import { Superfans } from "./superfans";
import { HookAnalysis } from "./hooks";
import { TopQuestions } from "./top-questions";
import { DoesntFollowBack } from "./follow-back";
import { HeroPanel, HeroRow, PageHero } from "@/components/layout/page-hero";
import { fmt, fmtDate, fmtShort } from "@/lib/format";

/** Everything one scope's Insights page draws, loaded together so the cards
 *  never mix two accounts while a switch is in flight. */
interface Loaded {
  scope: AccountScope;
  analytics: AnalyticsBundle;
  follow: FollowData;
  vault: ContentVault;
}

export function Insights() {
  const [scope] = useAccountScope();
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadAnalytics(scope), loadFollowData(), loadContentVault(scope)])
      .then(([analytics, follow, vault]) => {
        if (!cancelled) setLoaded({ scope, analytics, follow, vault });
      })
      .catch(() => {
        /* the loaders fall back to empty data; nothing to surface here */
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  // Until the first load lands there is nothing to draw. After that the page
  // keeps showing the previous scope for the instant a switch takes to load.
  if (!loaded) {
    return <PageHero eyebrow="Loading insights" title="Insights" controls={<AccountSwitch />} />;
  }

  const a = loaded.analytics;
  const vault = loaded.vault;
  const shown = loaded.scope;
  // Comments and follow lists were collected on the personal pages only.
  const hasComments = shown !== "brand";
  const follow = hasComments ? loaded.follow : null;
  const platforms = scopePlatforms(shown);

  const topHook = a.hookTypes
    ? [...a.hookTypes].sort((x, y) => y.avgViews - x.avgViews)[0]
    : null;
  const topHashtag = a.hashtagPerformance
    ? [...a.hashtagPerformance].sort((x, y) => y.avgViews - x.avgViews)[0]
    : null;
  const overlap = a.audienceOverlap;
  const overlapCount = Array.isArray(overlap?.crossPlatformUsers)
    ? overlap.crossPlatformUsers.length
    : 0;

  return (
    <>
      <PageHero
        eyebrow={`${accountLabel[shown]} · patterns · opportunities${
          a.generatedAt ? ` · computed ${fmtDate(a.generatedAt)}` : ""
        }`}
        controls={<AccountSwitch />}
        title="Insights"
        lede={
          hasComments
            ? shown === "all"
              ? "What the numbers say about what to make next, computed from every post on every page and the comment snapshot."
              : "What the numbers say about what to make next, computed from every post and the comment snapshot."
            : "What the Build With Phil pages' own numbers say about what to make next. Comments are not collected for these pages yet."
        }
        stats={[
          { label: "Viral posts", value: fmtShort(a.viralPosts?.length ?? 0), hint: "3× the platform average" },
          { label: "Cross-posts", value: fmtShort(a.crossPosts?.length ?? 0), hint: "same idea on 2+ platforms" },
          ...(hasComments
            ? [
                {
                  label: "Cross-platform fans",
                  value: fmtShort(overlapCount),
                  hint: overlap ? `of ${fmt(overlap.totalUniqueUsers)} unique commenters` : undefined,
                },
                {
                  label: "Audience questions",
                  value: fmtShort(a.questionCount ?? a.highValueComments?.length ?? 0),
                  hint: "in the comment snapshot, top 50 ranked below",
                },
              ]
            : [
                {
                  label: "Posts analyzed",
                  value: fmtShort(vault.totalPosts),
                  hint: platforms.map((p) => platformLabel[p]).join(", "),
                },
                {
                  label: "Topics covered",
                  value: fmtShort(vault.categories.length),
                  hint: "from the same topic list as every page",
                },
              ]),
        ]}
        aside={
          <HeroPanel label="Standouts">
            <ul className="mt-4 space-y-2.5">
              <HeroRow label="Best hook">
                <span className="font-medium capitalize">
                  {topHook?.type?.replace(/_/g, " ") ?? "none"}
                </span>
                <span className="tabular w-16 text-right font-mono text-[11px] text-white/55">
                  {topHook ? `${fmt(topHook.avgViews)} avg` : ""}
                </span>
              </HeroRow>
              <HeroRow label="Top hashtag">
                <span className="max-w-[160px] truncate font-medium">{topHashtag?.tag ?? "none"}</span>
                <span className="tabular w-16 text-right font-mono text-[11px] text-white/55">
                  {topHashtag ? `${fmt(topHashtag.avgViews)} avg` : ""}
                </span>
              </HeroRow>
              {hasComments ? (
                <HeroRow label="Comments through">
                  <span className="tabular font-medium">
                    {a.dataAsOf?.comments ? fmtDate(a.dataAsOf.comments) : "n/a"}
                  </span>
                </HeroRow>
              ) : (
                <HeroRow label="Posts through">
                  <span className="tabular font-medium">
                    {a.dataAsOf?.posts ? fmtDate(a.dataAsOf.posts) : "n/a"}
                  </span>
                </HeroRow>
              )}
            </ul>
          </HeroPanel>
        }
      />
      <div className="mx-auto max-w-[1500px] space-y-8 px-6 py-8">

      {/* Most actionable insights first: viral posts + hook library */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {a.viralPosts && (
          <Numbered n={1}>
            <ViralPosts posts={a.viralPosts} />
          </Numbered>
        )}
        {a.highValueComments && (
          <TopQuestions comments={a.highValueComments} asOf={a.dataAsOf?.comments} />
        )}
      </div>

      {a.hookTypes && a.topHooks && (
        <HookAnalysis hookTypes={a.hookTypes} topHooks={a.topHooks} />
      )}

      {/* Pattern analysis */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {a.hashtagPerformance && (
          <Numbered n={2}>
            <HashtagPerformance data={a.hashtagPerformance} />
          </Numbered>
        )}
        {a.crossPosts && (
          <Numbered n={3}>
            <CrossPosts data={a.crossPosts} />
          </Numbered>
        )}
      </div>

      {a.postingHeatmap && <PostingHeatmap data={a.postingHeatmap} />}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {vault && vault.categories.length > 0 && <TopicsCard vault={vault} />}
        {a.engagementFunnel && (
          <Numbered n={4}>
            <EngagementFunnel data={a.engagementFunnel} />
          </Numbered>
        )}
        {a.growthVelocity && (
          <Numbered n={5}>
            <GrowthVelocity data={a.growthVelocity} />
          </Numbered>
        )}
      </div>

      {a.topCommenters && (
        <Superfans
          commenters={a.topCommenters}
          overlap={a.audienceOverlap}
          asOf={a.dataAsOf?.comments}
        />
      )}

      {follow && <DoesntFollowBack data={follow} />}
      </div>
    </>
  );
}
