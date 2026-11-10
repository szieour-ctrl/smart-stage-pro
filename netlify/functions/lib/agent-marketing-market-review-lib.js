// lib/agent-marketing-market-review-lib.js — Netlify (shared, pure functions; no network, no database, no file access)
// Phase 1 of the format-independent Market Review reader (Nov 10, 2026): the Domus Analytics "Market Review" dashboards, all five
// periods (week, month, quarter, year to date, year), read DETERMINISTICALLY from positioned text. No model, no paid call.
//
// WHAT THIS ENFORCES (SSP Stage B, Market Update Intake handoff):
//  - Every figure keeps the tokens it was read from; a figure that cannot be paired, parsed or range-checked is reported as UNREAD, never guessed.
//  - Each comparison keeps its exact printed label ("vs Q3 2023"). Its kind is derived from that label and the report's own period, nothing else.
//  - Period coverage comes from the report (comparison labels, header, data date), never from a title alone. A year still in progress is partial.
//  - Measures a report type does not print (Active Inventory / Months Supply on quarterly, YTD, yearly) are "not printed", not "missing".
//  - The header's geography ("Includes all Property Types in all Counties") is stored verbatim as DISPLAYED geography and never becomes the
//    report's geography. The subscriber's confirmed scope is an attestation about the report's filters, never presented as verified.
//  - Percent changes are as printed; "List price received" changes are percents, not percentage points. Nothing is recomputed to replace a print.
//
// Inputs are plain data: `pages` (array of page text) and `items` = [{ s, x, y }] positioned text of page 1 (y from the top), exactly what
// agent-marketing-report-read-lib.js readPdf() returns for a Domus dashboard.
"use strict";

const lib = require("./agent-marketing-report-lib");

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthIdx = (name) => { const k = String(name).toLowerCase().slice(0, 3); return ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(k) + 1; };
const MONTH_RE = "(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\.?";
const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dayNum = (s) => Math.floor(Date.parse(`${s}T00:00:00Z`) / 86400000);
const addDays = (s, n) => new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const validIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

