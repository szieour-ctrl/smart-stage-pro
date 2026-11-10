// Trend Intelligence: one shared, deterministic reading of a confirmed report's figures (Option 1 and Option 2 both use it).
const test = require("node:test");
const assert = require("node:assert");
const lib = require("../netlify/functions/lib/agent-marketing-report-lib");
const ti = require("../netlify/functions/lib/agent-marketing-trend-intelligence-lib");
const rr = require("../netlify/functions/lib/agent-marketing-research-report-lib");
const fx = require("./helpers/market-update-fixtures");

const ctxOf = (facts, geography) => rr.buildContext([{ id: "u1", facts }], { geography });
const analyzeText = (text, geography) => ti.analyze(ctxOf(lib.analyzePages([text], {}).facts, geography));

test("a report with growing supply and falling sales reads as inventory building, with every observation tied to report figures", () => {
  const a = analyzeText(fx.marketUpdate(), { type: "zip", name: "95747", label: "ZIP 95747" });
  assert.ok(a.usable);
  assert.strictEqual(a.character.key, "inventory_building");
  const sd = a.observations.find((o) => o.kind === "supply_demand");
  assert.strictEqual(sd.signal, "buyer_favoring");
  assert.ok(sd.evidence.length >= 2 && sd.evidence.every((e) => /^r1\.f\d+$/.test(e.ref) && /\d/.test(e.text)));
  assert.ok(!/\d/.test(sd.statement), "statements carry no numbers; evidence does");
  assert.ok(a.observations.some((o) => o.kind === "month_vs_year"), "the month against the year to date is a relationship");
  assert.ok(a.interpretations.every((i) => i.status === "interpretation"));
  assert.deepStrictEqual(a.reports[0].places, ["ZIP 95747"]);
  assert.strictEqual(a.reports[0].period.label, "October 2026");
});

test("a tight, heating market reads differently from an inventory-building one", () => {
  const tight = analyzeText(fx.marketUpdate({ active: [180, 120], closed: [90, 118], pended: [80, 104], months: [1.5, 0.9], dom: [30, 21], sl: [99, 101], price: [600, 640] }));
  const loose = analyzeText(fx.marketUpdate());
  assert.notStrictEqual(tight.character.key, loose.character.key);
  assert.strictEqual(tight.character.key, "tight_supply");
  const realtor = (x) => x.interpretations.filter((i) => i.audience === "realtor").map((i) => i.text).join("|");
  assert.notStrictEqual(realtor(tight), realtor(loose));
  const kinds = (a) => a.observations.map((o) => `${o.kind}:${o.signal}`).sort().join("|");
  assert.notStrictEqual(kinds(tight), kinds(loose));
});

test("a county dashboard with only changes still produces relationships and carries its period and place", () => {
  const f = lib.analyzePages([fx.DOMUS_TEXT], { items: fx.DOMUS_ITEMS }).facts;
  const a = ti.analyze(ctxOf(f, { type: "city", name: "Roseville", county: "Placer County" }));
  assert.ok(a.usable);
  assert.strictEqual(a.reports[0].geoStatus, "different");
  assert.ok(a.caveats.some((c) => /wider than Roseville/.test(c)));
  assert.ok(a.observations.every((o) => o.basis.type === "prior" && /September 2026/.test(o.basis.label)));
});

test("no earlier figures means no analysis, not an invented one", () => {
  const f = { version: 1, layout: "labeled_metrics", geography: { cities: ["Roseville"], zips: [] }, period: null, figures: [{ id: "f1", key: "median_close_price", label: "Median sold price", value: 600000, unit: "usd" }, { id: "f2", key: "count_closed", label: "Closed sales", value: 50, unit: "count" }], sample: {} };
  const a = ti.analyze(ctxOf(f));
  assert.strictEqual(a.usable, false);
  assert.strictEqual(ti.promptBlock(a), "");
});

test("refs can be renamed for the caller, and a topic keeps only the slice it rests on", () => {
  const ctx = ctxOf(lib.analyzePages([fx.marketUpdate()], {}).facts);
  const ids = new Map([...ctx.figures.keys()].map((k, i) => [k, `R${i + 1}`]));
  const a = ti.analyze(ctx, { refOf: (r) => ids.get(r) });
  assert.ok(a.observations[0].evidence.every((e) => /^R\d+$/.test(e.ref)));
  const slice = ti.editorialInput(a, [a.observations[0].id]);
  assert.strictEqual(slice.observations.length, 1);
  assert.ok(slice.interpretations.every((i) => i.basis.includes(a.observations[0].id)));
  assert.match(ti.promptBlock(a), /TREND INTELLIGENCE[\s\S]*Market character:[\s\S]*evidence R\d+:/);
});

test("the analysis is deterministic", () => {
  const f = lib.analyzePages([fx.marketUpdate()], {}).facts;
  assert.deepStrictEqual(ti.analyze(ctxOf(f)), ti.analyze(ctxOf(f)));
});
