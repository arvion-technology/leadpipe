/**
 * Leadpipe demo dataset.
 *
 * Everything is generated from one seed so the pipeline board, the forecast
 * chart and the tests all see the same numbers. Timestamps are derived from an
 * explicit `now`, which is how the tests freeze the clock.
 *
 * Object shapes
 *   deal     { id, name, companyId, contactId, ownerId, value, stage, status,
 *              probability?, createdAt, stageEnteredAt, closeDate, lastActivityAt,
 *              nextStepAt?, nextStep?, wonAt?, lostAt?, lostReason?, source }
 *   activity { id, dealId, companyId, type, ts, by, summary }
 */

export const DAY = 86_400_000;

/** Stage probability is the default weight; a deal may override it. */
export const STAGES = [
  { id: "lead", label: "Lead", probability: 0.1, staleAfter: 7 },
  { id: "qualified", label: "Qualified", probability: 0.25, staleAfter: 10 },
  { id: "proposal", label: "Proposal", probability: 0.5, staleAfter: 14 },
  { id: "negotiation", label: "Negotiation", probability: 0.75, staleAfter: 10 },
];

export const OPEN_STAGES = STAGES.map((s) => s.id);

export const LOST_REASONS = [
  "Went with an in-house build",
  "Budget frozen",
  "Lost on price",
  "Chose a cheaper agency",
  "No decision — project shelved",
  "Timeline did not fit",
];

export const ACTIVITY_TYPES = ["email", "call", "meeting", "note", "proposal"];

const OWNERS = [
  { id: "u1", name: "Anisha Shrestha", initials: "AS", role: "Enterprise" },
  { id: "u2", name: "Bikash Adhikari", initials: "BA", role: "Mid-market" },
  { id: "u3", name: "Priya Gurung", initials: "PG", role: "SMB" },
  { id: "u4", name: "Nabin Thapa", initials: "NT", role: "Enterprise" },
];

const COMPANIES = [
  ["c1", "Himalayan Roasters", "Food & beverage", 210, "Nepal"],
  ["c2", "Sagarmatha Logistics", "Logistics", 480, "Nepal"],
  ["c3", "Blue Yonder Retail", "Retail", 950, "India"],
  ["c4", "Kirtipur Health", "Healthcare", 140, "Nepal"],
  ["c5", "Patan Craft Co.", "Manufacturing", 80, "Nepal"],
  ["c6", "Everest Fintech", "Financial services", 320, "Singapore"],
  ["c7", "Mero Kirana", "Retail", 260, "Nepal"],
  ["c8", "Nepal Solar Works", "Energy", 190, "Nepal"],
  ["c9", "Boudha Foods", "Food & beverage", 350, "Nepal"],
  ["c10", "Terai Agro", "Agriculture", 610, "Nepal"],
  ["c11", "Kathmandu Cloudworks", "Software", 120, "Nepal"],
  ["c12", "Anantara Travel", "Hospitality", 275, "Thailand"],
];

const CONTACT_NAMES = [
  "Rojina Karki", "Suman Basnet", "Meera Joshi", "Arjun Poudel",
  "Sabina Rai", "Kiran Maharjan", "Dipesh Shahi", "Laxmi Bhandari",
  "Nisha Tamang", "Prakash Bhattarai", "Anjali Singh", "Ramesh Khadka",
  "Sunita Magar", "Bibek Lama", "Pooja Sharma", "Hari Dhakal",
  "Manisha Chaudhary", "Sagar Neupane", "Rita Pandey", "Umesh Yadav",
  "Kalpana Ghimire", "Prabin Subedi", "Sarita Ojha", "Deepak Bista",
];

const TITLES = ["CTO", "Head of Operations", "Founder", "IT Manager", "Finance Director", "Product Lead"];

const DEAL_SUFFIX = [
  "Platform rebuild", "Warehouse dashboard", "Customer portal", "Field agent app",
  "Payments integration", "Booking engine", "Inventory sync", "Loyalty programme",
  "Reporting pipeline", "Mobile checkout", "Vendor onboarding", "Support desk migration",
];

const NEXT_STEPS = [
  "Send the revised scope",
  "Book a technical call with their CTO",
  "Chase signature on the SOW",
  "Share the reference architecture",
  "Follow up on the security questionnaire",
  "Schedule a workshop",
  "Confirm budget sign-off",
];

const ACTIVITY_COPY = {
  email: ["Sent the discovery questionnaire", "Shared a case study and pricing", "Followed up on last week's demo"],
  call: ["15-minute intro call", "Reviewed the timeline with finance", "Called to unblock the security review"],
  meeting: ["Demo with the product team", "On-site workshop in Lalitpur", "Scoping session with their CTO"],
  note: ["They are also evaluating an in-house build", "Procurement needs two references", "Budget sits in next quarter"],
  proposal: ["Sent proposal v1", "Revised the SOW after feedback", "Shared the final commercial terms"],
};

const SOURCES = ["Referral", "Inbound", "Outbound", "Partner", "Event"];