// ── The measures ───────────────────────────────────────────────────────────────────────────────────────────────────
// `kinds` = the report types that print the measure. A measure outside its kinds is "not printed" there, by design.
const ALL = ["week", "month", "quarter", "ytd", "year"];
const TILES = [
  { labels: ["Median Sales Price"], key: "median_close_price", name: "Median sold price", status: "closed", unit: "usd", kinds: ALL },
  { labels: ["Closed Sales"], key: "count_closed", name: "Closed sales", status: "closed", unit: "count", kinds: ALL },
  { labels: ["Median Days on Market"], key: "median_dom", name: "Median days on market", status: "market", unit: "days", kinds: ALL },
  { labels: ["List Price Received"], key: "avg_close_to_list_pct", name: "Sold price as a percent of list price", status: "closed", unit: "pct", kinds: ALL },
  { labels: ["Median Sold $/SqFt", "Median Sold $/Sq Ft"], key: "median_ppsf", name: "Median sold price per square foot", status: "closed", unit: "usd_per_sqft", kinds: ALL },
  { labels: ["New Listings"], key: "count_new", name: "New listings", status: "active", unit: "count", kinds: ALL },
  { labels: ["Active Inventory"], key: "count_active", name: "Active listings", status: "active", unit: "count", kinds: ["week", "month"] },
  { labels: ["Months Supply of Inventory", "Months of Inventory"], key: "months_supply", name: "Months of inventory", status: "market", unit: "months", kinds: ["month"] },
  { labels: ["Weeks Supply of Inventory"], key: "weeks_supply", name: "Weeks of inventory", status: "market", unit: "weeks", kinds: ["week"] },
];
const RANGE = { usd: [20000, 60000000], count: [0, 100000], days: [0, 3000], pct: [50, 150], usd_per_sqft: [20, 5000], months: [0, 60], weeks: [0, 520] };
const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]/g, "");
const NUMLIKE = /^\$?\d[\d,]*(?:\.\d+)?%?$/;
const CHANGE = /^[+\-−–]?\d+(?:\.\d+)?%$/;
const parseChange = (s) => { const n = Number(String(s).replace(/[%+]/g, "").replace(/[−–]/, "-")); return Number.isFinite(n) ? n : null; };
const parseValue = (s) => { const n = Number(String(s).replace(/[$,%]/g, "").replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
// A printed token must have the shape its unit needs: dollars with "$", percents with "%", counts as plain integers.
function tokenFits(unit, s) {
  if (!NUMLIKE.test(s)) return false;
  if (unit === "usd" || unit === "usd_per_sqft") return s.startsWith("$") && !s.includes("%");
  if (unit === "pct") return s.endsWith("%") && !s.startsWith("$");
  if (unit === "count") return /^\d[\d,]*$/.test(s);
  return !s.startsWith("$") && !s.endsWith("%");
}
function inRange(unit, n) { const r = RANGE[unit] || [0, Infinity]; return Number.isFinite(n) && n >= r[0] && n <= r[1]; }

// ── Comparison labels: kept as printed, classified only from the label and the report's own period ────────────────────
/** parseBasis("vs Q3 2023") → { type, ...parts } or null. The label text itself is never altered. */
function parseBasis(printed) {
  const t = String(printed || "").replace(/^vs\.?\s+/i, "").replace(/\s+/g, " ").trim();
  let m;
  if ((m = new RegExp(`^(?:Wk|Week)\\s+ending\\s+(\\d{1,2})\\s+${MONTH_RE}\\s+(20\\d\\d)$`, "i").exec(t))) { const mo = monthIdx(m[2]); return mo ? { type: "week", end: iso(Number(m[3]), mo, Number(m[1])) } : null; }
  if ((m = new RegExp(`^(?:Wk|Week)\\s+ending\\s+${MONTH_RE}\\s+(\\d{1,2}),?\\s+(20\\d\\d)$`, "i").exec(t))) { const mo = monthIdx(m[1]); return mo ? { type: "week", end: iso(Number(m[3]), mo, Number(m[2])) } : null; }
  if ((m = /^(?:Yr|Year)\s+ending\s+(20\d\d)$/i.exec(t))) return { type: "year", year: Number(m[1]) };
  if ((m = /^YTD\s+(20\d\d)$/i.exec(t)) || (m = /^(20\d\d)\s+YTD$/i.exec(t))) return { type: "ytd", year: Number(m[1]) };
  if ((m = /^Q([1-4])\s*(20\d\d)$/i.exec(t))) return { type: "quarter", q: Number(m[1]), year: Number(m[2]) };
  if ((m = new RegExp(`^${MONTH_RE}\\s+(20\\d\\d)$`, "i").exec(t))) { const mo = monthIdx(m[1]); return mo ? { type: "month", month: mo, year: Number(m[2]) } : null; }
  return null;
}
const sortKey = (b) => !b ? 0 : b.type === "week" ? dayNum(b.end) : b.type === "month" ? b.year * 12 + b.month : b.type === "quarter" ? b.year * 4 + b.q : b.year;

/** compareKind(period, basis) → "prior_period" | "same_period_last_year" | "full_prior_year" | "earlier_period" | "unknown". Only from the label and the period. */
function compareKind(period, basis) {
  if (!basis || !period || basis.type !== period.kind) return "unknown";
  if (period.kind === "week") { const d = dayNum(period.end) - dayNum(basis.end); return d === 7 ? "prior_period" : d === 364 || d === 371 ? "same_period_last_year" : d > 0 ? "earlier_period" : "unknown"; }
  if (period.kind === "month") { const cur = period.year * 12 + period.month, was = basis.year * 12 + basis.month; return was === cur - 1 ? "prior_period" : was === cur - 12 ? "same_period_last_year" : was < cur ? "earlier_period" : "unknown"; }
  if (period.kind === "quarter") { const cur = period.year * 4 + period.q, was = basis.year * 4 + basis.q; return was === cur - 1 ? "prior_period" : was === cur - 4 ? "same_period_last_year" : was < cur ? "earlier_period" : "unknown"; }
  if (period.kind === "ytd") return basis.year === period.year - 1 ? "same_period_last_year" : basis.year < period.year ? "earlier_period" : "unknown";
  if (period.kind === "year") return basis.year === period.year - 1 ? "full_prior_year" : basis.year < period.year ? "earlier_period" : "unknown";
  return "unknown";
}

// ── Period: established from the report ──────────────────────────────────────────────────────────────────────────────
const dateFromText = (text) => {
  let m = new RegExp(`\\b(\\d{1,2})\\s+${MONTH_RE}\\s+(20\\d\\d)\\b`, "i").exec(text);
  if (m && monthIdx(m[2])) return iso(Number(m[3]), monthIdx(m[2]), Number(m[1]));
  m = new RegExp(`\\b(20\\d\\d)\\s+${MONTH_RE}\\s+(\\d{1,2})\\b`, "i").exec(text);
  if (m && monthIdx(m[2])) return iso(Number(m[1]), monthIdx(m[2]), Number(m[3]));
  m = new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2}),?\\s+(20\\d\\d)\\b`, "i").exec(text);
  if (m && monthIdx(m[1])) return iso(Number(m[3]), monthIdx(m[1]), Number(m[2]));
  return null;
};
function updatedDate(text) {
  const m = /updated\s+(\d{1,2})\/(\d{1,2})\/(\d{2})\b/.exec(text);
  if (!m) return null;
  const d = iso(2000 + Number(m[3]), Number(m[1]), Number(m[2]));
  return validIso(d) ? d : null;
}
function periodLabel(p) {
  if (p.kind === "week") { const [y, m, d] = p.end.split("-").map(Number); return `the week ending ${MONTHS[m - 1]} ${d}, ${y}`; }
  if (p.kind === "month") return `${MONTHS[p.month - 1]} ${p.year}`;
  if (p.kind === "quarter") return `Q${p.q} ${p.year}`;
  if (p.kind === "ytd") return p.end ? `year to date through ${MONTHS[Number(p.end.slice(5, 7)) - 1]} ${p.year}` : `${p.year} year to date`;
  if (p.partial !== false && p.coverageThrough) { const [y, m, d] = p.coverageThrough.split("-").map(Number); return `${p.year} Year to Date (through ${MONTHS[m - 1]} ${d}, ${y})`; }
  return p.partial ? `${p.year} \u2014 Partial Year` : `${p.year}`;
}
/**
 * detectPeriod(headerTexts, basisKinds, updated) → { period } | { error }.
 * The comparison labels (printed beside every figure) decide the report type; the header supplies the period itself. Disagreement is reported.
 */
function detectPeriod(header, bases, updated) {
  const head = header.join(" ");
  const fromBases = [...new Set(bases.map((b) => b && b.type).filter(Boolean))];
  const hasYtd = /\bYTD\b|year[\s-]*to[\s-]*date/i.test(head);
  // "Q3 2026", "2026 Q3", or the real layout: "Q3" and the quarter's last month, "Sep 2026", as separate header items.
  const mQ = (() => {
    let m = /\bQ([1-4])\s*(20\d\d)\b/i.exec(head) || (() => { const x = /\b(20\d\d)\s*Q([1-4])\b/i.exec(head); return x ? [x[0], x[2], x[1]] : null; })();
    if (m) return m;
    m = /\bQ([1-4])\b/i.exec(head);
    const my = new RegExp(`\\b${MONTH_RE}\\s+(20\\d\\d)\\b`, "i").exec(head);
    if (!m || !my) return null;
    return monthIdx(my[1]) === Number(m[1]) * 3 ? [m[0], m[1], my[2]] : { mismatch: true };
  })();
  const mMonth = new RegExp(`\\b${MONTH_RE}\\s+(20\\d\\d)\\b`, "i").exec(head.replace(/\b\d{1,2}\s+[A-Za-z]{3,9}\s+20\d\d\b/g, " "));
  const wkDate = dateFromText(head);
  const mYear = header.map((h) => /^\s*(20\d\d)\s*$/.exec(h)).find(Boolean);
  const hasWeekWord = /weekly/i.test(head);
  if (mQ && mQ.mismatch) return { error: "period_conflict", detail: "the header's quarter and month do not agree" };
  const titleKinds = [];
  if (hasYtd) titleKinds.push("ytd");
  else if (mQ) titleKinds.push("quarter");
  else if (/weekly/i.test(head) || (wkDate && fromBases.includes("week"))) titleKinds.push("week");
  else if (mMonth && !/\bthrough\b/i.test(head)) titleKinds.push("month");
  else if (mYear) titleKinds.push("year");
  const kinds = fromBases.length ? fromBases : titleKinds;
  if (!kinds.length) return { error: "period_unreadable" };
  if (fromBases.length > 1) return { error: "period_conflict", detail: `comparison labels mix report types: ${fromBases.join(", ")}` };
  if (fromBases.length && titleKinds.length && fromBases[0] !== titleKinds[0] && !(fromBases[0] === "ytd" && titleKinds[0] === "month"))
    return { error: "period_conflict", detail: `the comparison labels say ${fromBases[0]} but the header says ${titleKinds[0]}` };
  const kind = kinds[0];
  const p = { kind, start: null, end: null, partial: false };
  if (kind === "week") {
    const wd = dateFromText(head);
    if (!wd) return { error: "period_unreadable" };
    p.end = wd; p.start = addDays(wd, -6);
  } else if (kind === "month") {
    const m = mMonth || new RegExp(`${MONTH_RE}\\s+(20\\d\\d)`, "i").exec(head);
    if (!m) return { error: "period_unreadable" };
    p.month = monthIdx(m[1]); p.year = Number(m[2]); p.start = iso(p.year, p.month, 1); p.end = iso(p.year, p.month, lastDay(p.year, p.month));
  } else if (kind === "quarter") {
    if (!mQ) return { error: "period_unreadable" };
    p.q = Number(mQ[1]); p.year = Number(mQ[2]);
    p.start = iso(p.year, (p.q - 1) * 3 + 1, 1); p.end = iso(p.year, p.q * 3, lastDay(p.year, p.q * 3));
  } else if (kind === "ytd") {
    const y = mMonth ? Number(mMonth[2]) : (/\b(20\d\d)\b/.exec(head) || [])[1] && Number(/\b(20\d\d)\b/.exec(head)[1]);
    if (!y) return { error: "period_unreadable" };
    p.year = y; p.start = iso(y, 1, 1);
    // The through-month is used only when the report prints one; otherwise it stays unknown and the coverage report says so.
    if (mMonth && monthIdx(mMonth[1])) p.end = iso(y, monthIdx(mMonth[1]), lastDay(y, monthIdx(mMonth[1])));
    p.partial = true;
  } else {
    const y = mYear ? Number(mYear[1]) : (/\b(20\d\d)\b/.exec(head) || [])[1] && Number(/\b(20\d\d)\b/.exec(head)[1]);
    if (!y) return { error: "period_unreadable" };
    p.year = y; p.start = iso(y, 1, 1); p.end = iso(y, 12, 31);
    // A year is complete only if the data was last updated after it ended. The title "2026" alone never says so.
    // The footer's "updated" date is when the data was refreshed, NOT proof of the last day it covers. A "through" date is used only when the caller has verified it.
    if (updated) p.partial = updated < p.end; else p.partial = null;
    if (p.partial !== false) p.end = null;      // never claim December 31 for a year still in progress or one whose completeness is unknown
  }
  p.label = periodLabel(p);
  return { period: p };
}

// ── Geography ──────────────────────────────────────────────────────────────────────────────────────────────────────
const keyOf = (s) => String(s || "").toLowerCase().replace(/[.,]/g, " ").replace(/\b(?:county|city of|city|ca|california)\b/g, " ").replace(/\s+/g, " ").trim();
const SAFE = /^[A-Za-z0-9 ,.&'\/-]+$/;

/** parseHeaderScope(text) → what the header says, verbatim, classified but never expanded. */
function parseHeaderScope(items) {
  const hit = (items || []).map((i) => /^Includes\s+(.{3,100}?)\s+in\s+(.{2,200})$/i.exec(String(i.s || "").trim())).find(Boolean);
  if (!hit) return { raw: null, kind: "absent", places: [], propertyTypesRaw: null };
  const raw = hit[0], typesRaw = SAFE.test(hit[1]) ? hit[1] : null, placeRaw = hit[2].trim();
  const out = { raw, propertyTypesRaw: typesRaw, placeRaw, places: [], count: null, moreCount: null, kind: "places" };
  if (/^all\s+counties$/i.test(placeRaw)) { out.kind = "all_counties"; out.unreliable = true; return out; }
  let m = /^(\d+)\s+(?:cities|city|areas|zip\s*codes|zips)$/i.exec(placeRaw);
  if (m) { out.kind = "count"; out.count = Number(m[1]); return out; }            // "4 cities": never expanded into names
  const more = /(?:,|\band\b|\+)\s*(\d+)\s+more\b/i.exec(placeRaw);
  let body = placeRaw;
  if (more) { out.moreCount = Number(more[1]); body = placeRaw.slice(0, more.index); }
  if (!SAFE.test(body)) { out.kind = "unreadable"; return out; }
  out.places = body.split(/\s*(?:,|&|\band\b)\s*/i).map((s) => s.trim()).filter(Boolean).map((s) => ({ raw: s, ...lib.classifyPlace(s) })).filter((p) => p.city || p.county || p.zip);
  if (!out.places.length) out.kind = "unreadable";
  return out;
}

/** confirmScope(selection) → { ok, confirmed } | { ok:false, question }. The subscriber's attestation, captured before the report is read. */
function confirmScope(sel) {
  const s = sel || {};
  const names = (Array.isArray(s.names) ? s.names : [s.name]).map((n) => String(n == null ? "" : n).replace(/\s+/g, " ").trim()).filter(Boolean);
  const bad = names.find((n) => n.length > 80 || !SAFE.test(n));
  if (bad) return { ok: false, question: "One of those area names has characters I can't use. Which cities, county or ZIP codes does the report cover?" };
  const type = s.type;
  const ask = (q) => ({ ok: false, question: q });
  let confirmed;
  if (type === "city") {
    if (names.length !== 1) return ask("Which city does this report cover?");
    confirmed = { type: "city", names: [names[0].replace(/,\s*(?:CA|California)$/i, "")] };
  } else if (type === "cities") {
    const uniq = [...new Set(names.map((n) => n.replace(/,\s*(?:CA|California)$/i, "")))];
    if (uniq.length < 2) return ask("Which cities does this report cover? Please list each one.");
    confirmed = { type: "cities", names: uniq };
  } else if (type === "county") {
    if (names.length !== 1) return ask("Which county does this report cover?");
    confirmed = { type: "county", names: [`${names[0].replace(/\s*county\s*$/i, "").trim()} County`] };
  } else if (type === "zips") {
    const zips = [...new Set(names.map((n) => n.replace(/^ZIP\s*(?:code\s*)?/i, "").trim()))];
    if (!zips.length || zips.some((z) => !/^9\d{4}$/.test(z))) return ask("Which ZIP codes does this report cover? Please give each as five digits.");
    confirmed = { type: "zips", names: zips };
  } else if (type === "custom") {
    if (!names.length) return ask("How would you describe the area this report covers?");
    confirmed = { type: "custom", names: [names.join(", ")] };
  } else return ask("What area does this report cover: one city, several cities, a county, or ZIP codes?");
  confirmed.attestedBySubscriber = true;                   // an attestation about the report's filters, never verified from the PDF
  confirmed.areasIncluded = listText(confirmed.names);
  return { ok: true, confirmed };
}
const listText = (a) => a.length <= 1 ? a.join("") : a.length === 2 ? `${a[0]} and ${a[1]}` : `${a.slice(0, -1).join(", ")}, and ${a[a.length - 1]}`;

/** reconcileGeography(displayed, confirmed) → { status, conflicts[], note }. Three sources are compared, never merged. */
function reconcileGeography(displayed, confirmed) {
  const conflicts = [];
  if (!confirmed) return { status: "needs_scope", conflicts, note: "Ask which area this report covers; the header cannot be used for that." };
  const d = displayed || { kind: "absent", places: [] };
  const cn = confirmed.names.map(keyOf);
  if (d.kind === "count" && confirmed.type === "cities" && d.count !== confirmed.names.length)
    conflicts.push({ kind: "count", message: `The report header says ${d.count} cities; you listed ${confirmed.names.length}.` });
  (d.places || []).forEach((p) => {
    if (p.city) {
      if (confirmed.type === "city" || confirmed.type === "cities") { if (!cn.includes(keyOf(p.city))) conflicts.push({ kind: "city", header: p.city, message: `The report header names ${p.city}, which is not among the cities you selected.` }); }
      else if (confirmed.type === "county") conflicts.push({ kind: "city", header: p.city, message: `The report header names ${p.city}, but you selected ${confirmed.names[0]}.` });
    } else if (p.county) {
      if (confirmed.type === "county" && keyOf(p.county) !== cn[0]) conflicts.push({ kind: "county", header: p.county, message: `The report header names ${p.county}, but you selected ${confirmed.names[0]}.` });
      // a county beside selected cities only locates them: not a mismatch
    } else if (p.zip) {
      if (confirmed.type === "zips" && !confirmed.names.includes(p.zip)) conflicts.push({ kind: "zip", header: p.zip, message: `The report header names ZIP ${p.zip}, which is not among the ZIP codes you selected.` });
    }
  });
  return { status: conflicts.length ? "conflict" : "ok", conflicts, note: d.unreliable ? "The report header says all counties on every export; it was not used to decide the area." : null };
}

/** confirmPropertyTypes(list) → { ok, confirmed } | { ok:false, question }. The subscriber's attestation, like the area. */
function confirmPropertyTypes(list) {
  const names = (Array.isArray(list) ? list : [list]).map((n) => String(n == null ? "" : n).replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!names.length || names.some((n) => n.length > 60 || !SAFE.test(n))) return { ok: false, question: "Which property types does this report cover?" };
  return { ok: true, confirmed: { names: [...new Set(names)], attestedBySubscriber: true } };
}
/** The header's property types are shown as printed; where the report's filters cannot be reliably established (always, for these exports), the subscriber is asked to confirm. */
function propertyTypeBlock(displayed, confirmed) {
  const shown = displayed.propertyTypesRaw ? displayed.propertyTypesRaw.replace(/^all\s+/i, "All ") : null;
  const out = { displayed: shown, confirmed: confirmed || null, conflicts: [] };
  if (confirmed) {
    const named = shown && !/^all\b/i.test(shown) ? shown.split(/\s*(?:,|&|\band\b)\s*/i).map((x) => x.trim().toLowerCase()) : [];
    named.filter((x) => x && !confirmed.names.some((c) => c.toLowerCase() === x)).forEach((x) => out.conflicts.push({ kind: "property_type", header: x, message: `The report header names ${x}, which is not among the property types you selected.` }));
    out.status = out.conflicts.length ? "conflict" : "ok";
  } else out.status = "needs_confirmation";
  out.reason = !shown ? "header_missing" : /^all\b/i.test(shown) ? "header_says_all_types_on_every_export" : "header_not_proof_of_filter";
  return out;
}

function geographyBlock(headerScope, confirmed) {
  const rec = reconcileGeography(headerScope, confirmed);
  const g = { cities: [], zips: [], counties: [], drawnOnMap: false, displayed: headerScope, confirmed: confirmed || null, conflicts: rec.conflicts, status: rec.status, source: confirmed ? "subscriber" : "none" };
  if (confirmed) {
    if (confirmed.type === "city" || confirmed.type === "cities") g.cities = confirmed.names.slice();
    else if (confirmed.type === "county") g.counties = confirmed.names.slice();
    else if (confirmed.type === "zips") g.zips = confirmed.names.slice();
    g.combined = confirmed.type === "cities" || (confirmed.type === "zips" && confirmed.names.length > 1);   // the statistics describe the combined market, never each place
  }
  return g;
}

// ── Reading the dashboard by position ────────────────────────────────────────────────────────────────────────────────
const cleanItems = (items) => (Array.isArray(items) ? items : []).filter((i) => i && typeof i.s === "string" && Number.isFinite(i.x) && Number.isFinite(i.y)).map((i) => ({ ...i, s: i.s.trim() })).filter((i) => i.s);

/** True when the text looks like a Domus Market Review: Domus dashboard with at least one "vs …" comparison header over the tiles. */
function isMarketReview(pages, items) {
  const text = (Array.isArray(pages) ? pages : []).join("\n");
  if (!/Domus Analytics/i.test(text) || /Pricing Insights/i.test(text)) return false;
  const its = cleanItems(items);
  const hasTile = its.some((i) => TILES.some((t) => t.labels.some((l) => norm(l) === norm(i.s))));
  return hasTile && its.some((i) => /^vs\.?\s+\S/i.test(i.s));
}

const footerYOf = (its) => { const f = its.find((i) => /^Data provided by/i.test(i.s)); return f ? f.y - 5 : Infinity; };
const NOTE_RE = /\bonly applies? (?:for|to)\b.*\b(?:monthly|weekly)\b/i;
function readTiles(its) {
  const footer = its.find((i) => /^Data provided by/i.test(i.s));
  const footerY = footer ? footer.y - 5 : Infinity;                      // the footer's year and date are never figures
  const values = its.filter((i) => NUMLIKE.test(i.s) && i.y < footerY);
  const notes = its.filter((i) => NOTE_RE.test(i.s));
  const found = [];
  TILES.forEach((t) => {
    const lab = its.find((i) => t.labels.some((l) => norm(l) === norm(i.s)));
    if (lab) found.push({ t, lab });
  });
  // A measure the report itself says "only applies for monthly and weekly" is NOT PRINTED here: its note sits right beside its label.
  const noted = new Map();
  found.forEach((f) => { const n = notes.find((x) => x.y >= f.lab.y - 5 && x.y - f.lab.y < 45); if (n) noted.set(f.t.key, n.s); });
  const live = found.filter((f) => !noted.has(f.t.key));
  // A value must lie between its label and the next label below it in the same column.
  const below = (f) => Math.min(Infinity, ...found.filter((o) => o !== f && o.lab.y > f.lab.y && Math.abs(o.lab.x - f.lab.x) <= 110).map((o) => o.lab.y));
  const pairs = [];
  live.forEach((f) => { const lim = below(f); values.forEach((v) => { const dy = v.y - f.lab.y; if (dy > 0 && dy < 220 && v.y < lim && Math.abs(v.x - f.lab.x) <= 110) pairs.push({ f, v, cost: dy + 1.5 * Math.abs(v.x - f.lab.x) }); }); });
  pairs.sort((a, b) => a.cost - b.cost);
  const usedL = new Set(), usedV = new Set(), tiles = [], rejected = [];
  pairs.forEach((p) => {
    if (usedL.has(p.f) || usedV.has(p.v)) return;
    const n = parseValue(p.v.s);
    // Validate FIRST: a nearby token with the wrong form or range is skipped and consumes neither the label nor the token.
    if (!tokenFits(p.f.t.unit, p.v.s) || !inRange(p.f.t.unit, n)) { rejected.push({ key: p.f.t.key, token: p.v.s, reason: "value_outside_expected_form_or_range" }); return; }
    usedL.add(p.f); usedV.add(p.v);
    tiles.push({ t: p.f.t, lab: p.f.lab, v: p.v, value: n });
  });
  return { tiles, rejected: rejected.filter((r) => !tiles.some((t) => t.t.key === r.key)), noted };
}

/**
 * readMarketReview(pages, { items, scope }) → { facts } | { error } | null   (null = not a Market Review)
 * `scope` = the result of confirmScope(...).confirmed, captured at intake before the report is read.
 */
function readMarketReview(pages, opts) {
  const o = opts || {};
  if (!isMarketReview(pages, o.items)) return null;
  const its = cleanItems(o.items), text = (Array.isArray(pages) ? pages : []).join("\n");
  const updated = updatedDate(text);

  // 1. Comparison headers, kept exactly as printed.
  const heads = its.filter((i) => /^vs\.?\s+\S/i.test(i.s)).map((h) => ({ printed: h.s, x: h.x, basis: parseBasis(h.s) }));
  // 2. Period, from the comparison labels and the header.
  const tileTexts = new Set(TILES.flatMap((t) => t.labels.map(norm)));
  const header = its.filter((i) => i.y < 140 && !/^vs\.?\s/i.test(i.s) && !/^Includes\s/i.test(i.s) && !tileTexts.has(norm(i.s)) && !(NUMLIKE.test(i.s) && !/^20\d\d$/.test(i.s)) && !CHANGE.test(i.s) && !NOTE_RE.test(i.s) && i.s.length > 1).map((i) => i.s);
  const per = detectPeriod(header, heads.map((h) => h.basis), updated);
  if (per.error) return { error: per.error, detail: per.detail || null };
  const period = per.period;

  // 3. Tiles and their row bands.
  const { tiles, rejected, noted } = readTiles(its);
  if (tiles.length < 4) return { error: "no_figures" };
  const shown = new Set(tiles.map((x) => x.v));
  const labelItems = new Set(tiles.map((x) => x.lab));
  const rows = tiles.map((x) => ({ x, cy: (x.lab.y + x.v.y) / 2 }));
  const cols = heads.map((h) => ({ ...h, kind: compareKind(period, h.basis) }));
  const claimedTokens = new Set();

  // 4. Each percent / earlier value belongs to the row it is level with and the column header it sits under.
  // Year-to-date rows print the two years as tags ("2026", "2025") with a value beside each: the earlier value is the one beside the OTHER year's tag.
  const YEAR_TAG = /^20\d\d$/;
  const tags = its.filter((i) => YEAR_TAG.test(i.s) && i.y >= 100 && i.y < (footerYOf(its)));
  const earlierOf = new Map();
  rows.forEach((r) => {
    const mine = tags.filter((t) => Math.abs(t.y - r.cy) <= 40 && t.x < r.x.v.x - 150);
    const other = mine.filter((t) => Number(t.s) !== period.year);
    if (!other.length || !mine.some((t) => Number(t.s) === period.year)) return;
    const t = other[0];
    const cand = its.filter((i) => NUMLIKE.test(i.s) && !YEAR_TAG.test(i.s) && Math.abs(i.y - t.y) <= 6 && i.x > t.x + 20 && i.x < r.x.v.x - 5 && tokenFits(r.x.t.unit, i.s) && inRange(r.x.t.unit, parseValue(i.s)));
    if (cand.length === 1) earlierOf.set(r.x, { value: parseValue(cand[0].s), token: cand[0].s, year: Number(t.s) });
  });
  const cells = [];
  its.forEach((it) => {
    if (YEAR_TAG.test(it.s) && it.x < 200) return;
    if (shown.has(it) || labelItems.has(it) || !cols.length) return;
    const isChange = CHANGE.test(it.s), isVal = NUMLIKE.test(it.s);
    if (!isChange && !isVal) return;
    if (isVal && !isChange && earlierOf.size && it.x > 200 && it.x < 380) return;   // the year-tagged values are read from their tags, not by column
    const row = rows.map((r) => ({ r, d: Math.abs(it.y - r.cy) })).sort((a, b) => a.d - b.d)[0];
    if (!row || row.d > 30) return;
    if (it.x >= row.r.x.v.x - 5) return;                                  // comparisons sit left of the big number
    const col = cols.map((c) => ({ c, d: Math.abs(it.x - c.x) })).sort((a, b) => a.d - b.d)[0];
    cells.push({ it, row: row.r, col: col.c, isChange, isVal, d: row.d });
  });
  const partialVsFull = (c, unit) => period.kind === "year" && period.partial === true && c.kind === "full_prior_year" && unit === "count";
  const figures = tiles.map((x, i) => {
    const unit = x.t.unit;
    const mine = cells.filter((c) => c.row.x === x);
    const comps = cols.map((c) => {
      const inCol = mine.filter((m) => m.col === c);
      // For "List price received" both the earlier value (99.5%) and the change (-0.1%) end in "%": the value is the one in the percent-of-list range.
      const ye = earlierOf.get(x);
      const valCand = ye ? [] : inCol.filter((m) => m.isVal && !(m.isChange && !(unit === "pct" && inRange("pct", parseValue(m.it.s)) && tokenFits("pct", m.it.s))) && tokenFits(unit, m.it.s) && inRange(unit, parseValue(m.it.s)));
      const chgCand = inCol.filter((m) => m.isChange && !valCand.includes(m)).sort((a, b) => a.d - b.d);
      const comp = { printed: c.printed, position: c.x, kind: c.kind, pct: null, value: null, tokens: [] };
      if (chgCand.length) { comp.pct = parseChange(chgCand[0].it.s); comp.tokens.push(chgCand[0].it.s); }
      if (valCand.length) { comp.value = parseValue(valCand[0].it.s); comp.tokens.push(valCand[0].it.s); }
      if (ye && cols.length === 1) { comp.value = ye.value; comp.tokens.push(ye.token); comp.valueYear = ye.year; }
      return comp;
    }).filter((c) => c.pct != null || c.value != null);
    // Deterministic check: where the report prints the earlier value as well as the change, the change must follow from them (to the printed rounding).
    const checks = [];
    comps.forEach((c) => {
      if (c.pct != null && c.value != null && c.value !== 0) {
        const dec = ((String(c.tokens[0]).match(/\.(\d+)%/) || [])[1] || "").length;
        const calc = (x.value / c.value - 1) * 100, tol = 0.5 * Math.pow(10, -dec) + 0.06;
        const ok = Math.abs(calc - c.pct) <= tol;
        checks.push({ against: c.printed, ok, printed: c.pct, computed: Math.round(calc * 100) / 100 });
        if (!ok) c.unverified = true;
      }
    });
    const fig = {
      id: `f${i + 1}`, status: x.t.status, key: x.t.key, label: x.t.name, value: x.value, unit, n: 0, small: false, reported: true,
      window: { start: period.start, end: period.end }, source: { label: x.lab.s, value: x.v.s },
      comparisons: comps.map((c) => ({ printed: c.printed, kind: c.kind, pct: c.pct, earlierValue: c.value, tokens: c.tokens.slice(), unverified: !!c.unverified, likeWithLike: !partialVsFull(c, unit) })),
      verification: checks,
    };
    // A count for a year in progress, set against a FULL year, is not a like-with-like change: it stays in `comparisons` as printed but is not offered as a change.
    const usable = comps.filter((c) => c.pct != null && !c.unverified && !partialVsFull(c, unit));
    const withBasis = usable.map((c) => ({ c, b: parseBasis(c.printed) })).sort((a, b) => sortKey(b.b) - sortKey(a.b));
    if (withBasis.length) fig.changes = withBasis.map(({ c }) => ({ pct: c.pct, vs: c.printed.replace(/^vs\.?\s+/i, ""), printed: c.printed, kind: c.kind, likeWithLike: true }));
    return fig;
  });

  // 5. Coverage: every measure this report type should print is read, not printed, or unread. Never silently missing.
  const coverage = { period: period.kind, read: [], notPrinted: [], unread: [] };
  const readKeys = new Set(figures.map((f) => f.key));
  const unitOf = (k) => TILES.find((t) => t.key === k);
  const onPage = (t) => its.some((i) => t.labels.some((l) => norm(l) === norm(i.s)));
  TILES.forEach((t) => {
    if (readKeys.has(t.key)) { coverage.read.push(t.key); return; }
    if (noted.has(t.key)) { coverage.notPrinted.push(t.key); (coverage.notPrintedNotes = coverage.notPrintedNotes || {})[t.key] = noted.get(t.key); return; }
    // a report prints weeks of supply or months of supply, not both
    if (t.key === "weeks_supply" && period.kind !== "week" && !onPage(t)) return;
    if (t.key === "months_supply" && period.kind === "week" && !onPage(t)) return;
    if (!t.kinds.includes(period.kind) && !onPage(t)) { coverage.notPrinted.push(t.key); return; }
    const why = rejected.find((r) => r.key === t.key);
    coverage.unread.push({ key: t.key, label: t.name, reason: why ? why.reason : onPage(t) ? "value_not_found_beside_label" : "label_not_found" });
  });
  const missingComps = figures.filter((f) => cols.length && (f.comparisons || []).length < cols.length).map((f) => f.key);

  // 6. Geography and property type as the document displays them. The subscriber's attestation is applied by finalize().
  const displayed = parseHeaderScope(its);
  const closed = (figures.find((f) => f.key === "count_closed") || {}).value;
  const small = closed != null && closed < lib.SMALL_SAMPLE_BELOW;
  const base = [];
  if (period.kind === "week") base.push("This is one week of data. Weekly figures swing from week to week, so topics will describe the week and will not call it a trend.");
  if (small) base.push(`Only ${closed} closed ${closed === 1 ? "sale" : "sales"} in ${period.label}: a small sample.`);
  if (period.kind === "year" && period.partial) base.push(`This report is titled ${period.year} but covers only part of the year. Its comparison with the year ending ${period.year - 1} is against a full year, so a drop in counts is not a full-year decline.`);
  if (period.kind === "year" && period.partial === null) base.push("I can't tell from this report whether the year is complete. Don't describe it as a finished year.");
  if (coverage.unread.length) base.push(`I couldn't read ${coverage.unread.length} measure${coverage.unread.length === 1 ? "" : "s"}: ${coverage.unread.map((u) => u.label).join(", ")}. They were left out.`);
  if (missingComps.length) base.push("Some comparisons could not be read for every measure; the ones that were read are shown exactly as printed.");
  if (figures.some((f) => (f.comparisons || []).some((c) => c.unverified))) base.push("A printed percent change did not agree with the two values beside it, so that change was left out.");
  if (cols.some((c) => c.kind === "unknown")) base.push("A comparison label could not be classified, so it is shown as printed and not described further.");

  const facts = {
    version: lib.FACTS_VERSION, kind: "pdf", layout: "market_review", reportDate: updated,
    mlsSource: /Data provided by MetroList/i.test(text) ? "MetroList" : null,
    propertyTypes: displayed.propertyTypesRaw ? [displayed.propertyTypesRaw.replace(/^all\s+/i, "All ")] : [], propertyTypesSource: "report_header",
    criteria: { closedSince: null }, geography: { displayed }, propertyTypeScope: { displayed: displayed.propertyTypesRaw ? displayed.propertyTypesRaw.replace(/^all\s+/i, "All ") : null },
    period: { kind: period.kind, label: period.label, start: period.start, end: period.end, partial: period.partial, weekly: period.kind === "week", year: period.year || null, month: period.month || null, q: period.q || null,
      comparisons: cols.map((c) => ({ printed: c.printed, kind: c.kind })) },
    statuses: {}, figures,
    sample: { total: closed != null ? closed : 0, closed: closed != null ? closed : 0, small, broadWindow: false, windowDays: period.start && period.end ? dayNum(period.end) - dayNum(period.start) : null },
    reportedTotal: null, coverage, baseWarnings: base, warnings: [],
    suggestions: o.suggestions || null,
    notes: ["Only the dashboard's figures were kept. Each percent change is as printed, against the period named beside it."],
  };
  const att = (o.scope || o.propertyTypes || o.dataThrough || o.companions) ? { scope: o.scope || null, propertyTypes: o.propertyTypes || null, dataThrough: o.dataThrough || null, companions: o.companions || [], acknowledgeConflicts: !!o.acknowledgeConflicts } : null;
  return att ? applyAttestation(facts, att) : { facts: finalize(facts, {}) };
}

