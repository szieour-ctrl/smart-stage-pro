// Run with: node --test tests/*.test.js
const test = require("node:test");
const assert = require("node:assert");
const lib = require("../netlify/functions/lib/agent-marketing-report-lib");
const gate = require("../netlify/functions/lib/agent-marketing-gate");
const fx = require("./helpers/cma-fixture");

const analyze = (over) => { const f = fx.standard(over); const r = lib.analyzePages(f.pages); assert.ok(r.facts, JSON.stringify(r)); return { ...f, facts: r.facts }; };
const fig = (facts, status, key) => (facts.figures.find((f) => f.status === status && f.key === key) || {}).value;

test("parsers: dates, money, days on market, statuses", () => {
  assert.strictEqual(lib.parseDate("10/23/26"), "2026-10-23");
  assert.strictEqual(lib.parseDate("2/18/2026"), "2026-02-18");
  assert.strictEqual(lib.parseDate("2026-10-23"), "2026-10-23");
  assert.strictEqual(lib.parseDate("Oct 23, 2026"), "2026-10-23");
  assert.strictEqual(lib.parseDate(new Date(Date.UTC(2026, 9, 23))), "2026-10-23");
  assert.strictEqual(lib.parseDate("02/31/26"), null);
  assert.strictEqual(lib.parseMoney("$689,000"), 689000);
  assert.strictEqual(lib.parseMoney("689K"), 689000);
  assert.strictEqual(lib.parseMoney("$2,500"), null); // a rent, not a sale price
  assert.strictEqual(lib.parseDom("3/3"), 3);
  assert.strictEqual(lib.parseDom("abc"), null);
  assert.strictEqual(lib.normStatus("Closed"), "closed");
  assert.strictEqual(lib.normStatus("Sold"), "closed");
  assert.strictEqual(lib.normStatus("Active Under Contract"), "contingent");
  assert.strictEqual(lib.normStatus("Canceled"), "canceled");
  assert.strictEqual(lib.normStatus("Sold Off MLS"), "other");
});

test("a CMA in the MetroList layout is read: counts match the report's own LISTING COUNT and medians match MEDIAN PRICE", () => {
  const { facts, total } = analyze();
  assert.strictEqual(facts.layout, "cma_table");
  assert.strictEqual(facts.mlsSource, "MetroList");
  assert.strictEqual(facts.reportDate, "2026-10-24");
  assert.deepStrictEqual(facts.propertyTypes, ["Residential"]);
  assert.strictEqual(facts.criteria.closedSince, "2026-02-18");
  assert.strictEqual(facts.geography.drawnOnMap, true);
  assert.deepStrictEqual(facts.geography.cities, ["Roseville"]);
  assert.strictEqual(facts.sample.total, total);
  assert.strictEqual(facts.reportedTotal, total);
  for (const k of ["active", "pending", "closed", "expired"]) {
    assert.strictEqual(facts.statuses[k].count, facts.statuses[k].reportedCount, k);
    assert.strictEqual(facts.statuses[k].medianChecked, true, `${k} median verified`);
  }
  assert.deepStrictEqual(facts.warnings.filter((w) => /did not use|does not match|could not read/.test(w)), []);
});

test("figures are computed from the rows", () => {
  const { facts } = analyze();
  // closed: list 600k..710k step 10k, close = list ±5k → median and average sold price 655,000, six at or above list
  assert.strictEqual(fig(facts, "closed", "median_close_price"), 655000);
  assert.strictEqual(fig(facts, "closed", "avg_close_price"), 655000);
  assert.strictEqual(fig(facts, "closed", "low_price"), 595000);
  assert.strictEqual(fig(facts, "closed", "high_price"), 715000);
  assert.strictEqual(fig(facts, "closed", "at_or_above_list_count"), 6);
  assert.ok(Math.abs(fig(facts, "closed", "avg_close_to_list_pct") - 100) < 0.5);
  assert.strictEqual(fig(facts, "closed", "median_dom"), 37.5);
  // active: list 500k..700k step 40k → median 600k; two of six were reduced
  assert.strictEqual(fig(facts, "active", "median_list_price"), 600000);
  assert.strictEqual(fig(facts, "active", "reduced_count"), 2);
  assert.strictEqual(fig(facts, "active", "median_dom"), 30);
  assert.strictEqual(fig(facts, "active", "count"), 6);
});

test("a status with only one or two listings gets a count and nothing else: its median would be one home's price", () => {
  const { facts } = analyze();
  const pend = facts.figures.filter((f) => f.status === "pending");
  assert.deepStrictEqual(pend.map((f) => f.key), ["count"]);
  assert.deepStrictEqual(facts.figures.filter((f) => f.status === "expired").map((f) => f.key), ["count"]);
  assert.strictEqual(pend[0].small, true);
});

