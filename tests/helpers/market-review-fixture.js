// Synthetic Domus "Market Review" dashboards as positioned text, one per report type. MADE-UP NUMBERS: the real exports are licensed and never
// live in this public repository. The layout follows the weekly fixture (labels on the right, the big number below each label, the longer-range
// comparison on the left, the immediate prior-period comparison in the middle). The titles of the non-weekly reports are ASSUMED forms; the
// reader takes the report type from the printed comparison labels, so a different title wording does not change what it reads.
"use strict";

const ROW_KEYS = ["Median Sales Price", "Closed Sales", "Median Days on Market", "List Price Received", "Median Sold $/SqFt", "New Listings"];
const EXTRA_MONTH = ["Active Inventory", "Months Supply of Inventory"];
const EXTRA_WEEK = ["Active Inventory", "Weeks Supply of Inventory"];

// [label, value, left comparison, middle comparison]
const WEEK = [["Median Sales Price", "$512,000", "-3.7%", "-1.7%"], ["Closed Sales", "30", "-5.7%", "17.9%"], ["Median Days on Market", "25", "88.0%", "-51.0%"], ["List Price Received", "101.6%", "1.5%", "3.8%"], ["Median Sold $/SqFt", "$310", "-1.4%", "3.7%"], ["New Listings", "41", "-26.4%", "-7.1%"], ["Active Inventory", "420", "-0.9%", "-2.0%"], ["Weeks Supply of Inventory", "12.5", "5.1%", "-16.9%"]];
const MONTH = [["Median Sales Price", "$498,500", "0.3%", "-2.9%"], ["Closed Sales", "150", "-28.4%", "-16.8%"], ["Median Days on Market", "29", "12.7%", "14.8%"], ["List Price Received", "99.2%", "-0.1%", "0.2%"], ["Median Sold $/SqFt", "$301", "3.7%", "2.1%"], ["New Listings", "220", "6.6%", "1.0%"], ["Active Inventory", "410", "19.7%", "2.8%"], ["Months Supply of Inventory", "3.1", "67.1%", "23.5%"]];
const QUARTER = [["Median Sales Price", "$515,000", "3.3%", "-3.1%"], ["Closed Sales", "560", "5.4%", "-7.3%"], ["Median Days on Market", "21", "53.8%", "33.3%"], ["List Price Received", "99.2%", "-0.7%", "-0.7%"], ["Median Sold $/SqFt", "$305", "2.2%", "-1.2%"], ["New Listings", "700", "13.5%", "-22.1%"]];
// year to date: the earlier value is printed beside its change, and it must agree with it
const YTD = [["Median Sales Price", "$510,000", "$510,000", "0.0%"], ["Closed Sales", "1,800", "1,790", "0.6%"], ["Median Days on Market", "20", "19", "5.3%"], ["List Price Received", "99.4%", "99.5%", "-0.1%"], ["Median Sold $/SqFt", "$308", "$309", "-0.3%"], ["New Listings", "2,500", "2,600", "-3.8%"]];
// the yearly report of a year still in progress: SAME values as the year-to-date report, compared with the FULL year ending the year before
const YEAR = [["Median Sales Price", "$510,000", "55.0%", "0.0%"], ["Closed Sales", "1,800", "-35.1%", "-15.4%"], ["Median Days on Market", "20", "53.8%", "0.0%"], ["List Price Received", "99.4%", "0.1%", "0.0%"], ["Median Sold $/SqFt", "$308", "57.1%", "0.3%"], ["New Listings", "2,500", "-24.5%", "-14.1%"]];

// Footer as the real exports print it: the sentence, the date, the licence line, and a bare copyright year (a number-like token that is NOT a figure).
const FOOT_ITEMS = (updated) => [{ s: "Data provided by MetroList and updated", x: 114, y: 781 }, { s: updated || "11/09/26", x: 189, y: 781 }, { s: ".", x: 203, y: 781 },
  { s: "End User License Agreement", x: 410, y: 781 }, { s: "2026", x: 469, y: 781 }, { s: "Domus Analytics", x: 506, y: 781 }];
