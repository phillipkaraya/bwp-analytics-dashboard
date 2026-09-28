#!/usr/bin/env python3
"""
BWP Scraper Service, port 5556

Stdlib-only HTTP service the dashboard's Refresh button calls to start
a re-scrape of Instagram / TikTok / YouTube / Threads data.

Tonight's build is a STUB: /scrape accepts a request, simulates work for
a configurable number of seconds, then writes a fresh `lastScrapedDate`
into `public/data/scrape_state.json` so the UI shows updated freshness.
The platform-by-platform scraping logic plugs into `run_scrape()` next
session — see TODO blocks below.

Run:
    python3 scrape/server.py

Endpoints:
    GET  /ping                     -> {"ok": true, "version": "0.1.0"}
    POST /scrape                   -> {"jobId": "...", "startedAt": "..."}
    GET  /scrape-status?id=<jobId> -> {"status": "running"|"complete"|"error", ...}
    GET  /jobs                     -> list of recent jobs
"""

from __future__ import annotations

import json
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

# Make `import scrape.*` work when running this file directly.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scrape import analyze  # noqa: E402
from scrape.cdp import CDPError  # noqa: E402
from scrape.platforms import instagram, linkedin, tiktok, youtube, threads  # noqa: E402

PORT = 5556
VERSION = "0.3.0"

# Resolve paths relative to this file so it works no matter where it's run from.
ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "public" / "data"
SCRAPE_STATE = DATA_DIR / "scrape_state.json"

# In-memory job registry. Restarting the server clears it — that's fine for the
# stub. A persistent store (sqlite or jobs/*.json) is a follow-up if needed.
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()

PLATFORMS = ["instagram", "tiktok", "youtube", "threads", "linkedin"]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_scrape_state() -> dict:
    if SCRAPE_STATE.exists():
        return json.loads(SCRAPE_STATE.read_text())
    return {}


def save_scrape_state(state: dict) -> None:
    SCRAPE_STATE.parent.mkdir(parents=True, exist_ok=True)
    SCRAPE_STATE.write_text(json.dumps(state, indent=2))


def update_job(job_id: str, **fields) -> None:
    with JOBS_LOCK:
        if job_id in JOBS:
            JOBS[job_id].update(fields)


# ---------------------------------------------------------------------------
# Platform runners ---------------------------------------------------------
# ---------------------------------------------------------------------------
# Each module's scrape() function:
#   - takes (max_pages: int, on_progress: callable | None)
#   - returns {"totalScraped": int, "lastPostId": str | None, ...}
#   - raises CDPError on failure
#
# Instagram is real (Chrome CDP via scrape/cdp.py). TikTok/YouTube/Threads
# are scaffolds — see their files for the plug-in checklist.
PLATFORM_RUNNERS = {
    "instagram": instagram.scrape,
    "tiktok": tiktok.scrape,
    "youtube": youtube.scrape,
    "threads": threads.scrape,
    "linkedin": linkedin.scrape,
}


def record_platform_result(state: dict, platform: str, result: dict) -> None:
    """Write one platform's scrape result into scrape_state (in place)."""
    sub = state.get(platform, {}) or {}
    sub["lastScrapedDate"] = now_iso()
    sub["status"] = "complete"
    sub.pop("lastError", None)
    if result.get("totalScraped") is not None:
        sub["totalScraped"] = result["totalScraped"]
    if result.get("lastPostId"):
        sub["lastPostId"] = result["lastPostId"]
    if result.get("newPosts") is not None:
        sub["lastRunNewPosts"] = result["newPosts"]
    state[platform] = sub
    followers = int(result.get("followers") or 0)
    if followers > 0:
        state.setdefault("followers", {})[platform] = followers
        # analyze.py only appends a follower_history point for days on which
        # at least one platform reported a fresh count.
        state.setdefault("followersUpdated", {})[platform] = now_iso()


