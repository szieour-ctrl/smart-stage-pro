// A synthetic monthly market-trends report ("TrendVision" layout) in the page-text shape the PDF reader produces. Made-up area, made-up
// numbers, a made-up agent name that must never appear in the figures.
"use strict";
const MONTHS = ["7/25", "8/25", "9/25", "10/25", "11/25", "12/25", "1/26", "2/26", "3/26", "4/26", "5/26", "6/26", "7/26", "8/26", "9/26"];
const ROWS = [
  ["SUPPLY"], ["For Sale", [310, 300, 280, 270, 250, 240, 230, 240, 250, 260, 280, 300, 310, 305, 308]], ["New Listing", [140, 150, 130, 120, 100, 95, 110, 130, 150, 160, 170, 160, 150, 140, 135]],
  ["DEMAND"], ["Sold", [60, 62, 70, 64, 55, 58, 40, 50, 66, 70, 72, 75, 68, 61, 52]], ["Pended", [66, 70, 68, 60, 52, 50, 55, 60, 72, 74, 70, 66, 64, 60, 58]],
  ["MARKET BALANCE"], ["Months of Inventory\n(Closed Sales)", [5.2, 4.8, 4, 4.2, 4.5, 4.1, 5.8, 4.8, 3.8, 3.7, 3.9, 4, 4.6, 5, 5.9]], ["Months of Inventory\n(Pended Sales)", [4.7, 4.3, 4.1, 4.5, 4.8, 4.8, 4.2, 4, 3.5, 3.5, 4, 4.5, 4.8, 5.1, 5.3]],
  ["Absorption Rate (Closed\nSales) %", [19.4, 20.7, 25, 23.7, 22, 24.2, 17.4, 20.8, 26.4, 26.9, 25.7, 25, 21.9, 20, 16.9]], ["Absorption Rate (Pended\nSales) %", [21.3, 23.3, 24.3, 22.2, 20.8, 20.8, 23.9, 25, 28.8, 28.5, 25, 22, 20.6, 19.7, 18.8]],
  ["PRICING"], ["Avg. Active Price", [820, 815, 810, 805, 800, 801, 808, 812, 820, 825, 830, 828, 826, 822, 819]], ["Avg. Sold Price", [790, 782, 770, 775, 768, 760, 762, 770, 781, 790, 795, 798, 792, 785, 781]],
  ["Avg. Sq. Ft. Price (Sold)", [350, 349, 348, 347, 346, 345, 346, 348, 350, 352, 353, 354, 352, 351, 350]], ["Median Active Price", [760, 755, 750, 745, 742, 740, 745, 750, 758, 762, 765, 764, 760, 758, 755]], ["Median Sold Price", [720, 715, 710, 712, 705, 700, 702, 708, 716, 722, 725, 728, 724, 718, 715]],
  ["PERFORMANCE"], ["Sold/List Diff. %", [98, 98, 98, 98, 97, 97, 97, 98, 98, 98, 98, 98, 98, 98, 98]], ["Sold/Orig LP Diff. %", [96, 96, 96, 95, 95, 95, 95, 96, 96, 96, 96, 96, 96, 96, 95]],
  ["Avg Days on Market", [40, 41, 43, 45, 48, 52, 55, 50, 44, 41, 39, 38, 40, 42, 45]], ["Avg CDOM", [48, 49, 51, 53, 57, 61, 64, 58, 50, 47, 45, 44, 46, 49, 52]],
];
const head = (extra) => `TrendVisionTM ZIP 95999\nSINGLE FAMILY HOMES · OCTOBER 2026\nPAT FIXTURE\n${extra}`;
function dataPages() {
  const part = (title, from, to, trend) => {
    const lines = [head(`Data Table (Part ${title} of 2)`), `Metric ${MONTHS.slice(from, to).join(" ")}${trend ? " Trend" : ""}`];
    ROWS.forEach(([label, vals]) => {
      if (!vals) return lines.push(label);
      const wrapped = label.split("\n");
      if (wrapped.length > 1) { lines.push(wrapped[0]); lines.push(`${wrapped[1]} ${vals.slice(from, to).join(" ")}`); } else lines.push(`${label} ${vals.slice(from, to).join(" ")}`);
    });
    lines.push("© 2026 TRENDGRAPHIX, INC. · TRENDVISION™ PAGE 9 / 10");
    return lines.join("\n");
  };
  return [part(1, 0, 8, false), part(2, 8, 15, true)];
}
const val = (label, i) => ROWS.find((r) => r[0] === label)[1][i];
function summaryPage(title, rows) {
  return [head(title), "VS PREV MONTH", "Sep. 26 Aug. 26 % Change", "VS SAME MONTH 1 YR AGO", "Sep. 26 Sep. 25 % Change", ...rows, "© 2026 TRENDGRAPHIX, INC. · TRENDVISION™ PAGE 3 / 10"].join("\n");
}
/** standard({ summaryMismatch, closed }) → { pages, latest } */
function standard(over) {
  const o = over || {};
  const sold = o.closed != null ? o.closed : 52;
  const first = ["TrendVision TM", "OCTOBER 2026", "Pat Fixture", "LOCATION", "ZIP 95999", "PROPERTY TYPE", "Single Family Homes", "Special Listing Conditions: All", "Properties", "PRICE / SQFT", "Price: $0 - No Limit", "MARKET INSIGHT", "The selected market area is a seller-friendly market. Contact pat@example.com or 916-555-0100 for details.", "© 2026 TRENDGRAPHIX, INC. · TRENDVISION™ PAGE 1 / 10"].join("\n");
  const p3 = summaryPage("For Sale vs. Sold", [`For Sale 308 305 1% 308 280 10%`, `Pended 58 60 -3.3% 58 68 -14.7%`, `Sold ${o.summaryMismatch ? 53 : 52} 61 -14.8% 52 70 -25.7%`]);
  const p5 = summaryPage("Pricing", ["Avg Sold Price 781 785 -0.5% 781 770 1.4%", "Avg Active Price 819 822 -0.4% 819 810 1.1%"]);
  const today = [head("Today's Stats"), "Current vs. Prev MTD", "10/1/26 - 10/23/26 9/1/26 - 9/23/26 % Change", "Sold 999 1,111 15%", "Months of Inventory (Closed) 9.9 3.3 15.2%", "© 2026 TRENDGRAPHIX, INC. · TRENDVISION™ PAGE 8 / 10"].join("\n");
  const [d1, d2] = dataPages();
  const fixPart2 = o.closed != null ? d2.replace(/\nSold ([\d ]+) 52\n/, (m, a) => `\nSold ${a} ${sold}\n`) : d2;
  return { pages: [first, p3, p5, today, d1, fixPart2], latest: { sold } };
}
module.exports = { standard, MONTHS, ROWS, val };
