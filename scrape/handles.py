"""Phillip Karaya / Build With Phil handles per platform.

Verified 2026-09-04: TikTok and YouTube both moved from the financewithphil
handle to phillip.karaya. YouTube is scraped by channel ID so a future
handle rename cannot break it; the handle is kept for display/URLs only.
"""

from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "public" / "data"

# Two sets of pages since 2026-11-11. "personal" is Phil's own profiles, the
# only set the dashboard knew until then. "brand" is the Build With Phil pages
# opened on 2026-09-30. A platform appears under an account only once a reader
# can scrape it, because the runner table in scrape/server.py is built from
# this dict.
ACCOUNTS = {
    "personal": {
        "instagram": "phillip.karaya",
        "tiktok": "phillip.karaya",
        "youtube": "@phillip.karaya",  # channel handle, prefixed with @
        "threads": "phillip.karaya",
        "linkedin": "phillip-karaya",  # vanity slug, hyphen (linkedin.com/in/phillip-karaya)
    },
    "brand": {
        "instagram": "buildaiwithphil",  # owner pk 28536850942
        "tiktok": "buildaiwithphil",
    },
}
ACCOUNT_LABELS = {"personal": "Phillip Karaya", "brand": "Build With Phil"}
DEFAULT_ACCOUNT = "personal"

# The personal handles under their old name; most readers still import this.
HANDLES = ACCOUNTS["personal"]


def handle_for(platform: str, account: str = DEFAULT_ACCOUNT) -> str:
    try:
        return ACCOUNTS[account][platform]
    except KeyError:
        raise KeyError(f"no {platform} handle for the {account!r} account in scrape/handles.py") from None


def data_file(platform: str, account: str = DEFAULT_ACCOUNT) -> Path:
    """Posts file for one platform of one account. Personal files keep the
    names they always had; every other account is prefixed with its name."""
    prefix = "" if account == DEFAULT_ACCOUNT else f"{account}_"
    return DATA_DIR / f"{prefix}{platform}_posts.json"

# Stable identifiers that survive handle renames.
YOUTUBE_CHANNEL_ID = "UCHTb2yDMGoptvmgxh49UniA"
INSTAGRAM_USER_ID = "5251656103"  # numeric pk; suffix of every ig_<media>_<pk> post id
LINKEDIN_PROFILE_URN = "urn:li:fsd_profile:ACoAABUgSl0BPoWwKKr0_GS9fchy_4QAuZGs_ds"  # survives a vanity rename