def run_scrape(job_id: str, platforms: list[str], full: bool = False) -> None:
    """Worker thread — runs the platform scrapers sequentially and updates
    the in-memory job state + scrape_state.json as it goes, then rebuilds
    analytics.json / content_vault.json / follower_history.json."""
    update_job(job_id, status="running", currentPlatform=None, progress=0, mode="full" if full else "incremental")
    state = load_scrape_state()
    completed = 0
    errors: dict[str, str] = {}

    for platform in platforms:
        runner = PLATFORM_RUNNERS.get(platform)
        if not runner:
            continue
        update_job(job_id, currentPlatform=platform)

        def progress(stage: str, info: dict) -> None:
            update_job(job_id, currentStage=f"{platform}: {stage}", currentInfo=info)

        try:
            result = runner(on_progress=progress, full=full)
            record_platform_result(state, platform, result)
            save_scrape_state(state)
        except CDPError as e:
            errors[platform] = str(e)
            sub = state.get(platform, {}) or {}
            sub["status"] = "error"
            sub["lastError"] = str(e)
            state[platform] = sub
            save_scrape_state(state)
        except Exception as e:  # noqa: BLE001
            errors[platform] = f"{type(e).__name__}: {e}"

        completed += 1
        update_job(
            job_id,
            progress=int(completed / len(platforms) * 100),
            errors=errors if errors else None,
        )

    # Rebuild the derived files so Insights + Vault reflect the new posts.
    if len(errors) < len(platforms):
        update_job(job_id, currentStage="analyzing")
        try:
            analyze.run()
        except Exception as e:  # noqa: BLE001
            errors["analyze"] = f"{type(e).__name__}: {e}"

    final_status = "complete" if not errors else (
        "complete" if len(errors) < len(platforms) else "error"
    )
    update_job(
        job_id,
        status=final_status,
        currentPlatform=None,
        currentStage=None,
        progress=100,
        completedAt=now_iso(),
        errors=errors if errors else None,
    )


# ---------------------------------------------------------------------------
# HTTP layer ----------------------------------------------------------------
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self._cors()
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        url = urlparse(self.path)
        if url.path == "/ping":
            self._json(200, {"ok": True, "version": VERSION})
            return
        if url.path == "/scrape-status":
            qs = parse_qs(url.query)
            job_id = (qs.get("id") or [None])[0]
            if not job_id:
                self._json(400, {"error": "missing id"})
                return
            with JOBS_LOCK:
                job = JOBS.get(job_id)
            if not job:
                self._json(404, {"error": "job not found"})
                return
            self._json(200, job)
            return
        if url.path == "/jobs":
            with JOBS_LOCK:
                items = sorted(
                    JOBS.values(), key=lambda j: j.get("startedAt", ""), reverse=True
                )[:20]
            self._json(200, {"jobs": items})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        url = urlparse(self.path)
        if url.path != "/scrape":
            self._json(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length") or 0)
        body: dict = {}
        if length:
            try:
                body = json.loads(self.rfile.read(length))
            except json.JSONDecodeError:
                body = {}

        platforms = body.get("platforms") or PLATFORMS
        platforms = [p for p in platforms if p in PLATFORM_RUNNERS]
        if not platforms:
            self._json(400, {"error": "no valid platforms"})
            return
        full = body.get("mode") == "full"

        job_id = uuid.uuid4().hex[:12]
        # Incremental runs touch only the newest posts (~1 min/platform).
        # A full sweep re-pages everything (~3 min/platform, IG the longest).
        eta_seconds = (180 if full else 60) * len(platforms)
        job = {
            "id": job_id,
            "status": "queued",
            "mode": "full" if full else "incremental",
            "platforms": platforms,
            "startedAt": now_iso(),
            "etaSeconds": eta_seconds,
            "currentPlatform": None,
            "currentStage": None,
            "progress": 0,
            "isStub": False,
        }
        with JOBS_LOCK:
            JOBS[job_id] = job

        threading.Thread(
            target=run_scrape, args=(job_id, platforms, full), daemon=True
        ).start()
        self._json(200, job)

    def log_message(self, format, *args):  # noqa: A002
        # Keep stdout calm.
        return


def main() -> None:
    from scrape.cdp import default_port

    print(f"BWP Scraper service v{VERSION} on http://localhost:{PORT}")
    print(f"  data dir: {DATA_DIR}")
    print(f"  Chrome CDP port: {default_port()} (override with CHROME_CDP_PORT)")
    print("  platforms: instagram, tiktok, youtube, threads, linkedin (all real, Chrome-CDP)")
    print("  endpoints: GET /ping  POST /scrape {platforms?, mode?: 'full'}  GET /scrape-status?id=<jobId>")
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
