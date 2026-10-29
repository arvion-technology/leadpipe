/**
 * Leadpipe forecast and pipeline maths.
 *
 * Pure functions over plain deal objects. Every function that depends on time
 * takes a `now` argument so a test can freeze the clock, the demo always
 * passes Date.now().
 *
 * The two ideas worth reading here:
 *   1. A deal's weight is its stage probability unless a salesperson has
 *      overridden it. `probabilityOf` is the single source of that rule.
 *   2. A deal is stale when it has gone quiet for longer than its stage
 *      allows. Staleness is per-stage, not global: a lead can sit for a week,
 *      a negotiation cannot.
 */

import { DAY, STAGES } from "./data.js";

export { DAY, STAGES };

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

export function startOfMonth(ts) {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export function addMonths(ts, n) {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1);
}

export function monthKey(ts) {
  return new Date(ts).toISOString().slice(0, 7);
}

export function monthLabel(ts) {
  const d = new Date(ts);
  return `${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${String(d.getUTCFullYear()).slice(2)}`;
}

export function daysBetween(from, to) {
  return Math.floor((to - from) / DAY);
}

export function stageOf(stageId) {
  return STAGES.find((s) => s.id === stageId) ?? null;
}

/** Stage probability, or the deal's explicit override, or 0/1 when closed. */
export function probabilityOf(deal) {
  if (deal.status === "won") return 1;
  if (deal.status === "lost") return 0;
  const fallback = stageOf(deal.stage)?.probability ?? 0;
  const p = typeof deal.probability === "number" ? deal.probability : fallback;
  return clamp(p, 0, 1);
}

/** Expected revenue for one deal, rounded to whole currency units. */
export function weightedValue(deal) {
  return Math.round(deal.value * probabilityOf(deal));
}

export function isOpen(deal) {
  return deal.status === "open";
}

export function dealAgeDays(deal, now = Date.now()) {
  return Math.max(0, daysBetween(deal.createdAt, now));
}

export function daysInStage(deal, now = Date.now()) {
  return Math.max(0, daysBetween(deal.stageEnteredAt, now));
}

export function daysSinceActivity(deal, now = Date.now()) {
  return Math.max(0, daysBetween(deal.lastActivityAt, now));
}

/**
 * Stale = quiet for longer than the stage's allowance.
 * Thresholds can be overridden per stage, e.g. { negotiation: 5 }.
 */
export function staleInfo(deal, { now = Date.now(), thresholds = {} } = {}) {
  if (!isOpen(deal)) return { stale: false, daysSince: 0, limit: 0, overBy: 0 };
  const stage = stageOf(deal.stage);
  const limit = thresholds[deal.stage] ?? stage?.staleAfter ?? 14;
  const daysSince = daysSinceActivity(deal, now);
  return { stale: daysSince > limit, daysSince, limit, overBy: Math.max(0, daysSince - limit) };
}

/** Open deals that have gone quiet, worst first. */
export function staleDeals(deals, options = {}) {
  return deals
    .filter(isOpen)
    .map((deal) => ({ ...staleInfo(deal, options), deal }))
    .filter((row) => row.stale)
    .sort((a, b) => b.overBy - a.overBy);
}

/** Headline numbers for the pipeline. */
export function pipelineSummary(deals, { now = Date.now(), thresholds = {} } = {}) {
  const open = deals.filter(isOpen);
  const value = open.reduce((a, d) => a + d.value, 0);
  const weighted = open.reduce((a, d) => a + weightedValue(d), 0);
  const ages = open.map((d) => dealAgeDays(d, now));
  const stale = staleDeals(deals, { now, thresholds }).length;
  const won = deals.filter((d) => d.status === "won");
  const lost = deals.filter((d) => d.status === "lost");
  return {
    openCount: open.length,
    openValue: value,
    weighted,
    avgDealValue: open.length ? Math.round(value / open.length) : 0,
    avgAgeDays: ages.length ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : 0,
    oldestDealDays: ages.length ? Math.max(...ages) : 0,
    staleCount: stale,
    wonValue: won.reduce((a, d) => a + d.value, 0),
    lostValue: lost.reduce((a, d) => a + d.value, 0),
  };
}

/** Counts and value per open stage, plus the win column for the board. */
export function stageBreakdown(deals, { now = Date.now(), thresholds = {} } = {}) {
  const open = deals.filter(isOpen);
  return STAGES.map((stage) => {
    const rows = open.filter((d) => d.stage === stage.id);
    return {
      id: stage.id,
      label: stage.label,
      probability: stage.probability,
      count: rows.length,
      value: rows.reduce((a, d) => a + d.value, 0),
      weighted: rows.reduce((a, d) => a + weightedValue(d), 0),
      avgDaysInStage: rows.length
        ? Math.round(rows.reduce((a, d) => a + daysInStage(d, now), 0) / rows.length)
        : 0,
      stale: rows.filter((d) => staleInfo(d, { now, thresholds }).stale).length,
    };
  });
}

