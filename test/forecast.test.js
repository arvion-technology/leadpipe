import test from "node:test";
import assert from "node:assert/strict";
import {
  DAY, probabilityOf, weightedValue, staleInfo, staleDeals, dealAgeDays, daysInStage,
  pipelineSummary, stageBreakdown, forecastByMonth, winLoss, salesVelocity,
  agingBuckets, byOwner, nextStepQueue, timeline, activitySummary, stageFunnel,
  toCSV, startOfMonth, addMonths, monthKey, monthLabel,
} from "../src/forecast.js";
import { generatePipeline, STAGES } from "../src/data.js";

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0); // Wed 28 Oct 2026

const makeDeal = (over = {}) => ({
  id: "D-1",
  name: "Test deal",
  companyId: "c1",
  contactId: "p1",
  ownerId: "u1",
  value: 10000,
  stage: "proposal",
  status: "open",
  createdAt: NOW - 30 * DAY,
  stageEnteredAt: NOW - 10 * DAY,
  closeDate: NOW + 20 * DAY,
  lastActivityAt: NOW - 2 * DAY,
  nextStepAt: null,
  source: "Referral",
  ...over,
});

/* --------------------------------------------------------------- weights */

test("probabilityOf prefers the deal override and resolves closed states", () => {
  assert.equal(probabilityOf(makeDeal()), 0.5);
  assert.equal(probabilityOf(makeDeal({ probability: 0.35 })), 0.35);
  assert.equal(probabilityOf(makeDeal({ probability: 1.4 })), 1);
  assert.equal(probabilityOf(makeDeal({ status: "won" })), 1);
  assert.equal(probabilityOf(makeDeal({ status: "lost", probability: 0.9 })), 0);
  assert.equal(probabilityOf(makeDeal({ stage: "lead" })), STAGES[0].probability);
});

test("weightedValue is value times probability, rounded", () => {
  assert.equal(weightedValue(makeDeal({ value: 10000, stage: "proposal" })), 5000);
  assert.equal(weightedValue(makeDeal({ value: 12345, stage: "negotiation" })), 9259);
  assert.equal(weightedValue(makeDeal({ value: 10000, status: "won" })), 10000);
  assert.equal(weightedValue(makeDeal({ value: 10000, status: "lost" })), 0);
});

/* -------------------------------------------------------------- staleness */

test("staleness is per stage, not global", () => {
  const lead = makeDeal({ stage: "lead", lastActivityAt: NOW - 8 * DAY });
  const negotiation = makeDeal({ stage: "negotiation", lastActivityAt: NOW - 8 * DAY });
  assert.deepEqual(staleInfo(lead, { now: NOW }), {
    stale: true, daysSince: 8, limit: 7, overBy: 1,
  });
  assert.equal(staleInfo(negotiation, { now: NOW }).stale, false);
});

test("a won deal is never stale, and thresholds can be overridden", () => {
  assert.equal(staleInfo(makeDeal({ status: "won", lastActivityAt: NOW - 90 * DAY }), { now: NOW }).stale, false);
  const deal = makeDeal({ lastActivityAt: NOW - 2 * DAY });
  assert.equal(staleInfo(deal, { now: NOW, thresholds: { proposal: 1 } }).stale, true);
});

test("staleDeals only returns open quiet deals, worst first", () => {
  const deals = [
    makeDeal({ id: "a", stage: "lead", lastActivityAt: NOW - 10 * DAY }),
    makeDeal({ id: "b", stage: "lead", lastActivityAt: NOW - 9 * DAY }),
    makeDeal({ id: "c", stage: "negotiation", lastActivityAt: NOW - 9 * DAY }),
    makeDeal({ id: "d", status: "lost", lastActivityAt: NOW - 90 * DAY }),
  ];
  const rows = staleDeals(deals, { now: NOW });
  assert.deepEqual(rows.map((r) => r.deal.id), ["a", "b"]);
  assert.deepEqual(rows.map((r) => r.overBy), [3, 2]);
});

