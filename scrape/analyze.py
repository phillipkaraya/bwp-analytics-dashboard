#!/usr/bin/env python3
"""
Rebuild the derived JSON the dashboard reads, from the raw scraped posts.

    python3 scrape/analyze.py          (or: python3 scrape/run.py --analyze-only)

Inputs  (public/data/):  instagram_posts.json, tiktok_posts.json,
                         youtube_posts.json, threads_posts.json,
                         linkedin_posts.json, comments.json, scrape_state.json
Outputs (public/data/):  analytics.json        -> Insights tab (lib/types.ts AnalyticsBundle)
                         content_vault.json    -> Content Vault tab
                         follower_history.json -> follower growth series (appended, never rewritten)

Topic classification uses scrape/categories.json (editable, whole-word
keyword match, multi-label). Comment sentiment is labeled here too, by
scrape/sentiment.py (Groq model when GROQ_API_KEY is in the environment,
emoji-aware lexicon otherwise) and written back into comments.json, which is
the label cache. Stdlib only; sub-second without the model.

History: the original analytics.json was produced once by the v1 dashboard's
JavaScript on 2026-03-28 and the generator was lost. This module replaces it
so Insights refresh every time the scrapers run.
"""

from __future__ import annotations

import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:  # `python3 scrape/analyze.py` as well as `from scrape import analyze`
    sys.path.insert(0, str(ROOT))
from scrape.sentiment import classify_comments  # noqa: E402
DATA_DIR = ROOT / "public" / "data"
CATEGORIES_FILE = Path(__file__).resolve().parent / "categories.json"

PLATFORMS = ["instagram", "tiktok", "youtube", "threads", "linkedin"]
POST_FILES = {p: DATA_DIR / f"{p}_posts.json" for p in PLATFORMS}
COMMENTS_FILE = DATA_DIR / "comments.json"
SCRAPE_STATE_FILE = DATA_DIR / "scrape_state.json"
ANALYTICS_FILE = DATA_DIR / "analytics.json"
VAULT_FILE = DATA_DIR / "content_vault.json"
HISTORY_FILE = DATA_DIR / "follower_history.json"

VIRAL_MULTIPLIER = 3.0
MIN_HASHTAG_USES = 3
MIN_HEATMAP_COUNT = 3


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------
def _load_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return fallback


def _num(v: Any) -> float:
    if v is None or v == "":
        return 0.0
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _avg(values: Iterable[float]) -> float:
    vals = list(values)
    return sum(vals) / len(vals) if vals else 0.0


def _r(v: float, nd: int = 2) -> float:
    return round(v, nd)


# The TikTok and YouTube readers collect views only (scrape/platforms/tiktok.py
# and youtube.py write likes, comments and shares as 0), so a post from them
# with all three at 0 carries no engagement measurement and its "0.00" rate must
# not be averaged. A post from them with any of the three filled was measured
# (older data backfilled from v1) and counts. Mirrors engagementMeasured() in
# lib/derive.ts. Remove a platform here once its reader collects likes.
VIEWS_ONLY_READERS = {"tiktok", "youtube"}


def _has_engagement(p: dict) -> bool:
    if p.get("platform") not in VIEWS_ONLY_READERS:
        return True
    if p.get("engagementMeasured"):  # stamped by scrape/platforms/studio.py
        return True
    return _num(p.get("likes")) > 0 or _num(p.get("comments")) > 0 or _num(p.get("shares")) > 0


def _avg_eng(posts: Iterable[dict]) -> float:
    return _avg(_num(p.get("engagementRate")) for p in posts if _has_engagement(p))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _title(p: dict) -> str:
    t = (p.get("title") or "").strip()
    if not t:
        t = (p.get("caption") or "").strip().split("\n", 1)[0]
    return t[:160]


