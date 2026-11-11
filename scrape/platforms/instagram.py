"""
Instagram scraper.

Strategy (since 2026-09-04): open instagram.com/<handle>/ in our own tab,
hook window.fetch + XMLHttpRequest so every /graphql/query response body is
captured, reload so the first page flows through the hook, then scroll to
let Instagram's own React app paginate. Posts are parsed out of
`data.xdt_api__v1__feed__user_timeline_graphql_connection.edges[].node`.

Why not /api/v1/feed/user/<pk>/ like before: www.instagram.com now answers
that (and web_profile_info) with 429 / an HTML shell for scripted calls,
even from a logged-in tab. Letting the page make its own requests sidesteps
auth headers, doc_id rotation and the throttle entirely.

Follower count comes from the profile page's og:description meta
("10.9K Followers, 5,751 Following, 675 Posts"), no API call needed.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any

from scrape.cdp import CDP, CDPError
from scrape.handles import DEFAULT_ACCOUNT, data_file, handle_for
from scrape.incremental import STOP_AFTER_KNOWN, load_existing, merge

# The personal account's file and handle, kept for anything that imports them.
# scrape() resolves its own from the `account` argument.
DATA_FILE = data_file("instagram")
HANDLE = handle_for("instagram")
TIMELINE_KEYS = (
    "xdt_api__v1__feed__user_timeline_graphql_connection",
    "xdt_api__v1__feed__user_timeline_graphql_connection_v2",
)

# Captures every /graphql/query response (fetch AND XHR) into window.__FWP_IG.
_INSTALL_HOOK = """
(function() {
  if (window.__FWP_IG_HOOK__) return 'already';
  window.__FWP_IG_HOOK__ = true;
  window.__FWP_IG = [];
  function keep(url, text) {
    try {
      if (url.indexOf('graphql') >= 0 && text && text.length > 2000) {
        window.__FWP_IG.push({ at: Date.now(), length: text.length, body: text });
        if (window.__FWP_IG.length > 300) window.__FWP_IG.shift();
      }
    } catch (e) {}
  }
  const origFetch = window.fetch;
  window.fetch = function(input, init) {
    const url = (typeof input === 'string') ? input : ((input && input.url) || '');
    return origFetch.apply(this, arguments).then(function(res) {
      try { res.clone().text().then(function(t) { keep(url, t); }); } catch (e) {}
      return res;
    });
  };
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__fwp_url = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    this.addEventListener('load', () => { keep(this.__fwp_url || '', this.responseText || ''); });
    return origSend.apply(this, arguments);
  };
  // The FIRST grid page is server-embedded (RelayPrefetchedStreamCache in a
  // <script type="application/json"> tag) and never goes through fetch.
  // Harvest it too, otherwise the newest 12 posts are invisible and the
  // incremental stop fires on page two.
  window.__FWP_IG_harvest = function() {
    var n = 0;
    document.querySelectorAll('script[type="application/json"]').forEach(function(s) {
      var t = s.textContent || '';
      if (t.indexOf('user_timeline_graphql_connection') >= 0) { keep('embedded:graphql', t); n++; }
    });
    return n;
  };
  window.__FWP_IG_harvest();
  return 'installed';
})()
"""

_DRAIN_BODIES = """
(function() {
  const items = window.__FWP_IG || [];
  window.__FWP_IG = [];
  return items;
})()
"""

_FOLLOWERS_RE = re.compile(r"([\d.,]+)\s*([KM]?)\s+Followers", re.I)

APP_ID = "936619743392459"
# The timeline query hides play counts on reels (view_count null). The
# per-media info endpoint still answers from a logged-in tab (verified
# 2026-09-04: 200 + play_count), so we top up zero-view reels with it.
ENRICH_CAP_INCREMENTAL = 60
ENRICH_CAP_FULL = 200


# Instagram reports play counts for reels and videos only. Carousels and
# photos always arrive with views 0, which is an absence, not a measurement:
# their engagement is measured against followers, as Threads does (Phil,
# 2026-09-16: "fix the carousel 0 views thing"). The dashboard's
# postHasViews() in lib/derive.ts mirrors this list.
VIEWLESS_TYPES = ("carousel", "post")


def recompute_viewless_engagement(posts: list[dict], followers: int) -> int:
    """Set engagementRate = (likes + comments) / followers for view-less post
    types. Runs on the whole merged file so older rows catch up on the next
    scrape. Returns how many rows changed."""
    if not followers:
        return 0
    changed = 0
    for p in posts:
        if p.get("type") not in VIEWLESS_TYPES or p.get("views"):
            continue
        rate = f"{(int(p.get('likes') or 0) + int(p.get('comments') or 0)) / followers * 100:.2f}"
        if p.get("engagementRate") != rate:
            p["engagementRate"] = rate
            changed += 1
    return changed


def _enrich_views(cdp: CDP, posts: list[dict], cap: int, on_progress=None) -> int:
    """Fill in views (and bump likes/comments) for reels/videos that have
    views == 0, newest first, up to `cap` media-info calls. Returns count."""
    targets = [
        p for p in posts
        if not p.get("views") and p.get("type") in ("reel", "video") and p.get("id", "").startswith("ig_")
    ]
    targets.sort(key=lambda p: p.get("date") or "", reverse=True)
    done = 0
    for p in targets[:cap]:
        pk = p["id"][3:].split("_")[0]
        expr = (
            f"fetch('/api/v1/media/{pk}/info/', {{ headers: {{ 'X-IG-App-ID': '{APP_ID}' }}, credentials: 'include' }})"
            ".then(r => r.text().then(t => { try { const d = JSON.parse(t); const it = (d.items || [])[0] || {}; "
            "return { status: r.status, play: it.play_count || it.ig_play_count || it.view_count || 0, like: it.like_count || 0, comment: it.comment_count || 0 }; }"
            " catch (e) { return { status: r.status, error: 'parse' }; } }))"
            ".catch(e => ({ status: 0, error: String(e) }))"
        )
        try:
            r = cdp.evaluate(expr, await_promise=True) or {}
        except CDPError:
            break
        if r.get("status") != 200:
            # Throttled or blocked: stop rather than hammer the endpoint.
            if on_progress:
                on_progress("view enrichment stopped", {"status": r.get("status"), "done": done})
            break
        views = int(r.get("play") or 0)
        if views:
            p["views"] = views
            p["likes"] = max(int(p.get("likes") or 0), int(r.get("like") or 0))
            p["comments"] = max(int(p.get("comments") or 0), int(r.get("comment") or 0))
            p["engagementRate"] = f"{(p['likes'] + p['comments']) / views * 100:.2f}"
        done += 1
        time.sleep(0.45)
    if on_progress and done:
        on_progress("views enriched", {"posts": done, "remainingZeroView": max(0, len(targets) - done)})
    return done


def _parse_compact(num: str, suffix: str) -> int:
    try:
        n = float(num.replace(",", ""))
    except ValueError:
        return 0
    mult = {"k": 1_000, "m": 1_000_000}.get(suffix.lower(), 1)
    return int(n * mult)


def _followers_from_meta(cdp: CDP) -> int:
    desc = cdp.evaluate(
        "(document.querySelector('meta[property=\"og:description\"]') || {}).content || ''"
    ) or ""
    m = _FOLLOWERS_RE.search(str(desc))
    return _parse_compact(m.group(1), m.group(2)) if m else 0


def _walk(obj: Any):
    """Yield every dict nested anywhere inside obj."""
    if isinstance(obj, dict):
        yield obj
        for v in obj.values():
            yield from _walk(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk(v)


def _timeline_nodes(body: str) -> tuple[list[dict], bool | None]:
    """Return (nodes, has_next_page) from a captured graphql body, or ([], None).

    Handles both the plain fetch response ({data: {xdt_api__...}}) and the
    server-embedded Relay cache, where the same connection sits several
    levels deep inside a `require` array."""
    try:
        blob = json.loads(body)
    except json.JSONDecodeError:
        return [], None
    nodes: list[dict] = []
    has_next: bool | None = None
    seen: set[str] = set()
    for d in _walk(blob):
        for key in TIMELINE_KEYS:
            conn = d.get(key)
            if isinstance(conn, dict) and isinstance(conn.get("edges"), list):
                for e in conn["edges"]:
                    node = e.get("node") if isinstance(e, dict) else None
                    if isinstance(node, dict):
                        nid = str(node.get("id") or node.get("pk") or "")
                        if nid and nid not in seen:
                            seen.add(nid)
                            nodes.append(node)
                pi = conn.get("page_info") or {}
                if has_next is None and "has_next_page" in pi:
                    has_next = pi.get("has_next_page")
    return nodes, has_next


def _owner_username(item: dict) -> str:
    """Username of the account that published this node, lowercased, or ""
    when the node does not say."""
    for key in ("user", "owner"):
        who = item.get(key)
        if isinstance(who, dict) and who.get("username"):
            return str(who["username"]).lower()
    return ""


def _parse_post(item: dict) -> dict:
    """Convert an Instagram media node to our Post schema (same shape the
    old /api/v1/feed/user items had, so ids stay stable: ig_<pk>_<owner>)."""
    pk = item.get("pk")
    node_id = item.get("id") or (f"{pk}_{item.get('owner_id')}" if pk and item.get("owner_id") else pk)
    code = item.get("code")
    caption = ((item.get("caption") or {}).get("text")) or ""
    media_type = item.get("media_type")  # 1=image, 2=video, 8=carousel
    product_type = item.get("product_type")  # clips=reel, feed, igtv
    type_str = "reel" if product_type == "clips" else "carousel" if media_type == 8 else "video" if media_type == 2 else "post"
    views = item.get("play_count") or item.get("view_count") or 0
    likes = item.get("like_count") or 0
    comments = item.get("comment_count") or 0
    taken_at = item.get("taken_at")
    iso_dt = time.strftime("%Y-%m-%d", time.localtime(taken_at)) if taken_at else ""
    iso_t = time.strftime("%H:%M", time.localtime(taken_at)) if taken_at else ""
    thumb = ((item.get("image_versions2") or {}).get("candidates") or [{}])[0].get("url") or ""
    eng = ((likes + comments) / views * 100) if views else 0
    hashtags = " ".join(t for t in caption.split() if t.startswith("#"))
    return {
        "id": f"ig_{node_id}",
        "url": f"https://www.instagram.com/p/{code}/" if code else "",
        "title": caption.split("\n", 1)[0][:120] if caption else "",
        "caption": caption,
        "platform": "instagram",
        "type": type_str,
        "date": iso_dt,
        "time": iso_t,
        "views": views,
        "likes": likes,
        "comments": comments,
        "shares": 0,
        "saves": 0,
        "engagementRate": f"{eng:.2f}",
        "hashtags": hashtags,
        "duration": "",
        "thumbnailUrl": thumb,
        "notes": "",
    }


def scrape(max_pages: int = 60, on_progress=None, full: bool = False,
           account: str = DEFAULT_ACCOUNT) -> dict:
    """Scrape posts from instagram.com/<handle>/ by capturing the page's own
    GraphQL timeline responses while scrolling.

    Incremental (default): stops after STOP_AFTER_KNOWN consecutive posts
    that already exist locally. full=True (master sweep) scrolls until the
    grid is exhausted, refreshing metrics on every post.

    `account` picks the handle and the posts file (scrape/handles.py). The
    profile only has to be visible to the signed-in session, not owned by it.
    """
    handle = handle_for("instagram", account)
    out_file = data_file("instagram", account)
    page_url = f"https://www.instagram.com/{handle}/"
    # A profile grid also shows collab posts published by someone else. The
    # personal file has always kept them; a newer account's file holds only
    # what that account published, so a shared post is not counted twice
    # when both accounts are viewed together.
    own_only = account != DEFAULT_ACCOUNT
    skipped_foreign = 0
    empty = False  # a profile that has published nothing yet is not a failure
    existing, known_ids = load_existing(out_file)
    cdp = CDP()
    posts_by_id: dict[str, dict] = {}
    consecutive_known = 0
    stopped_early = False
    followers = 0
    saw_timeline = False

    def drain() -> int:
        nonlocal consecutive_known, saw_timeline, skipped_foreign
        new_in_round = 0
        for entry in cdp.evaluate(_DRAIN_BODIES) or []:
            nodes, _has_next = _timeline_nodes(entry.get("body") or "")
            if nodes:
                saw_timeline = True
            for node in nodes:
                if own_only:
                    owner = _owner_username(node)
                    if owner and owner != handle.lower():
                        skipped_foreign += 1
                        continue
                p = _parse_post(node)
                if p["id"] in known_ids:
                    consecutive_known += 1
                else:
                    consecutive_known = 0
                if p["id"] not in posts_by_id:
                    posts_by_id[p["id"]] = p
                    new_in_round += 1
        return new_in_round

    try:
        cdp.new_tab(page_url)
        cdp.wait_for_load(timeout=20, expect_url_substring=handle)
        time.sleep(1.5)
        followers = _followers_from_meta(cdp)

        # Register the hook to run before any page script on the next
        # document, then reload. Instagram fires the first timeline fetch
        # during load; a hook installed after load misses the newest 12
        # posts and the incremental stop then fires on page two.
        cdp.add_init_script(_INSTALL_HOOK)
        cdp.evaluate("window.location.reload()")
        time.sleep(0.5)
        cdp.wait_for_load(timeout=20, expect_url_substring=handle)
        cdp.evaluate(_INSTALL_HOOK)  # no-op if the init script ran; safety net otherwise
        time.sleep(2.5)
        embedded = cdp.evaluate("window.__FWP_IG_harvest ? window.__FWP_IG_harvest() : 0") or 0
        if not followers:
            followers = _followers_from_meta(cdp)

        logged_out = cdp.evaluate(
            "!!document.querySelector('input[name=\"username\"]') || /Log in/.test(document.title)"
        )
        if logged_out:
            raise CDPError("Instagram shows the login wall — sign in to instagram.com in the shared Chrome and rerun.")

        if on_progress:
            on_progress("hook installed", {
                "handle": handle, "existingPosts": len(existing),
                "followers": followers, "embeddedPayloads": embedded,
            })

        stale_rounds = 0
        for round_idx in range(max_pages):
            new_in_round = drain()
            if on_progress:
                on_progress("scrolling", {
                    "round": round_idx + 1,
                    "newPosts": len(posts_by_id),
                    "newInRound": new_in_round,
                    "consecutiveKnown": consecutive_known,
                })
            if not full and known_ids and consecutive_known >= STOP_AFTER_KNOWN:
                stopped_early = True
                break
            if new_in_round == 0 and round_idx > 0:
                stale_rounds += 1
                if stale_rounds >= 5:
                    break
            else:
                stale_rounds = 0
            cdp.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            time.sleep(2.5)

        drain()  # anything left in the buffer

        if not saw_timeline:
            missing = cdp.evaluate(
                "/Sorry, this page isn't available|Page Not Found/i.test(document.body ? document.body.innerText : '')"
            )
            if missing:
                raise CDPError(f"instagram.com/{handle}/ does not exist or is not visible to the signed-in session.")
            empty = cdp.evaluate(
                "/No posts yet/i.test(document.body ? document.body.innerText : '')"
            )
        if not saw_timeline and not empty:
            raise CDPError(
                "No timeline GraphQL responses captured on the profile page. "
                "Instagram may have changed its query names (see TIMELINE_KEYS) or the profile did not render."
            )

        new_posts = list(posts_by_id.values())
        merged = merge(existing, new_posts)
        # Top up play counts while the logged-in tab is still open.
        _enrich_views(cdp, merged, ENRICH_CAP_FULL if full else ENRICH_CAP_INCREMENTAL, on_progress)
    finally:
        cdp.close_owned()
        cdp.detach()

    # Carousels and photos: engagement against followers, never against views.
    fixed = recompute_viewless_engagement(merged, followers)
    if on_progress and fixed:
        on_progress("viewless engagement recomputed", {"posts": fixed, "followers": followers})
    merged.sort(key=lambda p: p.get("date", "") or "0", reverse=True)
    out_file.parent.mkdir(parents=True, exist_ok=True)
    out_file.write_text(json.dumps(merged, indent=2))

    new_count = sum(1 for p in new_posts if p["id"] not in known_ids)
    return {
        "totalScraped": len(merged),
        "newPosts": new_count,
        "stoppedEarly": stopped_early,
        "lastPostId": merged[0]["id"] if merged else None,
        "followers": followers,
        "skippedForeign": skipped_foreign,
    }