test("age helpers never go negative and use whole days", () => {
  assert.equal(dealAgeDays(makeDeal(), NOW), 30);
  assert.equal(daysInStage(makeDeal(), NOW), 10);
  assert.equal(dealAgeDays(makeDeal({ createdAt: NOW + 5 * DAY }), NOW), 0);
});

/* --------------------------------------------------------------- summary */

test("pipelineSummary ignores closed deals", () => {
  const deals = [
    makeDeal({ id: "a", value: 10000 }),
    makeDeal({ id: "b", stage: "lead", value: 20000 }),
    makeDeal({ id: "c", status: "won", value: 50000 }),
  ];
  const s = pipelineSummary(deals, { now: NOW });
  assert.equal(s.openCount, 2);
  assert.equal(s.openValue, 30000);
  assert.equal(s.weighted, 5000 + 2000);
  assert.equal(s.avgDealValue, 15000);
  assert.equal(s.staleCount, 0);
});

test("stageBreakdown reports counts, value and average stage age", () => {
  const deals = [
    makeDeal({ id: "a", value: 10000, stage: "lead", stageEnteredAt: NOW - 4 * DAY }),
    makeDeal({ id: "b", value: 20000, stage: "lead", stageEnteredAt: NOW - 8 * DAY }),
    makeDeal({ id: "c", value: 30000, stage: "proposal" }),
    makeDeal({ id: "d", status: "won", stage: "negotiation" }),
  ];
  const rows = stageBreakdown(deals, { now: NOW });
  const lead = rows.find((r) => r.id === "lead");
  assert.equal(lead.count, 2);
  assert.equal(lead.value, 30000);
  assert.equal(lead.avgDaysInStage, 6);
  assert.equal(rows.find((r) => r.id === "proposal").count, 1);
  assert.equal(rows.reduce((a, r) => a + r.count, 0), 3);
});

/* -------------------------------------------------------------- forecast */

test("forecast buckets deals by close month and splits the three totals", () => {
  const deals = [
    makeDeal({ id: "a", value: 10000, stage: "proposal", closeDate: NOW + 8 * DAY }), // November
    makeDeal({ id: "b", value: 20000, stage: "negotiation", closeDate: NOW + 23 * DAY }), // November
    makeDeal({ id: "c", value: 7000, stage: "lead", closeDate: NOW + 200 * DAY }), // beyond horizon
  ];
  const rows = forecastByMonth(deals, { months: 6, now: NOW, quota: 10000 });
  const november = rows[1];
  assert.equal(november.key, "2026-11");
  assert.equal(november.pipeline, 30000);
  assert.equal(november.weighted, 5000 + 15000);
  assert.equal(november.committed, 20000);
  assert.equal(november.overdue, 0);
  assert.equal(november.coverage, 2);
  assert.equal(rows.reduce((a, r) => a + r.pipeline, 0), 30000);
});

test("a passed close date falls into the current month and is flagged overdue", () => {
  const deals = [makeDeal({ value: 1000, stage: "lead", closeDate: NOW - 18 * DAY })];
  const rows = forecastByMonth(deals, { months: 3, now: NOW });
  assert.equal(rows[0].overdue, 1);
  assert.equal(rows[0].weighted, 100);
  assert.equal(rows[0].deals[0].id, "D-1");
});

test("forecast counts won revenue in the month it closed", () => {
  const deals = [
    makeDeal({ id: "w", status: "won", value: 40000, stage: "negotiation", wonAt: NOW - 5 * DAY }),
    makeDeal({ id: "old", status: "won", value: 9000, stage: "negotiation", wonAt: NOW - 90 * DAY }),
  ];
  const rows = forecastByMonth(deals, { months: 4, now: NOW });
  assert.equal(rows[0].won, 40000);
  assert.equal(rows.reduce((a, r) => a + r.won, 0), 40000);
  assert.equal(rows.reduce((a, r) => a + r.pipeline, 0), 0);
});

/* -------------------------------------------------------------- win / loss */

