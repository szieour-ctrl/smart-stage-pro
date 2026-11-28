// Run with: npm test — shared schema-driven intake for the seven series templates (Nov 28, 2026)
const test = require("node:test");
const assert = require("node:assert");
const series = require("../netlify/functions/lib/agent-marketing-series-lib");
const intakeLib = require("../netlify/functions/lib/agent-marketing-intake");
const gate = require("../netlify/functions/lib/agent-marketing-gate");

test("every series template defines angles, audiences, questions and a firsthand prompt", () => {
  assert.deepStrictEqual(series.KEYS.slice().sort(), gate.TEMPLATES.filter((t) => t !== "local_market_insider").sort());
  for (const k of series.KEYS) {
    const s = series.schemaFor(k);
    assert.ok(Object.keys(s.angles).length >= 2, k);
    assert.ok(s.audiences.length >= 3, k);
    assert.ok(s.writing.length >= 1, k);
    assert.ok(intakeLib.schemaFor(k), "shared schemaFor reaches it");
    assert.ok(series.systemRules(k).length > 5);
  }
  assert.strictEqual(series.systemRules("local_market_insider").length, 0);
});

test("Meet Your Agent: introduction needs no example, focused angles require one firsthand thing", () => {
  const intro = intakeLib.validateIntake("meet_your_agent", { angle: "introduce", audience: "General audience" });
  assert.ok(intro.ok); assert.deepStrictEqual(intro.needsInput, ["firsthand"]); assert.strictEqual(intro.clean.publicTitle, "Meet Your Agent");
  const bad = intakeLib.validateIntake("meet_your_agent", { angle: "shaped", audience: "Sellers" });
  assert.strictEqual(bad.ok, false); assert.strictEqual(bad.errors[0].field, "firsthand");
  const ok = intakeLib.validateIntake("meet_your_agent", { angle: "shaped", audience: "Sellers", firsthand: "I once replaced a rotted fascia board before listing." });
  assert.ok(ok.ok); assert.strictEqual(ok.clean.publicTitle, "What shaped my approach");
});

test("the subscriber can edit the public title; unknown keys and property fields are dropped", () => {
  const r = intakeLib.validateIntake("meet_your_agent", { angle: "introduce", audience: "Sellers", publicTitle: "Meet Sam", price: 700000, listingId: "x", series_recap: { title: "forged" } });
  assert.strictEqual(r.clean.publicTitle, "Meet Sam");
  assert.ok(!("price" in r.clean) && !("listingId" in r.clean) && !("series_recap" in r.clean));
});

test("Your Buyer Advantage: angle first, topic only for focused angles, titles follow the angle and audience", () => {
  const broad = series.validateSeriesIntake("your_buyer_advantage", { angle: "introduce", audience: "General buyers" });
  assert.ok(broad.ok); assert.strictEqual(broad.clean.topic, ""); assert.strictEqual(broad.clean.publicTitle, "Your Buyer Advantage");
  const moveUp = series.validateSeriesIntake("your_buyer_advantage", { angle: "introduce", audience: "Move-up buyers" });
  assert.strictEqual(moveUp.clean.publicTitle, "Your Buyer Advantage for Move-Up Buyers");
  const noTopic = series.validateSeriesIntake("your_buyer_advantage", { angle: "pitfall", audience: "First-time buyers", firsthand: "I build a question list." });
  assert.ok(noTopic.errors.some((e) => e.field === "topic"));
  const insp = series.validateSeriesIntake("your_buyer_advantage", { angle: "pitfall", audience: "First-time buyers", topic: "Inspections", firsthand: "I sort the report into must-fix and monitor." });
  assert.ok(insp.ok); assert.strictEqual(insp.clean.publicTitle, "Buyer Pitfalls · Inspections");
  assert.strictEqual(series.validateSeriesIntake("your_buyer_advantage", { angle: "pitfall", audience: "First-time buyers", topic: "Kitchens", firsthand: "x" }).ok, false);
});

test("conditional questions: Review Highlights needs the attestation, the exact text and a rating value only when one was attached", () => {
  const base = { angle: "highlight", audience: "General audience", source: "Google", reviewText: "Sam made it easy.", strength: "Care" };
  assert.ok(series.validateSeriesIntake("agent_review_highlights", { ...base, rating: "No rating", attested: true }).ok);
  assert.ok(series.validateSeriesIntake("agent_review_highlights", { ...base, rating: "No rating" }).errors.some((e) => e.field === "attested"));
  assert.ok(series.validateSeriesIntake("agent_review_highlights", { ...base, rating: "Source rating", attested: true }).errors.some((e) => e.field === "ratingValue"));
  const rated = series.validateSeriesIntake("agent_review_highlights", { ...base, rating: "Source rating", ratingValue: 5, attested: true });
  assert.ok(rated.ok); assert.strictEqual(rated.clean.ratingValue, 5);
  const unrated = series.validateSeriesIntake("agent_review_highlights", { ...base, rating: "No rating", ratingValue: 5, attested: true });
  assert.ok(!("ratingValue" in unrated.clean), "a rating value is dropped when no rating was attached");
});

test("every template accepts a valid answer set and each passes the content gate", () => {
  const good = {
    meet_your_agent: { angle: "introduce", audience: "General audience", motivation: "Serving my community", clientStyle: "Warm and patient" },
    why_list_with_me: { angle: "strategy", audience: "General sellers", topic: "Preparation", valueArea: "Strategy", gain: "Clear plan", firsthand: "I start with a one-page prep worksheet." },
    your_buyer_advantage: { angle: "introduce", audience: "General buyers", feel: "Prepared" },
    my_proven_process: { angle: "overview", audience: "Sellers", topic: "Starting", steps: "Walkthrough, then prep plan, then pricing review.", firsthand: "A 20-minute priorities call." },
    new_construction_specialist: { angle: "tip", audience: "New-home buyers", topic: "Incentives", productType: "Quick move-in", compare: "Price", firsthand: "Ask what is included in writing." },
    active_adult_55_specialist: { angle: "transition", audience: "Downsizers", topic: "Maintenance", concern: "Timing" },
    agent_review_highlights: { angle: "highlight", audience: "General audience", source: "Zillow", reviewText: "Clear and patient throughout.", rating: "No rating", strength: "Patience", attested: true },
  };
  for (const [t, v] of Object.entries(good)) {
    const r = intakeLib.validateIntake(t, v);
    assert.ok(r.ok, `${t}: ${JSON.stringify(r.errors)}`);
    const g = gate.evaluate({ template: t, intake: r.clean });
    assert.ok(g.ok, `${t}: ${JSON.stringify(g.blocks)}`);
  }
});

test("a different angle changes the planner's story flow; the brief carries only the agent's own answers", () => {
  const p = (angle, topic) => ({ template: "your_buyer_advantage", intake: { angle, audience: "Move-up buyers", topic, feel: "Prepared" } });
  assert.notStrictEqual(series.templateBrief(p("introduce", "")).story_flow, series.templateBrief(p("pitfall", "Inspections")).story_flow);
  assert.strictEqual(series.templateBrief(p("pitfall", "Inspections")).topic, "Inspections");
  assert.strictEqual(series.templateBrief({ template: "local_market_insider", intake: {} }), null);
});

test("Local Market Insider intake is unchanged", () => {
  const r = intakeLib.validateIntake("local_market_insider", { angle: "seller", market: "Roseville", audience: "Home sellers", issue: "Preparation before listing", action: "Compare options", observation: "x" });
  assert.ok(r.ok); assert.deepStrictEqual(Object.keys(r.clean).sort(), ["action", "angle", "audience", "issue", "market", "observation"]);
});
