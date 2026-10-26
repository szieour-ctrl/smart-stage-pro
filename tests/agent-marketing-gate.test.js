// Run with: node --test tests/
const test = require("node:test");
const assert = require("node:assert");
const gate = require("../netlify/functions/lib/agent-marketing-gate");

const intake = {
  market: "Roseville, CA",
  issue: "Supply and buyer demand",
  observation: "If your resale home is near new construction it can bring more interested buyers, but builders often have incentives and rate buy-downs.",
};
const cleanNarration = "Is new construction helping or hurting your resale home's value? Nearby new communities can attract more interested buyers, but they can also add competition. Builders may offer incentives or rate buydowns that change the comparison.";
const base = (over = {}) => ({
  template: "local_market_insider",
  intake,
  generated: { narration: cleanNarration, captions: cleanNarration, sceneTexts: [], overlays: [] },
  cta: { text: "Understand your home's competition.", source: "claude" },
  ...over,
});

test("the Local Market Insider sample passes", () => {
  const r = gate.evaluate(base());
  assert.deepStrictEqual(r.blocks, []);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.version, gate.GATE_VERSION);
});

test("unknown and not-yet-enabled templates are blocked", () => {
  assert.strictEqual(gate.evaluate(base({ template: "nope" })).ok, false);
  assert.strictEqual(gate.evaluate(base({ template: "meet_your_agent" })).ok, false);
});

test("property-sale keys are rejected structurally, in the payload and in the intake", () => {
  const r = gate.evaluate(base({ payload: { listingId: "abc", scenes: [{ price: 700000 }] } }));
  assert.ok(r.blocks.some((b) => b.rule === "property_field" && b.field === "payload.listingId"));
  assert.ok(r.blocks.some((b) => b.rule === "property_field" && b.field === "payload.scenes[0].price"));
  const r2 = gate.evaluate(base({ intake: { ...intake, address: "123 Main St" } }));
  assert.ok(r2.blocks.some((b) => b.field === "intake.address"));
  // an empty value for a forbidden key is not a violation
  assert.strictEqual(gate.evaluate(base({ payload: { price: "" } })).ok, true);
});

test("listing announcements, addresses, MLS numbers and tour CTAs in agent text are blocked", () => {
  const cases = [
    ["Just listed in Roseville!", "listing_announcement"],
    ["Open house this Saturday", "listing_announcement"],
    ["See 1234 Oak Ridge Drive today", "street_address"],
    ["see 456 elm st", "street_address"],
    ["MLS# 225012345", "mls_reference"],
    ["Listed at $689,000", "listing_price"],
    ["This home is currently available", "property_availability"],
    ["Schedule a private tour", "property_sale_cta"],
  ];
  for (const [text, rule] of cases) {
    const r = gate.evaluate(base({ intake: { ...intake, observation: text } }));
    assert.ok(r.blocks.some((b) => b.rule === rule), `${text} should trigger ${rule}`);
  }
});