// ── The subscriber's attestations, applied to the stored facts (the PDF is gone by then) ─────────────────────────────────
const SUBSCRIBER = "subscriber_attested", DOCUMENT = "document", CROSS = "cross_report";

/** validateDataThrough(period, date, updated) → { ok } | { ok:false, message }. Checked against the reporting year and what the report itself shows. */
function validateDataThrough(period, date, updated) {
  if (!validIso(String(date || ""))) return { ok: false, message: "Enter the date as a real calendar date." };
  if (!period.year || Number(date.slice(0, 4)) !== period.year) return { ok: false, message: `The date must fall in ${period.year}, the year this report covers.` };
  if (period.start && date < period.start) return { ok: false, message: "The date is before this report's period begins." };
  if (updated && date > updated) return { ok: false, message: "The data cannot run past the date the report was updated." };
  return { ok: true };
}

/** The coverage date, by the agreed hierarchy: (1) the document, (2) a compatible matching YTD report, (3) the subscriber, confirmed. */
function resolveCoverage(f, att) {
  const p = f.period, updated = f.reportDate || null;
  if (p.kind !== "year" && !(p.kind === "ytd" && !p.end)) return p.end ? { through: p.end, provenance: DOCUMENT, independentlyVerified: true } : null;
  if (p.kind === "ytd" && p.end) return { through: p.end, provenance: DOCUMENT, independentlyVerified: true };
  if (p.partial === false) return { through: p.end || `${p.year}-12-31`, provenance: DOCUMENT, independentlyVerified: true };
  const comp = (att.companions || []).map((c) => c && (c.facts || c)).find((c) => c && c.layout === "market_review" && c.period && c.period.kind === "ytd" && c.period.year === p.year && c.period.end && (!updated || c.period.end <= updated) && (p.kind === "ytd" || crossCheckPeriods(f, c).yearlyIsPartial));
  if (comp) {
    const out = { through: comp.period.end, provenance: CROSS, independentlyVerified: true };
    if (att.dataThrough && att.dataThrough !== comp.period.end) out.note = `You entered ${att.dataThrough}; your year-to-date report shows the data runs through ${comp.period.end}, so that date is used.`;
    return out;
  }
  if (att.dataThrough) {
    const v = validateDataThrough(p, att.dataThrough, updated);
    return v.ok ? { through: att.dataThrough, provenance: SUBSCRIBER, independentlyVerified: false } : { error: v.message };
  }
  return null;
}

