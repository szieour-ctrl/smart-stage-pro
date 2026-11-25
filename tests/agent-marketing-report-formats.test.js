// Reports from different associations: the one-page Market Update, the Domus Analytics monthly infographic, and where a report says it is.
const test = require("node:test");
const assert = require("node:assert");
const lib = require("../netlify/functions/lib/agent-marketing-report-lib");

const get = (f, key) => f.figures.find((x) => x.key === key);
const MU = [
  "Market Update", "Published: November 2026*", "ZIP 95747", "Single Family Homes", "October Year To Date",
  "Data Metrics 2025 2026 % Change 2025 2026 % Change",
  "For Sale 257 338 31.5% 257 338 31.5%", "New Listing 133 140 5.3% 1,666 1,629 -2.2%", "Sold 132 80 -39.4% 1,118 1,125 0.6%", "Pended 113 95 -15.9% 1,184 1,181 0.3%",
  "Months of Inventory (Closed Sales) 1.9 4.2 118.1% 2.3 3 30.5%", "Months of Inventory (Pended Sales) 2.3 3.6 57.2% 2.2 2.9 32.2%",
  "Avg. Active Price 707 716 1.3% 742 740 0.3%", "Avg. Sold Price 658 705 7.1% 695 696 0.1%", "Median Active Price 659 661 0.3% 683 707 3.5%",
  "Median Sold Price 612 618 1% 641 655 2.2%", "Avg. Sq. Ft. Price (Sold) 316 322 1.9% 319 316 0.9%", "Sold/List Diff. % 99 99 0% 99 99 0%",
  "Sold/Orig LP Diff. % 98 98 0% 98 98 0%", "Avg Days on Market 46 49 6.5% 38 42 10.5%", "Months of Inventory and Median Sold Price Trends",
  "All reports are published November 2026, based on data available at the end of October 2026, except for the today’s stats. Data from MetroList MLS.",
].join("\n");

test("Market Update: month and year-to-date figures, ZIP, property type, and MetroList notice", () => {
  const r = lib.analyzePages([MU], {});
  assert.ok(r.facts, JSON.stringify(r));
  const f = r.facts;
  assert.strictEqual(f.layout, "market_update");
  assert.deepStrictEqual(f.geography.zips, ["95747"]);
  assert.deepStrictEqual(f.propertyTypes, ["Single Family Homes"]);
  assert.strictEqual(f.period.label, "October 2026");
  assert.strictEqual(get(f, "median_close_price").value, 618000);
  assert.strictEqual(get(f, "median_close_price").yearAgo, 612000);
  assert.strictEqual(get(f, "count_closed").value, 80);
  assert.strictEqual(get(f, "count_closed_ytd").value, 1125);
  assert.strictEqual(get(f, "count_closed_ytd").yearAgoLabel, "January through October 2025");
  assert.match(lib.compareText(f, get(f, "count_closed")), /132 in October 2025 \(down 39\.4%\)/);
  assert.match(lib.attributionNotice(f), /MetroList Services, Inc\. All reports are published November 2026/);
  assert.match(lib.scopeSentence(f), /ZIP 95747.*October 2026 and the year to date/);
  assert.ok(f.figures.length <= 24);
});

test("Market Update: a table read into the wrong columns is refused, and one wrong percent is flagged", () => {
  const shifted = MU.replace(/(Sold \d+ \d+) (-?[\d.]+%)/, "$1 55.5%");
  const one = lib.analyzePages([shifted], {});
  assert.ok(one.facts && one.facts.warnings.some((w) => /does not match/.test(w)), JSON.stringify(one));
  const scrambled = MU.split("\n").map((l) => (/^[A-Z][A-Za-z. \/()%]+ [\d.,-]+ /.test(l) ? l.replace(/ (\S+) (\S+%) /, " $2 $1 ") : l)).join("\n");
  assert.deepStrictEqual(lib.analyzePages([scrambled], {}), { error: "no_figures" });
});