test("a custom CTA cannot smuggle in a property-sale CTA", () => {
  const r = gate.evaluate(base({ cta: { text: "Schedule a private tour of 12 Maple Court", source: "user_inserted" } }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.blocks.every((b) => b.field === "cta"));
  const ok = gate.evaluate(base({ cta: { text: "Ask me for a local perspective.", source: "user_edited" } }));
  assert.strictEqual(ok.ok, true);
});

test("ordinary educational wording is not blocked", () => {
  const text = "When your home is for sale, buyers compare it with 5 things like new construction. Walk the road with a neighbor.";
  const r = gate.evaluate(base({ intake: { ...intake, observation: text }, generated: { narration: "", captions: "" } }));
  assert.strictEqual(r.ok, true);
  assert.ok(r.warnings.some((w) => w.rule === "sale_language")); // warning only
});

test("market-context prices only warn", () => {
  const r = gate.evaluate(base({ intake: { ...intake, observation: "Homes priced at $600,000 face more competition." }, generated: { narration: "", captions: "" } }));
  assert.strictEqual(r.ok, true);
  assert.ok(r.warnings.some((w) => w.rule === "price_wording"));
});

test("Claude cannot invent results, testimonials, staging outcomes or numbers", () => {
  const bad = [
    ["My clients sold in three days.", "client_story"],
    ["Homes here sell over asking.", "transaction_result"],
    ["Staging boosted offers last month.", "staging_outcome"],
    ["Prices rose 12% last year.", "invented_number"],
  ];
  for (const [text, rule] of bad) {
    const r = gate.evaluate(base({ generated: { narration: text, captions: text } }));
    assert.ok(r.blocks.some((b) => b.rule === rule), `${text} should trigger ${rule}`);
  }
});

test("a claim or number the agent supplied passes through and is recorded", () => {
  const withClaim = { ...intake, observation: "My staging helped one home sell over asking in 9 days." };
  const r = gate.evaluate(base({ intake: withClaim, generated: { narration: "Staging can help. One home sold over asking in 9 days.", captions: "" } }));
  assert.strictEqual(r.blocks.filter((b) => b.rule === "invented_number").length, 0);
  assert.ok(r.agentSuppliedClaims.length > 0);
});

test("Fair Housing steering blocks Claude's output but only warns on the agent's own text", () => {
  const gen = gate.evaluate(base({ generated: { narration: "A safe neighborhood, perfect for families.", captions: "" } }));
  assert.ok(gen.blocks.some((b) => b.rule === "fair_housing"));
  const usr = gate.evaluate(base({ intake: { ...intake, observation: "Great schools nearby." }, generated: { narration: "", captions: "" } }));
  assert.strictEqual(usr.ok, true);
  assert.ok(usr.warnings.some((w) => w.rule === "fair_housing"));
});

test("explain() gives a readable message and is empty when ok", () => {
  assert.strictEqual(gate.explain(gate.evaluate(base())), "");
  const msg = gate.explain(gate.evaluate(base({ intake: { ...intake, observation: "Just listed" } })));
  assert.match(msg, /Listing Reel/);
});

test("attestation text and version are exported for the single checkbox", () => {
  assert.match(gate.ATTESTATION_TEXT, /right to use the submitted images/);
  assert.ok(gate.ATTESTATION_VERSION);
});

const NOTICE = "Based on information from MetroList Services, Inc. for the period Sep 1, 2026 through Sep 30, 2026.";

// ── Verified facts: Local Market Insider only (Oct 24) ─────────────────────────────────────────────────────────
const marketTopic = {
  id: "t1", kind: "market_update",
  question: "Are Roseville homes taking longer to sell? Median days on market reached 31 in October.",
  whyItMatters: "Sellers pricing now should know the median price was 742,000 with 2.4 months of inventory.",
  trendSignals: ["Median days on market 31 (up from 24)"], scope: "broader_context", scopeNote: "Data covers Roseville, not Crocker Ranch.",
  sources: [{ title: "Roseville market report", url: "https://example.com/r", domain: "example.com", published: "2026-10-20" }], event: null,
};
const eventTopic = {
  id: "t2", kind: "local_events", question: "What is happening in Old Roseville this weekend?", whyItMatters: "Neighbors gather downtown.", trendSignals: [], scope: "selected", scopeNote: "",
  sources: [{ title: "City events", url: "https://example.com/e", domain: "example.com", published: null }],
  event: { name: "Harvest Festival", date: "2026-10-31", endDate: null, time: "10:00 AM to 4:00 PM", location: "Maidu Community Center, 1550 Maidu Dr, Roseville", organizer: "City of Roseville", status: "upcoming" },
};
const lmi = (topic) => ({ template: "local_market_insider", selected_topic: topic });
const withVerified = (topic, narration, over = {}) => base({ verified: gate.verifiedFromProject(lmi(topic)), generated: { narration, captions: "" }, ...over });

test("sourced figures and days-on-market vocabulary pass when they trace to the verified topic", () => {
  const text = "Median days on market reached 31 in October, and the median price was 742,000 with 2.4 months of inventory.";
  const r = gate.evaluate(withVerified(marketTopic, text));
  assert.deepStrictEqual(r.blocks, []);
  assert.ok(r.sourcedFacts.some((f) => f.endsWith(": 31")));
  assert.strictEqual(r.review, "market_insider");
});

test("without a verified topic the same figures are still blocked", () => {
  const text = "Median days on market reached 31 in October.";
  const r = gate.evaluate(base({ generated: { narration: text, captions: "" } }));
  assert.ok(r.blocks.some((b) => b.rule === "invented_number" && b.match === "31"));
  assert.ok(r.blocks.some((b) => b.rule === "transaction_result"));
});

test("a number that is not in the verified topic is still blocked", () => {
  const r = gate.evaluate(withVerified(marketTopic, "Median days on market reached 31, and prices rose 12% this year."));
  assert.ok(r.blocks.some((b) => b.rule === "invented_number" && b.match === "12"));
  assert.ok(!r.blocks.some((b) => b.match === "31"));
});

test("outcome claims and client stories still need the agent or the topic to have said them", () => {
  const r = gate.evaluate(withVerified(marketTopic, "Homes here sold over asking and my clients loved it."));
  assert.ok(r.blocks.some((b) => b.rule === "unsupported_outcome"));
  assert.ok(r.blocks.some((b) => b.rule === "client_story"));
  // "sold at" / "days on market" are plain vocabulary; only the unsupported outcome blocks
  assert.ok(!r.blocks.some((b) => /sold|days on market/i.test(b.match)));
});

test("an event venue address that matches the verified event is allowed; any other address is blocked", () => {
  const ok = gate.evaluate(withVerified(eventTopic, "Join the Harvest Festival on October 31 at the Maidu Community Center, 1550 Maidu Drive, from 10:00 AM to 4:00 PM."));
  assert.deepStrictEqual(ok.blocks, []);
  assert.ok(ok.sourcedFacts.some((f) => /1550 Maidu/i.test(f)));
  const bad = gate.evaluate(withVerified(eventTopic, "Join the festival at 1550 Maidu Drive, then see 1234 Oak Ridge Drive."));
  assert.ok(bad.blocks.some((b) => b.rule === "street_address" && /1234 Oak Ridge/.test(b.match)));
  assert.ok(!bad.blocks.some((b) => /1550 Maidu/.test(b.match)));
});

test("event addresses are blocked when no event was verified", () => {
  const r = gate.evaluate(withVerified(marketTopic, "Come to 1550 Maidu Drive."));
  assert.ok(r.blocks.some((b) => b.rule === "street_address"));
});

test("property-sale rules and Fair Housing still block, even with verified facts", () => {
  const r = gate.evaluate(withVerified(marketTopic, "Just listed! A safe neighborhood, perfect for families. Schedule a private tour."));
  for (const rule of ["specific_home_announcement", "fair_housing", "property_sale_cta"]) assert.ok(r.blocks.some((b) => b.rule === rule), rule);
});

test("verified facts are honored for Local Market Insider only", () => {
  const verified = gate.verifiedFromProject(lmi(marketTopic));
  assert.ok(verified);
  assert.strictEqual(gate.verifiedFromProject({ template: "meet_your_agent", selected_topic: marketTopic }), null);
  const r = gate.evaluate(base({ template: "meet_your_agent", verified, generated: { narration: "Median days on market reached 31.", captions: "" } }));
  assert.ok(r.blocks.some((b) => b.rule === "template"));
  assert.ok(r.blocks.some((b) => b.rule === "invented_number" && b.match === "31"));
  assert.deepStrictEqual(r.sourcedFacts, []);
});

test("a topic with no validated source verifies nothing, and a client-sent verified block is ignored for other templates", () => {
  assert.strictEqual(gate.verifiedFromTopic({ ...marketTopic, sources: [] }), null);
  assert.strictEqual(gate.verifiedFromTopic(null), null);
  assert.strictEqual(gate.verifiedFromProject(null), null);
});

test("the agent's own typed text and structural property keys are unchanged by verified facts", () => {
  const r = gate.evaluate(base({ verified: gate.verifiedFromProject(lmi(eventTopic)), intake: { ...intake, observation: "See 1234 Oak Ridge Drive today" } }));
  assert.ok(r.blocks.some((b) => b.rule === "street_address" && b.field === "intake.observation"));
  const r2 = gate.evaluate(base({ verified: gate.verifiedFromProject(lmi(eventTopic)), payload: { address: "1550 Maidu Dr" } }));
  assert.ok(r2.blocks.some((b) => b.rule === "property_field"));
});

test("market vocabulary is plain vocabulary: list price, price reductions, open house, under contract; one home's price still blocks", () => {
  const topic = {
    id: "t1", kind: "market_update", question: "Are sellers cutting the list price? 4 of 12 active listings have a price reduction.", whyItMatters: "Median list price of active listings is 659,000.",
    trendSignals: [], scope: "selected", scopeNote: "", sources: [{ title: "r", url: "https://example.com/r", domain: "example.com", published: "2026-10-20" }], event: null,
  };
  const v = gate.verifiedFromProject({ template: "local_market_insider", selected_topic: topic });
  const ev = (text, verified) => gate.evaluate(base({ verified, generated: { narration: text, captions: "" } }));
  const ok = ev("Of 12 active listings, 4 have a price reduction, and the median list price is $659,000.", v);
  assert.deepStrictEqual(ok.blocks, []);
  // the words themselves never block, even for phrases the topic did not use
  assert.deepStrictEqual(ev("Price drops, open house season and homes under contract are all part of the market.", v).blocks, []);
  const oh = ev("Open house season is here, and buyers are touring more homes.", v);
  assert.deepStrictEqual([oh.blocks, oh.warnings], [[], []]); // no address, no announcement: nothing to review
  // without a validated topic the strict property-ad rules still apply
  const strict = ev("Of 12 active listings, 4 have a price reduction.", null);
  assert.strictEqual(strict.review, "strict");
  assert.ok(strict.blocks.some((b) => b.rule === "listing_announcement"));
  // an allowed phrase does not hide a bad one in the same text: the home-specific price and announcement still block
  const mixed = ev("The median list price is $659,000. Just listed at $689,000, open house Saturday.", v);
  for (const rule of ["specific_home_announcement", "specific_home_price"]) assert.ok(mixed.blocks.some((b) => b.rule === rule), rule);
});

test("Local Market Insider may use sold / active / pending in market context; ownership of any activity still blocks", () => {
  const am = require("../netlify/functions/lib/agent-marketing-lib.js");
  const project = { template: "local_market_insider", intake: { market: "Roseville, CA" }, selected_topic: {
    question: "Are sellers in Roseville accepting offers close to their asking price?", whyItMatters: "September 2026 sales.",
    sources: [{ url: "https://example.org/r" }], reportFigures: [{ text: "Sold price as a percent of list price: 99%" }, { text: "Sold price as a percent of original list price: 97%" }], reportNotice: NOTICE, trendSignals: [] } };
  const run = (s) => gate.evaluate(am.gateInputFor(project, { captionText: s, narrationTagged: s, scenes: [{ narrationExcerpt: s }], notice: NOTICE, cta: { text: "Ask me.", source: "claude" } }, "claude"));
  for (const ok of [
    "In September 2026, homes sold at 99% of their list price, and 97% of the original list price. I'm happy to walk you through what this means.",
    "Active listings are up, pending sales slowed and price reductions were common.",
    "I can show you how homes sold at 99% of list price and what pending homes mean for you.",
    "Homes are under contract faster in Roseville.",
  ]) assert.strictEqual(run(ok).ok, true, ok);
  for (const bad of [
    "I sold a home at 99% of list price.", "My listing is pending.", "I have a home under contract in Roseville.", "This home is pending.",
    "This home is listed at $689,000.", "We just sold 3 homes in Roseville.", "Just listed in Roseville.", "Homes sold over asking.",
  ]) assert.strictEqual(run(bad).ok, false, bad);
});

test("approving a sourced Local Market Insider script (agent-text path) applies the same context rules", () => {
  const am = require("../netlify/functions/lib/agent-marketing-lib.js");
  const project = { template: "local_market_insider", intake: { market: "Roseville, CA" }, selected_topic: {
    question: "Are sellers in Roseville accepting offers close to their asking price?", whyItMatters: "Negotiating room, September 2026",
    sources: [{ url: "https://example.org/r" }], reportFigures: [{ text: "99% sold to list" }, { text: "97% sold to original" }], reportNotice: NOTICE, trendSignals: [] } };
  const run = (s) => gate.evaluate(am.gateInputFor(project, { captionText: s, narrationTagged: s, scenes: [{ narrationExcerpt: s }], notice: NOTICE, cta: { text: "Ask me.", source: "user_edited" } }, "user"));
  assert.strictEqual(run("In September 2026, homes sold at 99% of their list price, and the original asking price figure was 97%. I'm happy to walk you through what this means.").ok, true);
  assert.strictEqual(run("I sold a home at 99% of list price.").ok, false);
  assert.strictEqual(run("This home is listed at $689,000.").ok, false);
});

test("topicNotice reads MetroList's notice from the frozen topic only, and the gate needs it on the piece", () => {
  const am = require("../netlify/functions/lib/agent-marketing-lib.js");
  const notice = "Based on information from MetroList Services, Inc. for the period Sep 1, 2026 through Sep 30, 2026.";
  const project = { template: "local_market_insider", intake: { market: "Roseville, CA" }, selected_topic: { question: "q 99%", whyItMatters: "w", sources: [{ url: "https://e.org" }], reportFigures: [{ text: "99% sold to list" }], reportNotice: notice, trendSignals: [] } };
  assert.strictEqual(am.topicNotice(project), notice);
  assert.strictEqual(am.topicNotice({ ...project, template: "other" }), "");
  const n = { captionText: "Homes sold at 99% of list price.", narrationTagged: "Homes sold at 99% of list price.", scenes: [], cta: { text: "Ask me.", source: "user_edited" } };
  assert.ok(gate.evaluate(am.gateInputFor(project, n, "edited")).blocks.some((b) => b.rule === "missing_notice"));
  assert.strictEqual(gate.evaluate(am.gateInputFor(project, { ...n, notice: am.topicNotice(project) }, "edited")).ok, true);
});

// ── SSP Agent Marketing — SaaS Production Model and Compliance Architecture (Oct 25, 2026) ─────────────────────────
const amLib = require("../netlify/functions/lib/agent-marketing-lib.js");
const roseville = (extra = {}) => ({
  template: "local_market_insider", intake: { market: "Roseville, CA" },
  selected_topic: {
    question: "Are sellers in Roseville accepting offers close to their asking price?", whyItMatters: "September 2026 closed sales.",
    sources: [{ url: "https://example.org/r" }], trendSignals: [], reportNotice: NOTICE,
    reportFigures: [{ text: "Sold price as a percent of list price: 99%" }, { text: "Sold price as a percent of original list price: 97%" }], ...extra,
  },
});
const review = (project, s, source = "claude") => gate.evaluate(amLib.gateInputFor(project, amLib.attachNotice(project, { captionText: s, narrationTagged: s, scenes: [{ narrationExcerpt: s }], cta: { text: "Ask me.", source: source === "claude" ? "claude" : "user_edited" } }), source));

test("acceptance: a buyer-education script on 99% of list price and 97% of original list price is not rejected", () => {
  const script = "In September 2026, Roseville homes sold for 99% of final list price and 97% of original list price. Here is what that means for buyers: there was some room to negotiate.";
  for (const src of ["claude", "edited"]) {
    const r = review(roseville(), script, src);
    assert.deepStrictEqual(r.blocks, [], src);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.review, "market_insider");
  }
});

