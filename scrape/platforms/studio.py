"""
Studio enrichment for TikTok and YouTube: likes, comments, shares and saves.

The public profile pages the tiktok.py and youtube.py readers scroll show a
view count per post and nothing else, so those readers write likes, comments
and shares as 0. The creator studios show everything, but only to the signed
in owner, and both feed their tables from calls the page has to make itself:

  - TikTok Studio (tiktok.com/tiktokstudio/content) POSTs to
    /tiktok/creator/manage/item_list/v1/ with a per-request signature in the
    query string. A replayed URL answers "url doesn't match".
  - YouTube Studio (studio.youtube.com/channel/<id>/videos/upload) POSTs to
    /youtubei/v1/creator/list_creator_videos with a SAPISIDHASH header that a
    hand-built replay could not reproduce (401).

So this module never replays a request. It installs a request hook before
the page loads (Page.addScriptToEvaluateOnNewDocument), drives the page the
way the owner would (scroll the TikTok list, click through YouTube's pages
and its Shorts tab), and reads the JSON the page received. The numbers are
exact, not the abbreviated "930K" the table shows.

Only posts already in <platform>_posts.json are updated, matched by id, so a
private "Only me" post the public reader never saw is never added. Nothing
is deleted. engagementRate is recomputed as (likes + comments + shares +
saves) / views, the same formula the v1 TikTok export used.

Both functions raise CDPError when the studio is not signed in, so run.py
can report "sign in to TikTok Studio in the dashboard Chrome window" and
still keep the base reader's result.
"""

from __future__ import annotations

import json
import time
from datetime import datetime
from pathlib import Path

from scrape.cdp import CDP, CDPError
from scrape.handles import YOUTUBE_CHANNEL_ID

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "public" / "data"
TIKTOK_FILE = DATA_DIR / "tiktok_posts.json"
YOUTUBE_FILE = DATA_DIR / "youtube_posts.json"

TIKTOK_URL = "https://www.tiktok.com/tiktokstudio/content"
YOUTUBE_URL = f"https://studio.youtube.com/channel/{YOUTUBE_CHANNEL_ID}/videos/upload"
YOUTUBE_SHORTS_URL = f"https://studio.youtube.com/channel/{YOUTUBE_CHANNEL_ID}/videos/short"

# Installed before any page script. Every XHR or fetch whose URL contains
# MATCH has its JSON response pushed onto window.__studio.
_HOOK = """
(() => {
  const MATCH = %s;
  window.__studio = [];
  const push = (t) => { try { window.__studio.push(JSON.parse(t)); } catch (e) {} };
  const o = XMLHttpRequest.prototype.open, s = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__u = String(u); return o.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    if (this.__u && this.__u.includes(MATCH)) {
      const x = this; x.addEventListener('load', () => push(x.responseText));
    }
    return s.apply(this, arguments);
  };
  const f = window.fetch;
  window.fetch = async function (i, n) {
    const u = typeof i === 'string' ? i : (i && i.url) || '';
    const r = await f.apply(this, arguments);
    if (String(u).includes(MATCH)) r.clone().text().then(push).catch(() => {});
    return r;
  };
})();
"""


def _num(v) -> int:
    try:
        return int(float(v or 0))
    except (TypeError, ValueError):
        return 0


def _rate(p: dict) -> str:
    views = _num(p.get("views"))
    if views <= 0:
        return str(p.get("engagementRate") or "0.00")
    eng = _num(p.get("likes")) + _num(p.get("comments")) + _num(p.get("shares")) + _num(p.get("saves"))
    return f"{eng / views * 100:.2f}"


def _apply(path: Path, updates: dict[str, dict], on_progress=None, label: str = "") -> dict:
    """Merge `updates` (post id -> fields) into the posts file. Returns stats."""
    posts = json.loads(path.read_text()) if path.exists() else []
    matched = changed = 0
    for p in posts:
        u = updates.get(p.get("id"))
        if not u:
            continue
        matched += 1
        before = {k: p.get(k) for k in u}
        p.update(u)
        # The studio counted likes and comments for this post, so a zero is a
        # real zero. lib/derive.ts and analyze.py read this flag.
        p["engagementMeasured"] = True
        p["engagementRate"] = _rate(p)
        if any(str(before[k]) != str(p.get(k)) for k in u):
            changed += 1
    path.write_text(json.dumps(posts, indent=2, ensure_ascii=False))
    stats = {"seen": len(updates), "matched": matched, "changed": changed, "unmatched": len(updates) - matched}
    if on_progress:
        on_progress(f"{label} studio applied", stats)
    return stats