# --------------------------------------------------------------------------
# topic classification
# --------------------------------------------------------------------------
class Classifier:
    def __init__(self, spec: dict):
        self.labels: dict[str, str] = {}
        self.patterns: dict[str, re.Pattern] = {}
        for slug, cfg in spec.items():
            if slug.startswith("_") or not isinstance(cfg, dict):
                continue
            self.labels[slug] = cfg.get("label") or slug.replace("_", " ").title()
            kws = [k.strip().lower() for k in cfg.get("keywords") or [] if k and k.strip()]
            if kws:
                alts = "|".join(re.escape(k) for k in sorted(kws, key=len, reverse=True))
                self.patterns[slug] = re.compile(rf"(?<![a-z0-9])(?:{alts})(?![a-z0-9])")
        self.labels.setdefault("other", "Other")

    def classify(self, post: dict) -> list[str]:
        text = " ".join(
            [post.get("title") or "", post.get("caption") or "", post.get("hashtags") or ""]
        ).lower().replace("#", " ")
        hits = [slug for slug, pat in self.patterns.items() if pat.search(text)]
        return hits or ["other"]


# --------------------------------------------------------------------------
# hooks
# --------------------------------------------------------------------------
_QUESTION_START = re.compile(r"^(what|why|how|who|when|where|which|do you|did you|would you|could you|can you|is it|are you|have you|should)\b", re.I)
_LISTICLE = re.compile(r"\b(\d+|three|five|seven|ten)\s+(things|ways|tips|reasons|mistakes|steps|rules|habits|lessons|signs)\b", re.I)
_STATISTIC = re.compile(r"(\$\s?\d|\d+(\.\d+)?\s?(%|percent|k\b|m\b|million|billion|thousand))", re.I)
_CONTROVERSY = re.compile(r"\b(unpopular opinion|nobody|stop|never|don'?t|wrong|truth|lie|lies|scam|hate|controversial|hot take|overrated|myth)\b", re.I)
_CHALLENGE = re.compile(r"\b(challenge|try this|bet you|dare|can you)\b", re.I)
_STORY = re.compile(r"\b(story ?time|when i|i remember|years ago|the time i|back when|my first|true story|so i)\b", re.I)
_EMOTIONAL = re.compile(r"\b(love|proud|grateful|blessed|cry|cried|tears|heart|miss|thank you|rip|emotional|dream come true)\b", re.I)


def hook_type(hook: str) -> str:
    h = hook.strip()
    if not h:
        return "other"
    if "?" in h or _QUESTION_START.search(h):
        return "question"
    if _LISTICLE.search(h):
        return "listicle"
    if _STATISTIC.search(h):
        return "statistic"
    if _CONTROVERSY.search(h):
        return "controversy"
    if _CHALLENGE.search(h):
        return "challenge"
    if _STORY.search(h):
        return "story"
    if _EMOTIONAL.search(h):
        return "emotional"
    return "other"


# --------------------------------------------------------------------------
# sections
# --------------------------------------------------------------------------
def posting_heatmap(posts: list[dict]) -> tuple[list[list[dict]], list[dict]]:
    grid = [[{"count": 0, "_eng": 0.0, "_eng_n": 0, "_views": 0.0} for _ in range(24)] for _ in range(7)]
    for p in posts:
        d, t = p.get("date"), p.get("time")
        if not d or not t:
            continue
        try:
            day = (datetime.strptime(d, "%Y-%m-%d").weekday() + 1) % 7  # Sunday = 0
            hour = int(str(t)[:2])
        except (ValueError, TypeError):
            continue
        if not 0 <= hour < 24:
            continue
        cell = grid[day][hour]
        cell["count"] += 1
        if _has_engagement(p):
            cell["_eng"] += _num(p.get("engagementRate"))
            cell["_eng_n"] += 1
        cell["_views"] += _num(p.get("views"))
    out: list[list[dict]] = []
    best: list[dict] = []
    for day in range(7):
        row = []
        for hour in range(24):
            c = grid[day][hour]
            n = c["count"]
            cell = {
                "count": n,
                "avgEngagement": _r(c["_eng"] / c["_eng_n"]) if c["_eng_n"] else 0,
                "avgViews": int(c["_views"] / n) if n else 0,
            }
            row.append(cell)
            if n >= MIN_HEATMAP_COUNT:
                best.append({"day": day, "hour": hour, **cell})
        out.append(row)
    best.sort(key=lambda b: b["avgViews"], reverse=True)
    return out, best[:20]


