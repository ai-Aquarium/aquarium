import json

from app_mcp.ledger import CoverageLedger, ledger_path, load
from app_mcp.pages import page_template

SNOOZE = {"id": 3, "role": "button", "name": "Snooze", "section": "SuggestedTaskCard: Reply to Ada",
          "hint": "Snooze: opens a menu…"}
DISMISS = {"id": 4, "role": "button", "name": "Dismiss"}


def rows(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def test_ledger_lives_under_hermes_home(tmp_path):
    assert ledger_path(str(tmp_path)) == tmp_path / "app-mcp" / "coverage-ledger.jsonl"
    assert ledger_path("") is None


def test_rows_appear_after_a_snapshot_and_repeat_snapshots_append_nothing(tmp_path):
    path = ledger_path(str(tmp_path))
    ledger = CoverageLedger(path)
    assert ledger.observe("/", [SNOOZE, DISMISS]) == 2
    assert ledger.observe("/", [SNOOZE, DISMISS]) == 0
    written = rows(path)
    assert [(r["page"], r["role"], r["name"], r["hinted"]) for r in written] == [
        ("/", "button", "Snooze", True),
        ("/", "button", "Dismiss", False),
    ]
    assert "section" not in written[0]
    assert path.stat().st_mode & 0o777 == 0o600


def test_append_only_and_latest_row_wins_when_hinted_flips(tmp_path):
    path = ledger_path(str(tmp_path))
    CoverageLedger(path).observe("/", [DISMISS])
    reopened = CoverageLedger(path)
    assert reopened.observe("/", [DISMISS]) == 0
    assert reopened.observe("/", [{**DISMISS, "hint": "Removes it"}]) == 1
    assert len(rows(path)) == 2
    assert load(path)[("/", "button", "Dismiss")]["hinted"] is True
    assert reopened.gaps() == []


def test_gaps_list_unhinted_elements(tmp_path):
    ledger = CoverageLedger(ledger_path(str(tmp_path)))
    ledger.observe("/todos", [SNOOZE, DISMISS])
    assert [g["name"] for g in ledger.gaps()] == ["Dismiss"]


def test_dynamic_paths_fold_into_page_templates(tmp_path):
    path = ledger_path(str(tmp_path))
    ledger = CoverageLedger(path)
    ledger.observe("/todos/41", [DISMISS])
    ledger.observe("/todos/42", [DISMISS])
    assert [r["page"] for r in rows(path)] == ["/todos/[id]"]


def test_never_records_values_or_unnamed_elements(tmp_path):
    path = ledger_path(str(tmp_path))
    CoverageLedger(path).observe("/settings", [
        {"role": "textbox", "name": "Title", "value": "Ship it"},
        {"role": "button", "name": ""},
    ])
    (row,) = rows(path)
    assert "value" not in row and "Ship it" not in json.dumps(row)


def test_key_cap_bounds_growth(tmp_path):
    ledger = CoverageLedger(ledger_path(str(tmp_path)), max_keys=2)
    ledger.observe("/", [{"role": "button", "name": f"B{i}"} for i in range(5)])
    assert len(load(ledger.path)) == 2


def test_disabled_without_hermes_home_and_tolerates_io_errors(tmp_path):
    assert CoverageLedger(None).observe("/", [SNOOZE]) == 0
    blocker = tmp_path / "file"
    blocker.write_text("x")
    assert CoverageLedger(blocker / "app-mcp" / "l.jsonl").observe("/", [SNOOZE]) == 0


def test_page_template():
    assert page_template("/") == "/"
    assert page_template("/todos/42") == "/todos/[id]"
    assert page_template("/projects/new") == "/projects/new"
    assert page_template("/projects/acme/runs/3") == "/projects/[slug]/runs/[runNo]"
    assert page_template("/no/such/page") == "/no/such/page"


def test_duplicate_labels_with_mixed_hints_are_one_gap_and_do_not_churn(tmp_path):
    path = ledger_path(str(tmp_path))
    ledger = CoverageLedger(path)
    twins = [{**DISMISS, "hint": "Removes the suggestion"}, DISMISS]
    assert ledger.observe("/projects", twins) == 1
    assert ledger.observe("/projects", twins) == 0
    assert load(path)[("/projects", "button", "Dismiss")]["hinted"] is False


def test_lone_surrogate_from_a_clipped_emoji_never_breaks_the_snapshot(tmp_path):
    path = ledger_path(str(tmp_path))
    ledger = CoverageLedger(path)
    assert ledger.observe("/", [{"role": "button", "name": "Reply \ud83d"}]) == 1
    assert ("/", "button", "Reply \ud83d") in load(path)


def test_failed_write_is_retried_on_the_next_snapshot(tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("x")
    ledger = CoverageLedger(blocker / "app-mcp" / "l.jsonl")
    assert ledger.observe("/", [DISMISS]) == 0
    blocker.unlink()
    blocker.mkdir()
    assert ledger.observe("/", [DISMISS]) == 1


def test_private_section_text_is_not_recorded(tmp_path):
    path = ledger_path(str(tmp_path))
    CoverageLedger(path).observe("/", [SNOOZE])
    assert "Reply to Ada" not in path.read_text()
