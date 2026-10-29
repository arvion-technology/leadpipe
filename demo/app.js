// Leadpipe demo, rendering and interaction only.
// The pipeline maths lives in ../src/forecast.js and the dataset in
// ../src/data.js; both are the same files the test suite imports.
import {
  DAY, STAGES, LOST_REASONS, ACTIVITY_TYPES, generatePipeline,
} from "../src/data.js";
import {
  probabilityOf, weightedValue, pipelineSummary, stageBreakdown, forecastByMonth,
  winLoss, salesVelocity, agingBuckets, byOwner, nextStepQueue, timeline,
  activitySummary, staleDeals, staleInfo, daysInStage,
  daysSinceActivity, dealAgeDays, toCSV,
} from "../src/forecast.js";
import { dealHealth } from "../src/scoring.js";

const $ = A.$, $$ = A.$$, el = A.el, fmt = A.fmt;
const money0 = (v) => fmt.money(v, "USD", 0);
const moneyK = (v) => "$" + fmt.compact(v);
const STORE_KEY = "leadpipe";
const WON_DAYS = 60;

/* ------------------------------------------------------------------ state */

const state = {
  view: "pipeline",
  owner: "all",
  quota: 180_000,
  filters: { q: "", stage: "", status: "" },
  page: 0,
};

function freshData() {
  return generatePipeline({ now: Date.now() });
}

function restore() {
  const saved = A.store.get(STORE_KEY, null);
  if (saved && Array.isArray(saved.deals) && Array.isArray(saved.activities)) {
    return { ...freshData(), deals: saved.deals, activities: saved.activities };
  }
  return freshData();
}

let data = restore();
const persist = () => A.store.set(STORE_KEY, { deals: data.deals, activities: data.activities });

const owner = (id) => data.owners.find((o) => o.id === id) ?? { name: "Unassigned", initials: ", ", role: "" };
const company = (id) => data.companies.find((c) => c.id === id) ?? { name: ", ", sector: ", ", employees: 0, country: ", " };
const contact = (id) => data.contacts.find((c) => c.id === id) ?? { name: ", ", title: "", email: "" };
const dealLabel = (deal) => deal.name.split(", ").slice(1).join(", ") || deal.name;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function scopedDeals() {
  return state.owner === "all" ? data.deals : data.deals.filter((d) => d.ownerId === state.owner);
}

function openDrawerFor(id) {
  state.openDealId = id;
  renderDrawer();
  $("#drawer-backdrop").hidden = false;
}
function closeDrawer() {
  state.openDealId = null;
  $("#drawer-backdrop").hidden = true;
}

/* ------------------------------------------------------------- components */

function statCard({ label, value, sub, tone = "", spark }) {
  const color = tone === "green" ? "var(--green)" : tone === "red" ? "var(--red)" : tone === "blue" ? "#8fb4ff" : "var(--gold)";
  return el("div", { class: "card" },
    el("div", { class: "stat" },
      el("div", { class: "stat-label", text: label }),
      el("div", { class: "row", style: "align-items:baseline;gap:8px" },
        el("div", { class: "stat-value", style: `color:${color}`, text: value }),
        spark ? A.sparkline(spark, { width: 74, height: 24, color }) : null),
      el("div", { class: "small muted", text: sub })));
}

const stageBadge = (stage) => {
  const s = STAGES.find((x) => x.id === stage);
  return el("span", { class: "badge", text: s ? s.label : stage });
};

const statusBadge = (deal) => deal.status === "won"
  ? el("span", { class: "badge green", text: "won" })
  : deal.status === "lost"
    ? el("span", { class: "badge red", text: "lost" })
    : stageBadge(deal.stage);

/* ---------------------------------------------------------------- pipeline */

function dealCard(deal) {
  const now = Date.now();
  const won = deal.status === "won";
  const info = staleInfo(deal, { now });
  const days = won ? Math.max(0, Math.round((won ? now - deal.wonAt : now - deal.stageEnteredAt) / DAY)) : daysInStage(deal, now);
  const o = owner(deal.ownerId);
  return el("div", {
    class: `deal-card${info.stale ? " is-stale" : ""}${won ? " is-won" : ""}`,
    onclick: () => openDrawerFor(deal.id),
    title: `${deal.name} · ${money0(deal.value)}`,
  },
    el("div", { class: "deal-co", text: company(deal.companyId).name }),
    el("div", { class: "deal-name", text: dealLabel(deal) }),
    el("div", { class: "row", style: "margin-top:9px" },
      el("span", { class: "deal-value", text: money0(deal.value) }),
      el("span", { class: "spacer" }),
      el("span", { class: "avatar sm", title: o.name, text: o.initials })),
    el("div", { class: "deal-meta" },
      won
        ? el("span", { class: "flag ok", text: `won ${days}d ago` })
        : el("span", { class: `flag${info.stale ? "" : " ok"}`, text: `${days}d in stage` }),
      el("span", { class: "spacer" }),
      el("span", { class: "mono", text: won ? "100% closed" : `${Math.round(probabilityOf(deal) * 100)}% · ${moneyK(weightedValue(deal))}` })));
}

