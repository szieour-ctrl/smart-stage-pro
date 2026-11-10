#!/usr/bin/env node
// Local check of the Market Review reader against REAL Domus PDFs (licensed: never commit them or this script's output).
//   node scripts/read-market-review.js --scope city:Roseville  weekly.pdf monthly.pdf quarterly.pdf ytd.pdf yearly.pdf
//   node scripts/read-market-review.js --scope cities:Roseville,Rocklin  --expect expected.json  monthly.pdf
// --scope TYPE:NAME[,NAME]   TYPE = city | cities | county | zips | custom (optional; without it the area stays unconfirmed)
// --types A,B                property types the subscriber confirms (optional; otherwise a confirmation is requested)
// --through YYYY-MM-DD       a VERIFIED data-through date for a partial year (optional)
// --expect FILE              JSON kept OUTSIDE the repository, keyed by PDF file name. Each entry may hold any of:
//   figures {key: value}, comparisons {key: {"vs Q3 2023": pct}}, earlier {key: value}, ineligible [key], period {kind,label,start,end,partial},
//   notPrinted [key], attribution "…", displayedGeography "…", displayedPropertyTypes "…"
//   (a flat {key: value} entry is read as "figures"). Every discrepancy prints expected, extracted, source tokens and a proposed correction; exit code 1.
// Prints, per file: report type and period, every figure with the tokens it was read from, each comparison with its printed label and kind,
// the coverage report (read / not printed / unread), warnings and the displayed-versus-confirmed geography. No network, no model, no cost.
"use strict";
const fs = require("fs");
const path = require("path");
const read = require("../netlify/functions/lib/agent-marketing-report-read-lib");
const lib = require("../netlify/functions/lib/agent-marketing-report-lib");
const mr = require("../netlify/functions/lib/agent-marketing-market-review-lib");

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const scopeArg = opt("--scope"), expectArg = opt("--expect"), typesArg = opt("--types"), throughArg = opt("--through");
const files = args;
if (!files.length) { console.error("usage: node scripts/read-market-review.js [--scope TYPE:NAME,NAME] [--expect expected.json] file.pdf ..."); process.exit(2); }

let scope = null;
if (scopeArg) {
  const [type, names] = scopeArg.split(":");
  const r = mr.confirmScope({ type, names: (names || "").split(",") });
  if (!r.ok) { console.error(r.question); process.exit(2); }
  scope = r.confirmed;
}
const types = typesArg ? mr.confirmPropertyTypes(typesArg.split(",")) : null;
if (types && !types.ok) { console.error(types.question); process.exit(2); }
const expected = expectArg ? JSON.parse(fs.readFileSync(expectArg, "utf8")) : {};

function check(name, f, want) {
  if (!want) return 0;
  const w = want.figures || (want.comparisons || want.period || want.notPrinted ? want : { figures: want });
  let n = 0;
  const miss = (what, exp, got, src, fix) => { n++; console.log(`  DISCREPANCY ${what}\n    expected: ${JSON.stringify(exp)}\n    extracted: ${JSON.stringify(got)}\n    source token: ${src}\n    proposed correction: ${fix}`); };
  const fig = (k) => f.figures.find((x) => x.key === k);
  Object.entries(w.figures || w).forEach(([k, v]) => { if (typeof v === "object") return; const x = fig(k); if (!x || x.value !== v) miss(`figure ${k}`, v, x ? x.value : null, x ? `"${x.source.label}" / "${x.source.value}"` : "none found", x ? "check the value token pairing for this label" : "report why the label or value was not found"); });
  Object.entries(want.comparisons || {}).forEach(([k, byLabel]) => Object.entries(byLabel).forEach(([label, pct]) => {
    const c = ((fig(k) || {}).comparisons || []).find((y) => y.printed === label);
    if (!c || c.pct !== pct) miss(`comparison ${k} ${label}`, pct, c ? c.pct : null, c ? JSON.stringify(c.tokens) : "label not found", "check the column assignment for this header");
  }));
  Object.entries(want.earlier || {}).forEach(([k, v]) => { const c = ((fig(k) || {}).comparisons || [])[0]; if (!c || c.earlierValue !== v) miss(`earlier value ${k}`, v, c ? c.earlierValue : null, "year-tagged value", "check the year-tag row match"); });
  (want.ineligible || []).forEach((k) => { const c = ((fig(k) || {}).comparisons || []).find((y) => y.likeWithLike === false); if (!c) miss(`eligibility ${k}`, "likeWithLike:false", "eligible", "comparison kind", "check period.partial and the comparison kind"); });
  if (want.period) Object.entries(want.period).forEach(([k, v]) => { if (f.period[k] !== v) miss(`period.${k}`, v, f.period[k], f.period.label, "check header tokens and comparison labels"); });
  if (want.notPrinted && JSON.stringify(want.notPrinted) !== JSON.stringify(f.coverage.notPrinted)) miss("notPrinted", want.notPrinted, f.coverage.notPrinted, JSON.stringify(f.coverage.notPrintedNotes || {}), "check the printed note beside the label");
  if (f.coverage.unread.length) miss("unread measures", [], f.coverage.unread, f.coverage.unread.map((u) => u.reason).join(","), "inspect the row band for each unread label");
  if (want.attribution !== undefined && lib.attributionNotice(f) !== want.attribution) miss("attribution", want.attribution, lib.attributionNotice(f), f.period.label, "check period start/end");
  if (want.displayedGeography && f.geography.displayed.raw !== want.displayedGeography) miss("displayed geography", want.displayedGeography, f.geography.displayed.raw, "header", "check the Includes … in … item");
  if (want.displayedPropertyTypes && (f.propertyTypeScope.displayed !== want.displayedPropertyTypes)) miss("displayed property types", want.displayedPropertyTypes, f.propertyTypeScope.displayed, "header", "check the Includes … in … item");
  return n;
}

