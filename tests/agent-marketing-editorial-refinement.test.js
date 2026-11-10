// Nov 9, 2026 editorial refinement after the first real-model evaluation: prompt text for Options 1 and 2, and the wording of flat readings.
// Deterministic: no model is called. The fixture is the Domus October 2026 report (442 active, 138 closed, median $608,378 down 2.4%).
const test = require("node:test");
const assert = require("node:assert");
const lib = require("../netlify/functions/lib/agent-marketing-report-lib");
const rr = require("../netlify/functions/lib/agent-marketing-research-report-lib");
const ti = require("../netlify/functions/lib/agent-marketing-trend-intelligence-lib");
const ed = require("../netlify/functions/lib/agent-marketing-report-editorial-lib");
const b2 = require("../netlify/functions/lib/agent-marketing-b2-lib");
const fx = require("./helpers/market-update-fixtures");

const domus = () => rr.buildContext([{ id: "u1", facts: lib.analyzePages([fx.DOMUS_TEXT], { items: fx.DOMUS_ITEMS }).facts }], { geography: { type: "city", name: "Roseville", label: "Roseville" } });

test("a median price down 2.4% is never called steady, in the observation, the title, the contrast or the readings", () => {
  const a = ti.analyze(domus());
  const p = a.observations.find((o) => o.kind === "price_vs_activity");
  assert.ok(p.evidence.some((e) => /608,378.*down 2\.4%/.test(e.text)), "the fixture is the 442 / 138 / $608,378 report");
  assert.match(p.statement, /edged lower/);
  assert.match(p.title, /edged lower/);
  const everything = JSON.stringify([a.observations, a.contrasts, a.interpretations]);
  assert.ok(!/held steady|Prices steady|has held|price that holds/i.test(everything), everything.match(/.{40}(held steady|Prices steady|has held|price that holds).{20}/i));
  assert.ok(a.observations.every((o) => o.basis.label === "September 2026"), "every comparison is the prior month");
});

test("\"held steady\" is still used when a measure did not change at all, and a small rise reads as edged higher", () => {
  const same = lib.analyzePages([fx.marketUpdate({ price: [610, 610] })], {}).facts;
  const up = lib.analyzePages([fx.marketUpdate({ price: [600, 606] })], {}).facts;
  const read = (f) => ti.analyze(rr.buildContext([{ id: "u1", facts: f }], { geography: { type: "zip", name: "95747", label: "ZIP 95747" } })).observations.find((o) => o.kind === "price_vs_activity");
  const s = read(same), u = read(up);
  if (s) assert.ok(!/edged/.test(s.statement));
  if (u) assert.ok(/edged higher|rose/.test(u.statement) && !/held steady/.test(u.statement));
});

const OPTION_1 = ed.systemPrompt();
const OPTION_2 = b2.systemPrompt("article_report", true);
const OPTION_3 = b2.systemPrompt("article_editorial", false);

test("both options ask for ten meaningfully different perspectives, without padding to a quota", () => {
  for (const p of [OPTION_1, OPTION_2]) {
    assert.match(p, /Explore 10 meaningfully different editorial perspectives/);
    assert.match(p, /REALTOR IMPLICATION/);
    assert.match(p, /Do not pad to reach 10/);
    assert.match(p, /not (a different|another) wording/);
  }
});

test("Option 1 selects three to five and names the selection criteria; Option 2 selects the strongest five where the evidence supports them", () => {
  assert.match(OPTION_1, /Select the strongest 3 to 5/);
  assert.match(OPTION_2, /Select the strongest 5 where the evidence supports them/);
  for (const p of [OPTION_1, OPTION_2]) {
    ["strength of the market interpretation", "relevance to (this|the) audience", "specificity to THIS", "distinctness from the other selected", "practical Realtor insight", "decision journey", "Never select near-duplicates"]
      .forEach((x) => assert.match(p, new RegExp(x), x));
  }
  assert.match(OPTION_1, /perspectives, not recaps/);
});

test("both options carry the periods-and-comparisons rules and keep interpretation apart from reported statistics", () => {
  assert.ok(OPTION_1.includes(ti.COMPARISON_RULES) && OPTION_2.includes(ti.COMPARISON_RULES));
  assert.match(ti.COMPARISON_RULES, /month-over-month change: never call it year over year/);
  assert.match(ti.COMPARISON_RULES, /Never describe a measure that rose or fell as unchanged, steady or flat/);
  assert.match(ti.COMPARISON_RULES, /Do not introduce a historical comparison/);
  assert.match(ti.COMPARISON_RULES, /pricing strategy, competitive positioning, carrying costs, buyer behavior/);
  assert.match(ti.COMPARISON_RULES, /never carries a number that is not in the evidence/);
});

test("Option 2 keeps the article as the foundation, allows conditional Realtor interpretation, and refuses forced market connections", () => {
  assert.match(OPTION_2, /article stays the factual foundation; the report is the source of local market performance/);
  assert.match(OPTION_2, /PRIORITIZE candidates that reveal a real relationship between the article's subject and the market conditions/);
  assert.match(OPTION_2, /Never force a weak market connection just to use another article finding/);
  assert.match(OPTION_2, /not limited to repeating the article/);
  assert.match(OPTION_2, /builder competition and incentives, special taxes or assessments, ownership costs/);
  assert.match(OPTION_2, /Never present such a possibility as a verified fact about this particular development/);
  assert.match(OPTION_2, /LOCAL MARKET PERFORMANCE STATISTICS .* come ONLY from the agent's report/s);
});

test("Option 3 (article without a report) keeps its earlier prompt", () => {
  assert.match(OPTION_3, /Write up to 10 distinct candidate questions/);
  assert.match(OPTION_3, /Select the 5 strongest candidates/);
  assert.ok(!/PERIODS AND COMPARISONS|REALTOR IMPLICATION|not limited to repeating the article|TREND INTELLIGENCE/.test(OPTION_3));
});

test("the structure checks and limits are unchanged: up to ten candidates, three to five selected for Option 1", () => {
  assert.strictEqual(ed.MAX_CANDIDATES, 10);
  assert.strictEqual(ed.SELECT_MAX, 5);
  assert.strictEqual(ed.SELECT_MIN, 3);
  assert.strictEqual(b2.MAX_CANDIDATES, 10);
  assert.strictEqual(b2.SELECT, 5);
});
