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