test("winLoss honours the trailing window and reports count and value rates", () => {
  const deals = [
    makeDeal({ id: "w", status: "won", value: 50000, wonAt: NOW - 10 * DAY, createdAt: NOW - 60 * DAY, source: "Referral" }),
    makeDeal({ id: "l", status: "lost", value: 30000, lostAt: NOW - 20 * DAY, lostReason: "Lost on price", source: "Referral" }),
    makeDeal({ id: "old", status: "lost", value: 90000, lostAt: NOW - 300 * DAY, lostReason: "Budget frozen" }),
  ];
  const result = winLoss(deals, { now: NOW, windowDays: 180 });
  assert.equal(result.won.count, 1);
  assert.equal(result.lost.count, 1);
  assert.equal(result.winRate, 0.5);
  assert.equal(result.winRateByValue, 50000 / 80000);
  assert.equal(result.avgCycleDays, 50);
  assert.deepEqual(result.reasons, [{ reason: "Lost on price", count: 1, value: 30000 }]);
  assert.deepEqual(result.bySource[0], {
    source: "Referral", won: 1, lost: 1, value: 50000, rate: 0.5,
  });

  const narrow = winLoss(deals, { now: NOW, windowDays: 15 });
  assert.equal(narrow.won.count, 1);
  assert.equal(narrow.lost.count, 0);
  assert.equal(narrow.winRate, 1);
});

test("sales velocity follows its formula with the current pipeline", () => {
  const deals = [
    makeDeal({ id: "w", status: "won", value: 50000, wonAt: NOW - 10 * DAY, createdAt: NOW - 60 * DAY }),
    makeDeal({ id: "l", status: "lost", value: 30000, lostAt: NOW - 20 * DAY }),
    makeDeal({ id: "o1", value: 10000 }),
    makeDeal({ id: "o2", value: 20000 }),
  ];
  const v = salesVelocity(deals, { now: NOW });
  assert.equal(v.avgDealValue, 50000);
  assert.equal(v.winRate, 0.5);
  assert.equal(v.avgCycleDays, 50);
  assert.equal(v.openCount, 2);
  assert.equal(v.perDay, 1000); // 2 * 50000 * 0.5 / 50
  assert.equal(v.perMonth, 30000);
});

test("aging buckets respect their boundaries", () => {
  const deals = [
    makeDeal({ value: 100, createdAt: NOW }),
    makeDeal({ value: 100, createdAt: NOW - 30 * DAY }),
    makeDeal({ value: 200, createdAt: NOW - 31 * DAY }),
    makeDeal({ value: 300, createdAt: NOW - 90 * DAY }),
    makeDeal({ value: 400, createdAt: NOW - 91 * DAY }),
  ];
  const rows = agingBuckets(deals, { now: NOW });
  assert.deepEqual(rows.map((r) => [r.count, r.value]), [[2, 200], [1, 200], [1, 300], [1, 400]]);
});

test("byOwner groups open and closed performance and sorts by weighted value", () => {
  const deals = [
    makeDeal({ id: "a", ownerId: "u1", value: 10000, stage: "proposal" }),
    makeDeal({ id: "b", ownerId: "u2", value: 40000, stage: "lead" }),
    makeDeal({ id: "c", ownerId: "u2", status: "won", value: 90000, wonAt: NOW - 10 * DAY }),
    makeDeal({ id: "d", ownerId: "u2", status: "lost", value: 10000, lostAt: NOW - 10 * DAY }),
  ];
  const rows = byOwner(deals, { now: NOW });
  assert.deepEqual(rows.map((r) => r.ownerId), ["u1", "u2"]);
  assert.equal(rows[0].openCount, 1);
  assert.equal(rows[0].openValue, 10000);
  assert.equal(rows[0].weighted, 5000);
  assert.equal(rows[0].wonValue, 0);
  assert.equal(rows[1].openCount, 1);
  assert.equal(rows[1].weighted, 4000);
  assert.equal(rows[1].wonValue, 90000);
  assert.equal(rows[1].winRate, 0.5);
});

/* ------------------------------------------------- follow-ups / activity */