function renderPipeline() {
  const now = Date.now();
  const deals = scopedDeals();
  const summary = pipelineSummary(deals, { now });
  const recentWins = data.deals.filter((d) => d.status === "won" && d.wonAt >= now - WON_DAYS * DAY);
  const wonValue = recentWins.reduce((a, d) => a + d.value, 0);
  const stale = staleDeals(deals, { now });
  const followUps = nextStepQueue(deals, { now });

  $("#pipeline-kpis").replaceChildren(
    statCard({ label: "Open pipeline", value: moneyK(summary.openValue), sub: `${summary.openCount} open deals` }),
    statCard({ label: "Weighted value", value: moneyK(summary.weighted), sub: "each deal at its stage probability", tone: "blue" }),
    statCard({ label: `Won · ${WON_DAYS} days`, value: moneyK(wonValue), sub: `${recentWins.length} closed won`, tone: "green" }),
    statCard({ label: "Quiet deals", value: String(stale.length), sub: "no touch past the stage limit", tone: stale.length ? "red" : "green" }),
  );

  const board = $("#board");
  board.replaceChildren(...STAGES.map((stage) => {
    const rows = deals.filter((d) => d.status === "open" && d.stage === stage.id).sort((a, b) => b.value - a.value);
    const value = rows.reduce((a, d) => a + d.value, 0);
    return el("div", { class: "stage-col", "data-stage": stage.id },
      el("div", { class: "stage-head" },
        el("span", { class: "stage-name", text: stage.label }),
        el("span", { class: "stage-count", text: String(rows.length) }),
        el("span", { class: "stage-sum", text: moneyK(value) })),
      ...rows.slice(0, 3).map(dealCard),
      rows.length > 3
        ? el("button", {
          class: "more-link",
          onclick: () => { state.filters = { q: "", stage: stage.id, status: "open" }; location.hash = "#deals"; renderDeals(); },
          text: `+ ${rows.length - 3} more`,
        })
        : null,
      rows.length === 0 ? el("div", { class: "small muted center", style: "padding:16px 0", text: "Empty" }) : null);
  }), el("div", { class: "stage-col", "data-stage": "won" },
    el("div", { class: "stage-head" },
      el("span", { class: "stage-name", text: "Closed won" }),
      el("span", { class: "stage-count", text: String(recentWins.length) }),
      el("span", { class: "stage-sum", text: moneyK(wonValue) })),
    ...recentWins.sort((a, b) => b.wonAt - a.wonAt).slice(0, 3).map(dealCard),
    recentWins.length > 3 ? el("div", { class: "small muted center", style: "padding:6px 0", text: `+ ${recentWins.length - 3} more this quarter` }) : null,
    recentWins.length === 0 ? el("div", { class: "small muted center", style: "padding:16px 0", text: "Nothing yet" }) : null));

  const late = followUps.filter((r) => r.overdue);
  const chips = [
    ...stale.slice(0, 3).map((row) => el("span", { class: "attn", onclick: () => openDrawerFor(row.deal.id) },
      el("span", { class: "dot", style: "color:var(--red)" }),
      el("span", { text: `${company(row.deal.companyId).name} · ${row.daysSince}d quiet` }))),
    ...late.slice(0, 2).map((row) => el("span", { class: "attn", onclick: () => openDrawerFor(row.deal.id) },
      el("span", { class: "dot", style: "color:var(--amber)" }),
      el("span", { text: `${company(row.deal.companyId).name} · ${-row.daysUntil}d late` }))),
  ];
  $("#attention").replaceChildren(...[
    el("span", { class: "attn-label", text: "Needs attention" }),
    ...chips,
    chips.length === 0
      ? el("span", { class: "small muted", text: "Nothing overdue. Every open deal has a fresh touch and no follow-up is late." })
      : null,
    el("span", { class: "spacer" }),
    el("span", { class: "badge red", text: `${stale.length} quiet` }),
    el("span", { class: "badge gold", text: `${late.length} late` }),
  ].filter(Boolean));
}

/* ---------------------------------------------------------------- forecast */

function forecastRow(row) {
  const cov = row.coverage;
  const tone = cov >= 1 ? "green" : cov >= 0.6 ? "gold" : "red";
  return el("div", { class: "forecast-row" },
    el("div", { class: "month", text: row.label }),
    el("div", { class: "money commit", text: moneyK(row.committed) }),
    el("div", { class: "money weight", text: moneyK(row.weighted) }),
    el("div", { class: "money", text: moneyK(row.pipeline) }),
    el("div", { class: "cover" }, el("span", { class: `badge ${tone}`, text: fmt.pct(cov, 0) })));
}