function geoAreaLabel(g) {
  const c = g && g.confirmed;
  if (!c) return null;
  if (c.type === "cities") return `${listText(c.names)} combined`;
  if (c.type === "zips" && c.names.length > 1) return `ZIP codes ${listText(c.names)} combined`;
  if (c.type === "zips") return `ZIP ${c.names[0]}`;
  return c.names[0];
}

/** finalize(facts, att) → facts with geography, property type, coverage date, confirmation and warnings all derived from the document + the attestation. */
function finalize(f, att) {
  const out = JSON.parse(JSON.stringify(f));
  const displayed = (out.geography && out.geography.displayed) || { kind: "absent", places: [] };
  out.geography = geographyBlock(displayed, att.scope || null);
  out.geography.areaLabel = geoAreaLabel(out.geography);
  out.geography.scopeKind = !att.scope ? null : att.scope.type === "cities" || (att.scope.type === "zips" && att.scope.names.length > 1) ? "combined" : att.scope.type === "county" ? "county" : att.scope.type === "custom" ? "custom" : "exact";
  out.propertyTypeScope = { ...propertyTypeBlock({ propertyTypesRaw: (f.propertyTypeScope || {}).displayed || null }, att.propertyTypes || null) };
  const p = out.period;
  const cov = resolveCoverage(out, att);
  const needsThrough = (p.kind === "year" && p.partial !== false) || (p.kind === "ytd" && !p.end);
  p.coverage = cov && !cov.error ? { through: cov.through, provenance: cov.provenance, independentlyVerified: cov.independentlyVerified, updated: out.reportDate || null, ...(cov.note ? { note: cov.note } : {}) }
    : { through: null, provenance: null, independentlyVerified: false, updated: out.reportDate || null };
  // A year whose completeness the document could not settle becomes a partial year once a coverage date before its end is established.
  if (p.kind === "year" && p.partial === null && cov && !cov.error && p.year && cov.through < `${p.year}-12-31`) p.partial = true;
  p.coverageThrough = p.partial !== false && cov && !cov.error ? cov.through : null;
  p.disclosureEnd = p.end ? null : (cov && !cov.error ? cov.through : null);
  delete p.coverageDate;
  if (p.kind === "year" || p.kind === "ytd") p.label = periodLabel(p);
  const conflicts = out.geography.conflicts.concat(out.propertyTypeScope.conflicts || []);
  const acked = !!att.acknowledgeConflicts;
  const needed = [];
  if (out.geography.status === "needs_scope") needed.push("geography");
  if (out.propertyTypeScope.status === "needs_confirmation") needed.push("propertyTypes");
  if (needsThrough && !(cov && !cov.error)) needed.push("dataThrough");
  if (conflicts.length && !acked) needed.push("conflicts");
  const q = { geography: "the area", propertyTypes: "the property types", dataThrough: "the last date this report's data covers" };
  const asks = needed.filter((k) => q[k]);
  let question = null;
  if (cov && cov.error) question = cov.message || cov.error;
  else if (asks.length === 2 && !asks.includes("dataThrough")) question = "Please confirm the area and the property types this report covers; its header can't be relied on for either.";
  else if (asks.length === 1 && asks[0] === "geography") question = "Which area does this report cover? The header can't be used for that.";
  else if (asks.length === 1 && asks[0] === "propertyTypes") question = "Which property types does this report cover? The header can't be relied on for that.";
  else if (asks.length) question = `Please confirm ${listText(asks.map((k) => q[k]))}. The report itself does not establish ${asks.length === 1 ? "it" : "them"}.`;
  out.confirmation = { needed, question, suggested: out.suggestions || null, conflictsAcknowledged: acked && conflicts.length > 0 };
  const warnings = (out.baseWarnings || []).slice();
  if (p.kind === "ytd" && !p.end && !(cov && !cov.error)) warnings.push("This year-to-date report does not print the month it runs through, so its end date is unknown.");
  if (question) warnings.push(question);
  if (cov && cov.note) warnings.push(cov.note);
  if (cov && cov.provenance === SUBSCRIBER) warnings.push(`The data-through date (${cov.through}) is the one you entered. It is not independently verified.`);
  conflicts.forEach((c) => warnings.push(c.message));
  if (out.geography.scopeKind === "combined") warnings.push(`This report's figures describe the combined ${out.geography.areaLabel.replace(/ combined$/, "")} market. They are never stated for one of those places alone.`);
  out.warnings = warnings;
  out.attestation = att.scope || att.propertyTypes || att.dataThrough ? { scope: att.scope || null, propertyTypes: att.propertyTypes || null, dataThrough: cov && !cov.error ? { date: cov.through, provenance: cov.provenance } : null, acknowledgedConflicts: acked ? conflicts.map((c) => c.message) : [], carriedFrom: att.carriedFrom || null } : null;
  return out;
}

