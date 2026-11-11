"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { loadAllPosts, loadContentVault } from "@/lib/data";
import { useAccountScope } from "@/lib/account";
import { AccountSwitch } from "@/components/layout/account-switch";
import type { ContentVault, Platform, Post, VaultCategory } from "@/lib/types";
import { PLATFORMS, accountLabel, postHasViews, toNum } from "@/lib/derive";
import { fmt, fmtDate, fmtShort, platformLabel, platformShort } from "@/lib/format";
import { cn } from "@/lib/utils";
import { HeroPanel, PageHero } from "@/components/layout/page-hero";
import { PlatformBadge } from "@/components/charts/platform-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type SortKey = "views" | "likes" | "date";
const PAGE = 96;

export function Vault() {
  // Deep links from the Overview ribbon and the Insights topics card arrive
  // as /vault/?topic=<slug>. Read once for the initial chip.
  const params = useSearchParams();
  const [vault, setVault] = useState<ContentVault | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [slug, setSlug] = useState<string>(() => params.get("topic") || "all");
  const [platform, setPlatform] = useState<Platform | "all">("all");
  const [sort, setSort] = useState<SortKey>("views");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [copied, setCopied] = useState<number | null>(null);
  const [linkSheet, setLinkSheet] = useState<string | null>(null);

  const [scope] = useAccountScope();

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadContentVault(scope), loadAllPosts(scope)])
      .then(([v, p]) => {
        if (cancelled) return;
        setVault(v);
        setPosts(p);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  const byId = useMemo(() => {
    const m = new Map<string, Post>();
    for (const p of posts) m.set(p.id, p);
    return m;
  }, [posts]);

  const labelOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of vault?.categories ?? []) m.set(c.slug, c.label);
    return m;
  }, [vault]);

  const selected: VaultCategory | null = useMemo(
    () => vault?.categories.find((c) => c.slug === slug) ?? null,
    [vault, slug],
  );

  const filtered = useMemo(() => {
    let out: Post[] =
      slug === "all" || !selected
        ? posts
        : selected.postIds.map((id) => byId.get(id)).filter((p): p is Post => !!p);
    if (platform !== "all") out = out.filter((p) => p.platform === platform);
    if (search.trim()) {
      const q = search.toLowerCase();
      out = out.filter(
        (p) =>
          (p.title?.toLowerCase().includes(q) ?? false) ||
          (p.caption?.toLowerCase().includes(q) ?? false) ||
          (p.hashtags?.toLowerCase().includes(q) ?? false),
      );
    }
    return [...out].sort((a, b) => {
      if (sort === "date")
        return (b.date || "").localeCompare(a.date || "");
      return toNum(b[sort]) - toNum(a[sort]);
    });
  }, [posts, selected, slug, byId, platform, search, sort]);

  const linkable = useMemo(
    () => filtered.filter((p) => !!p.url),
    [filtered],
  );

  const multiTopic = useMemo(
    () =>
      Object.values(vault?.byPost ?? {}).filter((c) => c.length > 1).length,
    [vault],
  );
  const uncategorized =
    vault?.categories.find((c) => c.slug === "other")?.count ?? 0;

  async function copyLinks() {
    const text = linkable.map((p) => p.url).join("\n");
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // Clipboard API blocked (insecure context / permissions). Try the
      // legacy path, which only needs a user gesture.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      document.body.removeChild(ta);
    }
    if (ok) {
      setCopied(linkable.length);
      setTimeout(() => setCopied(null), 2200);
    } else {
      setLinkSheet(text);
    }
  }

  function pick(next: string) {
    setSlug(next);
    setLimit(PAGE);
  }

  if (loading || !vault) {
    return (
      <PageHero
        eyebrow="Loading vault"
        controls={<AccountSwitch />}
        title={
          <>
            Content <span className="italic">Vault</span>
          </>
        }
      />
    );
  }

  const visible = filtered.slice(0, limit);
  const topics = vault.categories.filter((c) => c.slug !== "other");
  const mostReach = [...topics].sort((a, b) => b.totalViews - a.totalViews).slice(0, 4);

  return (
    <>
      <PageHero
        eyebrow={`${accountLabel[scope]} · ${fmt(vault.totalPosts)} posts · ${topics.length} topics${
          vault.generatedAt ? ` · filed ${fmtDate(vault.generatedAt)}` : ""
        }`}
        controls={<AccountSwitch />}
        title={
          <>
            Content <span className="italic">Vault</span>
          </>
        }
        lede="Every post, filed by topic from its caption and hashtags. Pick a topic, narrow by platform, then copy the links or open any post at the source."
        stats={[
          { label: "Topics", value: fmtShort(topics.length), hint: "from scrape/categories.json" },
          {
            label: "Posts filed",
            value: fmtShort(vault.totalPosts - uncategorized),
            hint: `of ${fmt(vault.totalPosts)}`,
          },
          { label: "Multi-topic", value: fmtShort(multiTopic), hint: "posts in 2+ topics" },
          { label: "Unfiled", value: fmtShort(uncategorized), hint: "add keywords to file them" },
        ]}
        aside={
          <HeroPanel label="Most reach">
            <ul className="mt-4 space-y-1">
              {mostReach.map((c) => (
                <li key={c.slug}>
                  <button
                    type="button"
                    onClick={() => pick(c.slug)}
                    aria-pressed={slug === c.slug}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left text-sm transition",
                      slug === c.slug ? "bg-white text-ink" : "text-white/85 hover:bg-white/10",
                    )}
                  >
                    <span className="font-medium">{c.label}</span>
                    <span
                      className={cn(
                        "tabular font-mono text-[11px]",
                        slug === c.slug ? "text-ink-muted" : "text-white/55",
                      )}
                    >
                      {fmt(c.count)} · {fmt(c.totalViews)} views
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </HeroPanel>
        }
      />
      <div className="mx-auto max-w-[1500px] space-y-8 px-6 py-8">

      {/* Topic rail */}
      <nav aria-label="Topics" className="flex flex-wrap gap-2">
        <Chip
          active={slug === "all"}
          label="All"
          count={vault.totalPosts}
          onClick={() => pick("all")}
        />
        {vault.categories.map((c) => (
          <Chip
            key={c.slug}
            active={slug === c.slug}
            label={c.label}
            count={c.count}
            views={c.totalViews}
            muted={c.slug === "other"}
            onClick={() => pick(c.slug)}
          />
        ))}
      </nav>

      {/* Toolbar */}
      <div className="flex flex-wrap items-end gap-3 card p-4">
        <Field label="Search">
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setLimit(PAGE);
            }}
            placeholder="Caption, title, or hashtag"
            className="w-[240px]"
          />
        </Field>
        <Field label="Platform">
          <Select
            value={platform}
            onValueChange={(v) => {
              setPlatform(v as Platform | "all");
              setLimit(PAGE);
            }}
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
        <Field label="Sort by">
          <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
            <SelectTrigger className="w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="views">Views</SelectItem>
              <SelectItem value="likes">Likes</SelectItem>
              <SelectItem value="date">Date (newest)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <div className="ml-auto flex items-end gap-3">
          <p className="pb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-muted">
            {fmt(filtered.length)} {slug === "all" ? "posts" : selected?.label}
            {platform !== "all" && ` on ${platformLabel[platform]}`}
          </p>
          <Button
            variant="outline"
            onClick={copyLinks}
            disabled={linkable.length === 0}
            className="font-mono text-[11px] uppercase tracking-[0.14em]"
          >
            {copied !== null
              ? `Copied ${fmt(copied)} links`
              : `Copy ${fmt(linkable.length)} links`}
          </Button>
        </div>
      </div>

      {/* Cards */}
      {visible.length === 0 ? (
        <div className="rounded-lg bg-card/50 p-12 text-center outline-dashed outline-1 -outline-offset-1 outline-border">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-ink-muted">
            Nothing here
          </p>
          <p className="mt-2 text-sm text-ink-soft">
            No posts match this topic, platform, and search combination.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visible.map((p) => (
            <PostCard
              key={p.id}
              post={p}
              tags={vault.byPost[p.id] ?? []}
              labelOf={labelOf}
              activeSlug={slug}
              onTag={pick}
            />
          ))}
        </div>
      )}

      {filtered.length > visible.length && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={() => setLimit((l) => l + PAGE)}
            className="font-mono text-[11px] uppercase tracking-[0.14em]"
          >
            Show {fmt(Math.min(PAGE, filtered.length - visible.length))} more
            · {fmt(filtered.length - visible.length)} left
          </Button>
        </div>
      )}

      {/* Shown only when the clipboard is unavailable: links stay reachable. */}
      <Dialog open={linkSheet !== null} onOpenChange={(v) => !v && setLinkSheet(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-display text-xl leading-tight">
              Links for this view
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-ink-soft">
            The clipboard was blocked by the browser. Select all and copy.
          </p>
          <textarea
            readOnly
            value={linkSheet ?? ""}
            onFocus={(e) => e.currentTarget.select()}
            className="h-64 w-full rounded-md border border-border bg-muted/40 p-3 font-mono text-xs text-ink"
          />
        </DialogContent>
      </Dialog>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function Chip({
  active,
  label,
  count,
  views,
  muted,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  views?: number;
  muted?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        // Same surface language as the cards: no hairline border, soft shadow,
        // brand fill when selected. "Other" stays deliberately quieter.
        "group inline-flex items-baseline gap-2 rounded-lg px-3 py-2 text-sm transition",
        active
          ? "bg-brand text-white shadow-[0_8px_22px_-10px_rgb(30_111_217/0.65)] ring-1 ring-brand"
          : muted
            ? "bg-card/50 text-ink-muted outline-dashed outline-1 -outline-offset-1 outline-border hover:text-ink hover:outline-brand/40"
            : "card card-hover text-ink hover:text-brand-deep",
      )}
    >
      <span className="font-medium">{label}</span>
      <span
        className={cn(
          "tabular font-mono text-[11px]",
          active ? "text-white/80" : "text-ink-muted",
        )}
      >
        {fmt(count)}
        {views !== undefined && views > 0 && (
          // Phones drop the reach suffix so chips pack two or three per row
          // instead of stacking one per line for 15 rows.
          <span className={cn("hidden sm:inline", active ? "text-white/60" : "text-ink-muted/70")}>
            {" "}
            · {fmt(views)} views
          </span>
        )}
      </span>
    </button>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
        {label}
      </label>
      {children}
    </div>
  );
}

