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
const MIN_GROUP_FOR_STATS = SMALL_SAMPLE_BELOW; // Sam, Oct 25: "under 10 is not a trend, only count". A group below 10 gets its count and nothing else: no median, average or ratio
const BROAD_WINDOW_DAYS = 120;     // a date window wider than this must not be described as "this month" or "recent"
const MAX_RECORDS = 5000;
const PRICE_MIN = 20000, PRICE_MAX = 60000000;

const MLS_SOURCES = ["MetroList", "CRMLS", "MLSListings", "bridgeMLS", "Rapattoni"]; // only these names are ever kept from a report
const PROPERTY_TYPES = { RESI: "Residential", RESIDENTIAL: "Residential", COND: "Condo", CONDO: "Condo", MFR: "Multi-family", MULTI: "Multi-family", LAND: "Land", LOT: "Land" };

const STATUS_ORDER = ["active", "coming_soon", "contingent", "pending", "closed", "expired", "canceled", "withdrawn", "unknown", "other", "market"];
const STATUS_PLURAL = { active: "active listings", coming_soon: "coming-soon listings", contingent: "contingent listings", pending: "pending listings", closed: "closed sales", expired: "expired listings", canceled: "canceled listings", withdrawn: "withdrawn listings", unknown: "listings", other: "other listings", market: "market measures" };
const STATUS_HEADING = { active: "Active", coming_soon: "Coming soon", contingent: "Contingent", pending: "Pending", closed: "Closed", expired: "Expired", canceled: "Canceled", withdrawn: "Withdrawn", unknown: "Listings", other: "Other", market: "Market overview" };
const DATE_MEANING = { active: "listed", coming_soon: "listed", contingent: "listed", pending: "listed", closed: "closed", expired: "expired", canceled: "canceled", withdrawn: "withdrawn", unknown: "dated", other: "dated", market: "reported" };

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
    case "months": return `${round(f.value, 1)} months`;
    case "weeks": return `${round(f.value, 1)} weeks`;
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
  if (f.layout === "market_trends" && f.period) {
    const where = placesOf(f);
    return `This ${f.mlsSource ? f.mlsSource + " " : ""}market-trends report covers ${where.length ? listText(where) : "an area it does not name"}${(f.propertyTypes || []).length ? ` (${f.propertyTypes.join(", ")})` : ""}, for ${f.period.label}. It shows ${f.period.months} months of history; the latest month has ${f.sample ? Number(f.sample.closed).toLocaleString("en-US") : "?"} closed ${f.sample && f.sample.closed === 1 ? "sale" : "sales"}.`;
  }
  if (f.layout === "weekly_snapshot" && f.period) {
    const where = placesOf(f);
    return `This ${f.mlsSource ? f.mlsSource + " " : ""}weekly report covers ${where.length ? listText(where) : "an area it does not name"}${(f.propertyTypes || []).length ? ` (${f.propertyTypes.join(", ")})` : ""}, for ${f.period.label}${f.reportDate ? `, data updated ${longDate(f.reportDate)}` : ""}. The week has ${f.sample ? Number(f.sample.closed).toLocaleString("en-US") : "?"} closed ${f.sample && f.sample.closed === 1 ? "sale" : "sales"}.`;
  }
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
    if (f.window) parts.push(`Closed, expired and canceled listings are limited to ${f.window.label}.`);
    if (c && c.dateRange) parts.push(`Closed sales run from ${shortDate(c.dateRange.start, true)} to ${shortDate(c.dateRange.end, true)}.`);
  }
  if ((f.propertyTypes || []).length) parts.push(`Property type: ${f.propertyTypes.join(", ")}.`);
  return parts.join(" ");
}

// ── "Not right" feedback ──────────────────────────────────────────────────────────────────────────────────────────
const FEEDBACK_REASONS = ["wrong_area", "wrong_dates", "wrong_type", "counts_off", "other"];
const MAX_FEEDBACK_CHARS = 600;
/** cleanFeedback(body) → { reasons, message } | { error }. At least a reason or a note is needed. */
function cleanFeedback(b) {
  const x = b && typeof b === "object" ? b : {};
  const reasons = [...new Set((Array.isArray(x.reasons) ? x.reasons : []).map(String).filter((r) => FEEDBACK_REASONS.includes(r)))];
  const message = String(x.message == null ? "" : x.message).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_FEEDBACK_CHARS);
  if (!reasons.length && !message) return { error: "Tick what is wrong or write a short note." };
  return { reasons, message };
}
/** What is kept with a note: the scope sentence, layout, window and sample size. Never the file, its text or any listing. */
function feedbackContext(facts) {
  const f = facts || {};
  return { layout: f.layout || null, scope: scopeSentence(f), window: f.window ? { label: f.window.label, closedInWindow: f.window.closedInWindow } : null, sample: f.sample || null, reportDate: f.reportDate || null, warnings: (f.warnings || []).slice(0, 6) };
}

/** The only text about a report that is ever sent to Perplexity. No prices, no medians, no addresses: places, dates and counts. */
function scopeNote(facts) {
  const f = facts || {};
  const places = placesOf(f);
  if ((f.layout === "market_trends" || f.layout === "weekly_snapshot") && f.period) {
    const bits = [`${f.mlsSource ? f.mlsSource + " " : ""}${f.layout === "weekly_snapshot" ? "weekly" : "market-trends"} report`, places.length ? `covering ${listText(places)}` : null, (f.propertyTypes || []).length ? f.propertyTypes.join(", ") : null, `for ${f.period.label}`];
    if (f.sample && f.sample.small) bits.push("a small sample of closed sales");
    return bits.filter(Boolean).join(", ").slice(0, 400);
  }
  const bits = [`${f.mlsSource ? f.mlsSource + " " : ""}market report`, places.length ? `covering ${listText(places)}` : null, f.reportDate ? `as of ${f.reportDate}` : null];
  const st = f.statuses || {};
  const order = STATUS_ORDER.filter((k) => st[k]);
  if (order.length) bits.push(`with ${f.sample ? f.sample.total : ""} listings (${order.map((k) => `${st[k].count} ${STATUS_HEADING[k].toLowerCase()}`).join(", ")})`.replace(/with\s+listings/, "with listings"));
  if (f.sample && f.sample.small) bits.push("a small sample of closed sales");
  return bits.filter(Boolean).join(", ").slice(0, 400);
}

/** Display rows for the confirmation screen: grouped by status, each figure with its sample size. */
/**
 * The change between this figure and an earlier value of the SAME measure in the SAME report, calculated here by code (never by a model):
 * " (up 12.1%)" for counts, prices, days and months; " (up 1.2 points)" for a figure that is itself a percent. Rounded to one decimal.
 * The text becomes part of the verified figure, so a script may quote it exactly; any other percentage still blocks.
 */
function changeText(f, earlier) {
  const now = Number(f && f.value), then = Number(earlier);
  if (!Number.isFinite(now) || !Number.isFinite(then)) return "";
  const pct = f.unit === "pct";
  if (!pct && then === 0) return "";
  const diff = pct ? now - then : ((now - then) / Math.abs(then)) * 100;
  const mag = Math.round(Math.abs(diff) * 10) / 10;
  if (mag === 0) return " (unchanged)";
  return ` (${diff > 0 ? "up" : "down"} ${mag}${pct ? " points" : "%"})`;
}