(async () => {
  let bad = 0;
  const parsed = [];
  for (const file of files) {
    const name = path.basename(file);
    console.log(`\n=== ${name}`);
    let pdf;
    try { pdf = await read.readPdf(fs.readFileSync(file)); } catch (e) { console.log("  could not open:", e.code || e.message); bad++; continue; }
    const r = mr.readMarketReview(pdf.pages, { items: pdf.items, scope, propertyTypes: types && types.confirmed, verifiedDataThrough: throughArg || undefined });
    if (!r) { console.log("  NOT RECOGNIZED as a Market Review. Header items:", (pdf.items || []).filter((i) => i.y < 140).map((i) => i.s).slice(0, 12)); bad++; continue; }
    if (r.error) { console.log("  ERROR:", r.error, r.detail || ""); bad++; continue; }
    const f = r.facts; parsed.push({ name, f });
    console.log(`  type: ${f.period.kind}   period: ${f.period.label}   partial: ${f.period.partial}   data date: ${f.reportDate}`);
    console.log(`  comparisons: ${f.period.comparisons.map((c) => `${c.printed} [${c.kind}]`).join(" | ")}`);
    f.figures.forEach((x) => console.log(`  ${x.key.padEnd(22)} ${String(x.value).padStart(9)}  <- "${x.source.label}" / "${x.source.value}"   ${x.comparisons.map((c) => `${c.printed}: ${c.pct}%${c.earlierValue != null ? ` (earlier ${c.earlierValue})` : ""}${c.unverified ? " UNVERIFIED" : ""}${c.likeWithLike ? "" : " NOT-LIKE-WITH-LIKE"}`).join("; ")}`));
    console.log(`  not printed: ${f.coverage.notPrinted.join(", ") || "-"}   UNREAD: ${f.coverage.unread.map((u) => `${u.key} (${u.reason})`).join(", ") || "-"}`);
    console.log(`  property types: displayed "${f.propertyTypeScope.displayed}" | status ${f.propertyTypeScope.status} (${f.propertyTypeScope.reason})`);
    console.log(`  geography: displayed "${f.geography.displayed.raw}" | confirmed ${f.geography.confirmed ? f.geography.confirmed.areasIncluded + " (attested)" : "none"} | status ${f.geography.status}`);
    console.log(`  attribution: ${lib.attributionNotice(f) || "none (no end date printed)"}`);
    f.warnings.forEach((w) => console.log(`  warning: ${w}`));
    bad += check(name, f, expected[name]);
  }
  const y = parsed.find((p) => p.f.period.kind === "year"), t = parsed.find((p) => p.f.period.kind === "ytd");
  if (y && t) console.log(`\nyearly vs year-to-date: ${JSON.stringify(mr.crossCheckPeriods(y.f, t.f))}`);
  console.log(bad ? `\n${bad} problem(s) above.` : "\nAll files read with no unread measures and no mismatches.");
  process.exit(bad ? 1 : 0);
})();
