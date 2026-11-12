"""
Shared pieces for the readers that listen to a page's own feed requests
(facebook.py, x.py).

Both sites sign or token their GraphQL calls, so a replayed request is
refused. These readers never replay: they install a hook before any page
script runs (Page.addScriptToEvaluateOnNewDocument), scroll the page the way
a visitor would, and read the bodies the page itself received.

The buffer is drained on every round rather than left to grow, because one
Facebook feed body is about 1 MB and a long scroll would otherwise hold
hundreds of them inside the tab.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Iterator

from scrape.cdp import CDP

# %s is a JSON string: only responses whose URL contains it are kept.
_HOOK = """
(function () {
  if (window.__FEED_HOOK__) return;
  window.__FEED_HOOK__ = true;
  window.__FEED = [];
  var MATCH = %s;
  function keep(url, text) {
    try {
      if (String(url).indexOf(MATCH) >= 0 && text && text.length > 400) {
        window.__FEED.push(text);
        if (window.__FEED.length > 40) window.__FEED.shift();
      }
    } catch (e) {}
  }
  var origFetch = window.fetch;
  window.fetch = function (input) {
    var u = (typeof input === 'string') ? input : ((input && input.url) || '');
    return origFetch.apply(this, arguments).then(function (res) {
      try { res.clone().text().then(function (t) { keep(u, t); }); } catch (e) {}
      return res;
    });
  };
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__feed_url = u; return origOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    var self = this;
    this.addEventListener('load', function () {
      try { keep(self.__feed_url || '', self.responseText || ''); } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };
})()
"""


def hook_source(url_substring: str) -> str:
    return _HOOK % json.dumps(url_substring)


def drain(cdp: CDP) -> list[str]:
    """Take every captured body out of the tab and empty the buffer."""
    return cdp.evaluate("(window.__FEED || []).splice(0)") or []


def embedded_json(cdp: CDP, marker: str) -> list[str]:
    """The JSON the server put in the HTML itself (the first page of a feed
    usually arrives this way, before any request the hook could see)."""
    return cdp.evaluate(
        "Array.from(document.querySelectorAll('script[type=\"application/json\"]'))"
        ".map(s => s.textContent || '').filter(t => t.indexOf(%s) >= 0)" % json.dumps(marker)
    ) or []


def json_docs(text: str) -> Iterator[Any]:
    """Parse a body that is one JSON document or several, one per line
    (Facebook streams a feed page as newline-separated documents)."""
    text = (text or "").strip()
    if not text:
        return
    try:
        yield json.loads(text)
        return
    except json.JSONDecodeError:
        pass
    for line in text.split("\n"):
        line = line.strip()
        if not line or line[0] not in "{[":
            continue
        try:
            yield json.loads(line)
        except json.JSONDecodeError:
            continue


def walk(node: Any, match: Callable[[dict], bool]) -> Iterator[dict]:
    """Every dict under `node` that `match` accepts, outermost first. A
    matched dict is not searched further, so a post quoted or shared inside
    another post is not returned as a post of its own."""
    stack = [node]
    while stack:
        cur = stack.pop()
        if isinstance(cur, dict):
            if match(cur):
                yield cur
                continue
            stack.extend(cur.values())
        elif isinstance(cur, list):
            stack.extend(cur)


def find_key(node: Any, key: str) -> Iterator[Any]:
    """Every value stored under `key` anywhere below `node`, shallowest first."""
    queue = [node]
    while queue:
        cur = queue.pop(0)
        if isinstance(cur, dict):
            if key in cur:
                yield cur[key]
            queue.extend(cur.values())
        elif isinstance(cur, list):
            queue.extend(cur)


def first_key(node: Any, key: str, default: Any = None) -> Any:
    return next(find_key(node, key), default)