function renderForecast() {
  const now = Date.now();
  const deals = scopedDeals();
  const rows = forecastByMonth(deals, { months: 5, now, quota: state.quota });
  const total = (key) => rows.reduce((a, r) => a + r[key], 0);
  const coverage = total("weighted") / (state.quota * rows.length);

  $("#forecast-kpis").replaceChildren(
    statCard({ label: "Committed · 5 months", value: moneyK(total("committed")), sub: "negotiation deals at full value", tone: "blue" }),
    statCard({ label: "Weighted · 5 months", value: moneyK(total("weighted")), sub: "probability applied" }),
    statCard({ label: "Pipeline ceiling", value: moneyK(total("pipeline")), sub: "if every open deal closed" }),
    statCard({ label: "Quota coverage", value: fmt.pct(coverage, 0), sub: `${money0(state.quota)} / month across 5 months`, tone: coverage >= 1 ? "green" : "red" }),
  );

  $("#forecast-sub").textContent = `weighted vs committed · ${moneyK(state.quota)} monthly quota`;
  $("#forecast-chart").replaceChildren(A.lineChart({
    series: [
      { name: "Weighted", data: rows.map((r) => r.weighted) },
      { name: "Committed", data: rows.map((r) => r.committed), color: "#3a7bff", area: false },
    ],
    labels: rows.map((r) => r.label),
    width: 720,
    height: 158,
    yFormat: moneyK,
  }));

  $("#forecast-table").replaceChildren(
    el("div", { class: "forecast-row head" },
      el("div", { text: "Month" }), el("div", { class: "money", text: "Committed" }),
      el("div", { class: "money", text: "Weighted" }), el("div", { class: "money", text: "Pipeline" }),
      el("div", { class: "cover", text: "Quota" })),
    ...rows.map(forecastRow),
    el("div", { class: "forecast-row", style: "border-top:1px solid var(--line)" },
      el("div", { class: "month", text: "Total" }),
      el("div", { class: "money commit", text: moneyK(total("committed")) }),
      el("div", { class: "money weight", text: moneyK(total("weighted")) }),
      el("div", { class: "money", text: moneyK(total("pipeline")) }),
      el("div", { class: "cover" }, el("span", { class: `badge ${coverage >= 1 ? "green" : "gold"}`, text: fmt.pct(coverage, 0) }))));

  const stages = stageBreakdown(deals, { now });
  $("#stage-panel").replaceChildren(A.barList({
    rows: stages.map((s) => ({ label: `${s.label} · ${s.count}`, value: s.value })),
    format: moneyK,
  }));

  $("#aging-panel").replaceChildren(A.barList({
    rows: agingBuckets(deals, { now }).map((b) => ({ label: `${b.label} · ${b.count}`, value: b.value })),
    format: moneyK,
    max: Math.max(...agingBuckets(deals, { now }).map((b) => b.value), 1),
  }));
}

/* ------------------------------------------------------------------- deals */

function filteredDeals() {
  const { q, stage, status } = state.filters;
  const needle = q.trim().toLowerCase();
  return data.deals.filter((deal) => {
    if (stage === "won" || stage === "lost") { if (deal.status !== stage) return false; }
    else if (stage && deal.stage !== stage) return false;
    if (status && deal.status !== status) return false;
    if (!needle) return true;
    return deal.name.toLowerCase().includes(needle) || company(deal.companyId).name.toLowerCase().includes(needle)
      || owner(deal.ownerId).name.toLowerCase().includes(needle);
  }).sort((a, b) => b.value - a.value);
}

