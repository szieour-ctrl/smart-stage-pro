// Synthetic one-page "Market Update" text and a Domus monthly infographic, for Trend Intelligence and the Option 1 / Option 2 tests.
// Values default to the sample ZIP 95747 report; any measure can be overridden as [lastYear, thisYear].
const D = { active: [257, 338], newl: [133, 140], closed: [132, 80], pended: [113, 95], months: [1.9, 4.2], mp: [2.3, 3.6], aavg: [707, 716], savg: [658, 705], amed: [659, 661], price: [612, 618], ppsf: [316, 322], sl: [99, 99], so: [98, 98], dom: [46, 49] };
const pct = (a, b) => { const p = Math.round(((b - a) / Math.abs(a)) * 1000) / 10; return `${p}%`; };
const row = (label, [a, b], [c, d]) => `${label} ${a} ${b} ${pct(a, b)} ${c} ${d} ${pct(c, d)}`;
function marketUpdate(o, opts) {
  const v = { ...D, ...(o || {}) };
  const y = opts && opts.ytd ? opts.ytd : {};
  const Y = (k, mult) => y[k] || [Math.round(v[k][0] * mult), Math.round(v[k][1] * mult)];
  const zip = (opts && opts.zip) || "95747", type = (opts && opts.type) || "Single Family Homes";
  return [
    "Market Update", "Published: November 2026*", `ZIP ${zip}`, type, "October Year To Date",
    "Data Metrics 2025 2026 % Change 2025 2026 % Change",
    row("For Sale", v.active, v.active), row("New Listing", v.newl, Y("newl", 12)), row("Sold", v.closed, y.closed || [1118, 1125]), row("Pended", v.pended, Y("pended", 10)),
    row("Months of Inventory (Closed Sales)", v.months, v.months), row("Months of Inventory (Pended Sales)", v.mp, v.mp),
    row("Avg. Active Price", v.aavg, v.aavg), row("Avg. Sold Price", v.savg, v.savg), row("Median Active Price", v.amed, v.amed),
    row("Median Sold Price", v.price, y.price || [641, 655]), row("Avg. Sq. Ft. Price (Sold)", v.ppsf, v.ppsf), row("Sold/List Diff. %", v.sl, v.sl), row("Sold/Orig LP Diff. %", v.so, v.so),
    row("Avg Days on Market", v.dom, v.dom), "Months of Inventory and Median Sold Price Trends",
    "All reports are published November 2026, based on data available at the end of October 2026, except for the today’s stats. Data from MetroList MLS.",
  ].join("\n");
}
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
module.exports = { marketUpdate, DOMUS_TEXT, DOMUS_ITEMS };
