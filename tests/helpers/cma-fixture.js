// Synthetic MLS "Comparative Market Analysis" text in the same layout a MetroList / Rapattoni CMA PDF extracts to (one row per
// listing, a LISTING COUNT and MEDIAN PRICE line per status block, REPORT TOTALS at the end). Every street, name, phone and email
// here is made up; the tests use them to prove none of it is kept.
"use strict";

const FAKE = {
  agent: "Pat Fixture", phone: "916-555-0100", email: "pat.fixture@example.com", site: "http://www.example-fixture-realty.test",
  streets: ["Alder Ct", "Birch Ln", "Cedar Way", "Dogwood Dr", "Elmwood Ave", "Fir Cir", "Gum Tree Ln", "Hazel St", "Ivy Ct", "Juniper Way", "Kestrel Dr", "Laurel Ave", "Maple Cir", "Nettle Ln"],
};
const money = (n) => "$" + n.toLocaleString("en-US");
const mmddyy = (iso) => { const [y, m, d] = iso.split("-"); return `${m}/${d}/${y.slice(2)}`; };
const median = (a) => { const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** One listing → one text row, in the printed column order. `year: null` leaves the year out, as the real report does for some rows. */
function row(i, o) {
  const street = `${1000 + i * 7} ${FAKE.streets[i % FAKE.streets.length]}`;
  const city = o.city || "Roseville";
  const year = o.year === null ? "" : ` ${o.year || 2023}`;
  const tail = o.close != null ? ` ${money(o.close)} ${Math.round((o.close / o.list) * 100)}%` : "";
  return `${street} ${city} ${o.bd || "3"} ${o.bath || "3"} (${o.bath || "3"} 0) ${(o.sqft || 2000).toLocaleString("en-US")} ${o.lot || "0.1500"}${year} ${mmddyy(o.date)} $${o.ppsf || 300} ${o.dom}/${o.cdom || o.dom} ${money(o.orig || o.list)} ${money(o.list)}${tail}`;
}

const HEADER = ["ADDRESS CITY BD BATH SQ FT LOT SIZE YEAR DATE $/SQFT", "DOM", "CDOM", "ORIG", "PRICE", "LIST", "PRICE"];

/** block("Active", listings, { lastPrice, countOverride, medianOverride }) → lines for one status block. */
function block(name, listings, opts) {
  const o = opts || {};
  const closed = name === "Closed";
  const lines = [name, ...HEADER, ...(closed ? ["CLOSE", "PRICE", "CP%", "LP"] : [])];
  listings.forEach((l, i) => lines.push(row(i + (o.offset || 0), l)));
  const prices = listings.map((l) => (closed ? l.close : l.list));
  lines.push(`LISTING COUNT:${o.countOverride != null ? o.countOverride : listings.length} AVERAGES:$30734/34$667,582$662,9902,210$839,000`);
  lines.push(`MEDIAN PRICE:${money(o.medianOverride != null ? o.medianOverride : median(prices))} LOW PRICE:${money(Math.min(...prices))}HIGH PRICE:`);
  return lines;
}

const FOOTER = [
  "PRESENTED BY: " + FAKE.agent + " Fixture Realty Group", "LIC: 01234567", `Primary:${FAKE.phone} Secondary:800-555-0199`, FAKE.email, FAKE.site,
  "201 Fixture Way Roseville CA 95747", FAKE.phone,
  "All data, photos, visualizations and information regarding a property has been obtained from various sources and has not been verified.",
  "Copyright © 2026, MetroList Services, Inc. Copyright © 2026, Rapattoni Corporation. All rights reserved.",
];

/** Standard fixture: 6 active, 1 pending, 12 closed, 1 expired (Roseville). Returns { pages, lines, listings }. */
function standard(over) {
  const o = over || {};
  const active = o.active || Array.from({ length: 12 }, (_, i) => ({ list: 500000 + i * 20000, orig: i === 1 || i === 4 ? 500000 + i * 20000 + 20000 : undefined, dom: 5 + i * 5, date: `2026-10-${String(20 - i).padStart(2, "0")}`, sqft: 1800 + i * 100, ppsf: 280 + i }));
  const pending = o.pending || [{ list: 525000, orig: 544900, dom: 8, date: "2026-10-17", ppsf: 294 }];
  const closed = o.closed || Array.from({ length: 12 }, (_, i) => { const list = 600000 + i * 10000; return { list, close: list + (i % 2 ? 5000 : -5000), dom: 10 + i * 5, date: `2026-0${3 + (i % 6)}-1${i % 9}`, sqft: 2000 + i * 50, ppsf: 280 }; });
  const expired = o.expired || [{ list: 649900, dom: 41, date: "2026-06-30", ppsf: 323 }];
  const head = ["COMPARATIVE MARKET ANALYSIS REPORT", "Listings as of: Saturday, October 24, 2026 1:39 PM Page:1/3",
    "Search Criteria: Contains selected listings. Map Draw 1 Shape Property Type RESI Statuses Active, Pending, Closed (2/18/2026 or after),", "Expired (2/18/2026 or after), Sold Off MLS (2/18/2026 or after)", "Residential"];
  const page1 = [...head, ...block("Active", active), ...block("Pending", pending), ...FOOTER];
  const page2 = ["COMPARATIVE MARKET ANALYSIS REPORT", "Listings as of: Saturday, October 24, 2026 1:39 PM Page:2/3", ...block("Closed", closed, { offset: 20 }), ...block("Expired", expired, { offset: 40 }), ...FOOTER];
  const total = active.length + pending.length + closed.length + expired.length;
  const page3 = ["COMPARATIVE MARKET ANALYSIS REPORT", "Listings as of: Saturday, October 24, 2026 1:39 PM Page:3/3", "REPORT TOTALS", `LISTING COUNT:${total} AVERAGES:2,347$29250/52$685,564$675,829`, ...FOOTER];
  const pages = [page1.join("\n"), page2.join("\n"), page3.join("\n")];
  return { pages, lines: [...page1, ...page2, ...page3], listings: { active, pending, closed, expired }, total };
}

module.exports = { FAKE, row, block, standard, median, money };