/** applyAttestation(facts, { scope, propertyTypes, dataThrough, companions, acknowledgeConflicts, carriedFrom }) → { facts } | { error }. */
function applyAttestation(facts, att) {
  if (!facts || facts.layout !== "market_review") return { error: "not_a_market_review" };
  const a = att || {};
  const cov = facts.period && (facts.period.kind === "year" || facts.period.kind === "ytd") ? resolveCoverage(JSON.parse(JSON.stringify(facts)), a) : null;
  if (cov && cov.error) { const f = finalize(facts, { ...a, dataThrough: null }); f.confirmation.question = cov.error; f.confirmation.needed = Array.from(new Set([...f.confirmation.needed, "dataThrough"])); return { facts: f, error: "bad_data_through", message: cov.error }; }
  return { facts: finalize(facts, a) };
}

/** crossCheckPeriods(a, b): the same values in a yearly and a year-to-date report show the yearly one is a partial year. */
function crossCheckPeriods(a, b) {
  const pick = (f) => f.facts ? f.facts : f;
  const A = pick(a), B = pick(b);
  if (!A.period || !B.period) return { relation: "unknown" };
  const [y, t] = A.period.kind === "year" ? [A, B] : [B, A];
  if (y.period.kind !== "year" || t.period.kind !== "ytd") return { relation: "unrelated" };
  const same = y.figures.length && y.figures.every((f) => { const g = t.figures.find((x) => x.key === f.key); return g && g.value === f.value; });
  return { relation: same ? "yearly_equals_year_to_date" : "different", yearlyIsPartial: !!same, valuesCoverThrough: same ? t.period.end : null };
}

