// Run with: npm test   (B1_WORKSPACE=<private ssp-b1-evidence workspace>; without it the fixture tests are skipped with the reason)
// DEVELOPMENT ONLY (Nov 5, 2026): decision D1. The content gate with B1 evidence: held quotations cannot be restored, and a validated number does
// not authorize a broader or different claim. Frozen FA, FB and FC bundles and every article-derived test sentence are PRIVATE: they come from the
// B1 workspace (ssp_fixtures/cases.json, key "d1") through tests/helpers/b1-private.js. No provider call, no database.
const test = require("node:test");
const assert = require("node:assert");
const gate = require("../netlify/functions/lib/agent-marketing-gate");
const b1 = require("../netlify/functions/lib/agent-marketing-b1-evidence-lib");
const PRIV = require("./helpers/b1-private");

const NEEDS = { skip: PRIV.skip };
const D = () => PRIV.cases.d1;
const ON = { AGENT_MARKETING_B1_EVIDENCE: "dev" }, OFF = {};
const base = { id: "t1", question: "What is the market doing?", whyItMatters: "Pricing decisions.", sources: [{ url: "https://example.org/a", title: "a" }] };
const topic = (c, extra) => b1.attachToTopic({ ...base, ...(extra || {}) }, PRIV.bundle(c));
const run = (c, line, { env = ON, extra, intake } = {}) => gate.evaluate({ template: "local_market_insider", intake: intake || { market: "Sacramento County" },
  generated: { narration: line }, verified: gate.verifiedFromTopic(topic(c, extra), env) });
const rules = (r) => r.blocks.map((b) => b.rule);
const b1Rules = (r) => rules(r).filter((x) => x.startsWith("b1_"));
const passes = (c, line, o) => { const r = run(c, line, o); assert.ok(r.ok, `${c} should pass: ${line}\n${JSON.stringify(r.blocks)}`); return r; };
const blocked = (c, line, rule, o) => { const r = run(c, line, o); assert.ok(!r.ok && rules(r).includes(rule), `${c} should be blocked by ${rule}: ${line}\n${JSON.stringify(r.blocks)}`); return r; };

test("D1: FC's held headline reproduced verbatim is blocked (it is not contained in any validated quotation)", NEEDS, () => {
  const H = D().fc_headline, v = b1.readBundle(PRIV.bundle("FC"));
  assert.ok(v.held.some((h) => h.section === "headline_claims" && b1.quotesOf(h.finding).includes(H)));
  assert.ok(!b1.verifiedQuotes(v).some((q) => q.includes(H)), "no validated quotation independently contains it");
  const r = blocked("FC", `${H}.`, "b1_held_quote");
  assert.ok(rules(r).includes("b1_claim_context"), "its period / geography framing is also unsupported for the figure");
  blocked("FC", `[conversational] So here's the news. ${H}, and that matters for you.`, "b1_held_quote");   // inside a longer script
});

test("D1: a held quotation that a validated quotation independently contains is not treated as held", NEEDS, () => {
  const { contextFromView } = require("../netlify/functions/lib/agent-marketing-b1-claims-lib");
  const v = b1.readBundle(PRIV.bundle("FC"));
  const q = b1.verifiedQuotes(v).find((x) => x.includes(D().fc_validated_figure));
  const fake = { ...v, held: [...v.held, { section: "headline_claims", finding: { quote: q } }] };
  assert.ok(!contextFromView(fake).held.includes(q));
});

test("D1: paraphrases that introduce an unsupported geography, period or measurement are blocked", NEEDS, () => {
  for (const [c, line, why] of D().context_blocked) {
    const r = blocked(c, line, "b1_claim_context");
    assert.match(r.blocks.find((b) => b.rule === "b1_claim_context").message, new RegExp(why), line);
  }
});

test("D1: the same number in a different, unsupported claim is blocked", NEEDS, () => {
  for (const [c, line, rule] of D().same_number_blocked) blocked(c, line, rule);
});

