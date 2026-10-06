"""Warm the source-preview cache so reviewers never wait on SEC.

Every document some gold row cites is requested once through the app's
`source` Edge Function, which stores it in the source-cache bucket. Documents
already cached are skipped without touching the host; only real fetches are
paced (default 2 per second, well under SEC's 10 per second limit).

    SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... \\
        python scripts/prefetch_sources.py --as you@company.com

Safe to stop and re-run: it resumes where the cache leaves off.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

PAGE = 1000


def _get_json(url: str, key: str):
    req = urllib.request.Request(url, headers={"apikey": key, "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.load(res)


def column_values(base: str, key: str, table: str, column: str) -> set[str]:
    """Every distinct non-null value of table.column, paging past the row cap."""
    found: set[str] = set()
    offset = 0
    while True:
        query = urllib.parse.urlencode({"select": column, "order": column, "offset": offset, "limit": PAGE})
        page = _get_json(f"{base}/rest/v1/{table}?{query}", key)
        found.update(r[column] for r in page if r.get(column))
        if len(page) < PAGE:
            return found
        offset += PAGE


def pending(cited: set[str], cached: set[str]) -> list[str]:
    return sorted(cited - cached)


def fetch_once(base: str, key: str, url: str, reviewer: str | None) -> str:
    """Ask the function for one document; returns 'hit' or 'miss'. Raises on failure."""
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    if reviewer:
        headers["x-reviewer"] = reviewer
    req = urllib.request.Request(f"{base}/functions/v1/source?url={urllib.parse.quote(url, safe='')}", headers=headers)
    with urllib.request.urlopen(req, timeout=120) as res:
        res.read()
        return res.headers.get("X-Source-Cache", "miss")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--as", dest="reviewer", help="a team_members email to declare to SEC as the contact")
    ap.add_argument("--rate", type=float, default=2.0, help="max host fetches per second (default 2)")
    ap.add_argument("--dry-run", action="store_true", help="list what would be fetched and stop")
    args = ap.parse_args(argv)

    base = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base or not key:
        print("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.", file=sys.stderr)
        return 2
    if not 0 < args.rate <= 5:
        print("--rate must be above 0 and at most 5 (SEC allows 10/s; stay well under).", file=sys.stderr)
        return 2

    todo = pending(column_values(base, key, "rows", "source_url"),
                   column_values(base, key, "source_cache", "url"))
    print(f"{len(todo)} document(s) to fetch")
    if args.dry_run:
        print("\n".join(todo))
        return 0

    gap = 1.0 / args.rate
    failed: list[str] = []
    for i, url in enumerate(todo, 1):
        started = time.monotonic()
        try:
            state = fetch_once(base, key, url, args.reviewer)
            print(f"[{i}/{len(todo)}] {state}  {url}")
        except (urllib.error.URLError, TimeoutError) as err:  # the function already backs off on 429/5xx
            print(f"[{i}/{len(todo)}] FAILED {url}: {err}", file=sys.stderr)
            failed.append(url)
        wait = gap - (time.monotonic() - started)
        if wait > 0:
            time.sleep(wait)
    if failed:
        print(f"{len(failed)} failed; re-run to retry them.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