def platform_averages(posts: list[dict]) -> dict:
    out = {}
    for plat in PLATFORMS:
        ps = [p for p in posts if p.get("platform") == plat]
        viewed = [p for p in ps if _num(p.get("views")) > 0]
        out[plat] = {
            "avgViews": int(_avg(_num(p["views"]) for p in viewed)),
            "avgLikes": int(_avg(_num(p.get("likes")) for p in ps)),
            "avgComments": int(_avg(_num(p.get("comments")) for p in ps)),
            "avgEngagement": _r(_avg_eng(viewed)),
            "posts": len(ps),
        }
    return out


def viral_posts(posts: list[dict], averages: dict, cats: dict[str, list[str]]) -> list[dict]:
    out = []
    for p in posts:
        avg = averages.get(p.get("platform"), {}).get("avgViews") or 0
        views = _num(p.get("views"))
        if avg <= 0 or views < VIRAL_MULTIPLIER * avg:
            continue
        out.append({
            "id": p["id"],
            "title": _title(p),
            "platform": p["platform"],
            "views": int(views),
            "likes": int(_num(p.get("likes"))),
            "comments": int(_num(p.get("comments"))),
            "engagementRate": str(p.get("engagementRate") or "0.00"),
            "viralityScore": _r(views / avg),
            "multiplier": _r(views / avg),
            "avgViewsForPlatform": int(avg),
            "date": p.get("date") or "",
            "categories": cats.get(p["id"], ["other"]),
            "url": p.get("url") or "",
        })
    out.sort(key=lambda v: v["viralityScore"], reverse=True)
    return out[:50]


def content_categories(posts: list[dict], cats: dict[str, list[str]]) -> dict:
    buckets: dict[str, list[dict]] = defaultdict(list)
    for p in posts:
        for slug in cats.get(p["id"], ["other"]):
            buckets[slug].append(p)
    out = {}
    for slug, ps in buckets.items():
        viewed = [p for p in ps if _num(p.get("views")) > 0]
        out[slug] = {
            "count": len(ps),
            "avgViews": int(_avg(_num(p["views"]) for p in viewed)),
            "avgLikes": int(_avg(_num(p.get("likes")) for p in ps)),
            "avgEngagement": _r(_avg_eng(viewed)),
            "totalViews": int(sum(_num(p.get("views")) for p in ps)),
        }
    return dict(sorted(out.items(), key=lambda kv: kv[1]["count"], reverse=True))


def engagement_funnel(posts: list[dict]) -> dict:
    out = {}
    for plat in PLATFORMS:
        ps = [p for p in posts if p.get("platform") == plat]
        views = sum(_num(p.get("views")) for p in ps)
        likes = sum(_num(p.get("likes")) for p in ps)
        comments = sum(_num(p.get("comments")) for p in ps)
        shares = sum(_num(p.get("shares")) for p in ps)
        out[plat] = {
            "views": int(views),
            "likes": int(likes),
            "comments": int(comments),
            "shares": int(shares),
            "likeRate": _r(likes / views * 100) if views else 0,
            "commentRate": _r(comments / views * 100) if views else 0,
            "shareRate": _r(shares / views * 100) if views else 0,
        }
    return out


def growth_velocity(posts: list[dict]) -> list[dict]:
    months: dict[str, dict] = defaultdict(lambda: {"posts": 0, "views": 0, "likes": 0, "comments": 0})
    for p in posts:
        d = p.get("date") or ""
        if len(d) < 7:
            continue
        m = months[d[:7]]
        m["posts"] += 1
        m["views"] += int(_num(p.get("views")))
        m["likes"] += int(_num(p.get("likes")))
        m["comments"] += int(_num(p.get("comments")))
    return [{"month": k, **v} for k, v in sorted(months.items())]


def hashtag_performance(posts: list[dict]) -> list[dict]:
    tags: dict[str, list[dict]] = defaultdict(list)
    for p in posts:
        seen = set()
        for tok in (p.get("hashtags") or "").split():
            tag = tok.lower().strip(".,!")
            if tag.startswith("#") and len(tag) > 1 and tag not in seen:
                seen.add(tag)
                tags[tag].append(p)
    out = []
    for tag, ps in tags.items():
        if len(ps) < MIN_HASHTAG_USES:
            continue
        viewed = [p for p in ps if _num(p.get("views")) > 0]
        out.append({
            "tag": tag,
            "count": len(ps),
            "avgViews": int(_avg(_num(p["views"]) for p in viewed)),
            "avgLikes": int(_avg(_num(p.get("likes")) for p in ps)),
            "avgEngagement": _r(_avg_eng(viewed)),
            "totalViews": int(sum(_num(p.get("views")) for p in ps)),
        })
    out.sort(key=lambda h: h["avgViews"], reverse=True)
    return out[:50]