test("ordinary real estate terminology never blocks, whatever the word", () => {
  for (const s of [
    "Sold, pending and active counts all moved in September 2026.", "Price reductions and list price changes were common, and days on market stayed short.",
    "Inventory is a key number. Open house season is a good time to learn the market.", "Homes under contract moved quickly in Roseville.",
  ]) assert.strictEqual(review(roseville(), s).ok, true, s);
});

test("the four checks still block: specific home, untraceable number, spoken notice, Fair Housing", () => {
  const p = roseville();
  assert.ok(review(p, "Visit 4012 Maple Street today.").blocks.some((b) => b.rule === "street_address"));
  assert.ok(review(p, "My listing is pending.").blocks.some((b) => b.rule === "ownership_claim"));
  assert.ok(review(p, "Prices rose 12% in September 2026, and homes sold at 99% of list price.").blocks.some((b) => b.rule === "invented_number" && b.match === "12"));
  assert.ok(review(p, "Homes sold at 99% of list price. " + NOTICE).blocks.some((b) => b.rule === "notice_spoken"));
  assert.ok(review(p, "Roseville is a safe neighborhood, perfect for families.").blocks.some((b) => b.rule === "fair_housing"));
});

test("the MetroList notice is required as an on-screen overlay and is attached by code with the headshot placement", () => {
  const p = roseville();
  const n = amLib.attachNotice(p, { scenes: [{}, {}, {}, {}, {}, {}] });
  assert.deepStrictEqual(n.noticeOverlay, { text: NOTICE, position: "bottom", scenes: [0, 5], showHeadshot: true, headshotSource: "marketing_profile" });
  const bare = { captionText: "Homes sold at 99% of list price.", narrationTagged: "Homes sold at 99% of list price.", scenes: [], cta: { text: "Ask me.", source: "claude" } };
  assert.ok(gate.evaluate(amLib.gateInputFor(p, bare, "claude")).blocks.some((b) => b.rule === "missing_notice"));
  const noMetro = amLib.attachNotice({ ...p, selected_topic: { ...p.selected_topic, reportNotice: "" } }, { scenes: [{}], notice: "stale" });
  assert.strictEqual(noMetro.notice, undefined);
  assert.strictEqual(noMetro.noticeOverlay, undefined);
});