// Positions (x, y from the top) from the MetroList monthly Domus infographic, tile by tile.
const DOMUS_TEXT = "Domus Analytics Market Infographic October 2026 vs September 2026 Includes all Property Types in Placer Median Sales Price Closed Sales Active Inventory Median Days on Market Median Sold $/SqFt New Listings Data provided by MetroList and updated 11/08/26 ".repeat(2);
const DOMUS_ITEMS = [
  ["Market Infographic", 346, 44], ["October 2026", 312, 82], ["vs September 2026", 727, 111], ["Includes all Property Types in Placer", 341, 112],
  ["Median Sales Price", 194, 168], ["$608,378", 186, 255], ["Down 2.4%", 402, 268],
  ["Closed Sales", 620, 173], ["138", 656, 255], ["Down 16.9%", 518, 268],
  ["Active Inventory", 130, 353], ["442", 130, 515], ["Up 2.8%", 122, 404],
  ["Median Days on Market", 393, 333], ["30", 440, 412], ["Up 11.1%", 318, 407],
  ["Median Sold $/SqFt", 393, 472], ["$335", 352, 553], ["Up 1.8%", 474, 553],
  ["New Listings", 656, 367], ["211", 659, 467], ["Up 1.0%", 656, 515],
].map(([s, x, y]) => ({ s, x, y }));

test("Domus monthly infographic: each tile gets its own number and its own percent change; the place is a county", () => {
  const r = lib.analyzePages([DOMUS_TEXT], { items: DOMUS_ITEMS });
  assert.ok(r.facts, JSON.stringify(r));
  const f = r.facts;
  assert.strictEqual(f.layout, "monthly_snapshot");
  assert.deepStrictEqual(f.geography, { cities: [], zips: [], counties: ["Placer County"], drawnOnMap: false });
  assert.strictEqual(f.mlsSource, "MetroList");
  assert.strictEqual(f.period.label, "October 2026");
  assert.strictEqual(f.reportDate, "2026-11-08");
  const ch = (k) => get(f, k).changes[0];
  assert.deepStrictEqual([get(f, "median_close_price").value, ch("median_close_price")], [608378, { pct: -2.4, vs: "September 2026" }]);
  assert.deepStrictEqual([get(f, "count_closed").value, ch("count_closed")], [138, { pct: -16.9, vs: "September 2026" }]);
  assert.deepStrictEqual([get(f, "count_active").value, ch("count_active")], [442, { pct: 2.8, vs: "September 2026" }]);
  assert.deepStrictEqual([get(f, "median_dom").value, ch("median_dom")], [30, { pct: 11.1, vs: "September 2026" }]);
  assert.deepStrictEqual([get(f, "median_ppsf").value, ch("median_ppsf")], [335, { pct: 1.8, vs: "September 2026" }]);
  assert.deepStrictEqual([get(f, "count_new").value, ch("count_new")], [211, { pct: 1, vs: "September 2026" }]);
  assert.match(lib.scopeSentence(f), /Placer County.*October 2026/);
});

test("Weekly dashboards are still read as weekly", () => {
  const wk = require("./helpers/weekly-fixture");
  const fx = wk.review();
  assert.strictEqual(lib.analyzePages(fx.pages, { items: fx.items }).facts.layout, "weekly_snapshot");
});

test("places: ZIP, city and county are told apart", () => {
  assert.deepStrictEqual(lib.geographyFrom(["ZIP 95747", "Roseville, CA", "Placer", "El Dorado County"]), { cities: ["Roseville"], zips: ["95747"], counties: ["Placer County", "El Dorado County"], drawnOnMap: false });
  assert.deepStrictEqual(lib.classifyPlace("Rocklin"), { city: "Rocklin" });
});

test("location check: a ZIP request matches a ZIP report; a city request against a county report is flagged as wider", () => {
  const zipReport = lib.analyzePages([MU], {}).facts;
  assert.strictEqual(lib.geographyCheck(zipReport, { type: "zip", name: "95747" }).status, "match");
  assert.strictEqual(lib.geographyCheck(zipReport, { type: "zip", name: "ZIP 95747" }).status, "match");
  assert.strictEqual(lib.geographyCheck(zipReport, { type: "zip", name: "95765" }).status, "different");
  assert.strictEqual(lib.geographyCheck(zipReport, { type: "city", name: "Roseville" }).status, "not_named");
  const county = lib.analyzePages([DOMUS_TEXT], { items: DOMUS_ITEMS }).facts;
  assert.strictEqual(lib.geographyCheck(county, { type: "county", name: "Placer" }).status, "match");
  const wide = lib.geographyCheck(county, { type: "city", name: "Roseville", county: "Placer County" });
  assert.strictEqual(wide.status, "different");
  assert.match(wide.message, /wider than Roseville/);
  assert.strictEqual(lib.geographyCheck(county, { type: "city", name: "Roseville" }).status, "not_named");
  assert.strictEqual(lib.geographyCheck(county, { type: "county", name: "Sacramento" }).status, "different");
});