_NORM = re.compile(r"[^a-z0-9 ]+")


def _norm_title(p: dict) -> str:
    t = _NORM.sub(" ", _title(p).lower())
    t = re.sub(r"\s+", " ", t).strip()
    return t[:60]


def cross_posts(posts: list[dict]) -> list[dict]:
    groups: dict[str, list[dict]] = defaultdict(list)
    for p in posts:
        key = _norm_title(p)
        if len(key) >= 15:
            groups[key].append(p)
    out = []
    for key, ps in groups.items():
        plats = sorted({p["platform"] for p in ps})
        if len(plats) < 2:
            continue
        items = sorted(
            (
                {
                    "id": p["id"],
                    "platform": p["platform"],
                    "views": int(_num(p.get("views"))),
                    "likes": int(_num(p.get("likes"))),
                    "date": p.get("date") or "",
                    "url": p.get("url") or "",
                }
                for p in ps
            ),
            key=lambda x: x["views"],
            reverse=True,
        )
        out.append({
            "title": _title(ps[0]),
            "platforms": plats,
            "posts": items,
            "bestPlatform": items[0]["platform"],
            "viewDiff": items[0]["views"] - items[-1]["views"],
        })
    out.sort(key=lambda c: c["viewDiff"], reverse=True)
    return out


def hooks(posts: list[dict], cats: dict[str, list[str]]) -> tuple[list[dict], list[dict]]:
    with_hook = [p for p in posts if _title(p)]
    top = sorted(with_hook, key=lambda p: _num(p.get("views")), reverse=True)[:50]
    top_hooks = [
        {
            "hook": _title(p),
            "postId": p["id"],
            "platform": p["platform"],
            "views": int(_num(p.get("views"))),
            "likes": int(_num(p.get("likes"))),
            "engagement": _num(p.get("engagementRate")),
            "engagementRate": str(p.get("engagementRate") or "0.00"),
            "categories": cats.get(p["id"], ["other"]),
            "url": p.get("url") or "",
        }
        for p in top
    ]
    by_type: dict[str, list[dict]] = defaultdict(list)
    for p in with_hook:
        by_type[hook_type(_title(p))].append(p)
    types = []
    for t, ps in by_type.items():
        viewed = [p for p in ps if _num(p.get("views")) > 0]
        best = max(ps, key=lambda p: _num(p.get("views")))
        types.append({
            "type": t,
            "count": len(ps),
            "avgViews": int(_avg(_num(p["views"]) for p in viewed)),
            "avgLikes": int(_avg(_num(p.get("likes")) for p in ps)),
            "avgEngagement": _r(_avg_eng(viewed)),
            "totalViews": int(sum(_num(p.get("views")) for p in ps)),
            "topPost": _title(best),
        })
    types.sort(key=lambda t: t["count"], reverse=True)
    return top_hooks, types