def _open(cdp: CDP, url: str, match: str, wait_js: str, not_signed_in: str, timeout: int = 25) -> None:
    """Open our own tab with the hook installed, then wait for `wait_js` to be truthy."""
    cdp.new_tab("about:blank")
    cdp.add_init_script(_HOOK % json.dumps(match))
    cdp.navigate(url)
    cdp.wait_for_load(timeout=timeout)
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if cdp.evaluate(wait_js):
                return
        except CDPError:
            pass
        time.sleep(0.5)
    href = cdp.evaluate("location.href") or ""
    raise CDPError(f"{not_signed_in} (landed on {href[:80]})")


def _captured(cdp: CDP) -> list:
    raw = cdp.evaluate("JSON.stringify(window.__studio || [])") or "[]"
    return json.loads(raw)


# --- TikTok -----------------------------------------------------------------

_TT_SCROLL = """
(() => {
  let el = document.querySelector('a[href*="/video/"]');
  while (el && !(el.scrollHeight > el.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
  const sc = el || document.scrollingElement;
  sc.scrollTop = sc.scrollHeight;
  return sc.scrollHeight;
})()
"""


_TT_SORT_BY_VIEWS = """
(() => {
  const b = [...document.querySelectorAll('button')].find(x => /^\\s*Views\\s*$/.test((x.innerText || '').trim())
    && x.getBoundingClientRect().y > 120 && x.getBoundingClientRect().y < 220);
  if (!b) return false;
  b.click(); return true;
})()
"""


def _tt_pass(cdp: CDP, items: dict[str, dict], first_page: int, on_progress, label: str, max_rounds: int) -> int:
    """Scroll the list until a page captured at or after `first_page` says
    has_more false. The list renders about ten rows per scroll and only asks
    for the next ten when the rendered rows run out, so progress is measured
    on the rendered height as well as on the captured items. Returns the
    number of pages captured so far."""
    stale = 0
    last_height = -1
    pages = 0
    for round_idx in range(max_rounds):
        captured = _captured(cdp)
        pages = len(captured)
        done = False
        for page in captured[first_page:]:
            for it in page.get("item_list") or []:
                if it.get("item_id"):
                    items[str(it["item_id"])] = it
            if page.get("has_more") is False:
                done = True
        if on_progress:
            on_progress(f"tiktok studio {label}", {"round": round_idx + 1, "totalPosts": len(items)})
        if done:
            break
        before = len(items)
        height = cdp.evaluate(_TT_SCROLL) or 0
        time.sleep(1.2)
        stale = stale + 1 if (len(items) == before and height == last_height) else 0
        last_height = height
        if stale >= 6:
            break
    return pages


def enrich_tiktok(on_progress=None, max_rounds: int = 150) -> dict:
    """Read every post's exact counts from TikTok Studio and write them into tiktok_posts.json.

    The list endpoint pages ten at a time and, sorted by post time, stops
    short of the full set (164 of 194 on 2026-09-27: some pages come back
    with nine items while the cursor still moves by ten). Sorted by views it
    reaches a different subset, and the union of the two sorts is complete,
    so the reader scrolls the list twice.
    """
    cdp = CDP()
    items: dict[str, dict] = {}
    try:
        _open(
            cdp, TIKTOK_URL, "creator/manage/item_list",
            "document.querySelectorAll('a[href*=\"/video/\"]').length > 0",
            "TikTok Studio did not list posts: sign in to TikTok in the dashboard Chrome window",
        )
        pages = _tt_pass(cdp, items, 0, on_progress, "by date", max_rounds)
        if cdp.evaluate(_TT_SORT_BY_VIEWS):
            time.sleep(2.5)
            _tt_pass(cdp, items, pages, on_progress, "by views", max_rounds)
        elif on_progress:
            on_progress("tiktok studio", {"reason": "Views sort button not found; single pass only"})
    finally:
        cdp.close_owned()
        cdp.detach()

    updates: dict[str, dict] = {}
    for item_id, it in items.items():
        fields = {
            "views": _num(it.get("play_count")),
            "likes": _num(it.get("like_count")),
            "comments": _num(it.get("comment_count")),
            "shares": _num(it.get("share_count")),
            "saves": _num(it.get("favorite_count")),
        }
        ts = _num(it.get("post_time") or it.get("create_time"))
        if ts > 0:
            dt = datetime.fromtimestamp(ts)
            fields["date"] = dt.strftime("%Y-%m-%d")
            fields["time"] = dt.strftime("%H:%M")
        updates[f"tt_{item_id}"] = fields
    return _apply(TIKTOK_FILE, updates, on_progress, "tiktok")