function renderDeals() {
  const rows = filteredDeals();
  const perPage = 12;
  const pages = Math.max(1, Math.ceil(rows.length / perPage));
  state.page = Math.min(state.page, pages - 1);
  const slice = rows.slice(state.page * perPage, state.page * perPage + perPage);
  const now = Date.now();

  $("#deal-count").textContent = `${fmt.num(rows.length)} deals`;
  $("#deal-page-info").textContent = `Page ${state.page + 1} of ${pages} · ${moneyK(rows.reduce((a, d) => a + d.value, 0))} total value`;
  $("#deal-table").replaceChildren(A.dataTable({
    columns: [
      {
        label: "Deal",
        render: (r) => el("div", {},
          el("div", { class: "strong", text: dealLabel(r), style: "font-size:13px" }),
          el("div", { class: "small muted", text: company(r.companyId).name })),
      },
      { label: "Stage", render: statusBadge },
      { label: "Value", align: "right", render: (r) => el("span", { class: "mono", text: money0(r.value) }) },
      { label: "Weighted", align: "right", render: (r) => el("span", { class: "mono muted", text: money0(weightedValue(r)) }) },
      {
        label: "Owner",
        render: (r) => el("div", { class: "row", style: "gap:7px" },
          el("span", { class: "avatar sm", text: owner(r.ownerId).initials }),
          el("span", { class: "small", text: owner(r.ownerId).name.split(" ")[0] })),
      },
      { label: "Age", align: "right", render: (r) => el("span", { class: "mono small", text: `${dealAgeDays(r, now)}d` }) },
      {
        label: "Last touch", align: "right",
        render: (r) => el("span", { class: staleInfo(r, { now }).stale ? "small flag" : "small muted", text: `${daysSinceActivity(r, now)}d ago` }),
      },
      {
        label: "Next step", align: "right",
        render: (r) => r.status !== "open" ? el("span", { class: "small muted", text: ", " })
          : el("span", { class: "small", text: r.nextStep ?? "none set" }),
      },
    ],
    rows: slice,
    onRowClick: (r) => openDrawerFor(r.id),
    empty: "No deals match those filters.",
  }));
}

/* ---------------------------------------------------------------- accounts */

function renderAccounts() {
  const now = Date.now();
  const rows = data.companies.map((c) => {
    const deals = data.deals.filter((d) => d.companyId === c.id);
    const open = deals.filter((d) => d.status === "open");
    const lastTouch = deals.reduce((a, d) => Math.max(a, d.lastActivityAt), 0);
    return {
      company: c,
      openCount: open.length,
      openValue: open.reduce((a, d) => a + d.value, 0),
      weighted: open.reduce((a, d) => a + weightedValue(d), 0),
      lastTouch,
      contacts: data.contacts.filter((p) => p.companyId === c.id).length,
    };
  }).sort((a, b) => b.openValue - a.openValue);

  $("#company-table").replaceChildren(A.dataTable({
    columns: [
      {
        label: "Company",
        render: (r) => el("div", {},
          el("div", { class: "strong", text: r.company.name, style: "font-size:12.5px" }),
          el("div", { class: "small muted", text: `${r.company.sector} · ${fmt.num(r.company.employees)} staff` })),
      },
      { label: "Where", render: (r) => el("span", { class: "small muted", text: r.company.country }) },
      { label: "Open", align: "right", render: (r) => el("span", { class: "mono small", text: String(r.openCount) }) },
      { label: "Pipeline", align: "right", render: (r) => el("span", { class: "mono", text: moneyK(r.openValue) }) },
      { label: "Last touch", align: "right", render: (r) => el("span", { class: "small muted", text: r.lastTouch ? fmt.relative(r.lastTouch) : ", " }) },
    ],
    rows,
  }));

  $("#contact-count").textContent = `12 of ${data.contacts.length} contacts`;
  $("#contact-table").replaceChildren(A.dataTable({
    columns: [
      {
        label: "Name",
        render: (r) => el("div", { class: "row", style: "gap:8px" },
          el("span", { class: "avatar sm", text: fmt.initials(r.name) }),
          el("span", { class: "small", text: r.name })),
      },
      { label: "Title", render: (r) => el("span", { class: "small muted", text: r.title }) },
      { label: "Company", render: (r) => el("span", { class: "small muted", text: company(r.companyId).name }) },
    ],
    rows: data.contacts.slice(0, 12),
    empty: "No contacts.",
  }));

  const recent = [...data.activities].sort((a, b) => b.ts - a.ts).slice(0, 8);
  $("#activity-total").textContent = `${fmt.num(activitySummary(data.activities, { now, days: 30 }).total)} in 30 days`;
  $("#activity-feed").replaceChildren(...recent.map((a) => {
    const deal = data.deals.find((d) => d.id === a.dealId);
    return el("div", { class: "feed-row", style: "cursor:pointer", onclick: () => deal && openDrawerFor(deal.id) },
      el("span", { class: "mono small muted", text: fmt.date(a.ts) }),
      el("span", { class: `badge ${a.type === "meeting" ? "gold" : a.type === "stage" ? "purple" : a.type === "call" ? "blue" : ""}`, text: a.type }),
      el("span", { class: "small", text: a.summary }),
      el("span", { class: "small muted", style: "text-align:right", text: deal ? dealLabel(deal) : ", " }));
  }));
}

/* ----------------------------------------------------------------- reports */

