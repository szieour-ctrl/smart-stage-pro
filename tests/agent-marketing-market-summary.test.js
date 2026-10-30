// MetroList "Market Summary" PDFs (Oct 27, 2026): sentences, not tables. Fixture sentences are copied word for word from the Antelope report.
const test = require("node:test");
const assert = require("node:assert");
const rl = require("../netlify/functions/lib/agent-marketing-report-lib");

const FOOT = "All reports are published October 2026, based on data available at the end of September 2026, except for the today’s stats. All reports presented are based on data supplied by the MetroList MLS. The MetroList MLS does not guarantee or is not in anyway responsible for its accuracy.";
const HEAD = "                         MARKET SUMMARY\n                         Antelope\n                      Published October 2026*\n\n    PROPERTY TYPE      PRICE RANGE\n    Single Family Homes      Any\n";
const PAGES = [
  `${HEAD}\nSeptember 2026 was a Seller's market! The number of for sale listings was down 5.9% from one year earlier and down\n5.9% from the previous month. The number of sold listings decreased 24.1% year over year and the same month over month.\nThe number of under contract listings was the same compared to previous month and down 24.2% compared to previous\nyear. The Months of Inventory based on Closed Sales was 2.2, up 22.7% from the previous year.\nThe Average Days on Market showed a neutral trend, a decrease of 31.2% compared to previous year. The ratio of Sold\nPrice vs. Original List Price was 99%, an increase of 3.1% compared to previous year.\n${FOOT}`,
  `${HEAD}\nIt was a Seller's Market\nSeptember property sales were 22, down 24.1% from 29 in September of 2025 and the same as sales last month.\nThere was the same number of pended properties in September, 25 properties. This month's pended property sales were\n24.2% lower than at this time last year.\n${FOOT}`,
  `${HEAD}\nThe Average Sold Price per Square Footage was Neutral*\nThe September 2026 Average Sold Price\nper Square Footage of $308 was down 4.3% from $322 last month and up 4.8% from $294 in September of last year.\n${FOOT}`,
  `${HEAD}\nThe Days on Market Showed Neutral Trend*\nThe DOM for September 2026 was 22, down 18.5% from 27 days last month and down 31.2% from 32\ndays in September of last year.\nThe Sold/Original List Price Ratio Remains Steady**\nThis month Sold Price vs. Original List Price of 99% was up 1% % from last month and up from 3.1% % in September of last year.\n${FOOT}`,
  `${HEAD}\nThe Average For Sale Price was Depreciating*\nThe Average For Sale Price in September was $524,000, down 0.6% from $527,000 in September of 2025 and down 1.3%\nfrom $531,000 last month.\nThe Average Sold Price was Neutral*\nThe Average Sold Price in September was $512,000, down 0.6% from $515,000 in September of 2025 and up 3.9% from\n$493,000 last month.\nThe Median Sold Price was Depreciating*\nThe Median Sold Price in September was $482,000, down 4.2% from $503,000 in September of 2025 and down 2.2% from\n$493,000 last month.\n${FOOT}`,
  `${HEAD}\nMonths of Inventory based on Closed Sales\nThe September 2026 Months of Inventory based on Closed Sales of 2.2 was increased by 22.7% compared to last year and\ndown 4.3% compared to last month. September 2026 was Seller's market.\nMonths of Inventory based on Pended Sales\nThe September 2026 Months of Inventory based on Pended Sales of 1.9 was increased by 25.9% compared to last year and\ndown 4.9% compared to last month.\n${FOOT}`,
  `${HEAD}\nAbsorption Rate based on Closed Sales\nThe September 2026 Absorption Rate based on Closed Sales of 45.8 was decreased by 19.5% compared to last year and up\n6.3% compared to last month.\nAbsorption Rate based on Pended Sales\nThe September 2026 Absorption Rate based on Pended Sales of 52.1 was decreased by 19.5% compared to last year and\nup 6.3% compared to last month.\n${FOOT}`,
];

const read = () => { const r = rl.analyzePages(PAGES); assert.ok(r.facts, JSON.stringify(r)); return r.facts; };
const fig = (f, key) => f.figures.find((x) => x.key === key);

test("a Market Summary reads the real figures, never a percent change as a count", () => {
  const f = read();
  assert.strictEqual(f.layout, "market_summary");
  assert.strictEqual(fig(f, "count_closed").value, 22, "22 sold, not the 24.1% change");
  assert.strictEqual(fig(f, "avg_dom").value, 22, "22 days, not the 31.2% change");
  assert.deepStrictEqual([fig(f, "median_close_price").value, fig(f, "avg_close_price").value, fig(f, "avg_list_price").value, fig(f, "avg_ppsf").value], [482000, 512000, 524000, 308]);
  assert.deepStrictEqual([fig(f, "months_supply").value, fig(f, "months_supply_pended").value, fig(f, "absorption_rate").value, fig(f, "absorption_rate_pended").value, fig(f, "avg_close_to_list_pct").value], [2.2, 1.9, 45.8, 52.1, 99]);
  assert.deepStrictEqual(f.geography.cities, ["Antelope"]);
  assert.deepStrictEqual(f.propertyTypes, ["Single Family Homes"]);
  assert.strictEqual(f.marketCondition, "Seller's market");
});

