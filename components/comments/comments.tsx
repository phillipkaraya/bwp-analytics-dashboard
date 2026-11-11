"use client";

import { useEffect, useMemo, useState } from "react";
import { loadComments } from "@/lib/data";
import type { Comment, Platform } from "@/lib/types";
import { PLATFORMS, sentimentBreakdown } from "@/lib/derive";
import { fmt, fmtDate, fmtPct, fmtShort, platformLabel } from "@/lib/format";
import { StaleNote } from "@/components/layout/stale-note";
import { Section } from "@/components/charts/section";
import { PlatformBadge } from "@/components/charts/platform-badge";
import { HeroPanel, HeroRow, PageHero } from "@/components/layout/page-hero";
import { DoughnutChart } from "@/components/charts/doughnut-chart";
import { BarChart } from "@/components/charts/bar-chart";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type SentimentFilter = "all" | "positive" | "neutral" | "negative" | "question";
type SortKey = "newest" | "likes";

export function Comments() {
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [platform, setPlatform] = useState<Platform | "all">("all");
  const [sentiment, setSentiment] = useState<SentimentFilter>("all");
  const [sort, setSort] = useState<SortKey>("newest");
  const [search, setSearch] = useState("");

  useEffect(() => {
    loadComments().then((c) => {
      setComments(c);
      setLoading(false);
    });
  }, []);

  const enriched = useMemo(
    () =>
      comments.map((c) => ({
        ...c,
        sentiment: c.sentiment ?? ("neutral" as const),
      })),
    [comments],
  );

  const filtered = useMemo(() => {
    let out = enriched;
    if (platform !== "all") out = out.filter((c) => c.platform === platform);
    if (sentiment === "question") out = out.filter((c) => c.isQuestion);
    else if (sentiment !== "all") out = out.filter((c) => c.sentiment === sentiment);
    if (search.trim()) {
      const q = search.toLowerCase();
      out = out.filter(
        (c) =>
          c.text.toLowerCase().includes(q) ||
          c.username.toLowerCase().includes(q),
      );
    }
    return [...out].sort((a, b) => {
      if (sort === "likes") return b.likes - a.likes;
      return new Date(b.date).getTime() - new Date(a.date).getTime();
    });
  }, [enriched, platform, sentiment, sort, search]);

  // The "replied" flag in the snapshot is unreliable, so response rate and
  // replies sent are deliberately not shown anywhere on this tab.
  const stats = useMemo(
    () => ({
      total: comments.length,
      commenters: new Set(comments.map((c) => c.username.toLowerCase())).size,
      sentiment: sentimentBreakdown(enriched),
    }),
    [comments, enriched],
  );

  const sentimentData = [
    { name: "Positive", value: stats.sentiment.positive, color: "var(--positive)" },
    { name: "Neutral", value: stats.sentiment.neutral, color: "var(--ink-muted)" },
    { name: "Negative", value: stats.sentiment.negative, color: "var(--negative)" },
  ];
  const byModel = comments.filter((c) => c.sentimentSource === "llm").length;
  const byLexicon = comments.length - byModel;
  const labelHint =
    byModel === 0
      ? "Labeled by an emoji-aware lexicon"
      : byLexicon === 0
        ? "Labeled by a language model, emoji-aware lexicon as fallback"
        : `Labeled by a language model, ${fmt(byLexicon)} by the emoji-aware lexicon`;

  // Comments are a frozen snapshot until a scraper exists; label the newest date.
  const asOf = useMemo(
    () => comments.reduce<string>((m, c) => (c.date > m ? c.date : m), ""),
    [comments],
  );

  const volume = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of enriched) {
      const month = c.date.slice(0, 7);
      map.set(month, (map.get(month) ?? 0) + 1);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-18)
      .map(([month, count]) => ({ month, count }));
  }, [enriched]);

  if (loading) {
    return <PageHero eyebrow="Loading comments" title="Comments" />;
  }

  return (
    <>
      <PageHero
        // Comments were collected on the personal pages only, so this tab
        // does not follow the pages switch; it says whose comments these are.
        eyebrow={`Phillip Karaya pages · ${fmt(filtered.length)} of ${fmt(comments.length)} comments`}
        title="Comments"
        lede="What the audience said back, how it felt, and the questions worth answering."
        stats={[
          { label: "Total comments", value: fmtShort(stats.total), hint: "across all posts" },
          { label: "Questions", value: fmtShort(stats.sentiment.question), hint: "worth a reply" },
          {
            label: "Positive",
            value: fmtShort(stats.sentiment.positive),
            hint: fmtPct(stats.total ? (stats.sentiment.positive / stats.total) * 100 : 0, 0) + " of comments",
          },
          { label: "Commenters", value: fmtShort(stats.commenters), hint: "unique accounts" },
        ]}
        footer={
          <StaleNote
            tone="dark"
            date={asOf}
            label="Comments"
            detail="No comment scraper yet, so this tab is a snapshot."
          />
        }
        aside={
          <HeroPanel label="Sentiment">
            <ul className="mt-4 space-y-2.5">
              {(
                [
                  ["Positive", stats.sentiment.positive, "var(--positive)"],
                  ["Neutral", stats.sentiment.neutral, "rgb(255 255 255 / 0.45)"],
                  ["Negative", stats.sentiment.negative, "var(--negative)"],
                ] as const
              ).map(([name, n, color]) => (
                <HeroRow
                  key={name}
                  label={
                    <>
                      <span
                        aria-hidden
                        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full ring-2 ring-white/20"
                        style={{ background: color }}
                      />
                      <span>{name}</span>
                    </>
                  }
                >
                  <span className="tabular font-medium">{fmt(n)}</span>
                  <span className="tabular w-12 text-right font-mono text-[11px] text-white/55">
                    {fmtPct(stats.total ? (n / stats.total) * 100 : 0, 0)}
                  </span>
                </HeroRow>
              ))}
            </ul>
          </HeroPanel>
        }
      />
      <div className="mx-auto max-w-[1500px] space-y-8 px-6 py-8">

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section title="Comment Sentiment" hint={labelHint}>
          <DoughnutChart
            data={sentimentData}
            centerLabel="Comments"
            centerValue={fmt(stats.total)}
          />
        </Section>
        <Section title="Comment Volume" hint="Last 18 months">
          <BarChart
            data={volume}
            xKey="month"
            yKey="count"
            yFormatter={(v) => fmt(v)}
          />
        </Section>
      </div>

      <div className="flex flex-wrap items-end gap-3 card p-4">
        <Field label="Search">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Username or text"
            className="w-[260px]"
          />
        </Field>
        <Field label="Platform">
          <Select
            value={platform}
            onValueChange={(v) => setPlatform(v as Platform | "all")}
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All platforms</SelectItem>
              {PLATFORMS.map((p) => (
                <SelectItem key={p} value={p}>
                  {platformLabel[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Sentiment">
          <Select
            value={sentiment}
            onValueChange={(v) => setSentiment(v as SentimentFilter)}
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sentiment</SelectItem>
              <SelectItem value="positive">Positive</SelectItem>
              <SelectItem value="neutral">Neutral</SelectItem>
              <SelectItem value="negative">Negative</SelectItem>
              <SelectItem value="question">Question</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Sort">
          <Select
            value={sort}
            onValueChange={(v) => setSort(v as SortKey)}
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest</SelectItem>
              <SelectItem value="likes">Most likes</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>

      <Section
        title="Comments"
        bodyClassName="-mx-5 max-h-[640px] overflow-y-auto"
      >
        <table className="data-table tabular w-full text-sm">
          <thead className="sticky top-0 bg-card">
            <tr className="border-y border-border bg-muted/40 text-left">
              <Th>Platform</Th>
              <Th>User</Th>
              <Th>Sentiment</Th>
              <Th>Comment</Th>
              <Th align="right">Likes</Th>
              <Th>Date</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 300).map((c) => (
              <tr
                key={c.id}
                className="border-b border-border even:bg-muted/30 last:border-b-0 hover:bg-muted/40"
              >
                <td className="px-5 py-2">
                  <PlatformBadge platform={c.platform} />
                </td>
                <td className="px-2 py-2 text-ink">{c.username}</td>
                <td className="px-2 py-2">
                  <SentimentBadge sentiment={c.sentiment} question={c.isQuestion} />
                </td>
                <td className="px-2 py-2 max-w-[440px] truncate text-ink-soft">
                  {c.text}
                </td>
                <td className="px-2 py-2 text-right text-ink-soft">
                  {c.likes}
                </td>
                <td className="px-5 py-2 text-ink-muted">
                  {fmtDate(c.date)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length > 300 && (
          <div className="border-t border-border px-5 py-2 text-center text-[11px] text-ink-muted">
            Showing 300 of {fmt(filtered.length)} comments.
          </div>
        )}
      </Section>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
        {label}
      </label>
      {children}
    </div>
  );
}

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className="px-2 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted first:pl-5 last:pr-5"
      style={{ textAlign: align }}
    >
      {children}
    </th>
  );
}

function SentimentBadge({
  sentiment,
  question,
}: {
  sentiment: "positive" | "neutral" | "negative";
  question?: boolean;
}) {
  const map = {
    positive: "bg-positive-soft text-positive",
    neutral: "bg-muted text-ink-muted",
    negative: "bg-negative-soft text-negative",
  };
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className={`inline-block rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${map[sentiment]}`}
      >
        {sentiment}
      </span>
      {question && (
        <span
          title="Asks Phil a question"
          className="inline-block rounded bg-brand-soft px-1.5 py-0.5 font-mono text-[10px] font-semibold text-brand-deep"
        >
          ?
        </span>
      )}
    </span>
  );
}