// ── The read-back the subscriber confirms: what the DOCUMENT reported, apart from what the SUBSCRIBER attests ─────────────────
const KIND_TEXT = { prior_period: "the period just before", same_period_last_year: "the same period a year earlier", full_prior_year: "the full prior year", earlier_period: "an earlier period", unknown: "a period I could not classify" };
function readBackView(facts) {
  const f = facts || {}, g = f.geography || {}, p = f.period || {}, c = f.coverage || {}, t = f.propertyTypeScope || {}, conf = f.confirmation || {};
  const partialYear = p.kind === "year" && p.partial === true;
  const reported = {
    reportType: p.kind || null, period: { label: p.label, start: p.start, end: p.end, partial: p.partial === true, coverage: p.coverage || null },
    comparisons: (p.comparisons || []).map((x) => ({ printed: x.printed, kind: x.kind, meaning: KIND_TEXT[x.kind] || KIND_TEXT.unknown,
      eligibility: partialYear && x.kind === "full_prior_year" ? { counts: false, other: true, note: "Counts are not compared: this year is still in progress and the comparison is a full year. Prices and rates are shown as printed." } : { counts: true, other: true, note: null } })),
    figuresRead: c.read || [], notPrinted: (c.notPrinted || []).map((k) => ({ key: k, label: ((TILES.find((t) => t.key === k) || {}).name) || k, note: (c.notPrintedNotes || {})[k] || null })), unread: c.unread || [],
    header: { geography: g.displayed && g.displayed.raw || null, geographyUnreliable: !!(g.displayed && g.displayed.unreliable), propertyTypes: t.displayed || null },
    notice: lib.attributionNotice(f), noticeProvenance: p.coverage && p.coverage.provenance || (p.end ? DOCUMENT : null),
    source: f.mlsSource,
  };
  const attested = {
    note: "These come from you, not from the document. They are not checked against the PDF.",
    geography: { selected: g.confirmed || null, areaLabel: g.areaLabel || null, scopeKind: g.scopeKind || null, status: g.status, suggested: (conf.suggested && conf.suggested.scope) || null },
    propertyTypes: { selected: t.confirmed || null, status: t.status, suggested: (conf.suggested && conf.suggested.propertyTypes) || null },
    dataThrough: p.coverage ? { date: p.coverage.through, provenance: p.coverage.provenance, independentlyVerified: p.coverage.independentlyVerified } : null,
    conflicts: (g.conflicts || []).concat(t.conflicts || []), carriedFrom: f.attestation && f.attestation.carriedFrom || null,
  };
  return { reported, attested, needed: conf.needed || [], question: conf.question || null, canConfirm: (conf.needed || []).length === 0, warnings: f.warnings || [] };
}