function renderReports() {
  const now = Date.now();
  const deals = scopedDeals();
  const wl = winLoss(deals, { now, windowDays: 180 });
  const vel = salesVelocity(deals, { now, windowDays: 180 });

  $("#report-kpis").replaceChildren(
    statCard({ label: "Win rate · count", value: fmt.pct(wl.winRate, 0), sub: `${wl.won.count} won · ${wl.lost.count} lost` }),
    statCard({ label: "Win rate · value", value: fmt.pct(wl.winRateByValue, 0), sub: "revenue-weighted, last 180 days", tone: "blue" }),
    statCard({ label: "Average cycle", value: `${wl.avgCycleDays}d`, sub: "creation to close on won deals" }),
    statCard({ label: "Velocity", value: moneyK(vel.perMonth) + "/mo", sub: "pipeline revenue per month", tone: "green" }),
  );

  const slices = [
    { label: "Won", value: wl.won.value, color: "#34d399" },
    { label: "Lost", value: wl.lost.value, color: "#f87171" },
  ];
  $("#winloss-donut").replaceChildren(A.donut({
    slices,
    centerValue: fmt.pct(wl.winRateByValue, 0),
    centerLabel: "by value",
  }));
  $("#winloss-legend").replaceChildren(
    ...slices.map((s) => el("div", { class: "row", style: "gap:9px" },
      el("i", { style: `width:9px;height:9px;border-radius:3px;background:${s.color}` }),
      el("span", { text: s.label }),
      el("span", { class: "spacer" }),
      el("span", { class: "mono", text: moneyK(s.value) }))),
    el("div", { class: "divider", style: "margin:4px 0" }),
    el("div", { class: "row" },
      el("span", { class: "small muted", text: "Deals closed" }),
      el("span", { class: "spacer" }),
      el("span", { class: "mono", text: String(wl.won.count + wl.lost.count) })));

  const owners = byOwner(deals, { now });
  $("#owner-table").replaceChildren(A.dataTable({
    columns: [
      {
        label: "Owner",
        render: (r) => el("div", { class: "row", style: "gap:7px" },
          el("span", { class: "avatar sm", text: owner(r.ownerId).initials }),
          el("span", { class: "small", text: owner(r.ownerId).name })),
      },
      { label: "Open", align: "right", render: (r) => el("span", { class: "mono small", text: moneyK(r.weighted) }) },
      { label: "Won", align: "right", render: (r) => el("span", { class: "mono small", text: moneyK(r.wonValue) }) },
      { label: "Win rate", align: "right", render: (r) => el("span", { class: "badge " + (r.winRate >= 0.5 ? "green" : "gold"), text: fmt.pct(r.winRate, 0) }) },
    ],
    rows: owners,
  }));

  $("#lost-reasons").replaceChildren(A.barList({
    rows: wl.reasons.slice(0, 5).map((r) => ({ label: `${r.reason} · ${r.count}`, value: r.value })),
    format: moneyK,
  }));

  $("#velocity-panel").replaceChildren(el("dl", { class: "kv" },
    el("dt", { text: "Open deals" }), el("dd", { class: "mono", text: String(vel.openCount) }),
    el("dt", { text: "Average deal" }), el("dd", { class: "mono", text: money0(vel.avgDealValue) }),
    el("dt", { text: "Win rate" }), el("dd", { class: "mono", text: fmt.pct(vel.winRate, 0) }),
    el("dt", { text: "Cycle length" }), el("dd", { class: "mono", text: `${vel.avgCycleDays} days` }),
    el("dt", { text: "Velocity" }), el("dd", { class: "mono", text: `${moneyK(vel.perDay)} / day` }),
    el("dt", { text: "Per month" }), el("dd", { class: "mono", text: moneyK(vel.perMonth) })));

  $("#source-table").replaceChildren(A.dataTable({
    columns: [
      { label: "Source", render: (r) => el("span", { class: "strong", text: r.source }) },
      { label: "Won", align: "right", render: (r) => el("span", { class: "mono small", text: String(r.won) }) },
      { label: "Lost", align: "right", render: (r) => el("span", { class: "mono small", text: String(r.lost) }) },
      { label: "Won value", align: "right", render: (r) => el("span", { class: "mono", text: moneyK(r.value) }) },
      {
        label: "Rate", align: "right",
        render: (r) => el("span", { class: "badge " + (r.rate >= 0.5 ? "green" : r.rate >= 0.3 ? "gold" : "red"), text: fmt.pct(r.rate, 0) }),
      },
    ],
    rows: wl.bySource,
  }));
}

/* ------------------------------------------------------------------ drawer */