/** Small deterministic PRNG: same seed, same pipeline, every run. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generatePipeline({ seed = 20261028, now = Date.now() } = {}) {
  const r = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const int = (min, max) => Math.floor(min + r() * (max - min + 1));
  const money = (min, max) => Math.round((min + r() * (max - min)) / 500) * 500;

  const owners = OWNERS.map((o) => ({ ...o }));

  const companies = COMPANIES.map(([id, name, sector, employees, country], i) => ({
    id, name, sector, employees, country,
    ownerId: owners[i % owners.length].id,
  }));

  const contacts = [];
  companies.forEach((company, ci) => {
    for (let k = 0; k < 2; k++) {
      contacts.push({
        id: `p${ci * 2 + k + 1}`,
        name: CONTACT_NAMES[(ci * 2 + k) % CONTACT_NAMES.length],
        title: TITLES[(ci + k) % TITLES.length],
        companyId: company.id,
        email: `contact${ci * 2 + k + 1}@${company.name.toLowerCase().replace(/[^a-z]+/g, "")}.example`,
      });
    }
  });

  const deals = [];
  const activities = [];

  for (let i = 0; i < 60; i++) {
    const company = companies[i % companies.length];
    const contact = contacts.filter((c) => c.companyId === company.id)[i % 2];
    const owner = owners.find((o) => o.id === company.ownerId);
    const valueRoll = r();
    const status = valueRoll < 0.24 ? "won" : valueRoll < 0.44 ? "lost" : "open";
    const suffix = DEAL_SUFFIX[(i % 12 + Math.floor(i / 12)) % DEAL_SUFFIX.length];
    const base = {
      id: `D-${1000 + i}`,
      name: `${company.name} — ${suffix}`,
      companyId: company.id,
      contactId: contact.id,
      ownerId: owner.id,
      source: pick(SOURCES),
    };

    if (status === "open") {
      const stage = i % 4 === 0 ? "lead" : i % 4 === 1 ? "qualified" : i % 4 === 2 ? "proposal" : "negotiation";
      const ageDays = int(8, 140);
      const createdAt = now - ageDays * DAY;
      const stageEnteredAt = createdAt + int(0, Math.max(1, Math.floor(ageDays * 0.55))) * DAY;
      const lastActivityAge = r() < 0.6 ? int(0, 6) : r() < 0.6 ? int(7, 17) : int(18, 34);
      const openDeal = {
        ...base,
        value: money(stage === "lead" ? 6000 : stage === "qualified" ? 14000 : stage === "proposal" ? 24000 : 38000,
          stage === "lead" ? 26000 : stage === "qualified" ? 48000 : stage === "proposal" ? 74000 : 125000),
        stage,
        status,
        createdAt,
        stageEnteredAt,
        closeDate: now + int(-14, 115) * DAY,
        lastActivityAt: now - lastActivityAge * DAY,
        nextStep: r() < 0.75 ? pick(NEXT_STEPS) : null,
        nextStepAt: null,
      };
      openDeal.nextStepAt = openDeal.nextStep ? now + int(-7, 10) * DAY : null;
      if (r() < 0.22) {
        const defaultP = STAGES.find((s) => s.id === stage).probability;
        openDeal.probability = Math.round(Math.min(0.95, Math.max(0.05, defaultP + (r() - 0.5) * 0.2)) * 100) / 100;
      }
      deals.push(openDeal);
    } else if (status === "won") {
      const wonAt = now - int(5, 150) * DAY;
      const createdAt = wonAt - int(20, 85) * DAY;
      deals.push({
        ...base,
        value: money(18000, 115000),
        stage: "negotiation",
        status,
        createdAt,
        stageEnteredAt: createdAt + int(10, 30) * DAY,
        closeDate: wonAt,
        lastActivityAt: wonAt,
        nextStep: null,
        nextStepAt: null,
        wonAt,
      });
    } else {
      const lostAt = now - int(6, 160) * DAY;
      const createdAt = lostAt - int(15, 75) * DAY;
      deals.push({
        ...base,
        value: money(9000, 80000),
        stage: pick(["qualified", "proposal", "negotiation"]),
        status,
        createdAt,
        stageEnteredAt: createdAt + int(5, 25) * DAY,
        closeDate: lostAt,
        lastActivityAt: lostAt,
        nextStep: null,
        nextStepAt: null,
        lostAt,
        lostReason: pick(LOST_REASONS),
      });
    }
  }

  // A timeline for every deal: 3-8 touches between creation and close/last touch.
  for (const deal of deals) {
    const end = deal.status === "won" ? deal.wonAt : deal.status === "lost" ? deal.lostAt : deal.lastActivityAt;
    const span = Math.max(DAY, end - deal.createdAt);
    const count = int(3, 8);
    for (let k = 0; k < count; k++) {
      const ts = Math.round(deal.createdAt + (span * (k + 0.4)) / count);
      const type = ACTIVITY_TYPES[(k + deals.indexOf(deal)) % ACTIVITY_TYPES.length];
      activities.push({
        id: `${deal.id}-a${k}`,
        dealId: deal.id,
        companyId: deal.companyId,
        type,
        ts,
        by: deal.ownerId,
        summary: pick(ACTIVITY_COPY[type]),
      });
    }
    activities.push({
      id: `${deal.id}-stage`,
      dealId: deal.id,
      companyId: deal.companyId,
      type: "stage",
      ts: deal.stageEnteredAt,
      by: deal.ownerId,
      summary: deal.status === "won" ? "Moved to closed won" : deal.status === "lost" ? "Marked as lost" : `Entered ${deal.stage}`,
    });
  }
  activities.sort((a, b) => a.ts - b.ts);

  return { owners, companies, contacts, deals, activities, generatedAt: now, seed };
}
