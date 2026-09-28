#!/usr/bin/env python3
"""
BWP scrape runner: headless CLI, no HTTP server.

    python3 scrape/run.py                          # incremental, all platforms
    python3 scrape/run.py --platforms instagram,tiktok
    python3 scrape/run.py --full                   # master sweep: re-page everything
    python3 scrape/run.py --no-analyze             # skip analytics/vault rebuild
    python3 scrape/run.py --analyze-only           # just rebuild derived JSON

Talks to the ALREADY-RUNNING shared Chrome (CHROME_CDP_PORT, default 9222),
which carries Phil's logins. It opens its own tabs and closes them on every
exit path. Coordination with other Claude Code sessions goes through
`ccbrowser` (a `tab` lease is claimed for the duration and released after).

Exit codes:
    0  every requested platform scraped
    1  some platforms failed (others succeeded, derived files rebuilt)
    2  every platform failed, or refused to start (memory critical / no Chrome)
"""

from __future__ import annotations

import argparse
import atexit
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# Progress lines should appear live even when piped to tee / a log file.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(line_buffering=True)
    except (AttributeError, ValueError):
        pass

from scrape import analyze  # noqa: E402
from scrape.cdp import CDP, CDPError, default_port  # noqa: E402
from scrape.platforms import studio  # noqa: E402
from scrape.server import (  # noqa: E402
    PLATFORM_RUNNERS,
    PLATFORMS,
    load_scrape_state,
    record_platform_result,
    save_scrape_state,
)

LEASE_PURPOSE = "bwp-analytics scrape (scrape/run.py)"


# --------------------------------------------------------------------------
# ccbrowser coordination (optional: degrades to a warning when absent)
# --------------------------------------------------------------------------
def _ccbrowser_cmd() -> list[str] | None:
    """ccbrowser is a zsh function wrapping ~/.claude/chrome/ccbrowser.py."""
    script = Path.home() / ".claude" / "chrome" / "ccbrowser.py"
    if script.exists():
        return [sys.executable, str(script)]
    exe = shutil.which("ccbrowser")
    return [exe] if exe else None


def check_memory() -> None:
    cmd = _ccbrowser_cmd()
    if not cmd:
        return
    r = subprocess.run([*cmd, "mem"], capture_output=True, text=True)
    if r.returncode == 2:
        print("REFUSED: ccbrowser reports memory critical.", file=sys.stderr)
        print(r.stdout.strip() or r.stderr.strip(), file=sys.stderr)
        sys.exit(2)
    if r.returncode == 1:
        print(f"warning: memory pressure elevated: {r.stdout.strip()}", file=sys.stderr)


def claim_lease(url: str) -> str | None:
    cmd = _ccbrowser_cmd()
    if not cmd:
        print("warning: ccbrowser not found, running without a lease", file=sys.stderr)
        return None
    env = dict(os.environ)
    env.setdefault("CCBROWSER_OWNER", "bwp-analytics-scrape")
    r = subprocess.run(
        [*cmd, "claim", "tab", "--purpose", LEASE_PURPOSE, "--url", url],
        capture_output=True,
        text=True,
        env=env,
    )
    out = (r.stdout or "").strip()
    if r.returncode != 0:
        print(f"warning: ccbrowser claim failed ({r.returncode}): {out or r.stderr.strip()}", file=sys.stderr)
        return None
    # The lease name is the first token of the last non-empty stdout line.
    lines = [ln for ln in out.splitlines() if ln.strip()]
    name = lines[-1].split()[0] if lines else None
    if name:
        atexit.register(release_lease, name, env)
    return name


def release_lease(name: str, env: dict) -> None:
    cmd = _ccbrowser_cmd()
    if not cmd or not name:
        return
    subprocess.run([*cmd, "release", name], capture_output=True, text=True, env=env)


# --------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--platforms", default=",".join(PLATFORMS), help="comma-separated subset")
    ap.add_argument("--full", action="store_true", help="master sweep: ignore incremental early-stop")
    ap.add_argument("--no-analyze", action="store_true", help="skip rebuilding analytics/vault/history")
    ap.add_argument("--analyze-only", action="store_true", help="only rebuild derived JSON, no scraping")
    ap.add_argument("--quiet", action="store_true", help="suppress per-page progress lines")
    ap.add_argument("--no-studio", action="store_true",
                    help="skip the TikTok Studio and YouTube Studio pass that fills likes, comments and shares")
    args = ap.parse_args()

    if args.analyze_only:
        summary = analyze.run()
        print(f"analyze: {summary}")
        return 0

    platforms = [p.strip() for p in args.platforms.split(",") if p.strip()]
    bad = [p for p in platforms if p not in PLATFORM_RUNNERS]
    if bad:
        print(f"unknown platform(s): {', '.join(bad)}", file=sys.stderr)
        return 2

    check_memory()

    # Fail fast if Chrome is not reachable before claiming anything.
    try:
        CDP().list_tabs()
    except CDPError as e:
        print(f"REFUSED: {e}", file=sys.stderr)
        return 2

    claim_lease("https://www.instagram.com/")

    mode = "FULL SWEEP" if args.full else "incremental"
    print(f"bwp scrape [{mode}] on Chrome :{default_port()} -> {', '.join(platforms)}")

    state = load_scrape_state()
    errors: dict[str, str] = {}
    results: dict[str, dict] = {}
    t0 = time.time()

    for platform in platforms:
        runner = PLATFORM_RUNNERS[platform]
        started = time.time()

        def progress(stage: str, info: dict, _p=platform) -> None:
            if not args.quiet:
                brief = ", ".join(f"{k}={v}" for k, v in info.items() if k in (
                    "page", "round", "newPosts", "totalPosts", "consecutiveKnown", "reason"
                ))
                print(f"  [{_p}] {stage} {brief}")

        try:
            result = runner(on_progress=progress, full=args.full)
            record_platform_result(state, platform, result)
            save_scrape_state(state)
            results[platform] = result
            print(
                f"  {platform}: +{result.get('newPosts', 0)} new, "
                f"{result.get('totalScraped', 0)} total"
                f"{', stopped early' if result.get('stoppedEarly') else ''}"
                f"{', followers ' + str(result['followers']) if result.get('followers') else ''}"
                f"  ({time.time() - started:.0f}s)"
            )
            # The public page gives views only for these two; the signed-in
            # studio gives the rest. A studio failure (not signed in, layout
            # change) is reported but never undoes the base reader's result.
            if platform in studio.ENRICHERS and not args.no_studio:
                try:
                    stats = studio.ENRICHERS[platform](on_progress=progress)
                    result["studio"] = stats
                    print(f"  {platform} studio: {stats['matched']} posts matched, {stats['changed']} updated")
                except (CDPError, Exception) as e:  # noqa: BLE001
                    result["studioError"] = str(e)
                    print(f"  {platform} studio: SKIPPED {str(e)[:160]}", file=sys.stderr)
        except CDPError as e:
            errors[platform] = str(e)
            sub = state.get(platform, {}) or {}
            sub["status"] = "error"
            sub["lastError"] = str(e)
            state[platform] = sub
            save_scrape_state(state)
            print(f"  {platform}: FAILED {e}", file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            errors[platform] = f"{type(e).__name__}: {e}"
            print(f"  {platform}: FAILED {type(e).__name__}: {e}", file=sys.stderr)

    if results and not args.no_analyze:
        summary = analyze.run()
        print(f"analyze: {summary}")

    print(f"done in {time.time() - t0:.0f}s: {len(results)} ok, {len(errors)} failed")
    if errors and not results:
        return 2
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