# --- YouTube ----------------------------------------------------------------

_YT_FOOTER = """
(() => {
  const f = document.querySelector('ytcp-table-footer');
  const m = (f ? f.innerText : '').replace(/\\s+/g, ' ').match(/(\\d+)[^\\d]+(\\d+) of (\\d+)/);
  return m ? { to: +m[2], of: +m[3] } : null;
})()
"""

_YT_NEXT = """
(() => {
  const b = [...document.querySelectorAll('#navigate-after')].find(e => e.getBoundingClientRect().width > 0);
  if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
  b.click(); return true;
})()
"""


def _yt_collect(cdp: CDP, videos: dict[str, dict], on_progress, label: str, max_pages: int = 40) -> None:
    """Page through the current YouTube Studio list, collecting every video the page received."""
    for page_idx in range(max_pages):
        seen_before = len(videos)
        for page in _captured(cdp):
            for v in page.get("videos") or []:
                if v.get("videoId"):
                    videos[v["videoId"]] = v
        footer = cdp.evaluate(_YT_FOOTER)
        if on_progress:
            on_progress(f"youtube studio {label}", {"page": page_idx + 1, "totalPosts": len(videos), **(footer or {})})
        if footer and footer["to"] >= footer["of"]:
            break
        if footer is None and len(videos) == seen_before and page_idx > 0:
            break
        if not cdp.evaluate(_YT_NEXT):
            break
        # Wait for the next page's response to land.
        pages_before = len(_captured(cdp))
        deadline = time.time() + 12
        while time.time() < deadline and len(_captured(cdp)) == pages_before:
            time.sleep(0.5)


def enrich_youtube(on_progress=None) -> dict:
    """Read every video's and short's exact counts from YouTube Studio into youtube_posts.json."""
    cdp = CDP()
    videos: dict[str, dict] = {}
    try:
        not_signed_in = "YouTube Studio did not list videos: sign in to YouTube in the dashboard Chrome window"
        _open(cdp, YOUTUBE_URL, "list_creator_videos", "document.querySelectorAll('ytcp-video-row').length > 0", not_signed_in)
        _yt_collect(cdp, videos, on_progress, "videos")
        cdp.navigate(YOUTUBE_SHORTS_URL)
        cdp.wait_for_load(timeout=25, expect_url_substring="/videos/short")
        deadline = time.time() + 25
        while time.time() < deadline and not cdp.evaluate("document.querySelectorAll('ytcp-video-row').length > 0"):
            time.sleep(0.5)
        _yt_collect(cdp, videos, on_progress, "shorts")
    finally:
        cdp.close_owned()
        cdp.detach()

    updates: dict[str, dict] = {}
    for vid, v in videos.items():
        m = v.get("publicMetrics") or {}
        # For Shorts, viewCount is "engaged views" (a fraction of the public
        # number) and externalViewCount is what the watch page shows; the
        # public reader and every other platform count the public number.
        fields = {
            "views": _num(m.get("externalViewCount") or m.get("viewCount")),
            "likes": _num(m.get("likeCount")),
            "comments": _num(m.get("commentCount")),
        }
        ts = _num(v.get("timePublishedSeconds"))
        if ts > 0:
            dt = datetime.fromtimestamp(ts)
            fields["date"] = dt.strftime("%Y-%m-%d")
            fields["time"] = dt.strftime("%H:%M")
        updates[f"yt_{vid}"] = fields
    return _apply(YOUTUBE_FILE, updates, on_progress, "youtube")


ENRICHERS = {"tiktok": enrich_tiktok, "youtube": enrich_youtube}
