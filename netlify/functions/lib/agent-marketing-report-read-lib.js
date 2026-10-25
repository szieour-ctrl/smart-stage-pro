// lib/agent-marketing-report-read-lib.js — Netlify (shared). Opens an uploaded MLS report / CMA (PDF, CSV, Excel .xlsx) and hands
// plain text or rows to agent-marketing-report-lib.js. No network and no database. The file's bytes live only in memory for
// the length of one request; nothing is written anywhere.
//
// The file is untrusted. Its type is decided by its first bytes, not its name; size, page, row and time limits apply; a
// password-protected, damaged or scanned file produces a plain-language error, never a stack trace.
"use strict";

const lib = require("./agent-marketing-report-lib");

const MAX_BYTES = 4 * 1024 * 1024;     // a 4 MB file is about 5.4 MB as base64, inside Netlify's 6 MB request limit
const MAX_PDF_PAGES = 60;
const MAX_TEXT_CHARS = 600000;
const MAX_CSV_CELLS = 400000;
const READ_TIMEOUT_MS = 18000;

/** detectKind(fileName, bytes) → { kind: "pdf" | "xlsx" | "csv" } | { error } */
function detectKind(fileName, bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (b.length === 0) return { error: "empty" };
  if (b.length > MAX_BYTES) return { error: "too_big" };
  if (b.length >= 5 && b.slice(0, 5).toString("latin1") === "%PDF-") return { kind: "pdf" };
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return { kind: "xlsx" };
  if (b.length >= 4 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return { error: "xls" };
  const head = b.slice(0, Math.min(b.length, 4096));
  if (head.includes(0)) return { error: "unsupported" };             // binary of some other kind
  const name = String(fileName || "").toLowerCase();
  if (/\.(?:pdf|xlsx?|docx?|png|jpe?g|zip)$/.test(name) && !/\.(?:csv|txt|tsv)$/.test(name)) return { error: "unsupported" }; // named like a binary but is text
  return { kind: "csv" };
}

// ── CSV ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** parseCsv(text) → rows. Handles quotes, doubled quotes, newlines inside quotes, and comma / tab / semicolon files. */
function parseCsv(text) {
  let s = String(text == null ? "" : text).replace(/^﻿/, "");
  const first = s.split(/\r?\n/, 1)[0] || "";
  const counts = { ",": 0, "\t": 0, ";": 0 };
  let q = false;
  for (const ch of first) { if (ch === '"') q = !q; else if (!q && counts[ch] != null) counts[ch]++; }
  const delim = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const rows = [];
  let row = [], cell = "", inQ = false, cells = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(cell); cell = ""; if (++cells > MAX_CSV_CELLS) break; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); cell = ""; rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ── Excel ───────────────────────────────────────────────────────────────────────────────────────────────────────────
async function readXlsxRows(buf) {
  const rx = require("read-excel-file/node");
  const read = rx.default || rx.readExcelFile;
  const all = await read(buf);
  // Newer versions return every sheet: [{ sheet, data }]. Use the sheet that looks most like a listing table.
  const sheets = Array.isArray(all) && all.length && all[0] && Array.isArray(all[0].data) ? all.map((s) => s.data) : [all];
  let best = null, bestScore = -1;
  for (const data of sheets) {
    const t = lib.recordsFromRows(data);
    const score = t.records.length * 10 + lib.extractLabeledMetrics(data.map((r) => (Array.isArray(r) ? r.join(" ") : ""))).length;
    if (score > bestScore) { best = data; bestScore = score; }
  }
  return best || [];
}

// ── PDF ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// unpdf's own bundled PDF engine needs Node 22 (it fails on Node 18 and 20 with "Iterator is not defined"), and this site builds on Node 18
// (netlify.toml). The "legacy" build of pdf.js is made for older runtimes and gives byte-for-byte the same text on Node 18, 20 and 22 (checked
// Oct 24, 2026 against a real MetroList CMA), so unpdf is pointed at it. Set up once per process.
let pdfjsReady = null;
function useLegacyPdfjs(unpdf) {
  if (!pdfjsReady) pdfjsReady = unpdf.definePDFJSModule(() => import("pdfjs-dist/legacy/build/pdf.mjs"));
  return pdfjsReady;
}

async function readPdfPages(buf) {
  const unpdf = await import("unpdf");
  await useLegacyPdfjs(unpdf);
  const { extractText, getDocumentProxy } = unpdf;
  // The file is untrusted: no eval, no font loading, no console noise.
  const pdf = await getDocumentProxy(new Uint8Array(buf), { isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  if (pdf.numPages > MAX_PDF_PAGES) { const e = new Error("too_many_pages"); e.code = "too_large"; throw e; }
  const out = await extractText(pdf, { mergePages: false });
  const pages = (Array.isArray(out.text) ? out.text : [String(out.text || "")]).map((t) => String(t || "").slice(0, MAX_TEXT_CHARS));
  return pages;
}

/**
 * readPdf(buf) → { pages, items }. `items` (positioned text of page 1, y from the top) is only collected for Domus Analytics dashboards,
 * whose text comes out of the PDF in no useful order and has to be read by position.
 */
async function readPdf(buf) {
  const unpdf = await import("unpdf");
  await useLegacyPdfjs(unpdf);
  const pdf = await unpdf.getDocumentProxy(new Uint8Array(buf), { isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  if (pdf.numPages > MAX_PDF_PAGES) { const e = new Error("too_many_pages"); e.code = "too_large"; throw e; }
  const out = await unpdf.extractText(pdf, { mergePages: false });
  const pages = (Array.isArray(out.text) ? out.text : [String(out.text || "")]).map((t) => String(t || "").slice(0, MAX_TEXT_CHARS));
  let items = null;
  if (/Domus Analytics/i.test(pages.join("\n")) && /Weekly (?:Review|Infographic)/i.test(pages.join("\n"))) {
    const page = await pdf.getPage(1);
    const h = page.getViewport({ scale: 1 }).height;
    const tc = await page.getTextContent();
    items = tc.items.filter((i) => i && typeof i.str === "string" && i.str.trim() && Array.isArray(i.transform)).slice(0, 2000).map((i) => ({ s: i.str, x: i.transform[4] + (i.width || 0) / 2, y: h - i.transform[5] }));
  }
  return { pages, items };
}

function withTimeout(promise, ms) {
  let t;
  const timer = new Promise((_, reject) => { t = setTimeout(() => { const e = new Error("timeout"); e.code = "unreadable"; reject(e); }, ms); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

/**
 * readReport(bytes, fileName) → { ok: true, kind, facts } | { ok: false, code, message }
 * `facts` is the only thing that leaves this function: figures and a short allow-list of scope strings. See report-lib.
 */
async function readReport(bytes, fileName) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const k = detectKind(fileName, buf);
  if (k.error) return { ok: false, code: k.error, message: k.error === "too_big" ? "That file is larger than 4 MB. Try one property type or a shorter date range." : lib.errorMessage(k.error) };
  try {
    let result;
    if (k.kind === "pdf") { const pdf = await withTimeout(readPdf(buf), READ_TIMEOUT_MS); result = lib.analyzePages(pdf.pages, { items: pdf.items }); }
    else if (k.kind === "xlsx") result = lib.analyzeRows(await withTimeout(readXlsxRows(buf), READ_TIMEOUT_MS), "xlsx");
    else result = lib.analyzeRows(parseCsv(buf.toString("utf8")), "csv");
    if (result.error) return { ok: false, code: result.error, message: lib.errorMessage(result.error) };
    return { ok: true, kind: k.kind, facts: result.facts };
  } catch (e) {
    // Never echo the file's content or the parser's message back: log the class of failure only.
    const code = e && e.code === "too_large" ? "too_large" : "unreadable";
    console.error(`[agent-marketing-report] could not read a ${k.kind}: ${String((e && e.message) || e).slice(0, 80)}`);
    return { ok: false, code, message: lib.errorMessage(code === "too_large" ? "too_large" : "unreadable") };
  }
}

module.exports = { MAX_BYTES, MAX_PDF_PAGES, detectKind, parseCsv, readXlsxRows, readPdfPages, readPdf, readReport };
