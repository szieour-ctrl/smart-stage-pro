// lib/agent-marketing-report-lib.js — Netlify (shared, pure functions; no network, no database, no file access)
// Local Market Insider: reading an agent's own MLS market report or CMA (Oct 24, 2026).
//
// WHAT COMES OUT. Only market-level facts: counts, medians, averages, ranges, days on market, close-vs-list, price per
// square foot, price reductions, date windows and the cities the report covers. The report's text, property addresses,
// names, phone numbers, emails and file name are never kept: they are read, turned into numbers, and dropped. Nothing in
// this file can return them, because the output is built from numbers and a short allow-list of strings (see sanitize*).
//
// WHAT IS NEVER TRUSTED. Every figure is computed here from the rows, then checked against what the report itself printed
// (listing count, median price) when it printed them. A status block whose parsed rows do not match the report's own
// count gets NO computed figures, only a warning. The agent also sees every figure and the scope sentence and must
// confirm them before anything is used (agent-marketing-report.js).
//
// Inputs are plain data: `pages` (array of page text) for a PDF, `rows` (array of arrays of cells) for CSV or Excel.
// Reading the files themselves is in agent-marketing-report-read-lib.js.
"use strict";

const FACTS_VERSION = 1;
const PERMISSION_VERSION = "agent-marketing-report-1";
const PERMISSION_TEXT = "I am permitted to use this data in my marketing, and it excludes confidential client information.";
const SMALL_SAMPLE_BELOW = 10;     // fewer than this many records in a group = "small sample": say so, no trend claims
const MIN_GROUP_FOR_STATS = 3;     // a group of 1 or 2 listings only gets a count: its "median" would be one specific home's price
const BROAD_WINDOW_DAYS = 120;     // a date window wider than this must not be described as "this month" or "recent"
const MAX_RECORDS = 5000;
const PRICE_MIN = 20000, PRICE_MAX = 60000000;

const MLS_SOURCES = ["MetroList", "CRMLS", "MLSListings", "bridgeMLS", "Rapattoni"]; // only these names are ever kept from a report
const PROPERTY_TYPES = { RESI: "Residential", RESIDENTIAL: "Residential", COND: "Condo", CONDO: "Condo", MFR: "Multi-family", MULTI: "Multi-family", LAND: "Land", LOT: "Land" };

const STATUS_ORDER = ["active", "coming_soon", "contingent", "pending", "closed", "expired", "canceled", "withdrawn", "unknown", "other"];
const STATUS_PLURAL = { active: "active listings", coming_soon: "coming-soon listings", contingent: "contingent listings", pending: "pending listings", closed: "closed sales", expired: "expired listings", canceled: "canceled listings", withdrawn: "withdrawn listings", unknown: "listings", other: "other listings" };
const STATUS_HEADING = { active: "Active", coming_soon: "Coming soon", contingent: "Contingent", pending: "Pending", closed: "Closed", expired: "Expired", canceled: "Canceled", withdrawn: "Withdrawn", unknown: "Listings", other: "Other" };
const DATE_MEANING = { active: "listed", coming_soon: "listed", contingent: "listed", pending: "listed", closed: "closed", expired: "expired", canceled: "canceled", withdrawn: "withdrawn", unknown: "dated", other: "dated" };

const STREET_SUFFIX = "St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Rd|Road|Ln|Lane|Ct|Court|Way|Pl|Place|Cir|Circle|Ter|Terrace|Pkwy|Parkway|Hwy|Loop|Trl|Trail";

