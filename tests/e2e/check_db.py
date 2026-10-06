"""After the app has loaded gold, compare what the database holds with gold.

    python check_db.py <psql-args...>

Reads gold independently (any seed/gold/*.jsonl row with a gold_id and a
source_url) and the database's current rows, and checks they are the same set
with the same figure, period, product, currency, source and quote. Also checks
the verdicts the browser run left behind. Exits non-zero on any difference.
"""

import json
import os
import subprocess
import sys
from decimal import Decimal
from pathlib import Path

GOLD = (Path(os.environ.get("WORKBENCH") or Path(__file__).resolve().parents[3] / "pharma-analog-uptake-workbench")
        / "seed" / "gold")
RESULT = Path(sys.argv[1])
PSQL = ["psql", "-At", *sys.argv[2:]]


def query(sql: str):
    out = subprocess.run([*PSQL, "-c", sql], check=True, capture_output=True, text=True).stdout.strip()
    return json.loads(out or "null")


def gold_claims() -> dict:
    claims = {}
    for path in GOLD.glob("*.jsonl"):
        for line in path.read_text().splitlines():
            if line.strip():
                row = json.loads(line)
                if row.get("gold_id") and row.get("source_url"):
                    claims[row["gold_id"]] = row
    return claims


def main() -> int:
    failures = []
    claims = gold_claims()
    rows = query("""select json_agg(json_build_object('gold_id', gold_id, 'value', value_reported::text,
        'period', period, 'drug', drug_name, 'currency', currency, 'url', source_url, 'quote', source_quote,
        'kind', kind)) from rows where in_current_gold""") or []
    db = {r["gold_id"]: r for r in rows}
    missing, extra = set(claims) - set(db), set(db) - set(claims)
    if missing or extra:
        failures.append(f"row sets differ: {len(missing)} missing, {len(extra)} extra "
                        f"(e.g. {sorted(missing)[:3]} {sorted(extra)[:3]})")
    mismatched = []
    for gold_id in set(claims) & set(db):
        g, d = claims[gold_id], db[gold_id]
        gv = g.get("value_reported")
        same_value = (gv is None and d["value"] is None) or (
            gv is not None and d["value"] is not None and Decimal(str(gv)) == Decimal(d["value"]))
        if not (same_value and d["period"] == (g.get("period") or "") and d["drug"] == g["drug_name"]
                and d["currency"] == (g.get("currency") or "") and d["url"] == g["source_url"]
                and d["quote"] == (g.get("source_quote") or "")):
            mismatched.append(gold_id)
    if mismatched:
        failures.append(f"{len(mismatched)} rows differ from gold, e.g. {mismatched[:3]}")
    kinds = query("select json_object_agg(kind, n) from (select kind, count(*) n from rows where in_current_gold group by kind) k")
    print(f"database rows {len(db)}, gold claims {len(claims)}, identical {len(set(claims) & set(db)) - len(mismatched)}; by kind {kinds}")

    run = json.loads(RESULT.read_text()) if RESULT.exists() else {}
    verdicts = query("select json_agg(json_build_object('gold_id', gold_id, 'reviewer', reviewer, 'verdict', verdict, "
                     "'seen', gold_value_seen::text, 'gold', (select value_reported::text from rows r where r.gold_id = v.gold_id))) from verdicts v") or []
    by = {(v["gold_id"], v["reviewer"]): v for v in verdicts}
    expect = [((run.get("confirmed"), "asha@team.test"), "confirmed"), ((run.get("flagged"), "asha@team.test"), "wrong_period")]
    for key, verdict in expect:
        v = by.get(key)
        if not v or v["verdict"] != verdict:
            failures.append(f"expected {verdict} for {key}, found {v}")
        elif v["seen"] != v["gold"]:
            failures.append(f"verdict {key} records gold value {v['seen']}, row has {v['gold']}")
    if len(verdicts) != 2:
        failures.append(f"expected 2 verdicts after the undo, found {len(verdicts)}")
    res = query("select json_agg(json_build_object('gold_id', gold_id, 'outcome', outcome, 'by', resolved_by)) from resolutions") or []
    if [(r["gold_id"], r["outcome"], r["by"]) for r in res] != [(run.get("flagged"), "gold_correct", "ben@team.test")]:
        failures.append(f"unexpected resolutions {res}")
    assigned = query("select json_agg(id) from batches where assignee = 'asha@team.test'") or []
    if len(assigned) != 1 + run.get("bulk", 0):
        failures.append(f"expected {1 + run.get('bulk', 0)} batches assigned to asha (1 by hand, the rest in bulk), found {len(assigned)}")
    p2_left = query("select count(*) from batches where tier = 'P2' and assignee is null")
    if run.get("bulk") and p2_left != 0:
        failures.append(f"bulk assign left {p2_left} P2 batches unassigned")
    claimed = query("select json_agg(id) from batches where assignee = 'ben@team.test'") or []
    if claimed != [run.get("claimed")]:
        failures.append(f"expected ben to have claimed {run.get('claimed')}, found {claimed}")

    # The workbook the Export Excel button produced.
    export = RESULT.parent / "export.xlsx"
    if not export.exists():
        failures.append("no exported workbook")
    else:
        from openpyxl import load_workbook
        book = load_workbook(export, read_only=True)
        sheet_rows = list(book["Rows"].iter_rows(values_only=True))
        head = sheet_rows[0]
        exported = {r[head.index("Gold ID")]: r for r in sheet_rows[1:]}
        if set(exported) != set(claims):
            failures.append(f"export Rows sheet differs from gold: {len(set(claims) - set(exported))} missing, "
                            f"{len(set(exported) - set(claims))} extra")
        wrong = [g for g, r in exported.items() if g in claims and not (
            (claims[g].get("value_reported") is None and r[head.index("Value Reported (millions)")] in (None, ""))
            or Decimal(str(claims[g].get("value_reported"))) == Decimal(str(r[head.index("Value Reported (millions)")])))]
        if wrong:
            failures.append(f"{len(wrong)} exported figures differ from gold, e.g. {wrong[:3]}")
        listed = list(book["Human Verdicts"].iter_rows(values_only=True))[1:]
        if len(listed) != len(verdicts):
            failures.append(f"export lists {len(listed)} verdicts, database has {len(verdicts)}")
        print(f"export: {len(exported)} rows, {len(listed)} verdicts, sheets {book.sheetnames}")

    for f in failures:
        print("FAIL ", f)
    if not failures:
        print("PASS  database holds exactly gold's sourced rows; verdicts, undo, resolution and assignment as driven")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
