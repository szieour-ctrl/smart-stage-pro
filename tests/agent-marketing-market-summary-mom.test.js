// The month-over-month edition of the MetroList / Trend Vision "Market Summary" PDF (October 2026): the Roseville city report (379 active, 120 closed)
// and the ZIP 95747 report (338 active, 80 closed). The reader used to keep one figure of each; every sentence now yields its own figure.
const test = require("node:test");
const assert = require("node:assert");
const lib = require("../netlify/functions/lib/agent-marketing-report-lib");
const rr = require("../netlify/functions/lib/agent-marketing-research-report-lib");
const ti = require("../netlify/functions/lib/agent-marketing-trend-intelligence-lib");

const pages = (area, v) => [
  `MARKET SUMMARY\n${area}\nPublished November 2026*\nPROPERTY TYPE\nSingle Family Homes\nPRICE RANGE\nAny\nSQ FT RANGE\nAny\nBEDROOMS\nAny\nFULL BATHS\nAny\nHALF BATHS\nAny\nYEAR BUILT\nAny\nMARKET ADVANTAGE\nNeutral market\n${v.moi} mo\nMONTHS OF\nINVENTORY\nOctober 2026 was a Neutral market! The number of for sale listings was up ${v.activePct}% from the previous month. The number of sold listings decreased ${v.soldPct}% month over month. The Months of Inventory based on Closed Sales was ${v.moi}.\nAll reports are published November 2026, based on data available at the end of October 2026, except for the today’s stats. All reports presented are based on data supplied by the MetroList MLS.`,
  `MARKET SUMMARY\n${area}\nPublished November 2026*\nProperty Sales (Sold)\nOctober property sales were ${v.sold}, ${v.soldPct}% lower than the ${v.soldPrev} sales last month.\nCurrent Inventory (For Sale)\nThe total number of homes available this month was ${v.active}. The number of current inventory was up ${v.activePct}% compared to the previous month.\nProperty Under Contract (Pended)\nThere was a decrease of ${v.pendPct}% in the pended properties in October, with ${v.pend} properties versus ${v.pendPrev} last month.`,
  `MARKET SUMMARY\n${area}\nPublished November 2026*\nThe October 2026 Average Sold Price per Square Footage of $${v.ppsf} was up 4.1% from $${v.ppsfPrev} last month.`,
  `MARKET SUMMARY\n${area}\nPublished November 2026*\nThe DOM for October 2026 was ${v.dom}, up ${v.domPct}% from ${v.domPrev} days last month.\nThe Sold/Original List Price Ratio Remains Steady**\nThis month Sold Price vs. Original List Price of 98% was up 1% % from last month.`,
  `MARKET SUMMARY\n${area}\nPublished November 2026*\nThe Average For Sale Price in October was $${v.alp}, down 0.1% from $${v.alpPrev} last month.\nThe Average Sold Price in October was $${v.asp}, up 0.9% from $${v.aspPrev} last month.\nThe Median Sold Price was Depreciating*\nThe Median Sold Price in October was $${v.msp}, down ${v.mspPct}% from $${v.mspPrev} last month.`,
  `MARKET SUMMARY\n${area}\nPublished November 2026*\nThe October 2026 Months of Inventory based on Closed Sales of ${v.moi} was up ${v.moiPct}% compared to last month. October 2026 was Neutral market.\nThe October 2026 Months of Inventory based on Pended Sales of 3 was up 11.2% compared to last month.`,
  `MARKET SUMMARY\n${area}\nPublished November 2026*\nThe October 2026 Absorption Rate based on Closed Sales of ${v.abs} was down 23.4% compared to last month.\nThe October 2026 Absorption Rate based on Pended Sales of 33.2 was down 11% compared to last month.`,
];
const CITY = { moi: 3.2, activePct: 3.3, soldPct: 21.1, sold: 120, soldPrev: 152, active: 379, pendPct: 8, pend: 126, pendPrev: 137, ppsf: 329, ppsfPrev: 316, dom: 45, domPct: 15.4, domPrev: 39, alp: "719,000", alpPrev: "720,000", asp: "685,000", aspPrev: "679,000", msp: "619,000", mspPrev: "634,000", mspPct: 2.4, moiPct: 33.1, abs: 31.7 };
const ZIP = { moi: 4.2, activePct: 8, soldPct: 27.3, sold: 80, soldPrev: 110, active: 338, pendPct: 3.1, pend: 95, pendPrev: 98, ppsf: 322, ppsfPrev: 309, dom: 49, domPct: 16.7, domPrev: 42, alp: "716,000", alpPrev: "725,000", asp: "705,000", aspPrev: "694,000", msp: "618,000", mspPrev: "646,000", mspPct: 4.3, moiPct: 49.2, abs: 23.7 };
const fig = (f, k) => f.figures.find((x) => x.key === k);

test("the Roseville city Market Summary yields every figure it prints, each compared with September 2026", () => {
  const r = lib.analyzePages(pages("Roseville", CITY), {});
  const f = r.facts;
  assert.strictEqual(f.layout, "market_summary");
  assert.deepStrictEqual(f.geography.cities, ["Roseville"]);
  assert.deepStrictEqual(f.propertyTypes, ["Single Family Homes"]);
  assert.strictEqual(f.figures.length, 13);
  assert.strictEqual(fig(f, "count_active").value, 379);
  assert.strictEqual(fig(f, "count_closed").value, 120);
  assert.strictEqual(fig(f, "count_closed").prior, 152);
  assert.strictEqual(fig(f, "median_close_price").value, 619000);
  assert.strictEqual(fig(f, "avg_dom").value, 45);
  assert.strictEqual(fig(f, "months_supply").value, 3.2);
  assert.ok(f.figures.every((x) => (x.changes || []).every((c) => c.vs === "September 2026")));
  assert.deepStrictEqual(f.warnings, []);
});

test("the ZIP 95747 Market Summary reads its area as a ZIP, not as a city", () => {
  const f = lib.analyzePages(pages("ZIP 95747", ZIP), {}).facts;
  assert.deepStrictEqual(f.geography.zips, ["95747"]);
  assert.deepStrictEqual(f.geography.cities, []);
  assert.strictEqual(fig(f, "count_active").value, 338);
  assert.strictEqual(fig(f, "count_closed").value, 80);
  assert.deepStrictEqual(f.warnings, []);
});

test("Trend Intelligence reads these reports as month-over-month, and never pairs an average price with a median price", () => {
  const f = lib.analyzePages(pages("Roseville", CITY), {}).facts;
  const a = ti.analyze(rr.buildContext([{ id: "u1", facts: f }], { geography: { type: "city", name: "Roseville", label: "Roseville" } }));
  assert.ok(a.usable);
  assert.ok(a.observations.length >= 5);
  assert.ok(a.observations.every((o) => o.basis.label === "September 2026"));
  const sd = a.observations.find((o) => o.kind === "supply_demand");
  assert.ok(sd.evidence.some((e) => /379/.test(e.text)) && sd.evidence.some((e) => /120/.test(e.text)));
  const av = a.observations.find((o) => o.kind === "asking_vs_sold");
  assert.ok(av && av.evidence.map((e) => e.text).join(" ").includes("Average sold price") && !/Median sold price/.test(av.evidence.map((e) => e.text).join(" ")), "an average asking price is read against the average sold price");
  assert.ok(!/held steady|Prices steady/.test(JSON.stringify(a)), "a median price down 2.4% is not steady");
});
