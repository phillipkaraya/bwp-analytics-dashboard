"""Phillip Karaya / Build With Phil handles per platform.

Verified 2026-09-04: TikTok and YouTube both moved from the financewithphil
handle to phillip.karaya. YouTube is scraped by channel ID so a future
handle rename cannot break it; the handle is kept for display/URLs only.
"""

HANDLES = {
    "instagram": "phillip.karaya",
    "tiktok": "phillip.karaya",
    "youtube": "@phillip.karaya",  # channel handle, prefixed with @
    "threads": "phillip.karaya",
    "linkedin": "phillip-karaya",  # vanity slug, hyphen (linkedin.com/in/phillip-karaya)
}

# Stable identifiers that survive handle renames.
YOUTUBE_CHANNEL_ID = "UCHTb2yDMGoptvmgxh49UniA"
INSTAGRAM_USER_ID = "5251656103"  # numeric pk; suffix of every ig_<media>_<pk> post id
LINKEDIN_PROFILE_URN = "urn:li:fsd_profile:ACoAABUgSl0BPoWwKKr0_GS9fchy_4QAuZGs_ds"  # survives a vanity rename
