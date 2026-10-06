"""Snapshot the verification app's verdicts into docs/sourcing/human_verdicts.json.

Two sources, same output:

    # straight from the Supabase project (service-role key, never committed)
    SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... \\
        python scripts/pull_verdicts.py --from-supabase

    # or from the CSV the app's Progress page downloads ("Download all verdicts")
    python scripts/pull_verdicts.py --from-csv gold-verdicts-2026-10-06.csv

It is written into the workbench checkout ($WORKBENCH, else a sibling folder),
where scripts/sourcing/build_verification_tracker.py reads it to fill the
tracker's reviewer columns. It is gold-side: the pipeline never reads it.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(os.environ.get("WORKBENCH") or Path(__file__).resolve().parents[2] / "pharma-analog-uptake-workbench")
OUT = REPO_ROOT / "docs" / "sourcing" / "human_verdicts.json"
PAGE = 1000

VERDICT_FIELDS = ("gold_id", "reviewer", "verdict", "value_seen", "gold_value_seen", "note", "updated_at")
RESOLUTION_FIELDS = ("gold_id", "outcome", "note", "resolved_by", "resolved_at")


def _number(value):
    if value in (None, ""):
        return None
    return float(value)


def from_supabase(url: str, key: str) -> dict:
    def table(name: str, order: str) -> list[dict]:
        out: list[dict] = []
        while True:
            request = urllib.request.Request(
                f"{url.rstrip('/')}/rest/v1/{name}?select=*&order={order}",
                headers={"apikey": key, "Authorization": f"Bearer {key}",
                         "Range-Unit": "items", "Range": f"{len(out)}-{len(out) + PAGE - 1}"},
            )
            with urllib.request.urlopen(request, timeout=60) as response:
                page = json.loads(response.read())
            out.extend(page)
            if len(page) < PAGE:
                return out

    return {
        "verdicts": [{f: v.get(f) for f in VERDICT_FIELDS} for v in table("verdicts", "gold_id,reviewer")],
        "resolutions": [{f: r.get(f) for f in RESOLUTION_FIELDS} for r in table("resolutions", "gold_id")],
        "team": {m["email"].lower(): m["display_name"] for m in table("team_members", "email")},
    }


def from_csv(path: Path) -> dict:
    """The app's export: one line per verdict, the row's resolution repeated on each."""
    verdicts, resolutions = [], {}
    with path.open(newline="", encoding="utf-8") as handle:
        for line in csv.DictReader(handle):
            verdicts.append({
                "gold_id": line["gold_id"], "reviewer": line["reviewer"], "verdict": line["verdict"],
                "value_seen": _number(line["value_seen"]), "gold_value_seen": _number(line["gold_value_seen"]),
                "note": line["note"], "updated_at": line["updated_at"],
            })
            if line.get("resolution"):
                resolutions[line["gold_id"]] = {
                    "gold_id": line["gold_id"], "outcome": line["resolution"],
                    "note": line.get("resolution_note", ""), "resolved_by": line.get("resolved_by", ""),
                    "resolved_at": None,
                }
    return {"verdicts": verdicts, "resolutions": list(resolutions.values()), "team": {}}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--from-supabase", action="store_true")
    source.add_argument("--from-csv", type=Path)
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()

    if args.from_supabase:
        url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not url or not key:
            parser.error("--from-supabase needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment")
        data, origin = from_supabase(url, key), url
    else:
        data, origin = from_csv(args.from_csv), str(args.from_csv.name)

    data["verdicts"].sort(key=lambda v: (v["gold_id"], v["reviewer"]))
    data["resolutions"].sort(key=lambda r: r["gold_id"])
    snapshot = {"exported_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "source": origin, **data}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(snapshot, indent=1) + "\n")
    print(f"wrote {args.out}: {len(data['verdicts'])} verdicts, {len(data['resolutions'])} resolutions")
    return 0


if __name__ == "__main__":
    sys.exit(main())