function readBack(facts) {
  const v = readBackView(facts);
  return [
    { kind: "period", text: v.reported.period.label || "Period not read", partial: v.reported.period.partial },
    { kind: "comparisons", items: v.reported.comparisons.map((c) => ({ printed: c.printed, kind: c.kind })) },
    { kind: "read", keys: v.reported.figuresRead }, { kind: "not_printed", keys: v.reported.notPrinted.map((n) => n.key) }, { kind: "unread", items: v.reported.unread },
    { kind: "geography", displayed: v.reported.header.geography, confirmed: v.attested.geography.selected ? v.attested.geography.selected.areasIncluded : null, attested: !!(v.attested.geography.selected && v.attested.geography.selected.attestedBySubscriber), status: v.attested.geography.status, combined: v.attested.geography.scopeKind === "combined" },
  ];
}

/** suggestFrom(geography, propertyTypes) → a SUGGESTED selection for the read-back form. It is never an attestation: the subscriber must still choose it. */
function suggestFrom(geography, propertyTypes) {
  const g = geography && typeof geography === "object" ? geography : null;
  const out = {};
  if (g && g.name) {
    const name = String(g.name).trim();
    if (g.type === "city") out.scope = { type: "city", names: [name] };
    else if (g.type === "zip") { const z = (/\b(9\d{4})\b/.exec(name) || [])[1]; if (z) out.scope = { type: "zips", names: [z] }; }
    else if (g.type === "county") out.scope = { type: "county", names: [name] };
    else if (g.type === "neighborhood" || g.type === "metro") out.scope = { type: "custom", names: [name] };
  }
  if (Array.isArray(propertyTypes) && propertyTypes.length) out.propertyTypes = propertyTypes.map(String).slice(0, 6);
  return out.scope || out.propertyTypes ? out : null;
}