function renderDrawer() {
  const deal = data.deals.find((d) => d.id === state.openDealId);
  if (!deal) { closeDrawer(); return; }
  const now = Date.now();
  const companyRow = company(deal.companyId);
  const o = owner(deal.ownerId);
  const info = staleInfo(deal, { now });
  const health = dealHealth(deal, data.activities, { now });
  const activities = timeline(data.activities, deal.id).slice(0, 14);
  const healthTone = health.band === "healthy" ? "green" : health.band === "watch" ? "gold" : "red";

  const stageRail = el("div", { class: "stage-rail" },
    ...STAGES.map((stage) => {
      const index = STAGES.findIndex((s) => s.id === stage.id);
      const currentIndex = STAGES.findIndex((s) => s.id === deal.stage);
      const cls = deal.status === "open" && stage.id === deal.stage
        ? "current"
        : deal.status !== "open" || currentIndex > index ? "done" : "";
      return el("button", {
        class: `stage-pill ${cls}`,
        disabled: deal.status !== "open" ? "" : null,
        onclick: () => moveStage(deal.id, stage.id),
        text: `${stage.label} ${Math.round(stage.probability * 100)}%`,
      });
    }));

  const head = el("div", {},
    el("div", { class: "drawer-head" },
      el("div", {},
        el("div", { class: "eyebrow", style: "margin-bottom:4px", text: companyRow.name }),
        el("h2", { id: "drawer-title", text: dealLabel(deal) })),
      el("button", { class: "btn ghost icon close", "aria-label": "Close", onclick: closeDrawer, text: "✕" })),
    el("div", { class: "row wrap", style: "margin-bottom:14px" },
      el("span", { class: "stat-value gold", style: "font-size:26px", text: money0(deal.value) }),
      el("span", { class: "badge blue", text: `${moneyK(weightedValue(deal))} weighted` }),
      deal.status === "open" ? stageBadge(deal.stage) : statusBadge(deal),
      info.stale ? el("span", { class: "badge red", text: `${info.daysSince}d quiet` }) : null),
    el("dl", { class: "kv" },
      el("dt", { text: "Owner" }), el("dd", { text: `${o.name} · ${o.role}` }),
      el("dt", { text: "Primary contact" }), el("dd", { text: contact(deal.contactId).name }),
      el("dt", { text: "Source" }), el("dd", { text: deal.source }),
      el("dt", { text: "Created" }), el("dd", { text: fmt.date(deal.createdAt) }),
      el("dt", { text: "Expected close" }), el("dd", { text: fmt.date(deal.closeDate) }),
      el("dt", { text: "Age" }), el("dd", { text: plural(dealAgeDays(deal, now), "day") }),
      el("dt", { text: "Last touch" }), el("dd", { text: `${plural(daysSinceActivity(deal, now), "day")} ago` }),
      deal.status === "lost" ? el("dt", { text: "Lost reason" }) : null,
      deal.status === "lost" ? el("dd", { text: deal.lostReason }) : null));

  const actions = deal.status === "open"
    ? el("div", { class: "row", style: "margin:16px 0 4px;gap:8px" },
      el("button", { class: "btn primary sm", onclick: () => markWon(deal.id), text: "Mark won" }),
      el("button", { class: "btn danger sm", onclick: () => askLost(deal.id), text: "Mark lost" }),
      el("span", { class: "spacer" }),
      el("span", { class: "small muted", text: `No touch in ${info.daysSince}d` }))
    : el("div", { class: "row", style: "margin:16px 0 4px" },
      el("span", { class: "badge " + (deal.status === "won" ? "green" : "red"), text: deal.status === "won" ? `Won ${fmt.date(deal.wonAt)}` : `Lost ${fmt.date(deal.lostAt)}` }),
      el("span", { class: "spacer" }),
      el("button", { class: "btn sm ghost", onclick: () => reopen(deal.id), text: "Reopen deal" }));

  const logForm = deal.status === "open"
    ? el("div", { class: "log-form" },
      el("select", { class: "select", id: "log-type", "aria-label": "Activity type" },
        ...ACTIVITY_TYPES.filter((t) => t !== "stage").map((t) => el("option", { value: t, text: t }))),
      el("input", { class: "input", id: "log-note", placeholder: "What happened?", "aria-label": "Activity note" }),
      el("button", { class: "btn sm", id: "log-save", onclick: () => logActivity(deal.id), text: "Log" }))
    : null;

  $("#drawer-body").replaceChildren(
    head,
    el("div", { class: "divider", style: "margin:16px 0 10px" }),
    el("div", { class: "stage-head", style: "border:0;padding:0;margin-bottom:2px" },
      el("span", { class: "stage-name", text: "Stage" }),
      el("span", { class: "spacer" }),
      el("span", { class: "small muted", text: deal.status === "open" ? "click to move" : "closed" })),
    stageRail,
    actions,
    health.closed ? null : el("div", { class: "health-panel" },
      el("div", { class: "row", style: "margin-bottom:8px" },
        el("span", { class: "card-title", style: "font-size:12.5px", text: "Deal health" }),
        el("span", { class: "spacer" }),
        el("span", { class: `badge ${healthTone}`, text: `${health.score} · ${health.band.replace("-", " ")}` })),
      ...health.factors.map((f) => el("div", { style: "margin-bottom:7px" },
        el("div", { class: "row", style: "font-size:10.5px;color:var(--muted);margin-bottom:3px;gap:6px" },
          el("span", { style: "color:var(--text-2);font-weight:600", text: f.label }),
          el("span", { class: "nowrap", style: "overflow:hidden;text-overflow:ellipsis", text: f.note }),
          el("span", { class: "spacer" }),
          el("span", { class: "mono nowrap", text: `${f.points}/${f.max}` })),
        el("div", { class: "progress" + (healthTone === "green" ? " green" : ""), style: "height:5px" },
          el("i", { style: `width:${(f.points / f.max) * 100}%;${healthTone === "red" ? "background:linear-gradient(90deg,#b91c1c,#f87171)" : ""}` }))))),
    el("div", { class: "divider", style: "margin:16px 0 12px" }),
    el("div", { class: "card-head", style: "margin-bottom:10px" },
      el("div", { class: "card-title", text: "Activity" }),
      el("span", { class: "spacer" }),
      el("span", { class: "small muted", text: `${activities.length} entries` })),
    logForm,
    el("div", { class: "timeline", style: "margin-top:16px" },
      ...activities.map((a) => el("div", { class: "tl-item" },
        el("span", { class: `tl-dot ${a.type}` }),
        el("div", { class: "tl-when", text: `${fmt.date(a.ts)} · ${fmt.relative(a.ts)} · ${owner(a.by).initials}` }),
        el("div", { class: "tl-what", text: a.summary })))),
  );
  const note = $("#log-note");
  if (note) note.addEventListener("keydown", (e) => { if (e.key === "Enter") logActivity(deal.id); });
}