test("percent changes are quoted exactly as the report prints them, with its six-month trend words", () => {
  const f = read();
  const t = (k) => rl.compareText(f, fig(f, k));
  assert.match(t("avg_dom"), /32 days in September 2025 \(down 31\.2%\)/, "printed 31.2, not a recalculated 31.3");
  assert.match(t("avg_dom"), /27 days in August 2026 \(down 18\.5%\).*6-month trend: Neutral/);
  assert.match(t("median_close_price"), /6-month trend: Depreciating/);
  assert.match(t("avg_close_to_list_pct"), /6-month trend: Remains Steady/);
  assert.match(t("count_closed"), /29 in September 2025 \(down 24\.1%\)/);
  assert.match(t("count_pending"), /down 24\.2% from September 2025/);
  assert.match(t("months_supply"), /up 22\.7% from September 2025; down 4\.3% from August 2026/);
  assert.match(t("absorption_rate"), /down 19\.5% from September 2025; up 6\.3% from August 2026/);
  assert.strictEqual(rl.formatFigure(fig(f, "active_change_yoy")), "down 5.9%");
  assert.strictEqual(fig(f, "active_change_mom").value, -5.9);
});

test("the notice quotes the printed publication line word for word and invents no dates", () => {
  const f = read();
  assert.strictEqual(f.disclosure, "All reports are published October 2026, based on data available at the end of September 2026");
  assert.strictEqual(rl.attributionNotice(f), "Based on information from MetroList Services, Inc. All reports are published October 2026, based on data available at the end of September 2026.");
  assert.strictEqual(f.period.start, undefined);
  assert.strictEqual(f.period.end, undefined);
  assert.deepStrictEqual(f.warnings, [], "nothing to warn about on a clean report");
  const verified = rl.verifiedFromReport(f).texts.join(" | ");
  assert.match(verified, /Median sold price: \$482,000/);
  assert.match(verified, /Market condition, as the report calls it: Seller's market/);
});

test("a MetroList report with no readable dates or publication line warns at upload, not at the last step", () => {
  const w = rl.summarize({ mlsSource: "MetroList", figures: [], statuses: {}, geography: {}, sample: {} }).warnings.join(" ");
  assert.match(w, /couldn't find the dates/);
  const ok = rl.summarize(read()).warnings.join(" ");
  assert.doesNotMatch(ok, /couldn't find the dates/);
});

// Oct 30, 2026 (Lincoln): the median line says "the same as in September of 2025" and the pended line gives counts. Both were dropped without a word.
const lincolnPages = () => PAGES.map((p) => p
  .replace(/The Median Sold Price in September was[\s\S]*?last month\./, "The Median Sold Price in September was $625,000, the same as in September of 2025 and down 2.8% from $643,000 last\nmonth.")
  .replace(/under contract listings was the same compared to previous month and down 24\.2% compared to previous\s+year/, "under contract listings was down 10.9% compared to previous month and down 11.8% compared to previous year")
  .replace(/There was the same number of pended properties in September, 25 properties\./, "There was a decrease of 10.9% in the pended properties in September, with 82 properties versus 92 last month. This month's pended property sales were 11.8% lower than at this time last year."));

test("a median that is 'the same as' a year ago, and a pended count with its change, are read (not dropped)", () => {
  const pages = lincolnPages();
  assert.notDeepStrictEqual(pages, PAGES, "the fixture sentences were replaced");
  const f = rl.analyzePages(pages).facts;
  const med = fig(f, "median_close_price"), pend = fig(f, "count_pending");
  assert.ok(med && pend, "both figures are kept");
  assert.deepStrictEqual([med.value, med.prior, med.yearAgo], [625000, 643000, 625000]);
  assert.deepStrictEqual(med.printed, { yearAgo: 0, prior: -2.8 });
  assert.deepStrictEqual([pend.value, pend.prior], [82, 92]);
  assert.strictEqual(pend.printed.prior, -10.9);
  assert.strictEqual(pend.changes[0].pct, -11.8);
  assert.match(rl.compareText(f, med), /\$643,000 in August 2026 \(down 2\.8%\)/);
  assert.deepStrictEqual(f.warnings.filter((w) => /could not read/.test(w)), [], "nothing was left unread");
});

test("a measure printed in words the reader does not understand is named in a warning, never dropped in silence", () => {
  const pages = PAGES.map((p) => p.replace(/The Median Sold Price in September was[\s\S]*?last month\./, "The Median Sold Price in September was around six hundred thousand dollars, give or take."));
  const f = rl.analyzePages(pages).facts;
  assert.ok(!fig(f, "median_close_price"));
  assert.ok(f.warnings.some((w) => /could not read the median sold price/.test(w)), JSON.stringify(f.warnings));
  const s = rl.summarize(f, {});
  assert.ok(s.warnings.some((w) => /median sold price/.test(w)), "the agent sees it on the upload summary");
});