test("the agent's uploaded report wins over a conflicting web figure", () => {
  const p = roseville({ origin: "web", reportPrecedence: [{ key: "count_pending", label: "Pended sales", reportText: "Pended sales: 146", supersededNumbers: ["130"] }] });
  const bad = review(p, "Pending sales were 130 in September 2026.");
  assert.ok(bad.blocks.some((b) => b.rule === "report_priority" && b.match === "130"));
  assert.match(bad.blocks.find((b) => b.rule === "report_priority").message, /146/);
  assert.strictEqual(review(p, "Pending sales were 146 in September 2026.").ok, true); // the report's figure is verified text
  assert.ok(review(p, "Pending sales were 130 in September 2026.", "edited").blocks.some((b) => b.rule === "report_priority")); // approve/save path too
});

test("applyReportPrecedence records the agent's figure and the web number it replaces, and attaches the report's notice", () => {
  const rep = require("../netlify/functions/lib/agent-marketing-research-report-lib");
  const ctx = { reports: [], figures: new Map([["r1.f1", { ref: "r1.f1", report: { notice: NOTICE, facts: {} }, fig: { id: "f1", key: "count_pending", label: "Pended sales", value: 146, unit: "count" } }]]) };
  const web = { id: "t4", origin: "web", question: "Are pending sales slowing in Roseville?", whyItMatters: "Pending sales were 130 in September 2026.", trendSignals: [] };
  const rpt = { id: "t1", origin: "report", question: "q", whyItMatters: "w" };
  const out = rep.applyReportPrecedence([rpt, web], ctx);
  assert.strictEqual(out[0], rpt);
  assert.deepStrictEqual(out[1].reportPrecedence[0].supersededNumbers, ["130"]);
  assert.match(out[1].reportPrecedence[0].reportText, /146/);
  assert.strictEqual(out[1].reportNotice, NOTICE);
  // a web topic with no conflicting number is still report-first: the report is the only source of numbers
  const same = { ...web, whyItMatters: "Pending sales were 146 in September 2026." };
  const r2 = rep.applyReportPrecedence([same], ctx)[0];
  assert.strictEqual(r2.reportFirst, true);
  assert.deepStrictEqual(r2.reportPrecedence, []);
  assert.strictEqual(out[1].reportFirst, true);
  assert.match(out[1].reportFigures[0].text, /146/);
});