def comment_sections(comments: list[dict], posts_by_id: dict[str, dict]) -> dict:
    by_user: dict[str, list[dict]] = defaultdict(list)
    for c in comments:
        u = (c.get("username") or "").strip()
        if u:
            by_user[u.lower()].append(c)

    top_commenters = sorted(
        (
            {
                "username": cs[0]["username"],
                "count": len(cs),
                "platforms": sorted({c["platform"] for c in cs}),
            }
            for cs in by_user.values()
        ),
        key=lambda x: x["count"],
        reverse=True,
    )[:30]

    cross = sorted(
        (
            {
                "username": cs[0]["username"],
                "platforms": sorted({c["platform"] for c in cs}),
                "commentCount": len(cs),
                "totalLikes": int(sum(_num(c.get("likes")) for c in cs)),
            }
            for cs in by_user.values()
            if len({c["platform"] for c in cs}) >= 2
        ),
        key=lambda x: x["commentCount"],
        reverse=True,
    )
    breakdown = {
        plat: len({(c.get("username") or "").lower() for c in comments if c.get("platform") == plat and c.get("username")})
        for plat in PLATFORMS
    }
    overlap = {
        "crossPlatformUsers": cross,
        "totalUniqueUsers": len(by_user),
        "platformBreakdown": breakdown,
    }

    def hv(c: dict) -> dict:
        post = posts_by_id.get(c.get("postId") or "", {})
        return {
            "id": c["id"],
            "postId": c.get("postId"),
            "platform": c["platform"],
            "username": c.get("username") or "",
            "text": c.get("text") or "",
            "sentiment": c.get("sentiment"),
            "isQuestion": bool(c.get("isQuestion")),
            "likes": int(_num(c.get("likes"))),
            "date": c.get("date") or "",
            "postUrl": post.get("url") or "",
            "postTitle": _title(post) if post else "",
        }

    # The snapshot's reply flag is unreliable (Phil, 2026-09-04), so nothing
    # derived here uses it: no response rate, no "unreplied" filter. Questions
    # are simply ranked by likes. A question can also be positive or negative;
    # the flag is separate from sentiment since 2026-09-05.
    questions = [c for c in comments if c.get("isQuestion")]
    questions.sort(key=lambda c: _num(c.get("likes")), reverse=True)
    high_value = [hv(c) for c in questions[:50]]

    newest = max((c.get("date") or "" for c in comments), default="")
    return {
        "topCommenters": top_commenters,
        "audienceOverlap": overlap,
        "highValueComments": high_value,
        "questionCount": len(questions),
        "commentSentiment": dict(Counter(c.get("sentiment") or "neutral" for c in comments)),
        "sentimentSources": dict(Counter(c.get("sentimentSource") or "none" for c in comments)),
        "_commentsAsOf": newest,
    }


def last_posted_and_cadence(posts: list[dict]) -> tuple[dict, dict]:
    today = date.today()
    last: dict = {}
    cadence: dict = {}
    for plat in PLATFORMS:
        dated = sorted(
            (p for p in posts if p.get("platform") == plat and p.get("date")),
            key=lambda p: p["date"],
        )
        if not dated:
            continue
        newest = dated[-1]
        try:
            nd = datetime.strptime(newest["date"], "%Y-%m-%d").date()
            days_since = (today - nd).days
        except ValueError:
            days_since = None
        last[plat] = {
            "lastDate": newest["date"],
            "daysSince": days_since,
            "lastTitle": _title(newest),
            "lastId": newest["id"],
            "totalPosts": len([p for p in posts if p.get("platform") == plat]),
        }
        days = []
        for a, b in zip(dated, dated[1:]):
            try:
                da = datetime.strptime(a["date"], "%Y-%m-%d")
                db = datetime.strptime(b["date"], "%Y-%m-%d")
                days.append((db - da).days)
            except ValueError:
                continue
        avg_gap = _avg(days)
        cadence[plat] = {
            "avgDaysBetween": _r(avg_gap, 1),
            "postsPerWeek": _r(7 / avg_gap, 1) if avg_gap else 0,
            "postsPerMonth": _r(30 / avg_gap, 1) if avg_gap else 0,
            "longestGap": max(days) if days else 0,
            "totalPosts": len(dated),
        }
    return last, cadence


# --------------------------------------------------------------------------
# follower history
# --------------------------------------------------------------------------
def update_follower_history(state: dict, seed: list[dict] | None) -> list[dict]:
    """Append today's follower counts, but only when a scrape actually ran
    today. Re-running the analyzer on old data must not invent data points."""
    history = _load_json(HISTORY_FILE, None)
    if not isinstance(history, list):
        history = list(seed or [])
    followers = state.get("followers") or {}
    today = date.today().isoformat()
    updated = state.get("followersUpdated") or {}
    fresh_today = any(str(updated.get(p) or "").startswith(today) for p in PLATFORMS)
    if fresh_today and any(int(_num(followers.get(p))) > 0 for p in PLATFORMS):
        snap = {"date": today, **{p: int(_num(followers.get(p))) for p in PLATFORMS}}
        history = [h for h in history if h.get("date") != today] + [snap]
    history.sort(key=lambda h: h.get("date", ""))
    HISTORY_FILE.write_text(json.dumps(history, indent=2))
    return history