// ── Small helpers ──────────────────────────────────────────────────────────────────────────────────────────────────
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
function round(n, d) { const p = Math.pow(10, d || 0); return Math.round((n + Number.EPSILON) * p) / p; }
function median(a) { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function minOf(a) { return a.length ? a.reduce((x, y) => (y < x ? y : x), a[0]) : null; }
function maxOf(a) { return a.length ? a.reduce((x, y) => (y > x ? y : x), a[0]) : null; }

/** Status words from any MLS → one of STATUS_ORDER. */
function normStatus(s) {
  const t = String(s == null ? "" : s).toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (/sold off mls|off mls/.test(t)) return "other";
  if (/active under contract|contingent|backup|kick ?out/.test(t)) return "contingent";
  if (/coming soon/.test(t)) return "coming_soon";
  if (/\bpending\b/.test(t)) return "pending";
  if (/\b(closed|sold|settled)\b/.test(t)) return "closed";
  if (/expire/.test(t)) return "expired";
  if (/cancel/.test(t)) return "canceled";
  if (/withdr/.test(t)) return "withdrawn";
  if (/^active\b|\bfor sale\b/.test(t)) return "active";
  return "other";
}

function parseMoney(v) {
  if (typeof v === "number") return Number.isFinite(v) && v >= PRICE_MIN && v <= PRICE_MAX ? v : null;
  const s = String(v == null ? "" : v).trim();
  if (!s) return null;
  const m = /^\$?\s*(\d[\d,]*(?:\.\d+)?)\s*([kKmM])?$/.exec(s);
  if (!m) return null;
  let n = Number(m[1].replace(/,/g, ""));
  if (m[2]) n *= /k/i.test(m[2]) ? 1000 : 1000000;
  return Number.isFinite(n) && n >= PRICE_MIN && n <= PRICE_MAX ? n : null;
}
function parseDom(v) {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 && v <= 3000 && Number.isInteger(v) ? v : null;
  const m = /^\s*(\d{1,4})(?:\s*\/\s*\d{1,4})?\s*$/.exec(String(v == null ? "" : v));
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 3000 ? n : null;
}
function parseSqft(v) {
  const n = typeof v === "number" ? v : Number(String(v == null ? "" : v).replace(/[,\s]/g, ""));
  return Number.isFinite(n) && n >= 200 && n <= 50000 ? n : null;
}
function parsePpsf(v) {
  const n = typeof v === "number" ? v : Number(String(v == null ? "" : v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n >= 20 && n <= 5000 ? n : null;
}
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function isoDay(y, m, d) {
  if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return t.toISOString().slice(0, 10);
}
/** Dates as the MLS prints them (10/23/26, 10/23/2026, 2026-10-23, Oct 23, 2026) or as an Excel Date → "YYYY-MM-DD" or null. */
function parseDate(v) {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? isoDay(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate()) : null;
  const s = String(v == null ? "" : v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return isoDay(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (m) { let y = +m[3]; if (m[3].length === 2) y += y <= 69 ? 2000 : 1900; return isoDay(y, +m[1], +m[2]); }
  m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) return isoDay(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  m = /^(\d{1,2})[-\s]([A-Za-z]{3})[a-z]*[-\s](\d{4})$/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) return isoDay(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  return null;
}
const dayNumber = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86400000);
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function longDate(iso) { const [y, m, d] = iso.split("-").map(Number); return `${MONTH_NAMES[m - 1]} ${d}, ${y}`; }
function shortDate(iso, withYear) { const [y, m, d] = iso.split("-").map(Number); return `${MONTH_NAMES[m - 1].slice(0, 3)} ${d}${withYear ? `, ${y}` : ""}`; }

// Strings that may be kept from a report: a city, a ZIP, a place name. Letters, spaces and a few marks only, never a street.
function sanitizeCity(s) {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  if (!/^[A-Z][A-Za-z.'\- ]{1,29}$/.test(t)) return "";
  if (new RegExp(`\\b(?:${STREET_SUFFIX})\\b\\.?$`, "i").test(t) && t.split(" ").length > 1) return ""; // "Oak Ridge Drive" is a street, not a city
  return t;
}
const sanitizeZip = (s) => (/^9\d{4}$/.test(String(s || "").trim()) ? String(s).trim() : "");

// ── Statistics from normalized records ─────────────────────────────────────────────────────────────────────────────
/**
 * A record is { status, list, orig, close, dom, date, ppsf, sqft, city, zip } with numbers/ISO dates or null. Nothing else.
 * statsFromRecords(records) → { statuses: {key: {count, reportedCount?, dateRange, dateMeaning, small}}, figures: [...], total, sample }
 */
function statsFromRecords(records) {
  const groups = {};
  (records || []).slice(0, MAX_RECORDS).forEach((r) => { const k = r.status || "unknown"; (groups[k] = groups[k] || []).push(r); });
  const statuses = {};
  const figures = [];
  let nextId = 1;
  const add = (status, key, label, value, unit, n, extra) => {
    if (value == null || !Number.isFinite(value)) return;
    const small = n < SMALL_SAMPLE_BELOW;
    figures.push({ id: `f${nextId++}`, status, key, label, value, unit, n, small, ...(extra || {}) });
  };
  STATUS_ORDER.filter((k) => groups[k]).forEach((status) => {
    const recs = groups[status];
    const plural = STATUS_PLURAL[status];
    const n = recs.length;
    const dates = recs.map((r) => r.date).filter(Boolean).sort();
    const dateRange = dates.length ? { start: dates[0], end: dates[dates.length - 1], meaning: DATE_MEANING[status] } : null;
    statuses[status] = { count: n, dateRange, small: n < SMALL_SAMPLE_BELOW };
    const win = dateRange ? { start: dateRange.start, end: dateRange.end } : null;
    const w = win ? { window: win } : {};
    add(status, "count", status === "closed" ? "Closed sales" : status === "unknown" ? "Listings" : `${STATUS_HEADING[status]} listings`, n, "count", n, w);
    if (n < MIN_GROUP_FOR_STATS) return; // count only
    const lists = recs.map((r) => r.list).filter((x) => x != null);
    const closes = recs.map((r) => r.close).filter((x) => x != null);
    if (status === "closed" && closes.length) {
      add(status, "median_close_price", `Median sold price of ${plural}`, median(closes), "usd", closes.length, w);
      add(status, "avg_close_price", `Average sold price of ${plural}`, mean(closes), "usd", closes.length, w);
      add(status, "low_price", `Lowest sold price among ${plural}`, minOf(closes), "usd", closes.length, w);
      add(status, "high_price", `Highest sold price among ${plural}`, maxOf(closes), "usd", closes.length, w);
      const pairs = recs.filter((r) => r.close != null && r.list != null);
      if (pairs.length) {
        add(status, "avg_close_to_list_pct", `Average sold price as a percent of list price, ${plural}`, mean(pairs.map((r) => (r.close / r.list) * 100)), "pct", pairs.length, w);
        add(status, "at_or_above_list_count", `${plural.charAt(0).toUpperCase() + plural.slice(1)} that closed at or above list price`, pairs.filter((r) => r.close >= r.list).length, "count", pairs.length, w);
      }
    }
    if (lists.length) {
      add(status, "median_list_price", `Median list price of ${plural}`, median(lists), "usd", lists.length, w);
      add(status, "avg_list_price", `Average list price of ${plural}`, mean(lists), "usd", lists.length, w);
      if (status !== "closed") {
        add(status, "low_price", `Lowest list price among ${plural}`, minOf(lists), "usd", lists.length, w);
        add(status, "high_price", `Highest list price among ${plural}`, maxOf(lists), "usd", lists.length, w);
      }
    }
    if (["active", "pending", "contingent", "coming_soon"].includes(status)) {
      const both = recs.filter((r) => r.orig != null && r.list != null);
      if (both.length) add(status, "reduced_count", `${plural.charAt(0).toUpperCase() + plural.slice(1)} with a price reduction`, both.filter((r) => r.orig > r.list).length, "count", both.length, w);
    }
    const doms = recs.map((r) => r.dom).filter((x) => x != null);
    if (doms.length) {
      add(status, "median_dom", `Median days on market of ${plural}`, median(doms), "days", doms.length, w);
      add(status, "avg_dom", `Average days on market of ${plural}`, mean(doms), "days", doms.length, w);
    }
    const ppsf = recs.map((r) => r.ppsf != null ? r.ppsf : (r.sqft != null && (status === "closed" ? r.close : r.list) != null ? (status === "closed" ? r.close : r.list) / r.sqft : null)).filter((x) => x != null);
    if (ppsf.length) add(status, "median_ppsf", `Median price per square foot of ${plural}`, median(ppsf), "usd_per_sqft", ppsf.length, w);
  });
  const closed = (statuses.closed && statuses.closed.count) || 0;
  const total = (records || []).length;
  return { statuses, figures, total, sample: { total, closed, small: closed < SMALL_SAMPLE_BELOW } };
}

// ── Display ────────────────────────────────────────────────────────────────────────────────────────────────────────
const usd = (n) => "$" + Math.round(n).toLocaleString("en-US");
function formatFigure(f) {
  if (!f || f.value == null) return "";
  switch (f.unit) {
    case "usd": return usd(f.value);
    case "usd_per_sqft": return `${usd(f.value)} per sq ft`;
    case "pct": return `${round(f.value, 1)}%`;
    case "days": return `${Math.round(f.value)} days`;
    default: return Math.round(f.value).toLocaleString("en-US");
  }
}
function windowText(w) { return w ? (w.start === w.end ? shortDate(w.start, true) : `${shortDate(w.start, true)} to ${shortDate(w.end, true)}`) : ""; }

function listText(a) { return a.length <= 1 ? a.join("") : a.length === 2 ? `${a[0]} and ${a[1]}` : `${a.slice(0, -1).join(", ")}, and ${a[a.length - 1]}`; }
function placesOf(facts) {
  const g = (facts && facts.geography) || {};
  const out = [...(g.cities || [])];
  if (!out.length && (g.zips || []).length) return (g.zips || []).slice(0, 4).map((z) => `ZIP ${z}`);
  return out;
}

/**
 * scopeSentence(facts) → the plain-language question the agent confirms ("This report covers…. Correct?").
 * Built only from numbers and the allow-listed strings in `facts`.
 */
function scopeSentence(facts) {
  const f = facts || {};
  const parts = [];
  const places = placesOf(f);
  const src = f.mlsSource ? `${f.mlsSource} report` : "report";
  parts.push(`This ${src} covers ${places.length ? listText(places) : "an area it does not name"}${f.geography && f.geography.drawnOnMap ? " (an area drawn on a map)" : ""}${f.reportDate ? `, as of ${longDate(f.reportDate)}` : ""}.`);
  const st = f.statuses || {};
  const order = STATUS_ORDER.filter((k) => st[k]);
  if (order.length) {
    const total = f.sample ? f.sample.total : order.reduce((n, k) => n + st[k].count, 0);
    parts.push(`It includes ${total} ${total === 1 ? "listing" : "listings"}: ${listText(order.map((k) => `${st[k].count} ${STATUS_PLURAL[k] === "closed sales" ? "closed" : STATUS_HEADING[k].toLowerCase()}`))}.`);
    const c = st.closed;
    if (c && c.dateRange) parts.push(`Closed sales run from ${shortDate(c.dateRange.start, true)} to ${shortDate(c.dateRange.end, true)}.`);
  }
  if ((f.propertyTypes || []).length) parts.push(`Property type: ${f.propertyTypes.join(", ")}.`);
  return parts.join(" ");
}

/** The only text about a report that is ever sent to Perplexity. No prices, no medians, no addresses: places, dates and counts. */
function scopeNote(facts) {
  const f = facts || {};
  const places = placesOf(f);
  const bits = [`${f.mlsSource ? f.mlsSource + " " : ""}market report`, places.length ? `covering ${listText(places)}` : null, f.reportDate ? `as of ${f.reportDate}` : null];
  const st = f.statuses || {};
  const order = STATUS_ORDER.filter((k) => st[k]);
  if (order.length) bits.push(`with ${f.sample ? f.sample.total : ""} listings (${order.map((k) => `${st[k].count} ${STATUS_HEADING[k].toLowerCase()}`).join(", ")})`.replace(/with\s+listings/, "with listings"));
  if (f.sample && f.sample.small) bits.push("a small sample of closed sales");
  return bits.filter(Boolean).join(", ").slice(0, 400);
}

/** Display rows for the confirmation screen: grouped by status, each figure with its sample size. */
function displayFigures(facts) {
  const figs = (facts && facts.figures) || [];
  return STATUS_ORDER.filter((k) => figs.some((f) => f.status === k)).map((k) => ({
    status: k, heading: STATUS_HEADING[k],
    window: (facts.statuses && facts.statuses[k] && facts.statuses[k].dateRange) ? `Dates ${DATE_MEANING[k]}: ${windowText(facts.statuses[k].dateRange)}` : "",
    figures: figs.filter((f) => f.status === k).map((f) => ({ id: f.id, label: f.label, display: formatFigure(f), n: f.n, small: !!f.small })),
  }));
}

/**
 * verifiedFromReport(facts) → { texts: [string] } for the content gate (verified facts). Each figure becomes "label: $659,000";
 * decimals also appear rounded, so "about 30 days" (29.5) traces to the report. Only call this for a CONFIRMED report.
 * LIMIT: the gate checks that a number appears among these facts, not that it is attached to the right measure. Pass only the figures
 * a topic actually cites (not the whole report) so a mix-up has few places to hide.
 */
function verifiedFromReport(facts) {
  const f = facts || {};
  const texts = [];
  (f.figures || []).forEach((fig) => {
    const shown = formatFigure(fig);
    const rounded = fig.unit === "usd" || fig.unit === "usd_per_sqft" ? "" : Number.isInteger(fig.value) ? "" : ` (${Math.round(fig.value)})`;
    texts.push(`${fig.label}: ${shown}${rounded}${fig.window ? ` (${windowText(fig.window)})` : ""}`);
  });
  if (f.reportDate) texts.push(`Report date: ${longDate(f.reportDate)}`);
  const c = f.statuses && f.statuses.closed;
  if (c && c.dateRange) texts.push(`Closed sales: ${windowText(c.dateRange)}`);
  return { texts: texts.map((t) => t.replace(/\s+/g, " ")) };
}

/**
 * geographyCheck(facts, geography) → { status: "match" | "different" | "not_named", message }
 * Compares the place the agent chose with the cities/ZIPs the report names. A neighborhood cannot be proven from a city, so
 * it can only be "match" when the report names it; otherwise the agent's confirmation covers it.
 */
function geographyCheck(facts, geography) {
  const g = geography && typeof geography === "object" ? geography : null;
  const rg = (facts && facts.geography) || {};
  const cities = (rg.cities || []).map((c) => c.toLowerCase());
  const zips = rg.zips || [];
  if (!g) return { status: "not_named", message: "" };
  const name = String(g.name || "").trim().toLowerCase();
  const city = String(g.city || "").trim().toLowerCase();
  if (g.type === "city") {
    if (cities.includes(name)) return { status: "match", message: "" };
    if (cities.length) return { status: "different", message: `This report names ${listText(rg.cities)}, not ${g.name}.` };
  } else if (g.type === "zip") {
    if (zips.includes(name)) return { status: "match", message: "" };
    if (zips.length) return { status: "different", message: `This report names ZIP ${zips.join(", ")}, not ${g.name}.` };
  } else if (g.type === "neighborhood") {
    if (cities.length && city && !cities.includes(city)) return { status: "different", message: `This report names ${listText(rg.cities)}, not ${g.city}.` };
    return { status: "not_named", message: `This report does not name ${g.name}. Confirm it covers that neighborhood.` };
  }
  return { status: "not_named", message: `This report does not name ${g.name || "your place"}. Confirm it covers the area you chose.` };
}

// ── Tables: CSV and Excel ──────────────────────────────────────────────────────────────────────────────────────────
const colKey = (s) => String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]/g, "");
// Columns that identify people or properties are never read, even if present.
const NEVER_READ = /address|addr|street|owner|seller|buyer|client|agent|broker|phone|email|name|remark|description|mlsnumber|mls#|listingid|apn|parcel|unit|lockbox|showing/;
const COLS = {
  status: ["status", "liststatus", "mlsstatus", "currentstatus", "standardstatus", "propertystatus"],
  list: ["listprice", "lp", "currentprice", "currentlistprice", "askingprice", "lastlistprice", "listpr"],
  orig: ["origprice", "originallistprice", "originalprice", "olp", "origlistprice"],
  close: ["closeprice", "soldprice", "saleprice", "sp", "closedprice", "soldpr", "closeprc", "salesprice"],
  price: ["price"],
  dom: ["dom", "daysonmarket", "adom", "daystosell", "marketingdays"],
  cdom: ["cdom", "cumulativedom", "cumulativedaysonmarket"],
  closeDate: ["closedate", "solddate", "closingdate", "settleddate", "closeddate", "saledate", "datesold"],
  listDate: ["listdate", "listingdate", "listeddate", "ondate", "datelisted", "listingcontractdate"],
  date: ["date", "statusdate", "statuschangedate"],
  ppsf: ["ppsf", "pricepersqft", "pricepersf", "persqft", "dollarpersqft", "pricesqft"], // the size column "SqFt" is NOT this; a "$/SqFt" header is matched in mapColumns
  sqft: ["sqft", "squarefeet", "livingarea", "buildingareatotal", "sf", "totalsqft", "lasqft", "sqfttotal", "livingsqft"],
  city: ["city", "postalcity", "propertycity"],
  zip: ["zip", "zipcode", "postalcode", "zip5"],
};
function mapColumns(headerRow) {
  const idx = {};
  headerRow.forEach((h, i) => {
    const raw = String(h == null ? "" : h);
    const k = colKey(raw);
    if (!k || NEVER_READ.test(k) && !/^(city|postalcity|propertycity)$/.test(k)) return;
    if (/\$\/?sq/i.test(raw) || /^\$?\s*\/\s*sq/i.test(raw)) { if (idx.ppsf == null) idx.ppsf = i; return; }
    for (const [name, keys] of Object.entries(COLS)) {
      if (keys.includes(k) && idx[name] == null) { idx[name] = i; break; }
    }
  });
  return idx;
}

/**
 * recordsFromRows(rows) → { records, usedColumns, problem }
 * Finds the header row (the first of the first 15 rows with at least two known columns, one of them a status, price or days
 * column), then builds records from the known columns only. Address, name, phone and email columns are never looked at.
 */
function recordsFromRows(rows) {
  const grid = Array.isArray(rows) ? rows : [];
  let hi = -1, idx = null;
  for (let i = 0; i < Math.min(grid.length, 15); i++) {
    const m = mapColumns(Array.isArray(grid[i]) ? grid[i] : []);
    const known = Object.keys(m).length;
    if (known >= 2 && (m.status != null || m.list != null || m.close != null || m.price != null || m.dom != null)) { hi = i; idx = m; break; }
  }
  if (hi < 0) return { records: [], usedColumns: [], problem: "no_header" };
  const records = [];
  let skipped = 0;
  for (let r = hi + 1; r < grid.length && records.length < MAX_RECORDS; r++) {
    const row = Array.isArray(grid[r]) ? grid[r] : [];
    const cell = (k) => (idx[k] == null ? null : row[idx[k]]);
    const first = String(row.find((c) => c != null && String(c).trim() !== "") || "").toLowerCase();
    if (!first) continue;
    if (/^(total|totals|average|averages|median|summary|count|subtotal|min|max)\b/.test(first)) continue;
    let status = idx.status != null ? normStatus(cell("status")) : null;
    let list = parseMoney(cell("list")), close = parseMoney(cell("close")), orig = parseMoney(cell("orig"));
    const price = parseMoney(cell("price"));
    if (price != null && list == null && close == null) { if (status === "closed") close = price; else list = price; }
    if (!status) status = close != null ? "closed" : "unknown";
    if (list == null && close == null) { skipped++; continue; }
    const date = parseDate(cell(status === "closed" ? "closeDate" : "listDate")) || parseDate(cell("date")) || parseDate(cell(status === "closed" ? "listDate" : "closeDate"));
    records.push({
      status, list, orig, close, dom: parseDom(cell("dom") != null ? cell("dom") : cell("cdom")), date,
      ppsf: parsePpsf(cell("ppsf")), sqft: parseSqft(cell("sqft")),
      city: sanitizeCity(cell("city")), zip: sanitizeZip(cell("zip")),
    });
  }
  return { records, usedColumns: Object.keys(idx), skipped, problem: records.length ? null : "no_rows" };
}

// ── Labeled market statistics ("Median Sales Price  $742,000") ─────────────────────────────────────────────────────
const METRICS = [
  { key: "median_close_price", label: "Median sold price", unit: "usd", re: /\bmedian\s+(?:sales?|sold|closed|close)\s+price\b/i },
  { key: "avg_close_price", label: "Average sold price", unit: "usd", re: /\b(?:average|avg\.?|mean)\s+(?:sales?|sold|closed|close)\s+price\b/i },
  { key: "median_list_price", label: "Median list price", unit: "usd", re: /\bmedian\s+(?:list(?:ing)?|asking)\s+price\b/i },
  { key: "avg_list_price", label: "Average list price", unit: "usd", re: /\b(?:average|avg\.?|mean)\s+(?:list(?:ing)?|asking)\s+price\b/i },
  { key: "median_dom", label: "Median days on market", unit: "days", re: /\bmedian\s+(?:days\s+on\s+market|dom)\b/i },
  { key: "avg_dom", label: "Average days on market", unit: "days", re: /\b(?:average|avg\.?|mean)\s+(?:days\s+on\s+market|dom)\b|\bdays\s+on\s+market\b/i },
  { key: "months_supply", label: "Months of inventory", unit: "months", re: /\bmonths?\s+(?:of\s+)?(?:inventory|supply)\b/i },
  { key: "median_ppsf", label: "Median price per square foot", unit: "usd_per_sqft", re: /\bmedian\s+(?:price\s+per\s+sq(?:uare)?\.?\s*f(?:ee|oo)?t|\$\s*\/\s*sq\s*ft)\b/i },
  { key: "avg_ppsf", label: "Average price per square foot", unit: "usd_per_sqft", re: /\b(?:average|avg\.?)\s+(?:price\s+per\s+sq(?:uare)?\.?\s*f(?:ee|oo)?t|\$\s*\/\s*sq\s*ft)\b/i },
  { key: "avg_close_to_list_pct", label: "Sold price as a percent of list price", unit: "pct", re: /\b(?:sale|sold)s?[-\s]to[-\s](?:original\s+)?list(?:ing)?\s+(?:price\s+)?(?:ratio|percent)|\blist\s+price\s+received\b|\bsp\s*\/\s*lp\b/i },
  { key: "count_active", label: "Active listings", unit: "count", status: "active", re: /\b(?:active\s+(?:listings|inventory)|homes\s+for\s+sale)\b/i },
  { key: "count_pending", label: "Pending sales", unit: "count", status: "pending", re: /\bpending\s+(?:sales|listings)\b/i },
  { key: "count_closed", label: "Closed sales", unit: "count", status: "closed", re: /\b(?:closed\s+sales|sold\s+listings|homes\s+sold|closings)\b/i },
  { key: "count_new", label: "New listings", unit: "count", status: "active", re: /\bnew\s+listings\b/i },
];
const RANGE = { usd: [PRICE_MIN, PRICE_MAX], days: [0, 3000], months: [0, 60], usd_per_sqft: [20, 5000], pct: [50, 150], count: [0, 100000] };

function firstNumberAfter(text, from) {
  const re = /\$?\s*(\d[\d,]*(?:\.\d+)?)\s*([kKmM%])?/g;
  re.lastIndex = from;
  const m = re.exec(text);
  if (!m) return null;
  let n = Number(m[1].replace(/,/g, ""));
  if (m[2] && /k/i.test(m[2])) n *= 1000; else if (m[2] && /m/i.test(m[2])) n *= 1000000;
  return { value: n, end: re.lastIndex, hasPct: m[2] === "%", hasDollar: /\$/.test(m[0]) };
}

/** extractLabeledMetrics(lines) → [{key,label,unit,value,status?}]  (one per metric, first match wins; out-of-range values are dropped) */
function extractLabeledMetrics(lines) {
  const found = {};
  (lines || []).forEach((raw) => {
    const line = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
    if (!line || line.length > 300) return;
    for (const m of METRICS) {
      if (found[m.key]) continue;
      const hit = m.re.exec(line);
      if (!hit) continue;
      const v = firstNumberAfter(line, hit.index + hit[0].length);
      if (!v) continue;
      let value = v.value;
      if (m.unit === "pct" && value <= 1.5) value *= 100; // 0.991 → 99.1
      const [lo, hi] = RANGE[m.unit] || [0, Infinity];
      if (!(value >= lo && value <= hi)) continue;
      found[m.key] = { key: m.key, label: m.label, unit: m.unit === "months" ? "count" : m.unit, value, ...(m.status ? { status: m.status } : {}), ...(m.unit === "months" ? { months: true } : {}) };
    }
  });
  return Object.values(found);
}

function metricFigures(metrics, startId) {
  let n = startId || 1;
  return metrics.map((m) => ({ id: `f${n++}`, status: m.status || "all", key: m.key, label: m.months ? "Months of inventory" : m.label, value: m.value, unit: m.months ? "months" : m.unit, n: 0, small: false, reported: true }));
}

// ── MLS CMA PDFs (the MetroList / Rapattoni layout) ────────────────────────────────────────────────────────────────
// One row per listing, with the columns: address, city, beds, baths "2 (2 0)", sq ft, lot, [year], date, $/sq ft, DOM/CDOM,
// original price, list price, and for closed sales the close price and CP%. Each status block ends with "LISTING COUNT:n" and
// "MEDIAN PRICE:$x"; those two numbers are used to check the rows, never as figures.
const CMA_RIGHT = /^(\d[^$]*?)\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+\$([\d,]+)\s+(\d{1,4})\/(\d{1,4})\s+\$([\d,]+)\s+\$([\d,]+)(?:\s+\$([\d,]+)\s+(\d{2,3})%)?\s*$/;
const CMA_LEFT = /^(.*?)\s+(\d{1,2}(?:-\d{1,2})?)\s+(\d{1,2}(?:\.\d)?)(?:\s+\(\d+\s+\d+\))?\s+([\d,]+)\s+(\d[\d.]*)(?:\s+(\d{4}))?$/;
const CMA_SECTION = /^(active|pending|closed|expired|cancell?ed|withdrawn|contingent|coming soon|active under contract|sold off mls)$/i;

function cityFromPrefix(prefix) {
  const withSuffix = new RegExp(`^\\d+\\s+.+?\\b(?:${STREET_SUFFIX})\\b\\.?\\s+(.+)$`, "i").exec(prefix);
  const tail = withSuffix ? withSuffix[1] : (prefix.split(/\s+/).slice(-1)[0] || "");
  return sanitizeCity(tail.trim());
}

/**
 * analyzeCmaPages(pages) → { records, reported, layout: "cma_table" } or null when the pages are not in this layout.
 * `reported[status] = { count, median }` are the report's own printed numbers, used to verify the rows.
 */
function analyzeCmaPages(pages) {
  const lines = (Array.isArray(pages) ? pages : [pages]).join("\n").split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim());
  const records = [];
  const reported = {};
  let section = null, totals = false, reportedTotal = null;
  for (const line of lines) {
    if (!line) continue;
    if (/^REPORT TOTALS\b/i.test(line)) { totals = true; section = null; continue; }
    if (CMA_SECTION.test(line)) { section = normStatus(line); totals = false; continue; }
    const cnt = /^LISTING COUNT:\s*(\d+)/i.exec(line);
    if (cnt) { if (totals) reportedTotal = Number(cnt[1]); else if (section) { reported[section] = reported[section] || {}; reported[section].count = Number(cnt[1]); } continue; }
    const med = /MEDIAN PRICE:\s*\$([\d,]+)/i.exec(line);
    if (med && section) { reported[section] = reported[section] || {}; reported[section].median = Number(med[1].replace(/,/g, "")); continue; }
    const m = CMA_RIGHT.exec(line);
    if (!m) continue;
    const date = parseDate(m[2]);
    const ppsf = parsePpsf(m[3]);
    const dom = parseDom(m[4]);
    const orig = parseMoney("$" + m[6]), list = parseMoney("$" + m[7]);
    const close = m[8] ? parseMoney("$" + m[8]) : null;
    if (list == null && close == null) continue;
    let city = "", sqft = null;
    const left = CMA_LEFT.exec(m[1]);
    if (left) { city = cityFromPrefix(left[1]); sqft = parseSqft(left[4]); }
    else city = cityFromPrefix(m[1]);
    records.push({ status: section || (close != null ? "closed" : "unknown"), list, orig, close, dom, date, ppsf, sqft, city, zip: "" });
  }
  if (!records.length) return null;
  return { records, reported, reportedTotal, layout: "cma_table" };
}

/** Header details that describe the report (not the listings): as-of date, MLS name, property type, closed-since date, drawn map. */
function cmaMeta(text) {
  const t = String(text || "");
  const meta = { reportDate: null, mlsSource: null, propertyTypes: [], closedSince: null, drawnOnMap: false };
  const asOf = /Listings as of:\s*(?:[A-Za-z]+,\s*)?([A-Za-z]+ \d{1,2},\s*\d{4})/i.exec(t) || /(?:report|as of)\s*(?:date)?:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i.exec(t);
  if (asOf) meta.reportDate = parseDate(asOf[1].replace(/\s+/g, " "));
  meta.mlsSource = MLS_SOURCES.find((s) => new RegExp(`\\b${s}\\b`, "i").test(t)) || null;
  const pt = /Property Type\s+([A-Za-z]+)/i.exec(t);
  if (pt && PROPERTY_TYPES[pt[1].toUpperCase()]) meta.propertyTypes = [PROPERTY_TYPES[pt[1].toUpperCase()]];
  const cs = /Closed\s*\((\d{1,2}\/\d{1,2}\/\d{4})\s+or after\)/i.exec(t);
  if (cs) meta.closedSince = parseDate(cs[1]);
  meta.drawnOnMap = /\bMap Draw\b/i.test(t);
  return meta;
}

// ── Putting it together ────────────────────────────────────────────────────────────────────────────────────────────
function topPlaces(values, max) {
  const count = new Map();
  values.filter(Boolean).forEach((v) => count.set(v, (count.get(v) || 0) + 1));
  return [...count.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, max).map((e) => e[0]);
}

function checkAgainstReport(statuses, reported, warnings) {
  const dropped = new Set();
  Object.keys(statuses).forEach((k) => {
    const rep = reported && reported[k];
    if (!rep) return;
    statuses[k].reportedCount = rep.count != null ? rep.count : null;
    if (rep.count != null && rep.count !== statuses[k].count) {
      dropped.add(k);
      warnings.push(`I read ${statuses[k].count} of the ${rep.count} ${STATUS_PLURAL[k]} this report lists, so I did not use figures for them.`);
    }
  });
  Object.keys(reported || {}).forEach((k) => {
    if (!statuses[k] && reported[k].count) warnings.push(`The report lists ${reported[k].count} ${STATUS_PLURAL[k] || "listings"} that I could not read.`);
  });
  return dropped;
}

function verifyMedians(records, reported, statuses) {
  Object.keys(statuses).forEach((k) => {
    const rep = reported && reported[k];
    if (!rep || rep.median == null) return;
    const vals = records.filter((r) => r.status === k).map((r) => (k === "closed" ? r.close : r.list)).filter((x) => x != null);
    statuses[k].medianChecked = vals.length > 0 && Math.round(median(vals)) === rep.median;
  });
}

/**
 * buildFacts({ kind, records, metrics, reported, reportedTotal, meta, layout, skipped }) → facts (or { error })
 * `facts` is the ONLY thing stored about a report.
 */
function buildFacts({ kind, records, metrics, reported, reportedTotal, meta, layout, skipped }) {
  const recs = Array.isArray(records) ? records : [];
  const mets = Array.isArray(metrics) ? metrics : [];
  if (!recs.length && !mets.length) return { error: "no_figures" };
  const warnings = [];
  const stats = statsFromRecords(recs);
  const dropped = checkAgainstReport(stats.statuses, reported, warnings);
  verifyMedians(recs, reported, stats.statuses);
  Object.keys(stats.statuses).forEach((k) => { if (stats.statuses[k].medianChecked === false) warnings.push(`The median price I calculated for ${STATUS_PLURAL[k]} does not match the one printed in the report, so please check those figures.`); });
  let figures = stats.figures.filter((f) => !dropped.has(f.status) || f.key === "count");
  figures.forEach((f) => { if (dropped.has(f.status) && f.key === "count") { f.value = stats.statuses[f.status].reportedCount != null ? stats.statuses[f.status].reportedCount : f.value; } });
  if (mets.length) figures = figures.concat(metricFigures(mets, figures.length + 1));
  // Re-number so ids are stable and unique in the stored list.
  figures = figures.map((f, i) => ({ ...f, id: `f${i + 1}` }));
  const cities = topPlaces(recs.map((r) => r.city), 5);
  const zips = topPlaces(recs.map((r) => r.zip), 8);
  const m = meta || {};
  const closed = stats.statuses.closed;
  const windowDays = closed && closed.dateRange ? dayNumber(closed.dateRange.end) - dayNumber(closed.dateRange.start) : null;
  const facts = {
    version: FACTS_VERSION, kind, layout: layout || (recs.length ? "listing_table" : "labeled_metrics"),
    reportDate: m.reportDate || null, mlsSource: m.mlsSource || null, propertyTypes: m.propertyTypes || [],
    criteria: { closedSince: m.closedSince || null },
    geography: { cities, zips, drawnOnMap: !!m.drawnOnMap },
    statuses: stats.statuses,
    figures,
    sample: { total: stats.total, closed: stats.sample.closed, small: stats.sample.small, broadWindow: windowDays != null && windowDays > BROAD_WINDOW_DAYS, windowDays },
    reportedTotal: reportedTotal != null ? reportedTotal : null,
    warnings,
    notes: ["Property addresses, names, phone numbers and emails were not kept. Only the figures below were."],
  };
  if (reportedTotal != null && reportedTotal !== stats.total) facts.warnings.push(`The report lists ${reportedTotal} listings in total and I read ${stats.total}.`);
  if (skipped) facts.warnings.push(`${skipped} ${skipped === 1 ? "row" : "rows"} without a usable price ${skipped === 1 ? "was" : "were"} skipped.`);
  if (facts.sample.small && stats.statuses.closed) facts.warnings.push(`Only ${stats.statuses.closed.count} closed ${stats.statuses.closed.count === 1 ? "sale" : "sales"}: a small sample. Topics will say so and will not claim a trend.`);
  else if (facts.sample.small && recs.length) facts.warnings.push("This report has fewer than 10 closed sales: a small sample. Topics will say so and will not claim a trend.");
  if (facts.sample.broadWindow) facts.warnings.push(`Closed sales span about ${Math.round(windowDays / 30)} months, so they describe that whole period, not just this month.`);
  const size = JSON.stringify(facts).length;
  if (size > 40000) return { error: "too_large" };
  return { facts };
}

/** analyzeRows(rows, kind) → { facts } | { error }  for CSV and Excel. */
function analyzeRows(rows, kind) {
  const grid = Array.isArray(rows) ? rows : [];
  const lines = grid.map((r) => (Array.isArray(r) ? r.map((c) => (c == null ? "" : String(c))).join(" ") : ""));
  const t = recordsFromRows(grid);
  const metrics = extractLabeledMetrics(lines);
  if (!t.records.length && !metrics.length) return { error: t.problem === "no_header" ? "no_header" : "no_figures" };
  const meta = cmaMeta(lines.slice(0, 20).join("\n"));
  return buildFacts({ kind, records: t.records, metrics: t.records.length ? [] : metrics, meta, skipped: t.skipped || 0, layout: t.records.length ? "listing_table" : "labeled_metrics" });
}

/** analyzePages(pages) → { facts } | { error }  for PDF text. */
function analyzePages(pages) {
  const list = Array.isArray(pages) ? pages : [String(pages || "")];
  const text = list.join("\n");
  if (text.replace(/\s+/g, "").length < 150) return { error: "no_text" };
  const meta = cmaMeta(text);
  const cma = analyzeCmaPages(list);
  if (cma) return buildFacts({ kind: "pdf", records: cma.records, reported: cma.reported, reportedTotal: cma.reportedTotal, meta, layout: cma.layout });
  const metrics = extractLabeledMetrics(text.split(/\r?\n/));
  if (!metrics.length) return { error: "no_figures" };
  return buildFacts({ kind: "pdf", records: [], metrics, meta, layout: "labeled_metrics" });
}

const ERROR_MESSAGES = {
  no_text: "This PDF has no readable text. It may be a scan or a photo. Download the report as a text PDF, CSV or Excel file from your MLS and try again.",
  no_figures: "I couldn't find market figures in this file. A report with listing prices, closed prices or days on market works best.",
  no_header: "I couldn't find a header row with price or status columns in this file.",
  too_large: "This report has more detail than I can use. Try one property type or a shorter date range.",
  xls: "Old .xls files can't be read here. Save it as .xlsx or CSV from Excel and upload that.",
  unsupported: "Upload a PDF, CSV or Excel (.xlsx) file.",
  empty: "That file is empty.",
  unreadable: "I couldn't open that file. Check that it isn't password protected, then try again.",
};
const errorMessage = (code) => ERROR_MESSAGES[code] || ERROR_MESSAGES.unreadable;

/**
 * summarize(facts, { geography }) → what the confirmation screen shows. Derived on every read, never stored, so wording can improve.
 */
function summarize(facts, opts) {
  const f = facts || {};
  const geo = geographyCheck(f, opts && opts.geography);
  return {
    scopeSentence: scopeSentence(f), scopeNote: scopeNote(f), groups: displayFigures(f),
    warnings: [...(f.warnings || []), ...(geo.message ? [geo.message] : [])], geography: geo.status, notes: f.notes || [],
    sample: f.sample || null, layout: f.layout, reportDate: f.reportDate || null,
  };
}

module.exports = {
  FACTS_VERSION, PERMISSION_VERSION, PERMISSION_TEXT, SMALL_SAMPLE_BELOW, BROAD_WINDOW_DAYS, MAX_RECORDS, STATUS_ORDER, STATUS_PLURAL,
  normStatus, parseMoney, parseDom, parseDate, parseSqft, median, mean, statsFromRecords, formatFigure, scopeSentence, scopeNote, displayFigures,
  verifiedFromReport, geographyCheck, recordsFromRows, extractLabeledMetrics, analyzeCmaPages, cmaMeta, buildFacts, analyzeRows, analyzePages,
  errorMessage, summarize,
};
