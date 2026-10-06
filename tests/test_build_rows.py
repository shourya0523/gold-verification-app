"""The verification app is served every checkable claim in gold, unchanged.

Run with WORKBENCH set to a pharma-analog-uptake-workbench checkout (or with
one beside this repository): pytest tests
"""

from __future__ import annotations

import importlib.util
import json
import os
from collections import Counter
from pathlib import Path

import pytest

APP = Path(__file__).resolve().parents[1]
GOLD = Path(os.environ.get("WORKBENCH") or APP.parent / "pharma-analog-uptake-workbench") / "seed" / "gold"


@pytest.fixture(scope="module")
def built() -> dict:
    spec = importlib.util.spec_from_file_location("build_rows", APP / "scripts" / "build_rows.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.build()


def gold_claims() -> dict[str, dict]:
    """Every gold row naming a source, read here without the builder's code."""
    claims = {}
    for path in GOLD.glob("*.jsonl"):
        for line in path.read_text().splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            if row.get("gold_id") and row.get("source_url"):
                assert row["gold_id"] not in claims, f"gold_id {row['gold_id']} appears twice in gold"
                claims[row["gold_id"]] = row
    return claims


def test_every_sourced_gold_row_is_served_once(built):
    served = Counter(r["gold_id"] for r in built["rows"])
    assert [g for g, n in served.items() if n > 1] == []
    claims = gold_claims()
    assert set(served) == set(claims), (
        f"missing {sorted(set(claims) - set(served))[:5]}, extra {sorted(set(served) - set(claims))[:5]}")


def test_served_figures_match_gold_exactly(built):
    claims = gold_claims()
    for row in built["rows"]:
        gold = claims[row["gold_id"]]
        assert row["value_reported"] == gold.get("value_reported"), row["gold_id"]
        assert row["source_url"] == gold["source_url"], row["gold_id"]
        assert row["source_quote"] == (gold.get("source_quote") or ""), row["gold_id"]
        assert row["period"] == (gold.get("period") or ""), row["gold_id"]
        assert row["drug_name"] == gold["drug_name"], row["gold_id"]
        assert row["currency"] == (gold.get("currency") or ""), row["gold_id"]


def test_every_kind_in_gold_is_represented(built):
    kinds = Counter(r["kind"] for r in built["rows"])
    # Both a scored kind and the unscored ones reach reviewers.
    assert {"quarterly", "annual", "companion", "exclusion"} <= set(kinds)
    assert all(r["value_reported"] is None for r in built["rows"] if r["kind"] == "exclusion")
    assert all(r["value_reported"] is not None for r in built["rows"] if r["kind"] != "exclusion")


def test_batches_partition_the_rows(built):
    batches = {b["id"]: b for b in built["batches"]}
    assert len(batches) == len(built["batches"]), "batch ids collide"
    per_batch = Counter(r["batch_id"] for r in built["rows"])
    assert set(per_batch) == set(batches)
    for batch_id, count in per_batch.items():
        assert batches[batch_id]["row_count"] == count
        assert count <= 25
    for row in built["rows"]:
        assert batches[row["batch_id"]]["tier"] == row["tier"]


def test_peak_inputs_are_first_priority(built):
    rows = {r["gold_id"]: r for r in built["rows"]}
    inputs = {g for line in (GOLD / "peak_sales.jsonl").read_text().splitlines() if line.strip()
              for g in json.loads(line).get("input_ids") or []}
    assert inputs and inputs <= set(rows)
    assert [g for g in inputs if rows[g]["tier"] != "P1"] == []


def test_a_derived_row_carries_the_parts_its_documents_print(built):
    """A bridge total is printed in neither document; the parts are, and they
    reach the app with their own documents and add up to the total."""
    claims = gold_claims()
    bridged = [r for r in built["rows"] if claims[r["gold_id"]].get("bridge_components")]
    assert bridged, "gold has no bridge rows: this test no longer checks anything"
    for row in bridged:
        parts = claims[row["gold_id"]]["bridge_components"]
        assert [(i["value"], i["source_url"]) for i in row["inputs"]] == [(p["value"], p["source_url"]) for p in parts]
        assert sum(i["value"] for i in row["inputs"]) == row["value_reported"], row["gold_id"]
    assert all(r["inputs"] == [] for r in built["rows"] if r not in bridged)