const PLATFORM_TINT: Record<Platform, string> = {
  instagram: "color-mix(in oklab, var(--ig) 14%, white)",
  tiktok: "color-mix(in oklab, var(--tt) 8%, white)",
  youtube: "color-mix(in oklab, var(--yt) 12%, white)",
  threads: "color-mix(in oklab, var(--th) 8%, white)",
  linkedin: "color-mix(in oklab, var(--li) 12%, white)",
};

function youtubeThumb(post: Post): string | null {
  if (post.platform !== "youtube") return null;
  const id = post.id.startsWith("yt_") ? post.id.slice(3) : "";
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}

function PostCard({
  post,
  tags,
  labelOf,
  activeSlug,
  onTag,
}: {
  post: Post;
  tags: string[];
  labelOf: Map<string, string>;
  activeSlug: string;
  onTag: (slug: string) => void;
}) {
  const title = post.title || post.caption?.split("\n")[0] || "(no caption)";
  const thumb = youtubeThumb(post);
  return (
    <article className="group flex flex-col overflow-hidden card shadow-sm transition hover:border-brand/40">
      <div
        className="relative aspect-video w-full overflow-hidden"
        style={{ background: PLATFORM_TINT[post.platform] }}
      >
        {thumb ? (
          // YouTube thumbnails are stable public URLs; the other platforms'
          // CDN links expire, so those cards use a tinted block instead.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumb}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full flex-col justify-between p-3">
            <span
              className="font-display text-4xl font-medium leading-none"
              style={{ color: `var(--${platformShort[post.platform].toLowerCase()})` }}
            >
              {platformShort[post.platform]}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
              {post.type || "post"}
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <PlatformBadge platform={post.platform} />
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">
            {post.date ? fmtDate(post.date) : "undated"}
          </span>
        </div>

        <p className="line-clamp-2 min-h-[2.5rem] text-sm font-medium leading-snug text-ink">
          {title}
        </p>

        <dl className="tabular grid grid-cols-3 gap-2 font-mono text-[11px]">
          {postHasViews(post) ? (
            <Stat label="Views" value={fmt(post.views)} emphasis />
          ) : (
            <Stat label="Likes as reach" value={fmt(post.likes)} emphasis />
          )}
          <Stat label="Likes" value={fmt(post.likes)} />
          <Stat label="Cmts" value={fmt(post.comments)} />
        </dl>

        <div className="mt-auto flex items-end justify-between gap-2 pt-1">
          <div className="flex flex-wrap gap-1">
            {tags.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => onTag(t)}
                className={cn(
                  "rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors",
                  t === activeSlug
                    ? "border-brand bg-brand-soft text-brand"
                    : "border-border text-ink-muted hover:border-brand/40 hover:text-brand",
                )}
              >
                {labelOf.get(t) ?? t}
              </button>
            ))}
          </div>
          {post.url && (
            <a
              href={post.url}
              target="_blank"
              rel="noreferrer noopener"
              className="shrink-0 font-mono text-[11px] uppercase tracking-[0.14em] text-brand hover:underline"
            >
              Open ↗
            </a>
          )}
        </div>
      </div>
    </article>
  );
}

function Stat({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div>
      <dt className="text-[9px] uppercase tracking-[0.14em] text-ink-muted">
        {label}
      </dt>
      <dd className={cn("mt-0.5 text-sm", emphasis ? "text-brand" : "text-ink")}>
        {value}
      </dd>
    </div>
  );
}