/** reapply(facts, extra) → the stored facts re-derived with the attestation already on them plus new input (companion YTD reports, a date, an acknowledgement). */
function reapply(facts, extra) {
  const a = (facts && facts.attestation) || {};
  const x = extra || {};
  const prevDate = a.dataThrough && a.dataThrough.provenance === "subscriber_attested" ? a.dataThrough.date : null;
  return applyAttestation(facts, {
    scope: x.scope || a.scope || null, propertyTypes: x.propertyTypes || a.propertyTypes || null,
    dataThrough: x.dataThrough || prevDate, companions: x.companions || [], acknowledgeConflicts: x.acknowledgeConflicts != null ? x.acknowledgeConflicts : !!(a.acknowledgedConflicts && a.acknowledgedConflicts.length),
    // "Carried forward" describes an attestation the subscriber has not touched: a changed area or property-type selection is theirs, not carried.
    carriedFrom: (x.scope && a.scope && !sameScope(x.scope, a.scope)) || (x.propertyTypes && a.propertyTypes && !sameTypes(x.propertyTypes, a.propertyTypes)) ? null : (x.carriedFrom || a.carriedFrom || null),
  });
}
const lc = (v) => String(v).toLowerCase().replace(/\s+/g, " ").trim();
function sameScope(a, b) { return !!(a && b && a.type === b.type && a.names.length === b.names.length && a.names.map(lc).sort().join("|") === b.names.map(lc).sort().join("|")); }
function sameTypes(a, b) { return !!(a && b && a.names.map(lc).sort().join("|") === b.names.map(lc).sort().join("|")); }
/** carryApplies(prior, suggestions): an earlier attestation is reused only if the project's own current selection does not contradict it. */
function carryApplies(priorAtt, suggestions) {
  if (!priorAtt || !priorAtt.scope || !priorAtt.propertyTypes) return false;
  const s = suggestions || {};
  if (s.scope && !sameScope(confirmScope(s.scope).confirmed, priorAtt.scope)) return false;
  if (s.propertyTypes && !sameTypes({ names: s.propertyTypes }, priorAtt.propertyTypes)) return false;
  return true;
}

module.exports = { carryApplies, suggestFrom, reapply, confirmPropertyTypes, TILES, parseBasis, compareKind, detectPeriod, parseHeaderScope, confirmScope, reconcileGeography, isMarketReview, readMarketReview, applyAttestation, validateDataThrough, readBackView, crossCheckPeriods, readBack, updatedDate };