/**
 * Monthly forecast, split three ways.
 *
 *   committed, deals in Negotiation, counted at full value
 *   weighted, every open deal at its probability
 *   pipeline, every open deal at full value (the ceiling)
 *
 * Deals whose close date has already passed fall into the current month and
 * are flagged `overdue`, rather than disappearing from the forecast.
 */
export function forecastByMonth(deals, { months = 6, now = Date.now(), quota = 180_000 } = {}) {
  const start = startOfMonth(now);
  const rows = Array.from({ length: months }, (_, i) => {
    const monthStart = addMonths(start, i);
    return {
      key: monthKey(monthStart),
      label: monthLabel(monthStart),
      monthStart,
      committed: 0,
      weighted: 0,
      pipeline: 0,
      won: 0,
      overdue: 0,
      deals: [],
      quota,
    };
  });

  for (const deal of deals) {
    if (deal.status === "won") {
      const idx = monthIndex(start, deal.wonAt);
      if (idx >= 0 && idx < months) rows[idx].won += deal.value;
      continue;
    }
    if (!isOpen(deal)) continue;
    let idx = monthIndex(start, deal.closeDate);
    const isOverdue = deal.closeDate < now;
    if (isOverdue) idx = 0;
    if (idx < 0 || idx >= months) continue;
    const row = rows[idx];
    row.weighted += weightedValue(deal);
    row.pipeline += deal.value;
    if (deal.stage === "negotiation") row.committed += deal.value;
    if (isOverdue) row.overdue++;
    row.deals.push(deal);
  }

  return rows.map((row) => ({ ...row, coverage: row.quota ? row.weighted / row.quota : 0 }));
}

function monthIndex(start, ts) {
  const d = new Date(ts);
  return (d.getUTCFullYear() - new Date(start).getUTCFullYear()) * 12 + (d.getUTCMonth() - new Date(start).getUTCMonth());
}

/** Closed deals inside the trailing window, used by win/loss and velocity. */
export function closedDeals(deals, { now = Date.now(), windowDays = 180 } = {}) {
  const from = now - windowDays * DAY;
  return deals.filter((d) => {
    const closedAt = d.status === "won" ? d.wonAt : d.status === "lost" ? d.lostAt : null;
    return closedAt !== null && closedAt !== undefined && closedAt >= from && closedAt <= now;
  });
}

/**
 * Win rate, reasons and cycle time.
 *
 * Win rate is reported by count and by value, they can disagree by a lot when
 * a team wins small deals and loses big ones, which is exactly what you want to
 * know before forecasting next quarter.
 */
export function winLoss(deals, { now = Date.now(), windowDays = 180 } = {}) {
  const closed = closedDeals(deals, { now, windowDays });
  const won = closed.filter((d) => d.status === "won");
  const lost = closed.filter((d) => d.status === "lost");
  const sum = (rows) => rows.reduce((a, d) => a + d.value, 0);

  const reasons = Object.entries(
    lost.reduce((acc, deal) => {
      const key = deal.lostReason || "Unrecorded";
      acc[key] ||= { count: 0, value: 0 };
      acc[key].count++;
      acc[key].value += deal.value;
      return acc;
    }, {})
  )
    .map(([reason, agg]) => ({ reason, ...agg }))
    .sort((a, b) => b.count - a.count || b.value - a.value);

  const bySource = [...new Set(deals.map((d) => d.source))].map((source) => {
    const rows = closed.filter((d) => d.source === source);
    const wins = rows.filter((d) => d.status === "won");
    return {
      source,
      won: wins.length,
      lost: rows.length - wins.length,
      value: wins.reduce((a, d) => a + d.value, 0),
      rate: rows.length ? wins.length / rows.length : 0,
    };
  }).sort((a, b) => b.value - a.value);

  const cycleDays = won.map((d) => Math.max(0, daysBetween(d.createdAt, d.wonAt)));

  return {
    windowDays,
    won: { count: won.length, value: sum(won) },
    lost: { count: lost.length, value: sum(lost) },
    winRate: won.length + lost.length ? won.length / (won.length + lost.length) : 0,
    winRateByValue: sum(won) + sum(lost) ? sum(won) / (sum(won) + sum(lost)) : 0,
    avgCycleDays: cycleDays.length ? Math.round(cycleDays.reduce((a, b) => a + b, 0) / cycleDays.length) : 0,
    reasons,
    bySource,
  };
}

