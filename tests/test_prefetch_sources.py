import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import prefetch_sources as p


def test_pending_skips_cached_and_is_sorted():
    assert p.pending({"b", "a", "c"}, {"b", "x"}) == ["a", "c"]


def test_column_values_pages(monkeypatch):
    pages = [[{"u": str(i)} for i in range(p.PAGE)], [{"u": "last"}, {"u": None}]]
    monkeypatch.setattr(p, "_get_json", lambda url, key: pages.pop(0))
    assert len(p.column_values("http://x", "k", "rows", "u")) == p.PAGE + 1


def test_rate_validated(monkeypatch, capsys):
    monkeypatch.setenv("SUPABASE_URL", "http://x")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "k")
    assert p.main(["--rate", "50"]) == 2