test("small samples are flagged and say so", () => {
  const f = analyze({ closed: [{ list: 700000, close: 705000, dom: 18, date: "2026-09-20" }, { list: 650000, close: 640000, dom: 30, date: "2026-09-02" }, { list: 600000, close: 600000, dom: 9, date: "2026-08-14" }, { list: 720000, close: 700000, dom: 40, date: "2026-07-01" }] }).facts;
  assert.strictEqual(f.sample.small, true);
  assert.ok(f.warnings.some((w) => /small sample/i.test(w) && /trend/i.test(w)));
  assert.strictEqual(f.figures.find((x) => x.status === "closed" && x.key === "median_close_price").small, true);
  const big = analyze().facts;
  assert.strictEqual(big.sample.small, false);
});

test("a wide closed-sale window is flagged so it is not called 'this month'", () => {
  const f = analyze({ closed: Array.from({ length: 12 }, (_, i) => ({ list: 600000 + i * 1000, close: 600000 + i * 1000, dom: 10, date: i === 0 ? "2026-02-23" : "2026-09-24" })) }).facts;
  assert.strictEqual(f.sample.broadWindow, true);
  assert.ok(f.warnings.some((w) => /months/.test(w)));
});

test("if the rows I read do not match the report's own count, no figures are produced for that status", () => {
  const { facts } = analyze({ active: [0, 1, 2, 3, 4, 5].map((i) => ({ list: 500000 + i * 40000, dom: 10, date: "2026-10-10" })) });
  const bad = lib.analyzePages(fx.standard().pages.map((p) => p.replace("LISTING COUNT:6", "LISTING COUNT:7"))).facts;
  assert.ok(bad.warnings.some((w) => /I read 6 of the 7 active listings/.test(w)));
  assert.deepStrictEqual(bad.figures.filter((f) => f.status === "active").map((f) => f.key), ["count"]);
  assert.strictEqual(bad.figures.find((f) => f.status === "active").value, 7, "the count shown is the report's own");
  assert.ok(facts.figures.some((f) => f.status === "active" && f.key === "median_list_price"), "untouched when counts agree");
  assert.ok(bad.figures.some((f) => f.status === "closed" && f.key === "median_close_price"), "other statuses are unaffected");
});

test("a median that disagrees with the printed one is flagged for the agent", () => {
  const bad = lib.analyzePages(fx.standard().pages.map((p) => p.replace("MEDIAN PRICE:$600,000", "MEDIAN PRICE:$612,000"))).facts;
  assert.ok(bad.warnings.some((w) => /does not match/.test(w)));
  assert.strictEqual(bad.statuses.active.medianChecked, false);
});

test("nothing that names a person or a property is kept", () => {
  const { facts } = analyze();
  const json = JSON.stringify(facts);
  for (const s of [...fx.FAKE.streets.map((x) => x.split(" ")[0]), fx.FAKE.agent, "Pat", "916-555", "pat.fixture", "example.com", "Fixture Way", "Fixture Realty", "1007", "LIC"]) {
    assert.ok(!json.includes(s), `facts must not contain "${s}"`);
  }
  assert.ok(json.length < 20000);
});

test("scope sentence and the note for the research provider", () => {
  const { facts } = analyze();
  const s = lib.scopeSentence(facts);
  assert.match(s, /^This MetroList report covers Roseville \(an area drawn on a map\), as of October 24, 2026\./);
  assert.match(s, /20 listings: 6 active, 1 pending, 12 closed, and 1 expired|20 listings: 6 active, 1 pending, 12 closed, 1 expired/);
  assert.match(s, /Closed sales run from/);
  const note = lib.scopeNote(facts);
  assert.ok(!/\$/.test(note), "no prices go to the provider");
  assert.ok(!/\d{3},\d{3}/.test(note));
  assert.match(note, /Roseville/);
  assert.match(note, /12 closed/);
  assert.ok(note.length <= 400);
});

test("the confirmation screen groups figures by status with sample sizes", () => {
  const sum = lib.summarize(analyze().facts, { geography: { type: "city", name: "Roseville" } });
  assert.strictEqual(sum.geography, "match");
  const closed = sum.groups.find((g) => g.status === "closed");
  assert.match(closed.window, /^Dates closed: /);
  assert.ok(closed.figures.some((f) => f.display === "$655,000" && f.n === 12));
  assert.ok(sum.groups.find((g) => g.status === "pending").figures.every((f) => f.small));
});

test("the agent's chosen place is checked against what the report names", () => {
  const { facts } = analyze();
  assert.strictEqual(lib.geographyCheck(facts, { type: "city", name: "Roseville" }).status, "match");
  const other = lib.geographyCheck(facts, { type: "city", name: "Folsom" });
  assert.strictEqual(other.status, "different");
  assert.match(other.message, /names Roseville, not Folsom/);
  const hood = lib.geographyCheck(facts, { type: "neighborhood", name: "Crocker Ranch", city: "Roseville" });
  assert.strictEqual(hood.status, "not_named");
  assert.match(hood.message, /does not name Crocker Ranch/);
  assert.strictEqual(lib.geographyCheck(facts, { type: "neighborhood", name: "Willow Creek", city: "Folsom" }).status, "different");
});