test("report-first: when the agent chose Both, only the report's numbers can be stated; web numbers on the topic are not verified", () => {
  const rep = require("../netlify/functions/lib/agent-marketing-research-report-lib");
  const plan = require("../netlify/functions/lib/agent-marketing-plan-lib");
  const ctx = { reports: [], figures: new Map([
    ["r1.f1", { ref: "r1.f1", report: { notice: NOTICE, uploadId: "u1", facts: {} }, fig: { id: "f1", key: "count_active", label: "Active listings", value: 367, unit: "count" } }],
    ["r1.f2", { ref: "r1.f2", report: { notice: NOTICE, uploadId: "u1", facts: {} }, fig: { id: "f2", key: "avg_close_to_list_pct", label: "Sold price as a percent of list price", value: 99, unit: "pct" } }],
  ]) };
  const web = { id: "t4", origin: "web", question: "What is the gap between asking and selling prices?", whyItMatters: "The median asking price is $660,000 and the median sold price is $634,000. Buyers have more choices.", trendSignals: ["Median sold price $634,000 (up 3.1%)"], sources: [{ url: "https://example.org/blog" }], scope: "selected", scopeNote: "" };
  const topic = rep.applyReportPrecedence([web], ctx)[0];
  const project = { template: "local_market_insider", intake: { market: "Roseville, CA" }, selected_topic: topic };
  const run = (text) => gate.evaluate(amLib.gateInputFor(project, amLib.attachNotice(project, { captionText: text, narrationTagged: text, scenes: [{ narrationExcerpt: text }], cta: { text: "Ask me.", source: "claude" } }), "claude"));
  // the report's figures pass
  assert.strictEqual(run("There are 367 active listings, and homes sold for 99% of list price.").ok, true);
  // the web numbers do not, and the message says why
  const bad = run("The median asking price is $660,000 and homes sold for $634,000.");
  assert.ok(bad.blocks.some((b) => b.rule === "invented_number" && b.match === "660000"));
  assert.ok(bad.blocks.some((b) => b.match === "634000"));
  assert.match(bad.blocks[0].message, /source of truth/);
  // the report's notice rides along, and the planner never sees the web figures
  assert.strictEqual(topic.reportNotice, NOTICE);
  const brief = plan.topicBrief(topic);
  assert.strictEqual(brief.numbers_come_only_from_agent_report, true);
  assert.doesNotMatch(JSON.stringify(brief), /660,000|634,000|3\.1%/);
  assert.ok(brief.figures_you_may_state.some((f) => /367/.test(f)));
  assert.match(plan.buildSystemPrompt(), /numbers_come_only_from_agent_report/);
  assert.match(plan.buildSystemPrompt(), /never set the median asking price of active listings against the median price of sold homes/);
});

