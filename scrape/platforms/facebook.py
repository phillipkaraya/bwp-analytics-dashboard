"""
Facebook Page reader: the Page's own timeline, read from the feed responses
the page itself receives in the shared Chrome (CDP on :9222).

How the feed arrives (probed 2026-11-11):
  - The first posts are in a <script type="application/json"> block in the
    HTML. Every later page is a POST to /api/graphql whose body is several
    JSON documents, one per line (scrape/feedhook.py parses both).
  - A post is a `Story` dict carrying `post_id` and `comet_sections`. Its
    paths move between releases, so fields are found by key name anywhere
    inside the story rather than by a fixed path.
  - `creation_time` is Unix seconds. Reels link to /reel/<video id>.

What the timeline does not carry: play counts. So Facebook is a viewless
platform here, like Threads and LinkedIn: views stay 0, reactions are the
reach number and engagement is measured against followers.

Only posts whose actor is the Page are kept, so something the Page was
tagged in never lands in its file.

Hygiene: one tab, sequential, human-like pauses, a hard page cap.
"""

from __future__ import annotations

import json
import random
import re
import sys
import time

from scrape import feedhook as fh
from scrape.cdp import CDP, CDPError
from scrape.handles import DATA_DIR, DEFAULT_ACCOUNT, data_file, handle_for
from scrape.incremental import STOP_AFTER_KNOWN, load_existing, merge

_WALL_MARKERS = ("/login", "/checkpoint", "/recover", "/two_step_verification")
_COUNT_RE = re.compile(r"([\d.,]+)\s*([KkMm])?")


def page_url(page_id: str) -> str:
    """A numeric Page id goes through profile.php; anything else is a vanity."""
    if page_id.isdigit():
        return f"https://www.facebook.com/profile.php?id={page_id}"
    return f"https://www.facebook.com/{page_id}"


def _parse_count(text: str) -> int:
    m = _COUNT_RE.search(text or "")
    if not m:
        return 0
    n = float(m.group(1).replace(",", ""))
    unit = (m.group(2) or "").upper()
    return int(n * (1000 if unit == "K" else 1_000_000 if unit == "M" else 1))


def _is_story(d: dict) -> bool:
    return "post_id" in d and "comet_sections" in d


def _int(v) -> int:
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


def _count_under(story: dict, key: str) -> int:
    """First `{key: {"count": n}}` in the story (reaction_count, share_count)."""
    for v in fh.find_key(story, key):
        if isinstance(v, dict) and "count" in v:
            return _int(v.get("count"))
        if isinstance(v, int):
            return v
    return 0


def _comment_count(story: dict) -> int:
    for v in fh.find_key(story, "total_comment_count"):
        if isinstance(v, int):
            return v
    for inst in fh.find_key(story, "comment_rendering_instance"):
        if isinstance(inst, dict):
            comments = inst.get("comments")
            if isinstance(comments, dict) and "total_count" in comments:
                return _int(comments.get("total_count"))
    for v in fh.find_key(story, "comments"):
        if isinstance(v, dict) and "total_count" in v:
            return _int(v.get("total_count"))
    return 0


def _actor_id(story: dict) -> str:
    for actors in fh.find_key(story, "actors"):
        if isinstance(actors, list) and actors and isinstance(actors[0], dict):
            return str(actors[0].get("id") or "")
    return ""


def _caption(story: dict) -> str:
    for msg in fh.find_key(story, "message"):
        if isinstance(msg, dict) and isinstance(msg.get("text"), str):
            return msg["text"]
    return ""


def _url(story: dict) -> str:
    for key in ("wwwURL", "permalink_url"):
        for v in fh.find_key(story, key):
            if isinstance(v, str) and v.startswith("http"):
                return v
    return ""


def _media_types(story: dict) -> set[str]:
    kinds: set[str] = set()
    for media in fh.find_key(story, "media"):
        if isinstance(media, dict) and media.get("__typename"):
            kinds.add(str(media["__typename"]))
    return kinds


def _duration(story: dict) -> str:
    ms = _int(fh.first_key(story, "playable_duration_in_ms"))
    if not ms:
        return ""
    secs = round(ms / 1000)
    return f"{secs // 60}:{secs % 60:02d}"


def _engagement(likes: int, comments: int, shares: int, followers: int) -> float:
    """No views on this platform: interactions over followers, as Threads does."""
    return (likes + comments + shares) / followers * 100 if followers else 0.0


def _to_post(story: dict, followers: int) -> dict | None:
    post_id = str(story.get("post_id") or "")
    ts = _int(story.get("creation_time") or fh.first_key(story, "creation_time"))
    if not post_id or not ts:
        return None
    url = _url(story)
    kinds = _media_types(story)
    if "/reel/" in url:
        type_str = "reel"
    elif "Video" in kinds:
        type_str = "video"
    elif "Photo" in kinds:
        type_str = "image"
    else:
        type_str = "post"
    caption = _caption(story)
    likes = _count_under(story, "reaction_count")
    comments = _comment_count(story)
    shares = _count_under(story, "share_count")
    return {
        "id": f"fb_{post_id}",
        "url": url or f"https://www.facebook.com/{post_id}",
        "title": caption.split("\n", 1)[0][:120] if caption else "",
        "caption": caption,
        "platform": "facebook",
        "type": type_str,
        "date": time.strftime("%Y-%m-%d", time.localtime(ts)),
        "time": time.strftime("%H:%M", time.localtime(ts)),
        "views": 0,
        "likes": likes,
        "comments": comments,
        "shares": shares,
        "saves": 0,
        "engagementRate": f"{_engagement(likes, comments, shares, followers):.2f}",
        "hashtags": " ".join(t for t in caption.split() if t.startswith("#")),
        "duration": _duration(story),
        "thumbnailUrl": "",
        "notes": "",
    }


