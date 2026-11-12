"""
X reader: an account's own posts, read from the timeline responses the
profile page receives in the shared Chrome (CDP on :9222, signed in).

How the timeline arrives (probed 2026-11-11):
  - Nothing is embedded in the HTML. The profile's Posts tab pages through
    /i/api/graphql/<hash>/<Operation> calls, about 20 posts each. The
    operation name and hash change between releases, so the hook keeps every
    /graphql/ body and the parser looks for `__typename: "Tweet"` dicts
    wherever they sit (scrape/feedhook.py).
  - A Tweet carries `rest_id`, `legacy` (text, created_at, the four
    counters, media) and `views`. `views.count` is missing on posts from
    before X had a view counter (late 2022).
  - The author is at core.user_results.result.core.screen_name, with the
    older legacy.screen_name as a fallback.

Types written here:
  - "video"  a post with a video or GIF and a view count
  - "tweet"  any other post with a view count (text, photo, link)
  - "post"   a post with no view count. "post" is one of the dashboard's
             viewless types, so its likes count as reach, the same rule
             Instagram photos follow.

Kept: the account's own posts and its replies to itself (threads). Skipped:
reposts of other accounts and replies to other people, which are not
content the account published to its own audience.

X needs a signed-in session to show a full timeline. Signed out it shows a
handful of posts and a login prompt, which raises the "sign in and rerun"
CDPError rather than saving a partial file.

Hygiene: one tab, sequential, human-like pauses, a hard page cap. X rate
limits timeline calls, so a full pass on a long account may stop short; rerun
later with --full to pick up the rest.
"""

from __future__ import annotations

import json
import random
import re
import sys
import time
from datetime import datetime

from scrape import feedhook as fh
from scrape.cdp import CDP, CDPError
from scrape.handles import DATA_DIR, DEFAULT_ACCOUNT, data_file, handle_for
from scrape.incremental import STOP_AFTER_KNOWN, load_existing, merge

_WALL_MARKERS = ("/i/flow/login", "/login", "/account/access")
_COUNT_RE = re.compile(r"([\d.,]+)\s*([KkMm])?")


def _int(v) -> int:
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


def _parse_count(text: str) -> int:
    m = _COUNT_RE.search(text or "")
    if not m:
        return 0
    n = float(m.group(1).replace(",", ""))
    unit = (m.group(2) or "").upper()
    return int(n * (1000 if unit == "K" else 1_000_000 if unit == "M" else 1))


def _is_tweet(d: dict) -> bool:
    return d.get("__typename") == "Tweet" and isinstance(d.get("legacy"), dict) and bool(d.get("rest_id"))


def _screen_name(user: dict) -> str:
    if not isinstance(user, dict):
        return ""
    return str((user.get("core") or {}).get("screen_name") or (user.get("legacy") or {}).get("screen_name") or "")


def _author(tweet: dict) -> dict:
    return (((tweet.get("core") or {}).get("user_results") or {}).get("result")) or {}


def _is_own(tweet: dict, handle: str) -> bool:
    legacy = tweet["legacy"]
    if _screen_name(_author(tweet)).lower() != handle.lower():
        return False
    if legacy.get("retweeted_status_result"):
        return False
    reply_to = str(legacy.get("in_reply_to_screen_name") or "")
    return not reply_to or reply_to.lower() == handle.lower()


def _engagement(likes: int, comments: int, shares: int, saves: int, views: int, followers: int) -> float:
    """Interactions over views when X reports them, over followers otherwise."""
    interactions = likes + comments + shares + saves
    if views:
        return interactions / views * 100
    return interactions / followers * 100 if followers else 0.0


def _text(tweet: dict) -> str:
    """Long posts keep their full text in note_tweet; legacy.full_text is cut
    at 280 characters. A trailing t.co link to the post's own media is noise."""
    note = fh.first_key(tweet.get("note_tweet") or {}, "text")
    text = note if isinstance(note, str) and note else str(tweet["legacy"].get("full_text") or "")
    return re.sub(r"\s*https://t\.co/\w+$", "", text).strip()


def _to_post(tweet: dict, handle: str, followers: int) -> dict | None:
    legacy = tweet["legacy"]
    rest_id = str(tweet.get("rest_id") or "")
    try:
        when = datetime.strptime(str(legacy.get("created_at")), "%a %b %d %H:%M:%S %z %Y").astimezone()
    except ValueError:
        return None
    views_block = tweet.get("views") or {}
    has_views = "count" in views_block
    views = _int(views_block.get("count"))
    media = ((legacy.get("extended_entities") or {}).get("media")) or []
    kinds = {str(m.get("type") or "") for m in media if isinstance(m, dict)}
    if not has_views:
        type_str = "post"
    elif kinds & {"video", "animated_gif"}:
        type_str = "video"
    else:
        type_str = "tweet"
    caption = _text(tweet)
    likes = _int(legacy.get("favorite_count"))
    comments = _int(legacy.get("reply_count"))
    shares = _int(legacy.get("retweet_count")) + _int(legacy.get("quote_count"))
    saves = _int(legacy.get("bookmark_count"))
    thumb = next((str(m.get("media_url_https") or "") for m in media if isinstance(m, dict)), "")
    return {
        "id": f"x_{rest_id}",
        "url": f"https://x.com/{handle}/status/{rest_id}",
        "title": caption.split("\n", 1)[0][:120] if caption else "",
        "caption": caption,
        "platform": "x",
        "type": type_str,
        "date": when.strftime("%Y-%m-%d"),
        "time": when.strftime("%H:%M"),
        "views": views,
        "likes": likes,
        "comments": comments,
        "shares": shares,
        "saves": saves,
        "engagementRate": f"{_engagement(likes, comments, shares, saves, views, followers):.2f}",
        "hashtags": " ".join(t for t in caption.split() if t.startswith("#")),
        "duration": "",
        "thumbnailUrl": thumb,
        "notes": "",
    }