test("verified report figures let the content gate accept Claude's sourced numbers and still block invented ones", () => {
  const { facts } = analyze();
  const verified = lib.verifiedFromReport(facts);
  const intake = { market: "Roseville, CA", issue: "Prices", observation: "Local market." };
  const ev = (text) => gate.evaluate({ template: "local_market_insider", intake, verified, generated: { narration: text, captions: "" }, cta: { text: "Ask me about your home.", source: "claude" } });
  const ok = ev("Across 12 closed sales, the median sold price was $655,000, and 6 of them closed at or above list price.");
  assert.deepStrictEqual(ok.blocks, []);
  assert.ok(ok.sourcedFacts.length > 0);
  const bad = ev("The median sold price was $712,345.");
  assert.ok(bad.blocks.some((b) => b.rule === "invented_number" && b.match === "712345"));
});

test("a CSV-style table: PII columns are never read, summary rows are skipped, a title above the header is fine", () => {
  const rows = [
    ["MLS Export for Jane Seller"], [],
    ["Status", "Address", "Seller Name", "Phone", "Email", "City", "List Price", "Close Price", "DOM", "Close Date", "SqFt"],
    ["Closed", "12 Secret Ln", "Jane Seller", "916-555-0111", "jane@secret.test", "Roseville", "$600,000", "$610,000", "12", "09/10/2026", "2,000"],
    ["Closed", "14 Secret Ln", "Bob Buyer", "916-555-0112", "bob@secret.test", "Roseville", "$650,000", "$640,000", "20", "09/15/2026", "2,100"],
    ["Closed", "16 Secret Ln", "Cy Client", "916-555-0113", "cy@secret.test", "Roseville", "$700,000", "$700,000", "8", "09/20/2026", "2,300"],
    ["Active", "18 Secret Ln", "Di Owner", "916-555-0114", "di@secret.test", "Roseville", "$720,000", "", "3", "", "2,400"],
    ["Total", "", "", "", "", "", "$2,670,000", "", "", "", ""],
  ];
  const r = lib.analyzeRows(rows, "csv");
  assert.ok(r.facts, JSON.stringify(r));
  const f = r.facts;
  assert.strictEqual(f.sample.total, 4);
  assert.strictEqual(f.statuses.closed.count, 3);
  assert.strictEqual(fig(f, "closed", "median_close_price"), 640000);
  assert.strictEqual(fig(f, "closed", "median_dom"), 12);
  assert.deepStrictEqual(f.statuses.closed.dateRange, { start: "2026-09-10", end: "2026-09-20", meaning: "closed" });
  const json = JSON.stringify(f);
  for (const s of ["Secret", "Jane", "Bob", "Cy", "916-555", "@secret", "Seller"]) assert.ok(!json.includes(s), `facts must not contain "${s}"`);
});

test("a table with only a Price column uses it as the sold price for closed rows and the list price for the rest", () => {
  const r = lib.analyzeRows([["Status", "Price", "DOM"], ["Sold", "600000", "10"], ["Sold", "620000", "15"], ["Sold", "640000", "20"], ["Active", "700000", "4"]], "csv");
  assert.strictEqual(fig(r.facts, "closed", "median_close_price"), 620000);
  assert.strictEqual(r.facts.statuses.active.count, 1);
});

test("labeled market statistics are read when there are no listing rows", () => {
  const text = ["Roseville Market Statistics", "Median Sales Price  $742,000", "Average Days on Market: 31", "Months of Inventory 2.4", "Sold-to-List Price Ratio 99.1%", "Active Listings 118", "Closed Sales 96", "Report generated by Fixture Realty, jane@example.com and a long unrelated paragraph about the market that goes on for a while so the page has enough text to count as readable text rather than a scan."].join("\n");
  const r = lib.analyzePages([text]);
  assert.ok(r.facts, JSON.stringify(r));
  const f = r.facts;
  assert.strictEqual(f.layout, "labeled_metrics");
  assert.strictEqual(fig(f, "market", "median_close_price"), 742000);
  assert.strictEqual(fig(f, "market", "avg_dom"), 31);
  assert.strictEqual(fig(f, "market", "months_supply"), 2.4);
  assert.strictEqual(fig(f, "market", "avg_close_to_list_pct"), 99.1);
  assert.strictEqual(fig(f, "active", "count_active"), 118);
  assert.strictEqual(fig(f, "closed", "count_closed"), 96);
  assert.ok(!JSON.stringify(f).includes("jane@example.com"));
  // out-of-range values are dropped rather than guessed
  assert.strictEqual(lib.extractLabeledMetrics(["Median Sales Price $12"]).length, 0);
});

test("files with nothing readable fail with a plain message", () => {
  assert.strictEqual(lib.analyzePages(["short"]).error, "no_text");
  assert.strictEqual(lib.analyzePages(["x ".repeat(400)]).error, "no_figures");
  assert.strictEqual(lib.analyzeRows([["Notes"], ["hello"]], "csv").error, "no_header");
  assert.match(lib.errorMessage("no_text"), /scan/);
  assert.match(lib.errorMessage("xls"), /xlsx/);
});