# --------------------------------------------------------------------------
def run(verbose: bool = False) -> dict:
    posts: list[dict] = []
    for plat, path in POST_FILES.items():
        raw = _load_json(path, [])
        if isinstance(raw, list):
            for p in raw:
                if isinstance(p, dict) and p.get("id"):
                    p.setdefault("platform", plat)
                    posts.append(p)
    comments = [c for c in _load_json(COMMENTS_FILE, []) if isinstance(c, dict) and c.get("id")]
    # Label anything without a current label; the file is the cache.
    sent = classify_comments(comments, os.environ.get("GROQ_API_KEY"))
    if sent["queued"]:
        COMMENTS_FILE.write_text(json.dumps(comments, indent=1, ensure_ascii=False))
    state = _load_json(SCRAPE_STATE_FILE, {})
    previous = _load_json(ANALYTICS_FILE, {})
    if not isinstance(previous, dict):
        previous = {}

    clf = Classifier(_load_json(CATEGORIES_FILE, {}))
    cats = {p["id"]: clf.classify(p) for p in posts}
    posts_by_id = {p["id"]: p for p in posts}

    heatmap, best_times = posting_heatmap(posts)
    averages = platform_averages(posts)
    top_hooks, hook_types = hooks(posts, cats)
    last, cadence = last_posted_and_cadence(posts)
    comment_data = comment_sections(comments, posts_by_id)
    comments_as_of = comment_data.pop("_commentsAsOf")
    history = update_follower_history(state, previous.get("followerHistory"))

    posts_as_of = max(
        (str((state.get(p) or {}).get("lastScrapedDate") or "") for p in PLATFORMS),
        default="",
    )

    analytics = {
        **previous,  # keep anything we do not regenerate (e.g. revenue)
        "generatedAt": _now_iso(),
        "dataAsOf": {"posts": posts_as_of, "comments": comments_as_of},
        "postingHeatmap": heatmap,
        "bestPostingTimes": best_times,
        "platformAverages": averages,
        "viralPosts": viral_posts(posts, averages, cats),
        "contentCategories": content_categories(posts, cats),
        "engagementFunnel": engagement_funnel(posts),
        "growthVelocity": growth_velocity(posts),
        "hashtagPerformance": hashtag_performance(posts),
        "crossPosts": cross_posts(posts),
        "topHooks": top_hooks,
        "hookTypes": hook_types,
        "lastPosted": last,
        "cadenceStats": cadence,
        "followerHistory": history,
        **comment_data,
    }
    # Keys we no longer produce must not survive via **previous.
    for dead in ("responseRate", "revenue"):
        analytics.pop(dead, None)
    ANALYTICS_FILE.write_text(json.dumps(analytics, indent=1))

    # Content Vault --------------------------------------------------------
    buckets: dict[str, list[dict]] = defaultdict(list)
    for p in posts:
        for slug in cats[p["id"]]:
            buckets[slug].append(p)
    categories = []
    for slug, ps in buckets.items():
        ps_sorted = sorted(ps, key=lambda p: _num(p.get("views")), reverse=True)
        viewed = [p for p in ps if _num(p.get("views")) > 0]
        categories.append({
            "slug": slug,
            "label": clf.labels.get(slug, slug.replace("_", " ").title()),
            "count": len(ps),
            "totalViews": int(sum(_num(p.get("views")) for p in ps)),
            "avgViews": int(_avg(_num(p["views"]) for p in viewed)),
            "platforms": dict(Counter(p["platform"] for p in ps)),
            "postIds": [p["id"] for p in ps_sorted],
        })
    categories.sort(key=lambda c: c["count"], reverse=True)
    vault = {
        "generatedAt": analytics["generatedAt"],
        "totalPosts": len(posts),
        "categories": categories,
        "byPost": cats,
    }
    VAULT_FILE.write_text(json.dumps(vault, indent=1))

    summary = {
        "posts": len(posts),
        "comments": len(comments),
        "viral": len(analytics["viralPosts"]),
        "crossPosts": len(analytics["crossPosts"]),
        "categories": {c["slug"]: c["count"] for c in categories},
        "historyPoints": len(history),
        "sentiment": {"labeledNow": sent["queued"], "byModel": sent["llm"], "byLexicon": sent["lexicon"]},
    }
    if verbose:
        print(json.dumps(summary, indent=2))
    return summary


if __name__ == "__main__":
    run(verbose=True)
    sys.exit(0)