/**
 * Sales velocity: how much revenue the current pipeline produces per day.
 *   velocity = (open deals × average deal value × win rate) / average cycle days
 * It is a rate, not a forecast, it tells you whether the pipeline is big
 * enough to hit quota, independent of close dates.
 */
export function salesVelocity(deals, { now = Date.now(), windowDays = 180 } = {}) {
  const { winRate, avgCycleDays } = winLoss(deals, { now, windowDays });
  const won = closedDeals(deals, { now, windowDays }).filter((d) => d.status === "won");
  const avgDealValue = won.length ? Math.round(won.reduce((a, d) => a + d.value, 0) / won.length) : 0;
  const openCount = deals.filter(isOpen).length;
  const perDay = avgCycleDays ? (openCount * avgDealValue * winRate) / avgCycleDays : 0;
  return {
    openCount,
    avgDealValue,
    winRate,
    avgCycleDays,
    perDay,
    perMonth: perDay * 30,
  };
}

/** Open value by deal age, for the "is the pipeline maturing" panel. */
export function agingBuckets(deals, { now = Date.now() } = {}) {
  const buckets = [
    { label: "0-30 days", min: 0, max: 30, count: 0, value: 0 },
    { label: "31-60 days", min: 31, max: 60, count: 0, value: 0 },
    { label: "61-90 days", min: 61, max: 90, count: 0, value: 0 },
    { label: "90+ days", min: 91, max: Infinity, count: 0, value: 0 },
  ];
  for (const deal of deals.filter(isOpen)) {
    const age = dealAgeDays(deal, now);
    const bucket = buckets.find((b) => age >= b.min && age <= b.max);
    bucket.count++;
    bucket.value += deal.value;
  }
  return buckets;
}

/** Per-owner pipeline, used by the owner filter and the leaderboard. */
export function byOwner(deals, { now = Date.now(), windowDays = 180 } = {}) {
  const owners = [...new Set(deals.map((d) => d.ownerId))];
  return owners
    .map((ownerId) => {
      const rows = deals.filter((d) => d.ownerId === ownerId);
      const open = rows.filter(isOpen);
      const won = closedDeals(rows, { now, windowDays }).filter((d) => d.status === "won");
      const lost = closedDeals(rows, { now, windowDays }).filter((d) => d.status === "lost");
      return {
        ownerId,
        openCount: open.length,
        openValue: open.reduce((a, d) => a + d.value, 0),
        weighted: open.reduce((a, d) => a + weightedValue(d), 0),
        wonValue: won.reduce((a, d) => a + d.value, 0),
        winRate: won.length + lost.length ? won.length / (won.length + lost.length) : 0,
      };
    })
    .sort((a, b) => b.weighted - a.weighted);
}

/** Follow-ups that are due or already late, soonest first. */
export function nextStepQueue(deals, { now = Date.now() } = {}) {
  return deals
    .filter((d) => isOpen(d) && d.nextStepAt)
    .map((deal) => {
      const daysUntil = Math.ceil((deal.nextStepAt - now) / DAY);
      return { deal, daysUntil, overdue: daysUntil < 0 };
    })
    .sort((a, b) => a.daysUntil - b.daysUntil);
}

/** One deal's timeline, newest first. */
export function timeline(activities, dealId) {
  return activities.filter((a) => a.dealId === dealId).sort((a, b) => b.ts - a.ts);
}

/** Activity volume by type for the last `days`. */
export function activitySummary(activities, { now = Date.now(), days = 30 } = {}) {
  const from = now - days * DAY;
  const recent = activities.filter((a) => a.ts >= from && a.ts <= now);
  const byType = {};
  for (const a of recent) byType[a.type] = (byType[a.type] || 0) + 1;
  return {
    total: recent.length,
    days,
    byType: Object.entries(byType).map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
    last7: activities.filter((a) => a.ts >= now - 7 * DAY && a.ts <= now).length,
  };
}

/**
 * How far the pipeline has progressed: a deal counts at stage N if it is at
 * stage N or past it. Closed deals keep the stage they were in when they
 * closed, which makes the counts monotonic.
 */
export function stageFunnel(deals) {
  const index = (deal) => STAGES.findIndex((s) => s.id === deal.stage);
  return STAGES.map((stage, i) => {
    const rows = deals.filter((d) => index(d) >= i);
    return {
      stage: stage.id,
      label: stage.label,
      count: rows.length,
      value: rows.reduce((a, d) => a + d.value, 0),
    };
  });
}

/** Escaped value for CSV output (kept next to the maths so tests cover it). */
export function toCSV(rows, columns) {
  const cols = columns || Object.keys(rows[0] || {});
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}
