"""The app's CSV download and the database give the same verdict snapshot."""

from __future__ import annotations

import importlib.util
from pathlib import Path

PULL = Path(__file__).resolve().parents[1] / "scripts" / "pull_verdicts.py"


def _pull():
    spec = importlib.util.spec_from_file_location("pull_verdicts", PULL)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_csv_reads_back_as_verdicts_and_resolutions(tmp_path):
    path = tmp_path / "gold-verdicts.csv"
    path.write_text(
        "gold_id,reviewer,verdict,value_seen,gold_value_seen,note,updated_at,resolution,resolution_note,resolved_by\n"
        'g1,a@team.test,wrong_value,1234.5,1200,"read the U.S., not total",2026-10-05T09:00:00Z,gold_correct,ok,b@team.test\n'
        "g2,a@team.test,confirmed,,98,,2026-10-05T09:01:00Z,,,\n")
    data = _pull().from_csv(path)
    assert [v["gold_id"] for v in data["verdicts"]] == ["g1", "g2"]
    assert data["verdicts"][0]["value_seen"] == 1234.5 and data["verdicts"][1]["value_seen"] is None
    assert data["verdicts"][0]["note"] == "read the U.S., not total"
    assert data["resolutions"] == [{"gold_id": "g1", "outcome": "gold_correct", "note": "ok",
                                    "resolved_by": "b@team.test", "resolved_at": None}]
