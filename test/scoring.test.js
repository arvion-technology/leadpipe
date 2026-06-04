import test from "node:test";
import assert from "node:assert/strict";
import { DAY } from "../src/data.js";
import { dealHealth, riskiestDeals } from "../src/scoring.js";

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);

const makeDeal = (over = {}) => ({
  id: "D-1",
  value: 10000,
  stage: "proposal",
  status: "open",
  createdAt: NOW - 30 * DAY,
  stageEnteredAt: NOW - 3 * DAY,
  closeDate: NOW + 20 * DAY,
  lastActivityAt: NOW - 1 * DAY,
  nextStepAt: NOW + 2 * DAY,
  nextStep: "Send the SOW",
  ...over,
});

const act = (dealId, daysAgo, type = "email") => ({
  id: `${dealId}-${daysAgo}-${type}`,
  dealId,
  type,
  ts: NOW - daysAgo * DAY,
});

test("a well-worked deal scores 100 and lands in the healthy band", () => {
  const deal = makeDeal();
  const activities = [1, 2, 4, 6, 9].map((d) => act(deal.id, d));
  const health = dealHealth(deal, activities, { now: NOW });
  assert.equal(health.score, 100);
  assert.equal(health.band, "healthy");
  assert.equal(health.closed, false);
  assert.deepEqual(health.factors.map((f) => f.key), ["activity", "pace", "next", "momentum", "volume"]);
  assert.deepEqual(health.factors.map((f) => f.points), [30, 25, 10, 20, 15]);
});

test("a quiet deal with no next step scores zero and is at risk", () => {
  const deal = makeDeal({
    stage: "lead",
    stageEnteredAt: NOW - 20 * DAY,
    lastActivityAt: NOW - 24 * DAY,
    nextStepAt: null,
  });
  const health = dealHealth(deal, [], { now: NOW });
  assert.equal(health.score, 0);
  assert.equal(health.band, "at-risk");
  assert.equal(health.factors.find((f) => f.key === "next").note, "no next step set");
});

test("scores in the middle resolve to the watch band", () => {
  const deal = makeDeal({ stageEnteredAt: NOW - 7 * DAY, lastActivityAt: NOW - 10 * DAY, nextStepAt: NOW + 10 * DAY });
  const activities = [2, 16, 20, 25].map((d) => act(deal.id, d));
  const health = dealHealth(deal, activities, { now: NOW });
  assert.equal(health.score, 65);
  assert.equal(health.band, "watch");
});

test("an overdue next step scores less than one due soon", () => {
  const base = makeDeal({ lastActivityAt: NOW - 1 * DAY });
  const soon = dealHealth({ ...base, nextStepAt: NOW + 1 * DAY }, [], { now: NOW });
  const overdue = dealHealth({ ...base, nextStepAt: NOW - 2 * DAY }, [], { now: NOW });
  assert.equal(soon.factors[2].points, 10);
  assert.equal(overdue.factors[2].points, 4);
  assert.match(overdue.factors[2].note, /2d overdue/);
  assert.ok(overdue.score < soon.score);
});

test("closed deals skip scoring and other deals' activities are ignored", () => {
  assert.deepEqual(dealHealth({ ...makeDeal(), status: "won" }, [], { now: NOW }).score, 100);
  assert.deepEqual(dealHealth({ ...makeDeal(), status: "lost" }, [], { now: NOW }).score, 0);

  const deal = makeDeal({ lastActivityAt: NOW - 20 * DAY, nextStepAt: null });
  const stray = [1, 2, 3, 4, 5].map((d) => act("other-deal", d));
  const health = dealHealth(deal, stray, { now: NOW });
  assert.equal(health.factors.find((f) => f.key === "volume").points, 0);
});

test("riskiestDeals filters to open deals and sorts worst first", () => {
  const safe = makeDeal({ id: "safe" });
  const risky = makeDeal({ id: "risky", stage: "lead", stageEnteredAt: NOW - 30 * DAY, lastActivityAt: NOW - 30 * DAY, nextStepAt: null });
  const closed = makeDeal({ id: "closed", status: "won" });
  const rows = riskiestDeals([safe, risky, closed], [act("safe", 1)], { now: NOW });
  assert.deepEqual(rows.map((r) => r.deal.id), ["risky", "safe"]);
  assert.ok(rows[0].score < rows[1].score);
});
