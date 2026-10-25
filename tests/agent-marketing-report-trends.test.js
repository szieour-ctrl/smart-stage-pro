// The monthly market-trends layout (TrendVision), plus the rules that stop the generic reader from guessing at table rows.
const test = require("node:test");
const assert = require("node:assert");
const lib = require("../netlify/functions/lib/agent-marketing-report-lib");
const readLib = require("../netlify/functions/lib/agent-marketing-report-read-lib");
const gate = require("../netlify/functions/lib/agent-marketing-gate");
const tv = require("./helpers/trend-fixture");
const { pdfFromPages } = require("./helpers/make-pdf");

const get = (f, key) => f.figures.find((x) => x.key === key);

test("a trends report is read from its data table: latest month, prior month, same month last year", () => {
  const r = lib.analyzePages(tv.standard().pages);
  assert.ok(r.facts, JSON.stringify(r));
  const f = r.facts;
  assert.strictEqual(f.layout, "market_trends");
  assert.deepStrictEqual(f.geography, { cities: [], zips: ["95999"], drawnOnMap: false });
  assert.deepStrictEqual(f.propertyTypes, ["Single Family Homes"]);
  assert.deepStrictEqual({ label: f.period.label, start: f.period.start, end: f.period.end, months: f.period.months }, { label: "September 2026", start: "2026-09-01", end: "2026-09-30", months: 15 });
  assert.strictEqual(get(f, "months_supply").value, 5.9);                     // not rounded to 6, and not a prior-year column
  assert.strictEqual(get(f, "median_close_price").value, 715000);             // data table is in $ thousands
  assert.strictEqual(get(f, "median_close_price").prior, 718000);
  assert.strictEqual(get(f, "median_close_price").yearAgo, 710000);
  assert.strictEqual(get(f, "avg_ppsf").value, 350);
  assert.strictEqual(get(f, "count_closed").value, 52);
  assert.strictEqual(get(f, "absorption_closed").value, 16.9);
  assert.deepStrictEqual(f.checks, { checked: 5, mismatched: 0 });
  assert.deepStrictEqual(f.warnings, []);
});

test("the part-month 'Today's Stats' page is never used", () => {
  const f = lib.analyzePages(tv.standard().pages).facts;
  assert.notStrictEqual(get(f, "count_closed").value, 999);
  assert.notStrictEqual(get(f, "months_supply").value, 9.9);
  assert.ok(f.notes.some((n) => /Today's Stats/.test(n)));
});

test("no agent name, email or phone ends up in the stored facts", () => {
  const json = JSON.stringify(lib.analyzePages(tv.standard().pages).facts);
  for (const s of ["Pat Fixture", "PAT FIXTURE", "example.com", "916-555"]) assert.ok(!json.includes(s), s);
});

test("the confirmation text names the area and month, and months of inventory keeps its decimal", () => {
  const f = lib.analyzePages(tv.standard().pages).facts;
  const s = lib.summarize(f, { geography: { type: "zip", name: "95999" } });
  assert.match(s.scopeSentence, /ZIP 95999 \(Single Family Homes\), for September 2026/);
  assert.match(s.scopeSentence, /52 closed sales/);
  assert.strictEqual(s.geography, "match");
  const moi = s.groups.flatMap((g) => g.figures).find((x) => /closed-sales basis/.test(x.label));
  assert.strictEqual(moi.display, "5.9 months");
  assert.match(moi.compare, /vs 5 months in August 2026 and 4 months in September 2025/);
  assert.ok(!/\d{1,3},?\d{3}.*closed sale/.test(s.scopeNote) && !/\$/.test(s.scopeNote));    // nothing priced goes to the research provider
});

test("MetroList's required advertising notice is built from the report's own period", () => {
  const f = lib.analyzePages(tv.standard().pages).facts;
  assert.strictEqual(f.mlsSource, null);                                       // the fixture never names an MLS
  assert.strictEqual(lib.attributionNotice(f), null);
  f.mlsSource = "MetroList";
  assert.strictEqual(lib.attributionNotice(f), "Based on information from MetroList Services, Inc. for the period Sep 1, 2026 through Sep 30, 2026.");
  assert.strictEqual(lib.attributionNotice({ ...f, mlsSource: "CRMLS" }), null);
});

test("a small month is flagged, and a summary table that disagrees with the data table is flagged", () => {
  const small = lib.analyzePages(tv.standard({ closed: 6 }).pages).facts;
  assert.strictEqual(small.sample.small, true);
  assert.ok(small.warnings.some((w) => /small sample/.test(w)));
  const bad = lib.analyzePages(tv.standard({ summaryMismatch: true }).pages).facts;
  assert.strictEqual(bad.checks.mismatched, 1);
  assert.ok(bad.warnings.some((w) => /disagree/.test(w) && /closed sales/.test(w)));
});

test("months that skip a column are refused rather than compared wrongly", () => {
  const pages = tv.standard().pages.map((p) => p.replace("Metric 3/26", "Metric 4/26"));
  assert.strictEqual(lib.analyzePages(pages).error, "no_figures");
});

test("verified facts for the gate carry the comparisons, so 'down from last month' can be traced", () => {
  const f = lib.analyzePages(tv.standard().pages).facts;
  const v = lib.verifiedFromReport({ ...f, figures: f.figures.filter((x) => x.key === "median_close_price") });
  assert.match(v.texts[0], /Median sold price: \$715,000.*\$718,000 in August 2026 and \$710,000 in September 2025/);
});

test("the generic reader no longer guesses at table rows or sentences with several numbers", () => {
  assert.deepStrictEqual(lib.extractLabeledMetrics(["Months of Inventory (Closed) 3.3 2.9 13.6%"]), []);
  assert.deepStrictEqual(lib.extractLabeledMetrics(["Months of Inventory is 3.3 months and absorption is 30.5%."]), []);
  assert.strictEqual(lib.extractLabeledMetrics(["Months of Inventory 2.4"])[0].value, 2.4);
});

test("a real PDF of this layout is read end to end", async () => {
  const pdf = await pdfFromPages(tv.standard().pages);
  const r = await readLib.readReport(pdf, "TrendVision.pdf");
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.facts.layout, "market_trends");
  assert.deepStrictEqual(r.facts.figures, lib.analyzePages(tv.standard().pages).facts.figures);
});