def _followers_in(doc, handle: str) -> int:
    """followers_count of the profile's own user object, if this body has it."""
    def is_user(d: dict) -> bool:
        return _screen_name(d).lower() == handle.lower() and "followers_count" in (d.get("legacy") or {})
    for user in fh.walk(doc, is_user):
        return _int(user["legacy"].get("followers_count"))
    return 0


def _stored_followers(account: str) -> int:
    try:
        state = json.loads((DATA_DIR / "scrape_state.json").read_text())
    except (OSError, ValueError):
        return 0
    bucket = state if account == DEFAULT_ACCOUNT else ((state.get("accounts") or {}).get(account) or {})
    return _int((bucket.get("followers") or {}).get("x"))


def _check_wall(cdp: CDP) -> None:
    href = (cdp.evaluate("window.location.href") or "").lower()
    signed_out = cdp.evaluate(
        "!!document.querySelector('a[href=\"/login\"], a[href=\"/i/flow/login\"], [data-testid=\"loginButton\"]')"
    )
    if any(k in href for k in _WALL_MARKERS) or signed_out:
        raise CDPError("X is signed out in the shared Chrome; sign in to x.com and rerun.")


def read_timeline(handle: str, known_ids: set[str], full: bool, max_pages: int, on_progress=None) -> tuple[dict[str, dict], int, bool]:
    """Scroll the profile and return (own tweets by id, followers, stopped early)."""
    cdp = CDP()
    tweets: dict[str, dict] = {}
    followers = 0
    stopped_early = False
    try:
        cdp.new_tab("about:blank")
        cdp.add_init_script(fh.hook_source("/graphql/"))
        cdp.navigate(f"https://x.com/{handle}")
        cdp.wait_for_load(timeout=25)
        time.sleep(random.uniform(4.5, 6.0))
        _check_wall(cdp)
        if on_progress:
            on_progress("timeline open", {"handle": handle})

        stale_rounds = 0
        consecutive_known = 0
        for round_idx in range(max_pages):
            before = len(tweets)
            for text in fh.drain(cdp):
                for doc in fh.json_docs(text):
                    followers = followers or _followers_in(doc, handle)
                    for tweet in fh.walk(doc, _is_tweet):
                        rest_id = str(tweet["rest_id"])
                        if rest_id in tweets or not _is_own(tweet, handle):
                            continue
                        tweets[rest_id] = tweet
                        consecutive_known = consecutive_known + 1 if f"x_{rest_id}" in known_ids else 0
            if on_progress:
                on_progress("scrolling", {"round": round_idx, "totalPosts": len(tweets), "consecutiveKnown": consecutive_known})
            if not full and known_ids and consecutive_known >= STOP_AFTER_KNOWN:
                stopped_early = True
                break
            stale_rounds = stale_rounds + 1 if len(tweets) == before else 0
            if stale_rounds >= 4:
                break
            cdp.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            time.sleep(random.uniform(2.5, 4.0))

        if not followers:
            txt = cdp.evaluate("(document.querySelector('a[href$=\"/verified_followers\"], a[href$=\"/followers\"]') || {}).innerText || ''") or ""
            followers = _parse_count(txt)
    finally:
        cdp.close_owned()
        cdp.detach()
    return tweets, followers, stopped_early


def scrape(max_pages: int = 60, on_progress=None, full: bool = False,
           account: str = DEFAULT_ACCOUNT) -> dict:
    """Read an X account's own posts. Incremental (default) stops once
    STOP_AFTER_KNOWN consecutive already-known posts have scrolled past;
    full=True scrolls until the timeline stops growing or max_pages is hit.

    `account` picks the handle and the posts file (scrape/handles.py)."""
    handle = handle_for("x", account)
    out_file = data_file("x", account)
    existing, known_ids = load_existing(out_file)
    print("  [x] driving Phil's logged-in session; keep runs to about once a day", file=sys.stderr)

    tweets, followers, stopped_early = read_timeline(handle, known_ids, full, max_pages, on_progress)
    followers = followers or _stored_followers(account)

    new_posts = [p for p in (_to_post(t, handle, followers) for t in tweets.values()) if p]
    merged = merge(existing, new_posts)
    merged.sort(key=lambda p: (p.get("date", "") or "0", p.get("time", "") or ""), reverse=True)
    if followers:
        # Posts without a view count are measured against followers, so their
        # rate moves whenever the follower count does.
        for p in merged:
            if not _int(p.get("views")):
                p["engagementRate"] = f"{_engagement(_int(p.get('likes')), _int(p.get('comments')), _int(p.get('shares')), _int(p.get('saves')), 0, followers):.2f}"

    out_file.parent.mkdir(parents=True, exist_ok=True)
    out_file.write_text(json.dumps(merged, indent=2, ensure_ascii=False))

    return {
        "totalScraped": len(merged),
        "newPosts": len([p for p in new_posts if p["id"] not in known_ids]),
        "stoppedEarly": stopped_early,
        "lastPostId": merged[0]["id"] if merged else None,
        "followers": followers,
    }