/** "vs $652,000 in August 2026 and $620,000 in September 2025" for figures that carry a prior month / year-ago value. */
function compareText(facts, f) {
  const p = facts && facts.period;
  if (!p || !f) return "";
  const at = (v) => formatFigure({ ...f, value: v });
  const bits = [];
  if (f.prior != null) bits.push(`${at(f.prior)} in ${p.priorLabel}${changeText(f, f.prior)}`);
  if (f.yearAgo != null) bits.push(`${at(f.yearAgo)} in ${p.yearAgoLabel}${changeText(f, f.yearAgo)}`);
  const vs = bits.length ? `vs ${bits.join(" and ")}` : "";
  // Reports that print a percent change instead of the earlier value (the weekly dashboards): "down 1.8% from the week ending October 10, 2026".
  const ch = (Array.isArray(f.changes) ? f.changes : []).map((c) => `${c.pct < 0 ? "down" : c.pct > 0 ? "up" : "unchanged"}${c.pct === 0 ? "" : ` ${Math.abs(c.pct)}%`} from ${c.vs}`);
  return [vs, ...ch].filter(Boolean).join("; ");
}
function displayFigures(facts) {
  const figs = (facts && facts.figures) || [];
  return STATUS_ORDER.filter((k) => figs.some((f) => f.status === k)).map((k) => ({
    status: k, heading: STATUS_HEADING[k],
    window: (facts.statuses && facts.statuses[k] && facts.statuses[k].dateRange) ? `Dates ${DATE_MEANING[k]}: ${windowText(facts.statuses[k].dateRange)}` : "",
    figures: figs.filter((f) => f.status === k).map((f) => ({ id: f.id, label: f.label, display: formatFigure(f), compare: compareText(facts, f), n: f.n, small: !!f.small })),
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
    const cmp = compareText(f, fig);
    texts.push(`${fig.label}: ${shown}${rounded}${fig.window ? ` (${windowText(fig.window)})` : ""}${cmp ? ` ${cmp}` : ""}`);
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
      if (line.split(" ").length >= 15 && line.slice(v.end).trim() === "") continue; // the end of a long sentence is often cut off by the printout: "...Months of Inventory at 2" (of 2.6)
      if (/\d/.test(line.slice(v.end))) continue; // more numbers follow (a table row or a sentence): the first one may be the wrong column, so do not guess
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
  return metrics.map((m) => ({ id: `f${n++}`, status: m.status || "market", key: m.key, label: m.months ? "Months of inventory" : m.label, value: m.value, unit: m.months ? "months" : m.unit, n: 0, small: false, reported: true }));
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

// ── Date window (Sam, Oct 25): a granular report can be narrowed to the last 30 / 60 / 90 days or custom dates while it is read ─────────
// Applies to listings that have an event date (closed, expired, canceled, withdrawn). Active and pending listings are today's snapshot and
// stay. The report's own counts and medians are checked on the whole file first; the rows are then discarded like always.
const WINDOW_PRESETS = [30, 60, 90];
const WINDOW_STATUSES = ["closed", "expired", "canceled", "withdrawn"];
const MAX_WINDOW_DAYS = 800;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isoValid = (s) => ISO_DAY.test(String(s || "")) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const isoAdd = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
/** validateWindow(w) → { window } | { error }. Nothing / "all" = no window. { days: 30|60|90 } or { start, end } (YYYY-MM-DD). */
function validateWindow(w) {
  if (w == null || w === "" || w === "all" || (typeof w === "object" && !w.days && !w.start && !w.end)) return { window: null };
  if (typeof w !== "object") return { error: "Choose All, 30, 60 or 90 days, or two dates." };
  if (w.days != null && w.days !== "") {
    const d = Number(w.days);
    return WINDOW_PRESETS.includes(d) ? { window: { days: d } } : { error: "Choose 30, 60 or 90 days." };
  }
  if (!isoValid(w.start) || !isoValid(w.end)) return { error: "Enter both dates." };
  if (w.start > w.end) return { error: "The start date must be on or before the end date." };
  if (dayNumber(w.end) - dayNumber(w.start) > MAX_WINDOW_DAYS) return { error: "Choose a window of about two years or less." };
  return { window: { start: w.start, end: w.end } };
}
// The window's end is the report's own "as of" date (or its newest dated row), never today's date.
function resolveWindow(window, reportDate, recs) {
  if (!window) return null;
  if (window.start) return { start: window.start, end: window.end, label: windowText({ start: window.start, end: window.end }) };
  const dates = recs.map((r) => r.date).filter((d) => d && isoValid(d));
  const end = reportDate && isoValid(reportDate) ? reportDate : dates.sort().pop();
  if (!end) return null;
  const start = isoAdd(end, -(window.days - 1));
  return { start, end, days: window.days, label: `the last ${window.days} days, ${windowText({ start, end })}` };
}

// When a window leaves fewer than 10 closed sales, say which longer preset (30/60/90 days, ending the same day) has more, counted from the
// rows already in memory: no extra research call. It only suggests; the agent chooses.
function suggestWiderWindow(recs, applied) {
  const now = applied.closedInWindow;
  if (now >= SMALL_SAMPLE_BELOW) return null;
  const len = applied.days || dayNumber(applied.end) - dayNumber(applied.start) + 1;
  const closed = recs.filter((r) => r.status === "closed" && r.date && r.date <= applied.end);
  let best = null;
  for (const days of WINDOW_PRESETS.filter((d) => d > len)) {
    const start = isoAdd(applied.end, -(days - 1));
    const n = closed.filter((r) => r.date >= start).length;
    if (n >= SMALL_SAMPLE_BELOW) return { days, closed: n };
    if (n > now && (!best || n > best.closed)) best = { days, closed: n };
  }
  return best;
}

/**
 * buildFacts({ kind, records, metrics, reported, reportedTotal, meta, layout, skipped }) → facts (or { error })
 * `facts` is the ONLY thing stored about a report.
 */
function buildFacts({ kind, records, metrics, reported, reportedTotal, meta, layout, skipped, window }) {
  const recs = Array.isArray(records) ? records : [];
  const mets = Array.isArray(metrics) ? metrics : [];
  if (!recs.length && !mets.length) return { error: "no_figures" };
  const warnings = [];
  let stats = statsFromRecords(recs);
  const dropped = checkAgainstReport(stats.statuses, reported, warnings);
  verifyMedians(recs, reported, stats.statuses);
  Object.keys(stats.statuses).forEach((k) => { if (stats.statuses[k].medianChecked === false) warnings.push(`The median price I calculated for ${STATUS_PLURAL[k]} does not match the one printed in the report, so please check those figures.`); });
  // The window, if the agent chose one: counted from the dated rows, after the whole file was checked against the report's own totals above.
  let used = recs, applied = null;
  if (window && recs.length) {
    const rw = resolveWindow(window, (meta || {}).reportDate, recs);
    if (rw) {
      used = recs.filter((r) => !WINDOW_STATUSES.includes(r.status) || (r.date && r.date >= rw.start && r.date <= rw.end));
      applied = { start: rw.start, end: rw.end, days: rw.days || null, label: rw.label, closedInFile: recs.filter((r) => r.status === "closed").length, closedInWindow: used.filter((r) => r.status === "closed").length };
      if (!used.length) return { error: "no_window_rows" };
      applied.suggest = suggestWiderWindow(recs, applied);
      stats = statsFromRecords(used);
    }
  }
  let figures = stats.figures.filter((f) => !dropped.has(f.status) || f.key === "count");
  figures.forEach((f) => { if (dropped.has(f.status) && f.key === "count") { f.value = stats.statuses[f.status].reportedCount != null ? stats.statuses[f.status].reportedCount : f.value; } });
  if (mets.length) figures = figures.concat(metricFigures(mets, figures.length + 1));
  // Re-number so ids are stable and unique in the stored list.
  figures = figures.map((f, i) => ({ ...f, id: `f${i + 1}` }));
  const cities = topPlaces(used.map((r) => r.city), 5);
  const zips = topPlaces(used.map((r) => r.zip), 8);
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
    ...(applied ? { window: applied } : {}),
    warnings,
    notes: ["Property addresses, names, phone numbers and emails were not kept. Only the figures below were."],
  };
  if (applied && applied.closedInWindow === 0) facts.warnings.push(`No closed sales fall in ${applied.label}. Choose a longer window or a report that covers those dates.`);
  else if (applied) facts.warnings.push(`Closed, expired and canceled listings are limited to ${applied.label}: ${applied.closedInWindow} of the ${applied.closedInFile} closed sales in the file. Active and pending listings are as of the report date.`);
  if (applied && applied.suggest) {
    const g = applied.suggest;
    facts.warnings.push(`${applied.closedInWindow === 0 ? "" : `Only ${applied.closedInWindow} closed ${applied.closedInWindow === 1 ? "sale" : "sales"} in that window. `}The last ${g.days} days has ${g.closed}${g.closed >= SMALL_SAMPLE_BELOW ? ", enough for statistics" : ""}. Use "Update the figures" to try it.`);
  }
  if (reportedTotal != null && !applied && reportedTotal !== stats.total) facts.warnings.push(`The report lists ${reportedTotal} listings in total and I read ${stats.total}.`);
  if (skipped) facts.warnings.push(`${skipped} ${skipped === 1 ? "row" : "rows"} without a usable price ${skipped === 1 ? "was" : "were"} skipped.`);
  if (facts.sample.small && stats.statuses.closed) facts.warnings.push(`Only ${stats.statuses.closed.count} closed ${stats.statuses.closed.count === 1 ? "sale" : "sales"}: a small sample. Topics will say so and will not claim a trend.`);
  else if (facts.sample.small && recs.length) facts.warnings.push("This report has fewer than 10 closed sales: a small sample. Topics will say so and will not claim a trend.");
  if (facts.sample.broadWindow) facts.warnings.push(`Closed sales span about ${Math.round(windowDays / 30)} months, so they describe that whole period, not just this month.`);
  const size = JSON.stringify(facts).length;
  if (size > 40000) return { error: "too_large" };
  return { facts };
}

/** analyzeRows(rows, kind) → { facts } | { error }  for CSV and Excel. */
function analyzeRows(rows, kind, opts) {
  const grid = Array.isArray(rows) ? rows : [];
  const trendTable = analyzeTrendTable(grid, kind);
  if (trendTable) return trendTable;
  const lines = grid.map((r) => (Array.isArray(r) ? r.map((c) => (c == null ? "" : String(c))).join(" ") : ""));
  const t = recordsFromRows(grid);
  const metrics = extractLabeledMetrics(lines);
  if (!t.records.length && !metrics.length) return { error: t.problem === "no_header" ? "no_header" : "no_figures" };
  const meta = cmaMeta(lines.slice(0, 20).join("\n"));
  return buildFacts({ kind, records: t.records, metrics: t.records.length ? [] : metrics, meta, skipped: t.skipped || 0, layout: t.records.length ? "listing_table" : "labeled_metrics", window: opts && opts.window });
}


// ── Monthly market-trends reports (TrendGraphix "TrendVision", as MetroList subscribers receive them) ─────────────────
// Ten pages: a written overview, charts, a "VS PREV MONTH / VS SAME MONTH 1 YR AGO" table per chart, a "Today's Stats" page that covers
// only the month so far, and a two-part Data Table with every measure for the last 15 months. The Data Table is the source: its last
// column is the latest full month. The summary tables are used only to check it; "Today's Stats" is never used, because mixing a
// part-month with full months gives false comparisons.
const TV_ROWS = [
  { label: "For Sale", key: "count_active", name: "Active listings", status: "active", unit: "count" },
  { label: "New Listing", key: "count_new", name: "New listings", status: "active", unit: "count" },
  { label: "Sold", key: "count_closed", name: "Closed sales", status: "closed", unit: "count" },
  { label: "Pended", key: "count_pending", name: "Pended sales", status: "pending", unit: "count" },
  { label: "Months of Inventory (Closed Sales)", key: "months_supply", name: "Months of inventory (closed-sales basis)", status: "market", unit: "months" },
  { label: "Months of Inventory (Pended Sales)", key: "months_supply_pended", name: "Months of inventory (pended-sales basis)", status: "market", unit: "months" },
  { label: "Absorption Rate (Closed Sales) %", key: "absorption_closed", name: "Absorption rate (closed sales)", status: "market", unit: "pct" },
  { label: "Absorption Rate (Pended Sales) %", key: "absorption_pended", name: "Absorption rate (pended sales)", status: "market", unit: "pct" },
  { label: "Avg. Active Price", key: "avg_list_price", name: "Average active price", status: "active", unit: "usd", scale: 1000 },
  { label: "Avg. Sold Price", key: "avg_close_price", name: "Average sold price", status: "closed", unit: "usd", scale: 1000 },
  { label: "Avg. Sq. Ft. Price (Sold)", key: "avg_ppsf", name: "Average sold price per square foot", status: "closed", unit: "usd_per_sqft" },
  { label: "Median Active Price", key: "median_list_price", name: "Median active price", status: "active", unit: "usd", scale: 1000 },
  { label: "Median Sold Price", key: "median_close_price", name: "Median sold price", status: "closed", unit: "usd", scale: 1000 },
  { label: "Sold/List Diff. %", key: "avg_close_to_list_pct", name: "Sold price as a percent of list price", status: "closed", unit: "pct" },
  { label: "Sold/Orig LP Diff. %", key: "avg_close_to_orig_list_pct", name: "Sold price as a percent of original list price", status: "closed", unit: "pct" },
  { label: "Avg Days on Market", key: "avg_dom", name: "Average days on market", status: "market", unit: "days" },
  { label: "Avg CDOM", key: "avg_cdom", name: "Average cumulative days on market", status: "market", unit: "days" },
];
// The same measures as they are worded in the per-chart summary tables, for the cross-check.
const TV_CHECKS = [
  ["count_active", /For Sale (-?[\d,.]+) (-?[\d,.]+) -?[\d.,]+%/], ["count_pending", /Pended (-?[\d,.]+) (-?[\d,.]+) -?[\d.,]+%/], ["count_closed", /Sold (-?[\d,.]+) (-?[\d,.]+) -?[\d.,]+%/],
  ["months_supply", /Months of Inventory \(Closed\) (-?[\d,.]+) (-?[\d,.]+) -?[\d.,]+%/], ["avg_close_price", /Avg Sold Price (-?[\d,.]+) (-?[\d,.]+) -?[\d.,]+%/],
  ["avg_list_price", /Avg Active Price (-?[\d,.]+) (-?[\d,.]+) -?[\d.,]+%/], ["avg_close_to_list_pct", /Sold\/List Price Diff % (-?[\d,.]+) (-?[\d,.]+) -?[\d.,]+%/],
  ["avg_dom", /Avg Days on Market (-?[\d,.]+) (-?[\d,.]+) -?[\d.,]+%/],
];
const TV_NUM = "-?[\\d,]+(?:\\.\\d+)?";

function tvHeaderValue(page, heading, next) {
  const m = new RegExp(`${heading}\\s*\\n([\\s\\S]*?)\\n\\s*${next}`, "i").exec(page);
  return m ? m[1].split(/\n/).map((x) => x.trim()).filter(Boolean) : [];
}
function tvLocation(first) {
  const lines = tvHeaderValue(first, "LOCATION", "PROPERTY TYPE");
  const label = lines.join(" ").replace(/\s+/g, " ").trim();
  if (!label || label.length > 90 || !/^[A-Za-z0-9 ,.&'\/-]+$/.test(label)) return { cities: [], zips: [] };
  const zips = Array.from(new Set((label.match(/\b\d{5}\b/g) || [])));
  if (zips.length) return { cities: [], zips: zips.slice(0, 8) };
  return { cities: [label], zips: [] };
}

/** analyzeTrendReport(pages) → { facts } | { error } | null (null = not this layout) */
function analyzeTrendReport(pages) {
  const list = Array.isArray(pages) ? pages : [];
  const all = list.join("\n");
  if (!/TRENDVISION/i.test(all) || !/Data Table/i.test(all)) return null;
  const tables = list.filter((p) => /Data Table \(Part/i.test(p));
  if (!tables.length) return null;
  // Read every Data Table page: a header row of months, then one row per measure.
  const series = {};
  let months = [];
  for (const raw of tables) {
    const text = String(raw).replace(/\n(?=\((?:Closed|Pended) Sales\)|Sales\) %)/g, " ");
    const lines = text.split(/\n/).map((l) => l.trim());
    const hdr = lines.find((l) => /^Metric\s/.test(l));
    if (!hdr) return { error: "no_figures" };
    const cols = Array.from(hdr.matchAll(/\b(\d{1,2})\/(\d{2})\b/g)).map((m) => ({ m: Number(m[1]), y: 2000 + Number(m[2]) }));
    if (!cols.length || cols.some((c) => c.m < 1 || c.m > 12)) return { error: "no_figures" };
    months = months.concat(cols);
    for (const row of TV_ROWS) {
      const line = lines.find((l) => l.startsWith(row.label + " "));
      if (!line) continue;
      const nums = line.slice(row.label.length).trim().replace(/\s+Trend$/, "").split(/\s+/);
      if (nums.length !== cols.length || !nums.every((n) => new RegExp(`^${TV_NUM}$`).test(n))) continue;
      series[row.key] = (series[row.key] || []).concat(nums.map((n) => Number(n.replace(/,/g, ""))));
    }
  }
  const N = months.length;
  // The months must run one after another with no gaps, or "prior month" and "year ago" would point at the wrong column.
  for (let i = 1; i < N; i++) { const a = months[i - 1], b = months[i]; if (b.y * 12 + b.m !== a.y * 12 + a.m + 1) return { error: "no_figures" }; }
  const last = months[N - 1];
  const rows = TV_ROWS.filter((r) => series[r.key] && series[r.key].length === N);
  if (N < 2 || rows.length < 8) return { error: "no_figures" };
  const mkLabel = (c) => `${MONTH_NAMES[c.m - 1]} ${c.y}`;
  const ago = months.findIndex((c) => c.y === last.y - 1 && c.m === last.m);
  const start = isoDay(last.y, last.m, 1);
  const end = isoDay(last.y, last.m, new Date(Date.UTC(last.y, last.m, 0)).getUTCDate());
  const window = { start, end };
  const figures = rows.map((r, i) => {
    const sc = r.scale || 1, ser = series[r.key];
    const f = { id: `f${i + 1}`, status: r.status, key: r.key, label: r.name, value: ser[N - 1] * sc, unit: r.unit, n: 0, small: false, reported: true, window, prior: ser[N - 2] * sc };
    if (ago >= 0) f.yearAgo = ser[ago] * sc;
    return f;
  });
  // Check the Data Table against the report's own per-chart tables (latest and prior month).
  const warnings = [];
  const flat = list.filter((p) => !/Data Table \(Part|Today's Stats/i.test(p)).map((p) => p.replace(/\s+/g, " ")).join(" ");
  let checked = 0; const bad = [];
  TV_CHECKS.forEach(([key, re]) => {
    const fig = figures.find((x) => x.key === key), m = re.exec(flat);
    if (!fig || !m) return;
    const sc = (TV_ROWS.find((r) => r.key === key) || {}).scale || 1;
    checked++;
    const cur = Number(m[1].replace(/,/g, "")) * sc, prev = Number(m[2].replace(/,/g, "")) * sc;
    if (cur !== fig.value || prev !== fig.prior) bad.push(fig.label.toLowerCase());
  });
  if (bad.length) warnings.push(`The report's summary tables and its data table disagree on ${listText(bad)}. Please check those figures against the report.`);
  const loc = tvLocation(String(list[0] || ""));
  const first = String(list[0] || "");
  const ptLines = tvHeaderValue(first, "PROPERTY TYPE", "Special Listing|PRICE / SQFT");
  const pt = (ptLines[0] || "").trim();
  const mls = MLS_SOURCES.find((n) => new RegExp(`\\b${n}\\b`, "i").test(all)) || null;
  const closed = (figures.find((f) => f.key === "count_closed") || {}).value;
  const small = closed != null && closed < SMALL_SAMPLE_BELOW;
  if (small) warnings.push(`Only ${closed} closed ${closed === 1 ? "sale" : "sales"} in ${mkLabel(last)}: a small sample. Topics will say so and will not claim a trend.`);
  if (!loc.cities.length && !loc.zips.length) warnings.push("I couldn't read the area this report covers. Check it before using it.");
  const facts = {
    version: FACTS_VERSION, kind: "pdf", layout: "market_trends", reportDate: null, mlsSource: mls,
    propertyTypes: /^[A-Za-z ,\/-]{3,40}$/.test(pt) ? [pt] : [], criteria: { closedSince: null },
    geography: { cities: loc.cities, zips: loc.zips, drawnOnMap: false },
    period: { label: mkLabel(last), start, end, priorLabel: mkLabel(months[N - 2]), yearAgoLabel: ago >= 0 ? mkLabel(months[ago]) : null, months: N },
    statuses: {}, figures,
    sample: { total: closed != null ? closed : 0, closed: closed != null ? closed : 0, small, broadWindow: false, windowDays: 29 },
    reportedTotal: null, checks: { checked, mismatched: bad.length }, warnings,
    notes: ["Only market-level figures were kept. The partial-month \"Today's Stats\" page was not used."],
  };
  return { facts };
}


// ── Trends data as a spreadsheet (the same measures as the TrendVision Data Table, exported as CSV or Excel) ────────────
// One row per measure ("Sold", "Pended", "Median Sold Price", ...) and one column per month ("25-Jul", "Jul-25", "7/25", "2025-07").
// There is no area or property type in such a file, so the agent's confirmation covers it. Prices are in $ thousands, as in the PDF.
function parseMonthCell(v) {
  const t = String(v == null ? "" : v).trim();
  let m = /^(\d{2})-([A-Za-z]{3})[a-z]*$/.exec(t);                 // 25-Jul
  if (m && monthIdx(m[2]) > 0) return { m: monthIdx(m[2]), y: 2000 + Number(m[1]) };
  m = /^([A-Za-z]{3})[a-z]*[-\s'](\d{2}|\d{4})$/.exec(t);          // Jul-25, Jul 2025
  if (m && monthIdx(m[1]) > 0) return { m: monthIdx(m[1]), y: m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]) };
  m = /^(\d{1,2})\/(\d{2}|\d{4})$/.exec(t);                        // 7/25
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return { m: Number(m[1]), y: m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]) };
  m = /^(20\d\d)-(\d{2})$/.exec(t);                                // 2025-07
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return { m: Number(m[2]), y: Number(m[1]) };
  return null;
}

/** analyzeTrendTable(grid, kind) → { facts } | { error } | null  (null = not this layout) */
function analyzeTrendTable(grid, kind) {
  const rows = Array.isArray(grid) ? grid : [];
  const norm = (c) => String(c == null ? "" : c).trim().toLowerCase();
  const byLabel = new Map(TV_ROWS.map((r) => [r.label.toLowerCase(), r]));
  const hit = rows.filter((r) => Array.isArray(r) && byLabel.has(norm(r[0]))).length;
  if (hit < 6) return null;
  const hdrIdx = rows.findIndex((r) => Array.isArray(r) && r.slice(1).filter((c) => parseMonthCell(c)).length >= 3);
  if (hdrIdx < 0) return null;
  const hdr = rows[hdrIdx];
  const cols = [];
  for (let i = 1; i < hdr.length; i++) { const mc = parseMonthCell(hdr[i]); if (mc) cols.push({ i, ...mc }); else if (String(hdr[i] == null ? "" : hdr[i]).trim()) return { error: "no_figures" }; }
  const N = cols.length;
  if (N < 2) return { error: "no_figures" };
  // The months must run one after another with no gaps, or "prior month" and "year ago" would point at the wrong column.
  for (let i = 1; i < N; i++) { const a = cols[i - 1], b = cols[i]; if (b.y * 12 + b.m !== a.y * 12 + a.m + 1) return { error: "no_figures" }; }
  const series = {};
  rows.slice(hdrIdx + 1).forEach((r) => {
    const def = Array.isArray(r) ? byLabel.get(norm(r[0])) : null;
    if (!def || series[def.key]) return;
    const nums = cols.map((c) => { const raw = String(r[c.i] == null ? "" : r[c.i]).replace(/[,%$\s]/g, ""); return /^-?\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : null; });
    if (nums.every((n) => n != null)) series[def.key] = nums;
  });
  const used = TV_ROWS.filter((r) => series[r.key]);
  if (used.length < 8) return { error: "no_figures" };
  const last = cols[N - 1];
  const mkLabel = (c) => `${MONTH_NAMES[c.m - 1]} ${c.y}`;
  const ago = cols.findIndex((c) => c.y === last.y - 1 && c.m === last.m);
  const start = isoDay(last.y, last.m, 1);
  const end = isoDay(last.y, last.m, new Date(Date.UTC(last.y, last.m, 0)).getUTCDate());
  const window = { start, end };
  const figures = used.map((r, i) => {
    const sc = r.scale || 1, ser = series[r.key];
    const f = { id: `f${i + 1}`, status: r.status, key: r.key, label: r.name, value: ser[N - 1] * sc, unit: r.unit, n: 0, small: false, reported: true, window, prior: ser[N - 2] * sc };
    if (ago >= 0) f.yearAgo = ser[ago] * sc;
    return f;
  });
  const closed = (figures.find((f) => f.key === "count_closed") || {}).value;
  const small = closed != null && closed < SMALL_SAMPLE_BELOW;
  const warnings = ["This file does not say which area or property type it covers. Confirm it matches the place you chose."];
  if (small) warnings.push(`Only ${closed} closed ${closed === 1 ? "sale" : "sales"} in ${mkLabel(last)}: a small sample. Topics will say so and will not claim a trend.`);
  const facts = {
    version: FACTS_VERSION, kind, layout: "market_trends", reportDate: null, mlsSource: null, propertyTypes: [], criteria: { closedSince: null },
    geography: { cities: [], zips: [], drawnOnMap: false },
    period: { label: mkLabel(last), start, end, priorLabel: mkLabel(cols[N - 2]), yearAgoLabel: ago >= 0 ? mkLabel(cols[ago]) : null, months: N },
    statuses: {}, figures,
    sample: { total: closed != null ? closed : 0, closed: closed != null ? closed : 0, small, broadWindow: false, windowDays: 29 },
    reportedTotal: null, checks: { checked: 0, mismatched: 0 }, warnings,
    notes: ["Only market-level figures were kept."],
  };
  return { facts };
}

// ── The emailed TrendVision report, printed to PDF from a mail client ────────────────────────────────────────────────
// Same publisher, different layout: a header (REGION / PROPERTY), three "market advantage" tiles, a written overview whose lines are cut
// off at the page edge by the printout (so it is NEVER read), "Today's Stats" tiles for the part-month so far (also never read), and one
// small table per chart: "Sep. 26 | Aug. 26 | % Change | Sep. 26 | Sep. 25 | % Change | quarter". Only those tables are the source, and every
// row is checked against its own percent changes before it is kept.
const TE_ROWS = [
  { re: "For Sale", key: "count_active", name: "Active listings", status: "active", unit: "count" },
  { re: "Pended", key: "count_pending", name: "Pended sales", status: "pending", unit: "count" },
  { re: "Sold", key: "count_closed", name: "Closed sales", status: "closed", unit: "count" },
  { re: "Months of Inventory \\(Closed\\)", key: "months_supply", name: "Months of inventory (closed-sales basis)", status: "market", unit: "months" },
  { re: "Avg Sold Price", key: "avg_close_price", name: "Average sold price", status: "closed", unit: "usd", scale: 1000 },
  { re: "Avg Active Price", key: "avg_list_price", name: "Average active price", status: "active", unit: "usd", scale: 1000 },
  { re: "Sold/List Price Diff %", key: "avg_close_to_list_pct", name: "Sold price as a percent of list price", status: "closed", unit: "pct" },
  { re: "Avg Days on Market", key: "avg_dom", name: "Average days on market", status: "market", unit: "days" },
];
const TE_N = "(-?\\d[\\d,]*(?:\\.\\d+)?)";
function teHeaderField(text, heading, next) {
  const m = new RegExp(`${heading}\\s*\\n([\\s\\S]*?)\\n\\s*(?:${next})`, "i").exec(text);
  return m ? m[1].split(/\n/).map((x) => x.trim()).filter(Boolean) : [];
}

/** analyzeTrendEmail(pages) → { facts } | { error } | null  (null = not this layout) */
function analyzeTrendEmail(pages) {
  const list = Array.isArray(pages) ? pages : [];
  const all = list.join("\n");
  if (!/TrendVision/i.test(all) || !/VS PREV MONTH/i.test(all) || !/R\s*E\s*G\s*I\s*O\s*N/.test(all) || /Data Table \(Part/i.test(all)) return null;
  const flat = all.replace(/[\u25B2\u25BC]/g, " ").replace(/\s+/g, " ");
  const hdr = new RegExp(`([A-Z][a-z]{2})\\. (\\d{2}) ([A-Z][a-z]{2})\\. (\\d{2}) % Change ([A-Z][a-z]{2})\\. (\\d{2}) ([A-Z][a-z]{2})\\. (\\d{2}) % Change`).exec(flat);
  if (!hdr) return { error: "no_figures" };
  const mo = (n, y) => ({ m: monthIdx(n), y: 2000 + Number(y) });
  const cur = mo(hdr[1], hdr[2]), prior = mo(hdr[3], hdr[4]), cur2 = mo(hdr[5], hdr[6]), ago = mo(hdr[7], hdr[8]);
  if (![cur, prior, cur2, ago].every((c) => c.m > 0) || cur.m !== cur2.m || cur.y !== cur2.y || ago.m !== cur.m || ago.y !== cur.y - 1 || prior.y * 12 + prior.m !== cur.y * 12 + cur.m - 1) return { error: "no_figures" };
  const num = (v) => Number(String(v).replace(/,/g, ""));
  const figures = [], bad = [];
  TE_ROWS.forEach((r) => {
    const m = new RegExp(`(?:^|\\s)${r.re.replace(/ /g, "\\s+")} ${TE_N} ${TE_N} ${TE_N}% ${TE_N} ${TE_N} ${TE_N}%`).exec(flat);
    if (!m) return;
    const [a, b, pc1, a2, y, pc2] = m.slice(1).map(num);
    // The table must agree with itself: the same current value twice, and each percent change matching its own two numbers.
    const near = (x, from, pct) => from !== 0 && Math.abs(((x - from) / Math.abs(from)) * 100 - pct) <= Math.max(0.15, Math.abs(pct) * 0.02) + (Math.abs(from) < 20 ? 3 : 0);
    if (a !== a2 || !near(a, b, pc1) || !near(a, y, pc2)) { bad.push(r.name.toLowerCase()); return; }
    const sc = r.scale || 1;
    figures.push({ r, value: a * sc, prior: b * sc, yearAgo: y * sc });
  });
  if (figures.length < 5) return { error: "no_figures" };
  const start = isoDay(cur.y, cur.m, 1), end = isoDay(cur.y, cur.m, new Date(Date.UTC(cur.y, cur.m, 0)).getUTCDate());
  const window = { start, end };
  const out = figures.map((f, i) => ({ id: `f${i + 1}`, status: f.r.status, key: f.r.key, label: f.r.name, value: f.value, unit: f.r.unit, n: 0, small: false, reported: true, window, prior: f.prior, yearAgo: f.yearAgo }));
  // The tiles at the top carry two measures the tables do not; they are read only when they sit next to their own labels.
  const tiles = /(\d+(?:\.\d+)?)% ABSORPTION RATE (\d+(?:\.\d+)?) SP \/ ORIG LP/.exec(flat);
  if (tiles) {
    const ab = Number(tiles[1]), sp = Number(tiles[2]);
    if (ab > 0 && ab <= 100 && !out.some((f) => f.key === "absorption_closed")) out.push({ id: `f${out.length + 1}`, status: "market", key: "absorption_closed", label: "Absorption rate (closed sales)", value: ab, unit: "pct", n: 0, small: false, reported: true, window });
    if (sp >= 50 && sp <= 150) out.push({ id: `f${out.length + 1}`, status: "closed", key: "avg_close_to_orig_list_pct", label: "Sold price as a percent of original list price", value: sp, unit: "pct", n: 0, small: false, reported: true, window });
  }
  const region = teHeaderField(all, "R\\s*E\\s*G\\s*I\\s*O\\s*N", "P\\s*R\\s*O\\s*P\\s*E\\s*R\\s*T\\s*Y").join(" ").replace(/\s+/g, " ").trim();
  const okRegion = region && region.length <= 90 && /^[A-Za-z0-9 ,.&'\/-]+$/.test(region);
  const zips = okRegion ? Array.from(new Set(region.match(/\b\d{5}\b/g) || [])) : [];
  const ptLine = (teHeaderField(all, "P\\s*R\\s*O\\s*P\\s*E\\s*R\\s*T\\s*Y", "R\\s*A\\s*N\\s*G\\s*E")[0] || "").trim();
  const closed = (out.find((f) => f.key === "count_closed") || {}).value;
  const small = closed != null && closed < SMALL_SAMPLE_BELOW;
  const warnings = [];
  if (bad.length) warnings.push(`I could not confirm ${listText(bad)} against the report's own percent changes, so ${bad.length === 1 ? "it was" : "they were"} left out.`);
  if (!okRegion) warnings.push("I couldn't read the area this report covers. Check it before using it.");
  if (small) warnings.push(`Only ${closed} closed ${closed === 1 ? "sale" : "sales"} in ${MONTH_NAMES[cur.m - 1]} ${cur.y}: a small sample. Topics will say so and will not claim a trend.`);
  const mls = MLS_SOURCES.find((n) => new RegExp(`\\b${n}\\b`, "i").test(all)) || null;
  const facts = {
    version: FACTS_VERSION, kind: "pdf", layout: "market_trends", reportDate: null, mlsSource: mls,
    propertyTypes: /^[A-Za-z ,\/-]{3,40}$/.test(ptLine) ? [ptLine] : [], criteria: { closedSince: null },
    geography: okRegion ? (zips.length ? { cities: [], zips: zips.slice(0, 8), drawnOnMap: false } : { cities: [region], zips: [], drawnOnMap: false }) : { cities: [], zips: [], drawnOnMap: false },
    period: { label: `${MONTH_NAMES[cur.m - 1]} ${cur.y}`, start, end, priorLabel: `${MONTH_NAMES[prior.m - 1]} ${prior.y}`, yearAgoLabel: `${MONTH_NAMES[ago.m - 1]} ${ago.y}`, months: 2 },
    statuses: {}, figures: out,
    sample: { total: closed != null ? closed : 0, closed: closed != null ? closed : 0, small, broadWindow: false, windowDays: 29 },
    reportedTotal: null, checks: { checked: figures.length, mismatched: bad.length }, warnings,
    notes: ["Only the report's own comparison tables were used. The written overview and the part-month \"Today's Stats\" were not."],
  };
  return { facts };
}

// ── Weekly dashboards (Domus Analytics "Weekly Infographic" and "Weekly Review", as MetroList members receive them) ──
// One page of tiles: a label, a big number, and (Review only) the percent change against two earlier weeks. The text inside the PDF comes
// out in no useful order, so these are read by POSITION: each number is paired with the label directly above it, and each percent with the
// row it sits in. Anything that cannot be paired cleanly is left out rather than guessed. The Pricing Insights tool (individual listings)
// and the Market Insights chart are not read.
const WEEKLY_TILES = [
  { label: "Median Sales Price", key: "median_close_price", name: "Median sold price", status: "closed", unit: "usd" },
  { label: "Closed Sales", key: "count_closed", name: "Closed sales", status: "closed", unit: "count" },
  { label: "Median Days on Market", key: "median_dom", name: "Median days on market", status: "market", unit: "days" },
  { label: "List Price Received", key: "avg_close_to_list_pct", name: "Sold price as a percent of list price", status: "closed", unit: "pct" },
  { label: "Median Sold $/SqFt", key: "median_ppsf", name: "Median sold price per square foot", status: "closed", unit: "usd_per_sqft" },
  { label: "New Listings", key: "count_new", name: "New listings", status: "active", unit: "count" },
  { label: "Active Inventory", key: "count_active", name: "Active listings", status: "active", unit: "count" },
  { label: "Weeks Supply of Inventory", key: "weeks_supply", name: "Weeks of inventory", status: "market", unit: "weeks" },
];
const FULL_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const monthIdx = (name) => { const k = String(name).toLowerCase().slice(0, 3); return ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(k) + 1; };
const addDays = (iso, n) => { const t = Date.parse(`${iso}T00:00:00Z`) + n * 86400000; return new Date(t).toISOString().slice(0, 10); };

function weeklyDate(text) {
  let m = /\b(20\d\d)\s+([A-Za-z]{3,9})\s+(\d{1,2})\b/.exec(text);
  if (m && monthIdx(m[2]) > 0) return isoDay(Number(m[1]), monthIdx(m[2]), Number(m[3]));
  m = /\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(20\d\d)\b/.exec(text);
  if (m && monthIdx(m[2]) > 0) return isoDay(Number(m[3]), monthIdx(m[2]), Number(m[1]));
  return null;
}

/** analyzeWeeklySnapshot(pages, items) → { facts } | { error } | null  (null = not this layout). `items` = [{ s, x, y }] for page 1, y measured from the top. */
function analyzeWeeklySnapshot(pages, items) {
  const text = (Array.isArray(pages) ? pages : []).join("\n");
  if (!/Domus Analytics/i.test(text)) return null;
  if (/Pricing Insights/i.test(text) && /Proposed List Price|Select(ed)? Listing/i.test(text)) return { error: "pricing_tool" };
  const isReview = /Weekly Review/i.test(text), isInfo = /Weekly Infographic/i.test(text);
  if (!isReview && !isInfo) return /Market Insights|Time Series/i.test(text) ? { error: "chart_only" } : null;
  const its = (Array.isArray(items) ? items : []).filter((i) => i && typeof i.s === "string" && Number.isFinite(i.x) && Number.isFinite(i.y)).map((i) => ({ ...i, s: i.s.trim() })).filter((i) => i.s);
  if (!its.length) return { error: "no_figures" };
  const NUMLIKE = /^\$?\d[\d,]*(?:\.\d+)?%?$/;
  const values = its.filter((i) => NUMLIKE.test(i.s));
  // Pair each label with the number below it (greedy, closest first, each number used once).
  const labels = WEEKLY_TILES.map((t) => ({ t, it: its.find((i) => i.s.toLowerCase() === t.label.toLowerCase()) })).filter((x) => x.it);
  const pairs = [];
  labels.forEach((l) => values.forEach((v) => { const dy = v.y - l.it.y; if (dy > 0 && dy < 220 && Math.abs(v.x - l.it.x) <= 110) pairs.push({ l, v, cost: dy + 1.5 * Math.abs(v.x - l.it.x) }); }));
  pairs.sort((a, b) => a.cost - b.cost);
  const usedL = new Set(), usedV = new Set(), got = new Map();
  pairs.forEach((p) => { if (usedL.has(p.l) || usedV.has(p.v)) return; usedL.add(p.l); usedV.add(p.v); got.set(p.l.t.key, { l: p.l, v: p.v }); });
  const fig = {};
  got.forEach(({ l, v }) => {
    const n = Number(v.s.replace(/[$,%]/g, "").replace(/,/g, ""));
    const t = l.t;
    const [lo, hi] = RANGE[t.unit === "weeks" ? "months" : t.unit] || [0, Infinity];
    if (!Number.isFinite(n) || !(n >= lo && n <= hi)) return;
    if (t.unit === "usd" && !v.s.startsWith("$")) return;
    if (t.unit === "pct" && !v.s.endsWith("%")) return;
    fig[t.key] = { t, value: n, y: v.y, ly: l.it.y, item: v };
  });
  // Percent changes (Review): the headers say which earlier week each column is; each percent belongs to the row it is level with.
  const heads = its.filter((i) => /^vs\s+Wk\s+ending/i.test(i.s)).map((h) => ({ x: h.x, iso: weeklyDate(h.s) })).filter((h) => h.iso);
  const rowFigs = Object.values(fig);
  if (isReview && heads.length) {
    const shown = new Set(rowFigs.map((r) => r.item));      // the big numbers themselves (one of them, "List Price Received", is a percent)
    its.filter((i) => /^[-+−]?\d+(?:\.\d+)?%$/.test(i.s) && !shown.has(i)).forEach((c) => {
      const row = rowFigs.map((r) => ({ r, d: Math.abs(c.y - (r.y + r.ly) / 2) })).sort((a, b) => a.d - b.d)[0];
      const col = heads.map((h) => ({ h, d: Math.abs(c.x - h.x) })).sort((a, b) => a.d - b.d)[0];
      if (!row || row.d > 30 || !col) return;
      const pct = Number(c.s.replace(/[%+]/g, "").replace("−", "-"));
      if (!Number.isFinite(pct) || Math.abs(pct) > 500) return;
      const f = row.r; f.changes = f.changes || [];
      if (!f.changes.some((x) => x.iso === col.h.iso)) f.changes.push({ pct, iso: col.h.iso });
    });
  }
  const need = isReview ? 6 : 4;
  if (Object.keys(fig).length < need) return { error: "no_figures" };
  // The report's own date: the first full date left once the "vs Wk ending …" comparison dates are removed.
  const end = weeklyDate(text.replace(/vs\s+Wk\s+ending\s+(?:\d{1,2}\s+[A-Za-z]{3,9}\s+20\d\d|[A-Za-z]{3,9}\s+\d{1,2},?\s+20\d\d|\d{1,2}\/\d{1,2}\/\d{2,4})/gi, " "));
  if (!end) return { error: "no_figures" };
  const updated = /updated\s+(\d{1,2})\/(\d{1,2})\/(\d{2})\b/.exec(text);
  const scope = its.map((i) => /^Includes\s+(.{3,80}?)\s+in\s+(.{3,80})$/.exec(i.s)).find(Boolean);
  const okText = (x) => /^[A-Za-z0-9 ,.&'\/-]+$/.test(x);
  const types = scope && okText(scope[1]) ? scope[1].replace(/^all\s+/i, "All ") : null;
  const placeRaw = scope && okText(scope[2]) ? scope[2].trim() : null;
  const place = placeRaw ? (/^all counties$/i.test(placeRaw) ? "All MetroList counties" : placeRaw) : null;
  const label = (iso) => longDate(iso);
  const figures = WEEKLY_TILES.filter((t) => fig[t.key]).map((t, i) => {
    const f = fig[t.key];
    const out = { id: `f${i + 1}`, status: t.status, key: t.key, label: t.name, value: f.value, unit: t.unit, n: 0, small: false, reported: true, window: { start: addDays(end, -6), end } };
    if (f.changes && f.changes.length) out.changes = f.changes.sort((a, b) => (a.iso < b.iso ? 1 : -1)).map((c) => ({ pct: c.pct, vs: `the week ending ${label(c.iso)}` }));
    return out;
  });
  const closed = (figures.find((f) => f.key === "count_closed") || {}).value;
  const warnings = ["This is one week of data. Weekly figures swing from week to week, so topics will describe the week and will not call it a trend."];
  if (!place) warnings.push("I couldn't read the area this report covers. Check it before using it.");
  const small = closed != null && closed < SMALL_SAMPLE_BELOW;
  if (small) warnings.push(`Only ${closed} closed ${closed === 1 ? "sale" : "sales"} this week: a small sample.`);
  const facts = {
    version: FACTS_VERSION, kind: "pdf", layout: "weekly_snapshot", reportDate: updated ? isoDay(2000 + Number(updated[3]), Number(updated[1]), Number(updated[2])) : null,
    mlsSource: /Data provided by MetroList/i.test(text) ? "MetroList" : null, propertyTypes: types ? [types] : [], criteria: { closedSince: null },
    geography: { cities: place ? [place] : [], zips: [], drawnOnMap: false },
    period: { label: `the week ending ${label(end)}`, start: addDays(end, -6), end, weekly: true },
    statuses: {}, figures,
    sample: { total: closed != null ? closed : 0, closed: closed != null ? closed : 0, small, broadWindow: false, windowDays: 6, weekly: true }, reportedTotal: null,
    warnings, notes: ["Only the dashboard's figures were kept."],
  };
  return { facts };
}

/** analyzePages(pages, { items }) → { facts } | { error }  for PDF text. `items` = positioned text of page 1 (weekly dashboards only). */
function analyzePages(pages, opts) {
  const list = Array.isArray(pages) ? pages : [String(pages || "")];
  const text = list.join("\n");
  if (text.replace(/\s+/g, "").length < 150) return { error: "no_text" };
  const trend = analyzeTrendReport(list);
  if (trend) return trend;
  const trendEmail = analyzeTrendEmail(list);
  if (trendEmail) return trendEmail;
  const weekly = analyzeWeeklySnapshot(list, opts && opts.items);
  if (weekly) return weekly;
  const meta = cmaMeta(text);
  const cma = analyzeCmaPages(list);
  if (cma) return buildFacts({ kind: "pdf", records: cma.records, reported: cma.reported, reportedTotal: cma.reportedTotal, meta, layout: cma.layout, window: opts && opts.window });
  const metrics = extractLabeledMetrics(text.split(/\r?\n/));
  if (!metrics.length) return { error: "no_figures" };
  const built = buildFacts({ kind: "pdf", records: [], metrics, meta, layout: "labeled_metrics" });
  // The MetroList disclosure printed on these reports names the period ("...based on data available at the end of September 2026").
  const dp = disclosurePeriod(text);
  if (built.facts && dp && !built.facts.period) built.facts.period = dp;
  return built;
}

/**
 * The report period from MetroList's printed disclosure, e.g. "All reports are published October 2026, based on data available at the end of
 * September 2026" -> September 2026 (first to last day of that month). Null when the sentence is not there.
 */
function disclosurePeriod(text) {
  const m = /based on data available at the end of ([A-Za-z]{3,9})\.?,?\s+(\d{4})/i.exec(String(text || "").replace(/\s+/g, " "));
  if (!m) return null;
  const mi = MONTH_NAMES.findIndex((n) => n.slice(0, 3).toLowerCase() === m[1].slice(0, 3).toLowerCase());
  const y = Number(m[2]);
  if (mi < 0 || y < 2000 || y > 2100) return null;
  const last = new Date(Date.UTC(y, mi + 1, 0)).getUTCDate();
  const p2 = (n) => String(n).padStart(2, "0");
  return { label: `${MONTH_NAMES[mi]} ${y}`, start: `${y}-${p2(mi + 1)}-01`, end: `${y}-${p2(mi + 1)}-${p2(last)}`, monthly: true, fromDisclosure: true };
}

const ERROR_MESSAGES = {
  no_window_rows: "No listings in this file fall inside those dates. Choose a longer window or a report that covers them.",
  no_text: "This PDF has no readable text. It may be a scan or a photo. Download the report as a text PDF, CSV or Excel file from your MLS and try again.",
  no_figures: "I couldn't find market figures in this file. A report with listing prices, closed prices or days on market works best.",
  no_header: "I couldn't find a header row with price or status columns in this file.",
  too_large: "This report has more detail than I can use. Try one property type or a shorter date range.",
  xls: "Old .xls files can't be read here. Save it as .xlsx or CSV from Excel and upload that.",
  unsupported: "Upload a PDF, CSV or Excel (.xlsx) file.",
  pricing_tool: "This is the Pricing Insights tool, which shows individual listings, so it can't be used. Upload your MetroList Weekly Review or Weekly Infographic, a TrendVision market report, or a CMA instead.",
  chart_only: "This is a chart, not a table of figures, so I can't read numbers from it. Upload your MetroList Weekly Review or Weekly Infographic, a TrendVision market report, or a CMA instead.",
  empty: "That file is empty.",
  unreadable: "I couldn't open that file. Check that it isn't password protected, then try again.",
};
const errorMessage = (code) => ERROR_MESSAGES[code] || ERROR_MESSAGES.unreadable;

/**
 * summarize(facts, { geography }) → what the confirmation screen shows. Derived on every read, never stored, so wording can improve.
 */
/**
 * attributionNotice(facts) → the line MetroList Rule 12.9 requires on advertising that uses its statistics, or null when this is not a
 * MetroList report or the report states no period. Rule 12.9: "Based on information from MetroList Services, Inc. for the period (date)
 * through (date)." The period is the month a trends report covers, or the closed-sales window of a CMA.
 */
function attributionNotice(facts) {
  const f = facts || {};
  if (f.mlsSource !== "MetroList") return null;
  const w = f.period ? { start: f.period.start, end: f.period.end } : f.statuses && f.statuses.closed && f.statuses.closed.dateRange;
  if (!w || !w.start || !w.end) return null;
  return `Based on information from MetroList Services, Inc. for the period ${shortDate(w.start, true)} through ${shortDate(w.end, true)}.`;
}

function summarize(facts, opts) {
  const f = facts || {};
  const geo = geographyCheck(f, opts && opts.geography);
  return {
    scopeSentence: scopeSentence(f), scopeNote: scopeNote(f), notice: attributionNotice(f), groups: displayFigures(f),
    warnings: [...(f.warnings || []), ...(geo.message ? [geo.message] : []), ...(f.mlsSource === "MetroList" && !attributionNotice(f) ? ["I couldn't find the dates this report covers, and a MetroList Reel needs them for its required notice. Use a report that prints its dates, or the Reel will stop at the last step."] : [])], geography: geo.status, notes: f.notes || [],
    sample: f.sample || null, layout: f.layout, reportDate: f.reportDate || null, window: f.window || null,
  };
}

module.exports = {
  validateWindow, WINDOW_PRESETS, FEEDBACK_REASONS, cleanFeedback, feedbackContext,
  FACTS_VERSION, PERMISSION_VERSION, PERMISSION_TEXT, SMALL_SAMPLE_BELOW, BROAD_WINDOW_DAYS, MAX_RECORDS, STATUS_ORDER, STATUS_PLURAL,
  normStatus, parseMoney, parseDom, parseDate, parseSqft, median, mean, statsFromRecords, formatFigure, scopeSentence, scopeNote, displayFigures,
  verifiedFromReport, attributionNotice, disclosurePeriod, analyzeTrendReport, analyzeTrendEmail, analyzeTrendTable, analyzeWeeklySnapshot, compareText, windowText, geographyCheck, recordsFromRows, extractLabeledMetrics, analyzeCmaPages, cmaMeta, buildFacts, analyzeRows, analyzePages,
  errorMessage, summarize,
};