const TYPES = { default: "Includes all Property Types in all Counties" };
const NOTE = { "Active Inventory": "Inventory only applies for monthly and weekly calculations.", "Months Supply of Inventory": "MSI only applies for monthly and weekly calculations." };

/**
 * build({ title: string | [string,...], heads: [leftHead, midHead], rows, updated, omit: [labels], scopeLine, notes: true, yearTags: [cur, earlier] })
 * Title pieces are separate items, as in the real exports ("Market Review" / "Q3" / "Sep 2026"). `rows` = [label, value, left, mid]; with yearTags the
 * year-to-date shape is used: the current value beside the first tag, the earlier value beside the second, the change in the middle column.
 */
function build(o) {
  const titles = Array.isArray(o.title) ? o.title : [o.title];
  const items = [{ s: "", x: 544, y: 35 }, { s: o.scopeLine || TYPES.default, x: 306, y: 68 }, ...FOOT_ITEMS(o.updated)];
  titles.forEach((t, i) => items.push({ s: t, x: i === 0 ? 224 : 390 + (i - 1) * 50, y: 36 }));
  if (o.heads[0]) items.push({ s: o.heads[0], x: 83, y: 90 });
  if (o.heads[1]) items.push({ s: o.heads[1], x: 380, y: 90 });
  o.rows.forEach(([label, value, left, mid], i) => {
    if ((o.omit || []).includes(label)) return;
    const y = 125 + i * 83;
    items.push({ s: label, x: 517, y }, { s: value, x: 517, y: y + 46 }, { s: "$", x: 33, y: y + 32 });
    if (o.yearTags) {
      items.push({ s: o.yearTags[0], x: 95, y: y + 6 }, { s: value, x: 322, y: y + 6 }, { s: o.yearTags[1], x: 95, y: y + 39 }, { s: left, x: 322, y: y + 40 }, { s: mid, x: 392, y: y + 11 }, { s: "\u2192", x: 392, y: y + 41 });
    } else {
      items.push({ s: "\u2191", x: 392, y: y + 41 });
      if (left != null) items.push({ s: left, x: 95, y: y + 11 });
      if (mid != null) items.push({ s: mid, x: 392, y: y + 11 });
    }
  });
  if (o.notes) Object.keys(NOTE).forEach((l, i) => { if (!(o.omit || []).includes(l)) items.push({ s: l, x: 517, y: i ? 707 : 621 }, { s: NOTE[l], x: 273, y: i ? 716 : 644 }); });
  return { items, pages: [items.map((i) => i.s).join("\n")] };
}
const weekly = (o) => build({ title: ["Weekly Review", "07 Nov 2026"], heads: ["vs Wk ending 8 Aug 2026", "vs Wk ending 31 Oct 2026"], rows: WEEK, ...o });
const monthly = (o) => build({ title: ["Market Review", "Oct 2026"], heads: ["vs October 2025", "vs September 2026"], rows: MONTH, ...o });
const quarterly = (o) => build({ title: ["Market Review", "Q3", "Sep 2026"], heads: ["vs Q3 2023", "vs Q2 2026"], rows: QUARTER, notes: true, ...o });
const ytd = (o) => build({ title: ["Market Review", "Oct 2026"], heads: [null, "vs YTD 2025"], rows: YTD, yearTags: ["2026", "2025"], notes: true, ...o });
const yearly = (o) => build({ title: ["Market Review", "2026"], heads: ["vs Yr ending 2016", "vs Yr ending 2025"], rows: YEAR, notes: true, ...o });

module.exports = { weekly, monthly, quarterly, ytd, yearly, build, WEEK, MONTH, QUARTER, YTD, YEAR, ROW_KEYS, EXTRA_MONTH, EXTRA_WEEK };