test("the planner removes a spoken MetroList notice and tells the model the report wins", () => {
  const plan = require("../netlify/functions/lib/agent-marketing-plan-lib");
  assert.strictEqual(plan.stripNotice("Homes sold at 99% of list price. " + NOTICE + " Ask me."), "Homes sold at 99% of list price. Ask me.");
  const sys = plan.buildSystemPrompt();
  assert.match(sys, /agent_report_takes_priority/);
  assert.match(sys, /never judge|Do not judge whether the data may be used/i);
  const brief = plan.topicBrief(roseville({ reportPrecedence: [{ label: "Pended sales", reportText: "Pended sales: 146", supersededNumbers: ["130"] }] }).selected_topic);
  assert.deepStrictEqual(brief.agent_report_takes_priority, [{ measure: "Pended sales", agent_report_figure: "Pended sales: 146", never_state: ["130"] }]);
});

test("a validated calculation is as good as a written figure, and only when the caller passes it", () => {
  const topic = {
    id: "t2", kind: "market_update", question: "Are sellers cutting the list price? 6 of 14 active listings have a price reduction.", whyItMatters: "Sellers are watching the market.",
    trendSignals: [], scope: "selected", scopeNote: "", sources: [{ title: "r", url: "https://example.com/r", domain: "example.com", published: "2026-10-20" }], event: null,
  };
  const v = gate.verifiedFromProject({ template: "local_market_insider", selected_topic: topic });
  const text = "About 42.9% of the 14 active listings have a price reduction.";
  const without = gate.evaluate(base({ verified: v, generated: { narration: text, captions: "" } }));
  assert.ok(without.blocks.some((b) => b.rule === "invented_number" && b.match === "42.9"));
  const withDerived = gate.evaluate(base({ verified: v, derivedNumbers: [42.9], generated: { narration: text, captions: "" } }));
  assert.deepStrictEqual(withDerived.blocks, []);
  // a number that is neither written nor calculated still blocks
  const other = gate.evaluate(base({ verified: v, derivedNumbers: [42.9], generated: { narration: "About 55% have a price reduction.", captions: "" } }));
  assert.ok(other.blocks.some((b) => b.rule === "invented_number" && b.match === "55"));
  // derived numbers do nothing outside a verified Local Market Insider piece
  const strict = gate.evaluate(base({ verified: null, derivedNumbers: [42.9], generated: { narration: text, captions: "" } }));
  assert.ok(strict.blocks.some((b) => b.rule === "invented_number"));
});