test("D1: held and excluded findings are never support: a figure only they give is blocked", NEEDS, () => {
  for (const [c, line] of D().held_only_blocked) blocked(c, line, "b1_unsupported_figure");
  const fa = b1.readBundle(PRIV.bundle("FA"));
  assert.strictEqual(PRIV.faItems(fa.validated, PRIV.cases).A1, false, "FA A1 remains held");
  assert.strictEqual(PRIV.faItems(fa.held, PRIV.cases).A1, true);
});

test("D1: correctly attributed claims supported by validated evidence pass", NEEDS, () => {
  for (const [c, line] of D().pass) { const r = passes(c, line); assert.ok(r.sourcedFacts.some((s) => /B1 validated/.test(s)), line); }
});

test("D1: validated FA A6 and A7 findings remain available and can be stated", NEEDS, () => {
  const fa = b1.readBundle(PRIV.bundle("FA"));
  const it = PRIV.faItems(fa.validated, PRIV.cases);
  assert.deepStrictEqual([it.A1, it.A6, it.A7], [false, true, true]);
  const pe = b1.plannerArticleEvidence(fa);
  assert.ok(pe.validated_findings.some((f) => f.source_quotes.some((q) => q.includes(D().fa_a6_quote))), "A6 reaches the Planner");
  assert.ok(pe.validated_findings.some((f) => f.source_quotes.some((q) => q.includes(D().fa_a7_quote))), "A7 reaches the Planner");
  passes("FA", D().fa_a6_line);
});

test("D1: no legitimate validated statement is rejected because it shares common words with a held quotation", NEEDS, () => {
  for (const [c, line] of D().shared_words_pass) passes(c, line);
});

test("D1: rule 2f is preserved: on a report-first topic the agent's report owns market numbers", NEEDS, () => {
  const k = D().rule_2f;
  const extra = { reportFirst: true, reportFigures: [{ text: k.report_figure }] };
  passes("FC", k.report_figure, { extra });                                  // the agent's report figure is exempt from the B1 checks
  assert.ok(rules(run("FC", k.b1_line, { extra })).includes("invented_number"));   // a B1 market figure is still not a source here (legacy rule)
  passes("FC", "I have seen about 30 days on market lately.", { intake: { market: "Sacramento County", observation: "about 30 days on market lately" } });
});

test("D1: BLOCKED evidence authorizes no article figure (fail closed)", NEEDS, () => {
  const t = b1.attachToTopic({ ...base }, PRIV.bundle("BLOCKED"));
  const r = gate.evaluate({ template: "local_market_insider", intake: {}, generated: { narration: "Inventory is up 15% this year." }, verified: gate.verifiedFromTopic(t, ON) });
  assert.ok(rules(r).includes("b1_unsupported_figure"));
});

test("D1: B1 disabled: the legacy gate is unchanged", NEEDS, () => {
  for (const c of ["FA", "FB", "FC"]) {
    const vOn = gate.verifiedFromTopic(topic(c), ON), vOff = gate.verifiedFromTopic(topic(c), OFF);
    assert.ok(vOn.b1 && !("b1" in vOff), "the B1 context exists only with the switch on");
    assert.deepStrictEqual(vOff, gate.verifiedFromTopic({ ...base }, OFF), "switch off: identical to a topic with no evidence");
  }
  for (const line of D().disabled_lines) {
    const off = run("FC", line, { env: OFF });
    const legacy = gate.evaluate({ template: "local_market_insider", intake: { market: "Sacramento County" }, generated: { narration: line }, verified: gate.verifiedFromTopic({ ...base }, OFF) });
    assert.deepStrictEqual(off, legacy, line);
    assert.deepStrictEqual(b1Rules(off), []);
  }
});

test("D1: B1 disabled, no fixtures needed: a topic without evidence has no B1 context", () => {
  assert.ok(!("b1" in gate.verifiedFromTopic({ ...base }, ON)));
  assert.ok(!("b1" in gate.verifiedFromTopic(b1.attachToTopic({ ...base }, { format: "x" }), OFF)));
});
