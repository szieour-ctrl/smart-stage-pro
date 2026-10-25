// A synthetic weekly dashboard ("Weekly Review" layout) as positioned text: labels on the right, big numbers below them, percent changes on
// the left and middle of each row. Made-up numbers.
"use strict";
const ROWS = [
  ["Median Sales Price", "$512,345", "-3.1%", "-4.2%"],
  ["Closed Sales", "31", "-10.0%", "-20.5%"],
  ["Median Days on Market", "27", "12.5%", "-8.0%"],
  ["List Price Received", "99.2%", "0.4%", "-0.3%"],
  ["Median Sold $/SqFt", "$301", "1.5%", "2.2%"],
  ["New Listings", "58", "-5.0%", "7.5%"],
  ["Active Inventory", "402", "0.9%", "1.1%"],
  ["Weeks Supply of Inventory", "13.0", "2.0%", "5.5%"],
];
/** review({ title }) → { text: [...], items: [{ s, x, y }] } with y from the top. Left column = vs 18 Jul, middle = vs 10 Oct. */
function review(over) {
  const o = over || {};
  const items = [
    { s: o.title || "Weekly Review 17 Oct 2026", x: 224, y: 36 }, { s: "Includes all Property Types in all Counties", x: 306, y: 68 },
    { s: "vs Wk ending 10 Oct 2026", x: 360, y: 90 }, { s: "vs Wk ending 18 Jul 2026", x: 83, y: 90 },
    { s: "Data provided by MetroList and updated 10/23/26.", x: 150, y: 781 }, { s: "Domus Analytics", x: 506, y: 781 },
  ];
  ROWS.forEach(([label, value, left, mid], i) => {
    const y = 125 + i * 83;
    items.push({ s: label, x: 517, y }, { s: value, x: 517, y: y + 46 }, { s: left, x: 95, y: y + 11 }, { s: mid, x: 392, y: y + 11 }, { s: "↑", x: 392, y: y + 41 });
  });
  return { items, pages: [items.map((i) => i.s).join("\n")] };
}
/** infographic(): same tiles, no percent columns, the date in the "2026 October 17" form. */
function infographic() {
  const items = [
    { s: "Weekly Infographic", x: 336, y: 30 }, { s: "2026 October 17", x: 305, y: 70 }, { s: "Includes all Property Types in all Counties", x: 306, y: 104 },
    { s: "Data provided by MetroList and updated 10/23/26.", x: 150, y: 580 }, { s: "Domus Analytics", x: 506, y: 580 },
    { s: "Median Sales Price", x: 188, y: 153 }, { s: "$512,345", x: 180, y: 230 }, { s: "Down 3.1%", x: 390, y: 255 },
    { s: "Closed Sales", x: 603, y: 159 }, { s: "31", x: 638, y: 225 }, { s: "Active Inventory", x: 125, y: 333 }, { s: "402", x: 125, y: 470 },
    { s: "Median Days on Market", x: 380, y: 318 }, { s: "27", x: 425, y: 375 }, { s: "Median Sold $/SqFt", x: 380, y: 450 }, { s: "$301", x: 340, y: 515 },
    { s: "New Listings", x: 638, y: 347 }, { s: "58", x: 640, y: 430 },
  ];
  return { items, pages: [items.map((i) => i.s).join("\n")] };
}
module.exports = { review, infographic, ROWS };
