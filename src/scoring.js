/**
 * Deal health scoring.
 *
 * A single number is easy to build and easy to game, so this one is deliberately
 * a sum of five observable signals rather than a model with weights nobody can
 * inspect. Each factor carries its own maximum, and `factors` is returned with
 * the score so the UI can show why a deal is red.
 *
 * Only open deals are scored. Won deals are done; lost deals are not health
 * problems, they are history.
 */

import { DAY, STAGES } from "./data.js";
import { staleInfo, daysInStage, daysSinceActivity } from "./forecast.js";

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

export const HEALTH_BANDS = [
  { id: "healthy", label: "Healthy", min: 70 },
  { id: "watch", label: "Watch", min: 45 },
  { id: "at-risk", label: "At risk", min: 0 },
];

function recencyPoints(daysSince) {
  if (daysSince <= 1) return 30;
  if (daysSince <= 3) return 26;
  if (daysSince <= 7) return 20;
  if (daysSince <= 14) return 12;
  if (daysSince <= 21) return 6;
  return 0;
}

function pacePoints(daysInStageValue, limit) {
  if (limit <= 0) return 0;
  const ratio = daysInStageValue / limit;
  if (ratio <= 0.5) return 25;
  if (ratio <= 1) return 18;
  if (ratio <= 1.5) return 8;
  return 0;
}

function momentumPoints(activities, now) {
  const last14 = activities.filter((a) => a.ts > now - 14 * DAY && a.ts <= now).length;
  const prev14 = activities.filter((a) => a.ts > now - 28 * DAY && a.ts <= now - 14 * DAY).length;
  if (last14 > prev14) return 20;
  if (last14 === prev14) return last14 > 0 ? 14 : 0;
  return 6;
}

function volumePoints(activities, now) {
  const recent = activities.filter((a) => a.ts > now - 30 * DAY && a.ts <= now).length;
  if (recent >= 4) return 15;
  if (recent === 3) return 12;
  if (recent === 2) return 8;
  if (recent === 1) return 4;
  return 0;
}

function nextStepPoints(deal, now) {
  if (!deal.nextStepAt) return { points: 0, note: "no next step set" };
  const daysUntil = Math.ceil((deal.nextStepAt - now) / DAY);
  if (daysUntil < 0) return { points: 4, note: `${-daysUntil}d overdue` };
  if (daysUntil <= 3) return { points: 10, note: daysUntil === 0 ? "due today" : `due in ${daysUntil}d` };
  return { points: 7, note: `due in ${daysUntil}d` };
}

/**
 * @param {object} deal
 * @param {object[]} activities  this deal's activities (or all of them; it filters)
 * @param {{now?: number, thresholds?: object}} [options]
 */
export function dealHealth(deal, activities = [], { now = Date.now(), thresholds = {} } = {}) {
  if (deal.status === "won") {
    return { score: 100, band: "healthy", factors: [], closed: true };
  }
  if (deal.status === "lost") {
    return { score: 0, band: "at-risk", factors: [], closed: true };
  }

  const own = activities.filter((a) => a.dealId === deal.id);
  const info = staleInfo(deal, { now, thresholds });
  const inStage = daysInStage(deal, now);
  const stageLabel = STAGES.find((s) => s.id === deal.stage)?.label ?? deal.stage;
  const next = nextStepPoints(deal, now);

  const factors = [
    {
      key: "activity",
      label: "Recent activity",
      points: recencyPoints(info.daysSince),
      max: 30,
      note: `${info.daysSince}d since the last touch`,
    },
    {
      key: "pace",
      label: "Stage pace",
      points: pacePoints(inStage, info.limit),
      max: 25,
      note: `${inStage}d in ${stageLabel}, limit ${info.limit}d`,
    },
    {
      key: "next",
      label: "Next step",
      points: next.points,
      max: 10,
      note: next.note,
    },
    {
      key: "momentum",
      label: "Momentum",
      points: momentumPoints(own, now),
      max: 20,
      note: "touches this fortnight vs the one before",
    },
    {
      key: "volume",
      label: "Engagement",
      points: volumePoints(own, now),
      max: 15,
      note: `${own.filter((a) => a.ts > now - 30 * DAY && a.ts <= now).length} touches in 30 days`,
    },
  ];

  const score = clamp(factors.reduce((sum, f) => sum + f.points, 0), 0, 100);
  const band = HEALTH_BANDS.find((b) => score >= b.min) ?? HEALTH_BANDS.at(-1);
  return { score, band: band.id, factors, closed: false };
}

/** Score every open deal and sort the risky ones first. */
export function riskiestDeals(deals, activities = [], options = {}) {
  return deals
    .filter((d) => d.status === "open")
    .map((deal) => ({ deal, ...dealHealth(deal, activities, options) }))
    .sort((a, b) => a.score - b.score);
}
