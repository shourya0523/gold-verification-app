// The milestone rules: node --test tests/cheer.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { PERSONAL_STEPS, batchFinishers, catches, crossed, teamMilestones, today } from "../cheer.js";

test("a round number fires on the verdict that reaches it, and only then", () => {
  assert.equal(crossed(PERSONAL_STEPS, 49, 50), 50);
  assert.equal(crossed(PERSONAL_STEPS, 50, 51), null);
  assert.equal(crossed(PERSONAL_STEPS, 10, 11), null);
  assert.equal(crossed(PERSONAL_STEPS, 99, 100), 100);
});

test("team milestones: a tier at 100%, and each quarter of all gold", () => {
  const tiers = (p1, p2) => [
    { tier: "P1", rows: 10, verified_rows: p1 },
    { tier: "P2", rows: 30, verified_rows: p2 },
  ];
  assert.deepEqual(teamMilestones(tiers(9, 0)).map((m) => m.key), []);
  assert.deepEqual(teamMilestones(tiers(10, 0)).map((m) => m.key), ["tier:P1", "gold:25"]);
  assert.deepEqual(teamMilestones(tiers(10, 10)).map((m) => m.key), ["tier:P1", "gold:25", "gold:50"]);
  assert.deepEqual(teamMilestones(tiers(10, 30)).map((m) => m.key),
    ["tier:P1", "tier:P2", "gold:25", "gold:50", "gold:75", "gold:100"]);
});

test("a finished batch belongs to whoever gave its last unreviewed row a verdict", () => {
  const rows = [
    { gold_id: "a", batch_id: "b1" }, { gold_id: "b", batch_id: "b1" },
    { gold_id: "c", batch_id: "b2" }, { gold_id: "d", batch_id: "b2" },
  ];
  const verdicts = [
    { gold_id: "a", reviewer: "asha", created_at: "2026-10-01T10:00:00Z" },
    { gold_id: "b", reviewer: "ben", created_at: "2026-10-01T11:00:00Z" },
    // A second opinion later on a reviewed row does not take the batch.
    { gold_id: "a", reviewer: "cara", created_at: "2026-10-01T12:00:00Z" },
    { gold_id: "c", reviewer: "asha", created_at: "2026-10-01T10:00:00Z" },
  ];
  const out = batchFinishers(rows, verdicts);
  assert.equal(out.get("b1"), "ben");
  assert.equal(out.has("b2"), false, "b2 still has a row without a verdict");
});

test("a catch is a flag on a row resolved as needing a fix; confirming it is not", () => {
  const resolutions = [{ gold_id: "a", outcome: "gold_needs_fix" }, { gold_id: "b", outcome: "gold_correct" }];
  const verdicts = [
    { gold_id: "a", reviewer: "asha", verdict: "wrong_value" },
    { gold_id: "a", reviewer: "ben", verdict: "confirmed" },
    { gold_id: "b", reviewer: "ben", verdict: "wrong_period" },
  ];
  assert.deepEqual(catches(resolutions, verdicts), [{ gold_id: "a", reviewer: "asha" }]);
});

test("days are local calendar days", () => {
  assert.equal(today(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
});