def _stored_followers(account: str) -> int:
    try:
        state = json.loads((DATA_DIR / "scrape_state.json").read_text())
    except (OSError, ValueError):
        return 0
    bucket = state if account == DEFAULT_ACCOUNT else ((state.get("accounts") or {}).get(account) or {})
    return _int((bucket.get("followers") or {}).get("facebook"))


def _check_wall(cdp: CDP) -> None:
    href = (cdp.evaluate("window.location.href") or "").lower()
    if any(k in href for k in _WALL_MARKERS):
        raise CDPError("Facebook shows a login or checkpoint page; sign in to facebook.com in the shared Chrome and rerun.")


def _stories_in(texts: list[str]) -> list[dict]:
    found: list[dict] = []
    for text in texts:
        for doc in fh.json_docs(text):
            found.extend(fh.walk(doc, _is_story))
    return found


def read_feed(page_id: str, known_ids: set[str], full: bool, max_pages: int, on_progress=None) -> tuple[dict[str, dict], int | None, bool]:
    """Scroll the Page and return (stories by post id, followers, stopped early).
    followers is None when the page did not show a count, which is not the
    same as a new Page that shows "0 followers"."""
    cdp = CDP()
    stories: dict[str, dict] = {}
    followers: int | None = None
    stopped_early = False
    try:
        cdp.new_tab("about:blank")
        cdp.add_init_script(fh.hook_source("/api/graphql"))
        cdp.navigate(page_url(page_id))
        cdp.wait_for_load(timeout=25)
        time.sleep(random.uniform(4.5, 6.0))
        _check_wall(cdp)
        if on_progress:
            on_progress("feed open", {"handle": page_id})

        body_text = cdp.evaluate("(document.body.innerText || '').slice(0, 8000)") or ""
        m = re.search(r"([\d.,]+\s*[KkMm]?)\s+followers", body_text)
        followers = _parse_count(m.group(1)) if m else None

        texts = fh.embedded_json(cdp, "creation_time")
        stale_rounds = 0
        consecutive_known = 0
        for round_idx in range(max_pages):
            texts += fh.drain(cdp)
            before = len(stories)
            for story in _stories_in(texts):
                pid = str(story.get("post_id") or "")
                if not pid or pid in stories or _actor_id(story) != page_id:
                    continue
                stories[pid] = story
                consecutive_known = consecutive_known + 1 if f"fb_{pid}" in known_ids else 0
            texts = []
            if on_progress:
                on_progress("scrolling", {"round": round_idx, "totalPosts": len(stories), "consecutiveKnown": consecutive_known})
            if not full and known_ids and consecutive_known >= STOP_AFTER_KNOWN:
                stopped_early = True
                break
            stale_rounds = stale_rounds + 1 if len(stories) == before else 0
            if stale_rounds >= 4:
                break
            cdp.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            time.sleep(random.uniform(2.5, 4.0))

        if not stories and cdp.evaluate("!!document.querySelector('form#login_form, input[name=\"pass\"]')"):
            raise CDPError("Facebook is signed out in the shared Chrome; sign in to facebook.com and rerun.")
    finally:
        cdp.close_owned()
        cdp.detach()
    return stories, followers, stopped_early


def scrape(max_pages: int = 40, on_progress=None, full: bool = False,
           account: str = DEFAULT_ACCOUNT) -> dict:
    """Read a Facebook Page's timeline. Incremental (default) stops once
    STOP_AFTER_KNOWN consecutive already-known posts have scrolled past;
    full=True scrolls until the feed stops growing.

    `account` picks the Page id and the posts file (scrape/handles.py)."""
    page_id = handle_for("facebook", account)
    out_file = data_file("facebook", account)
    existing, known_ids = load_existing(out_file)
    print("  [facebook] driving Phil's logged-in session; keep runs to about once a day", file=sys.stderr)

    stories, seen_followers, stopped_early = read_feed(page_id, known_ids, full, max_pages, on_progress)
    followers = _stored_followers(account) if seen_followers is None else seen_followers

    new_posts = [p for p in (_to_post(s, followers) for s in stories.values()) if p]
    merged = merge(existing, new_posts)
    merged.sort(key=lambda p: (p.get("date", "") or "0", p.get("time", "") or ""), reverse=True)
    if followers:
        for p in merged:
            p["engagementRate"] = f"{_engagement(_int(p.get('likes')), _int(p.get('comments')), _int(p.get('shares')), followers):.2f}"

    out_file.parent.mkdir(parents=True, exist_ok=True)
    out_file.write_text(json.dumps(merged, indent=2, ensure_ascii=False))

    return {
        "totalScraped": len(merged),
        "newPosts": len([p for p in new_posts if p["id"] not in known_ids]),
        "stoppedEarly": stopped_early,
        "lastPostId": merged[0]["id"] if merged else None,
        "followers": followers,
        # True when the count was read off the page, so a real 0 is recorded
        # instead of being taken for "unknown".
        "followersKnown": seen_followers is not None,
    }
