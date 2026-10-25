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

// ── The same measures exported as a spreadsheet: one row per measure, one column per month ──
const TREND_CSV = [
  "Metric,25-Jul,25-Aug,25-Sep,25-Oct,25-Nov,25-Dec,26-Jan,26-Feb,26-Mar,26-Apr,26-May,26-Jun,26-Jul,26-Aug,26-Sep",
  "For Sale,403,372,355,332,297,257,240,247,273,300,334,365,377,360,367",
  "New Listing,210,225,208,183,135,118,173,181,243,259,281,277,237,187,193",
  "Sold,171,173,193,177,139,157,102,132,170,165,182,208,203,151,142",
  "Pended,171,195,181,149,131,107,150,150,188,186,199,184,171,160,146",
  "Months of Inventory (Closed Sales),2.4,2.2,1.8,1.9,2.1,1.6,2.4,1.9,1.6,1.8,1.8,1.8,1.9,2.4,2.6",
  "Months of Inventory (Pended Sales),2.4,1.9,2,2.2,2.3,2.4,1.6,1.6,1.5,1.6,1.7,2,2.2,2.3,2.5",
  "Absorption Rate (Closed Sales) %,42.4,46.5,54.4,53.3,46.8,61.1,42.5,53.4,62.3,55,54.5,57,53.8,41.9,38.7",
  "Absorption Rate (Pended Sales) %,42.4,52.4,51,44.9,44.1,41.6,62.5,60.7,68.9,62,59.6,50.4,45.4,44.4,39.8",
  "Avg. Active Price,729,717,729,695,705,707,725,726,756,746,740,747,744,728,720",
  "Avg. Sold Price,725,696,667,668,696,663,651,656,661,700,717,719,709,689,680",
  "Avg. Sq. Ft. Price (Sold),325,313,322,319,324,316,317,322,320,334,328,330,327,315,318",
  "Median Active Price,673,659,670,650,670,656,682,680,729,710,694,725,699,677,660",
  "Median Sold Price,650,658,613,618,655,635,625,624,633,659,670,668,665,640,634",
  "Sold/List Diff. %,99,99,99,99,98,99,99,99,100,100,100,100,99,99,99",
  "Sold/Orig LP Diff. %,97,97,98,98,96,97,96,98,99,99,99,99,98,98,97",
  "Avg Days on Market,33,39,40,41,51,53,61,43,37,31,32,32,31,33,38",
  "Avg CDOM,37,43,45,49,58,61,68,51,45,33,36,35,37,37,43",
].join("\n");

test("a trends CSV (metric rows, month columns) is read like the TrendVision data table", async () => {
  const r = await readLib.readReport(Buffer.from(TREND_CSV), "facts_trends_report_data_1.csv");
  assert.ok(r.ok, JSON.stringify(r));
  const f = r.facts;
  assert.strictEqual(f.layout, "market_trends");
  assert.strictEqual(f.period.label, "September 2026");
  assert.strictEqual(f.period.yearAgoLabel, "September 2025");
  assert.strictEqual(get(f, "count_pending").value, 146);
  assert.strictEqual(get(f, "count_pending").prior, 160);
  assert.strictEqual(get(f, "count_pending").yearAgo, 181);
  assert.strictEqual(get(f, "median_close_price").value, 634000);   // $ thousands in the file
  assert.strictEqual(get(f, "median_close_price").yearAgo, 613000);
  assert.strictEqual(get(f, "avg_dom").value, 38);
  assert.strictEqual(get(f, "months_supply").value, 2.6);
  assert.ok(f.warnings.some((w) => /does not say which area/.test(w)));  // the agent's confirmation covers the area
  assert.deepStrictEqual(f.geography, { cities: [], zips: [], drawnOnMap: false });
});

test("trends table: other month header styles work; gaps or missing measures are not guessed at", () => {
  const rows = (hdr) => TREND_CSV.split("\n").map((l, i) => (i === 0 ? hdr : l.split(",")));
  const months = ["Jul-25", "Aug-25", "Sep-25", "Oct-25", "Nov-25", "Dec-25", "Jan-26", "Feb-26", "Mar-26", "Apr-26", "May-26", "Jun-26", "Jul-26", "Aug-26", "Sep-26"];
  const a = lib.analyzeRows(rows(["Metric"].concat(months)), "csv");
  assert.strictEqual(a.facts.period.label, "September 2026");
  const gap = months.slice(); gap[5] = "Jan-26";
  assert.ok(lib.analyzeRows(rows(["Metric"].concat(gap)), "csv").error);
  const few = TREND_CSV.split("\n").slice(0, 6).map((l) => l.split(","));
  assert.ok(!lib.analyzeRows(few, "csv").facts || lib.analyzeRows(few, "csv").facts.layout !== "market_trends");
});