/* ----------------------------------------------------------------- actions */

function addActivity(deal, type, summary) {
  const now = Date.now();
  data.activities.push({
    id: `local-${deal.id}-${now}-${Math.random().toString(36).slice(2, 6)}`,
    dealId: deal.id, companyId: deal.companyId, type, ts: now, by: deal.ownerId, summary,
  });
  deal.lastActivityAt = now;
}

function afterMutation(message) {
  persist();
  route();
  renderDrawer();
  if (message) A.toast(message, "success", 1800);
}

function moveStage(id, stage) {
  const deal = data.deals.find((d) => d.id === id);
  if (!deal || deal.status !== "open" || deal.stage === stage) return;
  deal.stage = stage;
  deal.stageEnteredAt = Date.now();
  addActivity(deal, "stage", `Entered ${STAGES.find((s) => s.id === stage).label}`);
  afterMutation(`Moved to ${STAGES.find((s) => s.id === stage).label}`);
}

function logActivity(id) {
  const deal = data.deals.find((d) => d.id === id);
  if (!deal) return;
  const type = $("#log-type")?.value ?? "note";
  const text = ($("#log-note")?.value ?? "").trim();
  if (!text) { A.toast("Add a short note first", "error", 1600); return; }
  addActivity(deal, type, text);
  afterMutation("Activity logged");
}

function markWon(id) {
  const deal = data.deals.find((d) => d.id === id);
  if (!deal) return;
  const now = Date.now();
  deal.status = "won";
  deal.wonAt = now;
  deal.closeDate = now;
  deal.nextStep = null;
  deal.nextStepAt = null;
  addActivity(deal, "stage", "Moved to closed won");
  afterMutation("Deal marked won");
}

function reopen(id) {
  const deal = data.deals.find((d) => d.id === id);
  if (!deal) return;
  deal.status = "open";
  deal.stage = "proposal";
  deal.stageEnteredAt = Date.now();
  delete deal.wonAt;
  delete deal.lostAt;
  delete deal.lostReason;
  addActivity(deal, "stage", "Reopened at Proposal");
  afterMutation("Deal reopened");
}

function askLost(id) {
  const deal = data.deals.find((d) => d.id === id);
  if (!deal) return;
  const select = el("select", { class: "select", id: "lost-reason" },
    ...LOST_REASONS.map((reason) => el("option", { value: reason, text: reason })));
  A.modal({
    title: "Mark deal lost",
    body: el("div", { class: "col", style: "gap:12px" },
      el("p", { class: "small muted mb-0", text: "The reason is counted in the win/loss report. Recording it now is cheaper than guessing later." }),
      select),
    actions: [
      { label: "Cancel" },
      {
        label: "Mark lost", kind: "danger", onClick: () => {
          const reason = $("#lost-reason")?.value ?? LOST_REASONS[0];
          const now = Date.now();
          deal.status = "lost";
          deal.lostAt = now;
          deal.closeDate = now;
          deal.lostReason = reason;
          deal.nextStep = null;
          deal.nextStepAt = null;
          addActivity(deal, "stage", `Marked lost, ${reason}`);
          afterMutation("Deal marked lost");
        },
      },
    ],
  });
}