test("nextStepQueue orders by due date and flags overdue follow-ups", () => {
  const deals = [
    makeDeal({ id: "late", nextStepAt: NOW - 2 * DAY }),
    makeDeal({ id: "soon", nextStepAt: NOW + 3 * DAY }),
    makeDeal({ id: "none", nextStepAt: null }),
    makeDeal({ id: "closed", status: "won", nextStepAt: NOW }),
  ];
  const rows = nextStepQueue(deals, { now: NOW });
  assert.deepEqual(rows.map((r) => r.deal.id), ["late", "soon"]);
  assert.deepEqual(rows.map((r) => r.daysUntil), [-2, 3]);
  assert.equal(rows[0].overdue, true);
});

test("timeline returns one deal's activities newest first", () => {
  const activities = [
    { id: "1", dealId: "a", type: "email", ts: 100 },
    { id: "2", dealId: "b", type: "call", ts: 300 },
    { id: "3", dealId: "a", type: "meeting", ts: 200 },
  ];
  assert.deepEqual(timeline(activities, "a").map((a) => a.id), ["3", "1"]);
  assert.deepEqual(timeline(activities, "missing"), []);
});

test("activitySummary windows the counts and groups by type", () => {
  const activities = [
    { type: "email", ts: NOW - 1 * DAY },
    { type: "email", ts: NOW - 3 * DAY },
    { type: "call", ts: NOW - 3 * DAY },
    { type: "email", ts: NOW - 40 * DAY },
  ];
  const s = activitySummary(activities, { now: NOW, days: 30 });
  assert.equal(s.total, 3);
  assert.deepEqual(s.byType, [{ type: "email", count: 2 }, { type: "call", count: 1 }]);
  assert.equal(s.last7, 3);
});

test("stageFunnel counts deals at or past each stage and never increases", () => {
  const deals = [
    makeDeal({ stage: "lead" }),
    makeDeal({ stage: "proposal" }),
    makeDeal({ stage: "negotiation" }),
    makeDeal({ stage: "negotiation", status: "won" }),
  ];
  const rows = stageFunnel(deals);
  assert.deepEqual(rows.map((r) => r.count), [4, 3, 3, 2]);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].count <= rows[i - 1].count);
});

/* ------------------------------------------------------------------ misc */

test("month helpers handle boundaries and year rollover", () => {
  assert.equal(startOfMonth(Date.UTC(2026, 9, 28, 12)), Date.UTC(2026, 9, 1));
  assert.equal(monthKey(addMonths(Date.UTC(2026, 11, 15), 1)), "2027-01");
  assert.equal(monthLabel(Date.UTC(2027, 0, 1)), "Jan 27");
  const rows = forecastByMonth([], { months: 3, now: NOW });
  assert.deepEqual(rows.map((r) => r.key), ["2026-10", "2026-11", "2026-12"]);
});

test("toCSV escapes commas and quotes", () => {
  const csv = toCSV([{ name: 'Acme, "Intl"', value: 10 }], ["name", "value"]);
  assert.equal(csv, 'name,value\n"Acme, ""Intl""",10');
});

/* --------------------------------------------------------------- dataset */

test("the seeded dataset is deterministic and internally consistent", () => {
  const a = generatePipeline({ seed: 7, now: NOW });
  const b = generatePipeline({ seed: 7, now: NOW });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.deals.length, 60);
  assert.ok(a.activities.length >= a.deals.length * 4); // stage entry + at least three touches
  assert.ok(a.activities.every((x) => x.ts >= NOW - 250 * DAY && x.ts <= NOW));
  for (const deal of a.deals) {
    assert.ok(a.activities.filter((x) => x.dealId === deal.id).length >= 4);
  }

  const deals = a.deals;
  assert.ok(deals.every((d) => d.value > 0 && STAGES.some((s) => s.id === d.stage)));
  assert.ok(deals.filter((d) => d.status === "open").every((d) => !d.lostReason && !d.wonAt));
  assert.ok(deals.filter((d) => d.status === "won").every((d) => d.wonAt > d.createdAt));
  assert.ok(deals.filter((d) => d.status === "lost").every((d) => d.lostReason && d.lostAt > d.createdAt));

  const timestamps = a.activities.map((x) => x.ts);
  assert.deepEqual(timestamps, [...timestamps].sort((x, y) => x - y));

  const other = generatePipeline({ seed: 8, now: NOW });
  assert.notEqual(JSON.stringify(other.deals), JSON.stringify(a.deals));
});
