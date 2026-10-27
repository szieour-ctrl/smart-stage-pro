// The weekly dashboards (Weekly Review / Weekly Infographic), read by position, and the dashboards that are refused.
const test = require("node:test");
const assert = require("node:assert");
const lib = require("../netlify/functions/lib/agent-marketing-report-lib");
const rt = require("../netlify/functions/lib/agent-marketing-research-report-lib");
const wk = require("./helpers/weekly-fixture");

const get = (f, key) => f.figures.find((x) => x.key === key);
const analyze = (fx) => lib.analyzePages(fx.pages, { items: fx.items });

test("Weekly Review: every tile is paired with its own label, and each percent with its row and column", () => {
  const r = analyze(wk.review());
  assert.ok(r.facts, JSON.stringify(r));
  const f = r.facts;
  assert.strictEqual(f.layout, "weekly_snapshot");
  assert.strictEqual(get(f, "median_close_price").value, 512345);
  assert.strictEqual(get(f, "count_closed").value, 31);
  assert.strictEqual(get(f, "median_dom").value, 27);
  assert.strictEqual(get(f, "avg_close_to_list_pct").value, 99.2);        // the one big number that is itself a percent
  assert.strictEqual(get(f, "median_ppsf").value, 301);
  assert.strictEqual(get(f, "count_new").value, 58);
  assert.strictEqual(get(f, "count_active").value, 402);
  assert.strictEqual(get(f, "weeks_supply").value, 13);
  // newest comparison first: "vs 10 Oct" is the middle column, "vs 18 Jul" the left one
  assert.deepStrictEqual(get(f, "median_close_price").changes, [{ pct: -4.2, vs: "the week ending October 10, 2026" }, { pct: -3.1, vs: "the week ending July 18, 2026" }]);
  assert.deepStrictEqual(get(f, "median_dom").changes.map((c) => c.pct), [-8, 12.5]);
  assert.deepStrictEqual(get(f, "weeks_supply").changes.map((c) => c.pct), [5.5, 2]);
});

test("the week, the data date, the area and the MetroList notice come from the dashboard itself", () => {
  const f = analyze(wk.review()).facts;
  assert.deepStrictEqual({ start: f.period.start, end: f.period.end, weekly: f.period.weekly }, { start: "2026-10-11", end: "2026-10-17", weekly: true });
  assert.strictEqual(f.reportDate, "2026-10-23");
  assert.deepStrictEqual(f.geography.cities, ["All MetroList counties"]);
  assert.strictEqual(f.mlsSource, "MetroList");
  const s = lib.summarize(f, {});
  assert.match(s.scopeSentence, /weekly report covers All MetroList counties \(All Property Types\), for the week ending October 17, 2026, data updated October 23, 2026\. The week has 31 closed sales\./);
  assert.strictEqual(s.notice, "Based on information from MetroList Services, Inc. for the period Oct 11, 2026 through Oct 17, 2026.");
  assert.ok(s.warnings.some((w) => /one week of data/.test(w)));
  const compare = s.groups.flatMap((g) => g.figures).find((x) => x.label === "Closed sales").compare;
  assert.strictEqual(compare, "down 20.5% from the week ending October 10, 2026; down 10% from the week ending July 18, 2026");
});

test("Weekly Infographic: the numbers are read, and no comparisons are guessed for it", () => {
  const f = analyze(wk.infographic()).facts;
  assert.strictEqual(get(f, "median_close_price").value, 512345);
  assert.strictEqual(get(f, "count_active").value, 402);
  assert.strictEqual(get(f, "median_dom").value, 27);
  assert.strictEqual(get(f, "median_ppsf").value, 301);
  assert.strictEqual(get(f, "count_new").value, 58);
  assert.strictEqual(get(f, "count_closed").value, 31);
  assert.ok(f.figures.every((x) => !x.changes));
  assert.strictEqual(f.period.end, "2026-10-17");
});

test("a tile that cannot be paired is left out, and too few tiles is an error, never a guess", () => {
  const fx = wk.review();
  fx.items = fx.items.filter((i) => !["$512,345", "31"].includes(i.s));
  const f = analyze(fx).facts;
  assert.strictEqual(get(f, "median_close_price"), undefined);
  assert.strictEqual(get(f, "count_closed"), undefined);
  const few = wk.review(); few.items = few.items.filter((i) => !/^\$|^\d+$|%$/.test(i.s) || /^vs/.test(i.s));
  assert.strictEqual(analyze(few).error, "no_figures");
  assert.strictEqual(lib.analyzePages(wk.review().pages, {}).error, "no_figures");        // no positioned text at all
});

test("Pricing Insights (individual listings) and the Market Insights chart are refused with a plain reason", () => {
  const pricing = ["Pricing Insights Single Family Residence in 95747. Proposed List Price Click on a dot in the chart to display details about that listing. Selected Listing 569 Data provided by MetroList ©2026 Domus Analytics® ".repeat(2)];
  assert.strictEqual(lib.analyzePages(pricing, {}).error, "pricing_tool");
  assert.match(lib.errorMessage("pricing_tool"), /individual listings/);
  const chart = ["Market Insights, Median Sales Price Time Series (Line) 30YR Mortgage Rate Data provided by MetroList ©2026 Domus Analytics® ".repeat(3)];
  assert.strictEqual(lib.analyzePages(chart, {}).error, "chart_only");
});

test("topics from a weekly report: changes are quotable, but one week is never a trend", () => {
  const facts = analyze(wk.review()).facts;
  const ctx = rt.buildContext([{ id: "11111111-1111-4111-8111-111111111111", facts }], { audience: "sellers", geography: { zip: "95678", type: "metro", name: "MetroList", city: "", state: "CA", label: "MetroList metro area, CA" }, focus: {} });
  const ref = (key) => [...ctx.figures.values()].find((c) => c.fig.key === key).ref;
  const ok = rt.validateReportTopics([{ question: "Are fewer homes closing this week?", why_it_matters: "There were 31 closed sales, down 10% from the week ending October 10, 2026.", figure_ids: [ref("count_closed")] }], ctx, { want: 5 });
  assert.deepStrictEqual(ok.problems, []);
  assert.strictEqual(ok.topics[0].origin, "report");
  const trend = rt.validateReportTopics([{ question: "Is a downward trend starting?", why_it_matters: "There were 31 closed sales, down 10%.", figure_ids: [ref("count_closed")] }], ctx, { want: 5 });
  assert.strictEqual(trend.topics.length, 0);
  assert.match(trend.problems[0], /one week/);
  const invented = rt.validateReportTopics([{ question: "Are fewer homes closing?", why_it_matters: "There were 31 closed sales, down 12% from last week.", figure_ids: [ref("count_closed")] }], ctx, { want: 5 });
  assert.strictEqual(invented.topics.length, 0);
});