/* ----------------------------------------------------------------- routing */

const VIEWS = ["pipeline", "forecast", "deals", "accounts", "reports"];

function route() {
  const [requested, dealParam] = (location.hash || "#pipeline").slice(1).split("/");
  state.view = VIEWS.includes(requested) ? requested : "pipeline";
  $$("[data-view-panel]").forEach((panel) => { panel.hidden = panel.dataset.viewPanel !== state.view; });
  $$("[data-view]").forEach((a) => a.classList.toggle("active", a.dataset.view === state.view));
  if (state.view === "pipeline") renderPipeline();
  else if (state.view === "forecast") renderForecast();
  else if (state.view === "deals") renderDeals();
  else if (state.view === "accounts") renderAccounts();
  else if (state.view === "reports") renderReports();
  if (dealParam && data.deals.some((d) => d.id === dealParam)) openDrawerFor(dealParam);
  window.scrollTo({ top: 0 });
}

/* -------------------------------------------------------------------- wire */

function buildOwnerFilter() {
  const select = $("#owner-filter");
  select.replaceChildren(
    el("option", { value: "all", text: "All owners" }),
    ...data.owners.map((o) => el("option", { value: o.id, text: o.name })));
  select.value = state.owner;
}

function renderFilterOptions() {
  const stage = $("#deal-stage");
  stage.replaceChildren(
    el("option", { value: "", text: "All stages" }),
    ...STAGES.map((s) => el("option", { value: s.id, text: s.label })),
    el("option", { value: "won", text: "Closed won" }),
    el("option", { value: "lost", text: "Closed lost" }));
  stage.value = state.filters.stage;
  const status = $("#deal-status");
  status.replaceChildren(
    el("option", { value: "", text: "Any status" }),
    el("option", { value: "open", text: "Open" }),
    el("option", { value: "won", text: "Won" }),
    el("option", { value: "lost", text: "Lost" }));
  status.value = state.filters.status;
}

function wire() {
  const today = new Date();
  $("#today").textContent = today.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short" });
  buildOwnerFilter();
  renderFilterOptions();

  $("#owner-filter").addEventListener("change", (e) => {
    state.owner = e.target.value;
    route();
  });

  $$("#quota-tabs .tab").forEach((tab) => tab.addEventListener("click", () => {
    state.quota = Number(tab.dataset.quota);
    $$("#quota-tabs .tab").forEach((t) => t.classList.toggle("active", t === tab));
    renderForecast();
  }));

  $("#open-forecast").addEventListener("click", () => { location.hash = "#forecast"; });
  $("#export-pipeline").addEventListener("click", () => {
    const now = Date.now();
    const rows = scopedDeals().filter((d) => d.status === "open").map((d) => ({
      deal: dealLabel(d), company: company(d.companyId).name, owner: owner(d.ownerId).name,
      stage: d.stage, probability: probabilityOf(d), value: d.value, weighted: weightedValue(d),
      days_in_stage: daysInStage(d, now), last_activity: new Date(d.lastActivityAt).toISOString().slice(0, 10),
    }));
    A.download("leadpipe-pipeline.csv", toCSV(rows), "text/csv");
    A.toast(`Exported ${rows.length} open deals`, "success");
  });

  $("#reset-data").addEventListener("click", () => {
    A.store.remove(STORE_KEY);
    data = freshData();
    state.owner = "all";
    buildOwnerFilter();
    closeDrawer();
    route();
    A.toast("Demo data regenerated from the seed", "success");
  });

  $("#global-search").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    state.filters = { q: e.target.value, stage: "", status: "" };
    state.page = 0;
    location.hash = "#deals";
    renderFilterOptions();
    $("#deal-search").value = e.target.value;
    route();
  });

  $("#deal-search").addEventListener("input", A.debounce((e) => {
    state.filters.q = e.target.value; state.page = 0; renderDeals();
  }, 200));
  $("#deal-stage").addEventListener("change", (e) => { state.filters.stage = e.target.value; state.page = 0; renderDeals(); });
  $("#deal-status").addEventListener("change", (e) => { state.filters.status = e.target.value; state.page = 0; renderDeals(); });
  $("#deal-clear").addEventListener("click", () => {
    state.filters = { q: "", stage: "", status: "" };
    state.page = 0;
    $("#deal-search").value = "";
    renderFilterOptions();
    renderDeals();
  });
  $("#deal-prev").addEventListener("click", () => { state.page = Math.max(0, state.page - 1); renderDeals(); });
  $("#deal-next").addEventListener("click", () => { state.page++; renderDeals(); });

  $("#drawer-backdrop").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeDrawer(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.openDealId) closeDrawer(); });

  window.addEventListener("hashchange", route);
}

wire();
route();
