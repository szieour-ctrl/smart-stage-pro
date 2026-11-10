// Phase 2: Market Review intake, subscriber read-back and attestation, combined-market scope, partial-year disclosure.
// Synthetic numbers only; PDFs are drawn from the positioned fixture items. Nothing here touches the network.
const test = require("node:test");
const assert = require("node:assert");
const PDFDocument = require("pdfkit");
const fx = require("./helpers/market-review-fixture");
const cmaFx = require("./helpers/cma-fixture");
const { pdfFromPages } = require("./helpers/make-pdf");

const U1 = "11111111-1111-4111-8111-111111111111";
const db = { agent_marketing_projects: [], agent_marketing_uploads: [], agent_marketing_feedback: [] };
let nextId = 1;
const uuid = (n) => `dddddddd-dddd-4ddd-8ddd-${String(n).padStart(12, "0")}`;
function fakeSupabase(method, table, body, qs = "") {
  const rows = db[table];
  const q = new URLSearchParams(String(qs).replace(/^\?/, ""));
  const matches = (r) => { for (const [k, v] of q.entries()) { if (["select", "order", "limit"].includes(k)) continue; if (v.startsWith("eq.")) { if (String(r[k]) !== v.slice(3)) return false; } } return true; };
  if (method === "POST") { const row = { id: uuid(nextId++), created_at: new Date(Date.now() + nextId).toISOString(), updated_at: new Date().toISOString(), confirmed_at: null, ...body }; rows.push(row); return Promise.resolve({ status: 201, data: [row] }); }
  const found = rows.filter(matches);
  if (method === "GET") return Promise.resolve({ status: 200, data: found.slice() });
  if (method === "PATCH") { found.forEach((r) => Object.assign(r, body)); return Promise.resolve({ status: 200, data: found }); }
  if (method === "DELETE") { found.forEach((r) => rows.splice(rows.indexOf(r), 1)); return Promise.resolve({ status: 204, data: [] }); }
  throw new Error("unexpected " + method);
}
const stub = (mod, exports) => { const p = require.resolve(mod); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub("../netlify/functions/lib/marketing-profile-lib", { supabase: fakeSupabase });
stub("../netlify/functions/lib/reel-auth-lib", { requireUser: async () => ({ user: { id: U1 } }) });
const { handler } = require("../netlify/functions/agent-marketing-report");
const mr = require("../netlify/functions/lib/agent-marketing-market-review-lib");
const rl = require("../netlify/functions/lib/agent-marketing-report-lib");
const rr = require("../netlify/functions/lib/agent-marketing-research-report-lib");
const ti = require("../netlify/functions/lib/agent-marketing-trend-intelligence-lib");
const gate = require("../netlify/functions/lib/agent-marketing-gate");

const call = async (body) => { const res = await handler({ httpMethod: "POST", headers: {}, body: JSON.stringify(body), queryStringParameters: null }); return { status: res.statusCode, json: JSON.parse(res.body) }; };
const mkProject = () => { const row = { id: uuid(nextId++), user_id: U1, template: "local_market_insider", status: "draft", intake: {} }; db.agent_marketing_projects.push(row); return row; };
const reset = (mrOn = true) => { Object.values(db).forEach((a) => (a.length = 0)); process.env.AGENT_MARKETING_ENABLED = "true"; delete process.env.AGENT_MARKETING_USER_IDS; if (mrOn) process.env.AGENT_MARKETING_MARKET_REVIEW = "dev"; else delete process.env.AGENT_MARKETING_MARKET_REVIEW; };

const pdfCache = {};
function pdfFromItems(f) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 0, size: [612, 842] }), chunks = [];
    doc.on("data", (c) => chunks.push(c)); doc.on("end", () => resolve(Buffer.concat(chunks))); doc.fontSize(8);
    f.items.forEach((i) => { if (i.s === "↑") return; const w = doc.widthOfString(i.s); doc.text(i.s, i.x - w / 2, i.y - 6, { lineBreak: false }); });
    doc.end();
  });
}
const b64 = async (kind, opts) => { const key = kind + JSON.stringify(opts || {}); return (pdfCache[key] = pdfCache[key] || (await pdfFromItems(fx[kind](opts))).toString("base64")); };
const upload = async (p, kind, over) => call({ action: "upload", projectId: p.id, fileName: `${kind}.pdf`, fileBase64: await b64(kind), permission: true, ...over });
const CITY = { type: "city", name: "Roseville" };
const SF = ["Single Family Homes"];
const ROSE = { type: "city", names: ["Roseville"] };

// ── 1. Reader activation: only the dev switch, only supported layouts, other types untouched ─────────────────────────────
test("routing: with the switch off a Domus Market Review keeps the existing path; with it on only Market Reviews go to the new reader", async () => {
  reset(false);
  let p = mkProject();
  const off = await upload(p, "monthly", { geography: CITY });
  if (off.status === 201) assert.notStrictEqual(off.json.upload.summary.layout, "market_review", "the new reader is not active without the switch");
  reset(true); p = mkProject();
  const on = await upload(p, "monthly", { geography: CITY });
  assert.strictEqual(on.status, 201, JSON.stringify(on.json));
  assert.strictEqual(on.json.upload.summary.layout, "market_review");
  // a different PDF type is not routed to it, switch on
  const cma = await call({ action: "upload", projectId: p.id, fileName: "Smith CMA.pdf", fileBase64: (await pdfFromPages(cmaFx.standard().pages)).toString("base64"), permission: true });
  assert.strictEqual(cma.status, 201, JSON.stringify(cma.json));
  assert.notStrictEqual(cma.json.upload.summary.layout, "market_review");
  // a CSV is never routed to it
  const csv = await call({ action: "upload", projectId: p.id, fileName: "x.csv", fileBase64: Buffer.from("Status,Price\nClosed,500000\nClosed,510000\nClosed,520000\n").toString("base64"), permission: true });
  assert.notStrictEqual((csv.json.upload || {}).summary && csv.json.upload.summary.layout, "market_review");
  assert.strictEqual(am().marketReviewEnabled({ AGENT_MARKETING_MARKET_REVIEW: "true" }), false, "only the value dev turns it on");
  assert.strictEqual(am().marketReviewEnabled({}), false);
});
const am = () => require("../netlify/functions/lib/agent-marketing-lib");

test("a request field cannot turn the reader on", async () => {
  reset(false);
  const p = mkProject();
  const r = await upload(p, "monthly", { geography: CITY, marketReview: true });
  if (r.status === 201) assert.notStrictEqual(r.json.upload.summary.layout, "market_review");
});

// ── 2. Read-back, suggestions, explicit confirmation, carry-forward ─────────────────────────────────────────────────────
test("upload: the read-back separates what the document reported from what the subscriber must confirm, and the project's place is only a suggestion", async () => {
  reset(); const p = mkProject();
  const r = await upload(p, "monthly", { geography: CITY, propertyTypes: SF });
  const s = r.json.upload.summary, rv = s.review;
  assert.ok(rv.reported.period.label && rv.reported.comparisons.length >= 2 && rv.reported.figuresRead.length >= 6);
  assert.strictEqual(rv.reported.header.geographyUnreliable, true, "the header geography is shown as displayed, flagged unreliable");
  assert.strictEqual(rv.attested.geography.selected, null, "a suggestion is not a selection");
  assert.deepStrictEqual(rv.attested.geography.suggested, { type: "city", names: ["Roseville"] });
  assert.deepStrictEqual(rv.needed.sort(), ["geography", "propertyTypes"]);
  assert.strictEqual(rv.canConfirm, false);
  assert.match(rv.attested.note, /not checked against the (?:document|PDF)/i);
  assert.match(s.notice, /^Based on information from MetroList Services, Inc\. for the period/);
});

test("confirm: refused until the subscriber states the area and property types; the stored facts then carry both as attestations", async () => {
  reset(); const p = mkProject();
  const up = (await upload(p, "monthly", { geography: CITY })).json.upload;
  const bare = await call({ action: "confirm", uploadId: up.id, correct: true });
  assert.strictEqual(bare.status, 409); assert.strictEqual(bare.json.code, "confirmation_needed");
  assert.deepStrictEqual(bare.json.needed.sort(), ["geography", "propertyTypes"]);
  assert.strictEqual(db.agent_marketing_uploads[0].status, "pending");
  const half = await call({ action: "confirm", uploadId: up.id, correct: true, scope: ROSE });
  assert.strictEqual(half.status, 409); assert.deepStrictEqual(half.json.needed, ["propertyTypes"]);
  const bad = await call({ action: "confirm", uploadId: up.id, correct: true, scope: { type: "cities", names: ["Roseville"] }, propertyTypes: SF });
  assert.strictEqual(bad.status, 400, "several cities need at least two names");
  const ok = await call({ action: "confirm", uploadId: up.id, correct: true, scope: ROSE, propertyTypes: SF });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
  const row = db.agent_marketing_uploads[0];
  assert.strictEqual(row.status, "confirmed");
  assert.strictEqual(row.facts.geography.confirmed.attestedBySubscriber, true);
  assert.strictEqual(row.facts.propertyTypeScope.confirmed.attestedBySubscriber, true);
  assert.ok(row.facts.geography.displayed.raw, "the header geography is still stored as displayed, apart from the confirmed scope");
  assert.strictEqual(row.facts.attestation.scope.names[0], "Roseville");
});

test("a second report with the same header reuses the earlier attestation: no duplicate confirmation, and it is marked as carried forward", async () => {
  reset(); const p = mkProject();
  const first = (await upload(p, "monthly", { geography: CITY })).json.upload;
  await call({ action: "confirm", uploadId: first.id, correct: true, scope: ROSE, propertyTypes: SF });
  const second = (await upload(p, "quarterly", { geography: CITY })).json.upload;
  assert.deepStrictEqual(second.summary.review.needed, []);
  assert.strictEqual(second.summary.review.canConfirm, true);
  assert.ok(second.summary.review.attested.carriedFrom);
  const ok = await call({ action: "confirm", uploadId: second.id, correct: true });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
  // a report whose displayed header differs is not covered by that attestation
  const other = (await call({ action: "upload", projectId: p.id, fileName: "m.pdf", fileBase64: (await pdfFromItems(fx.monthly({ scopeLine: "Includes Condo in all Counties" }))).toString("base64"), permission: true })).json.upload;
  assert.deepStrictEqual(other.summary.review.needed.sort(), ["geography", "propertyTypes"]);
});

test("a header that conflicts with the selection must be acknowledged before the report is usable", async () => {
  reset(); const p = mkProject();
  const up = (await call({ action: "upload", projectId: p.id, fileName: "m.pdf", fileBase64: (await pdfFromItems(fx.monthly({ scopeLine: "Includes Condo in all Counties" }))).toString("base64"), permission: true })).json.upload;
  const no = await call({ action: "confirm", uploadId: up.id, correct: true, scope: ROSE, propertyTypes: SF });
  assert.strictEqual(no.status, 409); assert.ok(no.json.needed.includes("conflicts"));
  const yes = await call({ action: "confirm", uploadId: up.id, correct: true, scope: ROSE, propertyTypes: SF, acknowledgeConflicts: true });
  assert.strictEqual(yes.status, 200, JSON.stringify(yes.json));
});

// ── 3. Partial-year disclosure hierarchy and MetroList period ───────────────────────────────────────────────────────────
test("partial yearly: no data-through date is invented; the subscriber's date is validated, stored as attested, never called verified", async () => {
  reset(); const p = mkProject();
  const up = (await upload(p, "yearly", { geography: CITY })).json.upload;
  assert.ok(up.summary.review.needed.includes("dataThrough"));
  assert.strictEqual(up.summary.notice, null, "no end date, no MetroList period");
  assert.ok(!/12-31|December 31/.test(JSON.stringify(db.agent_marketing_uploads[0].facts)), "December 31 is never claimed");
  const need = await call({ action: "confirm", uploadId: up.id, correct: true, scope: ROSE, propertyTypes: SF });
  assert.strictEqual(need.status, 409); assert.ok(need.json.needed.includes("dataThrough"));
  for (const d of ["2025-10-31", "2026-02-30", "garbage"]) {
    const bad = await call({ action: "confirm", uploadId: up.id, correct: true, scope: ROSE, propertyTypes: SF, dataThrough: d });
    assert.strictEqual(bad.status, 400, d); assert.strictEqual(bad.json.code, "bad_data_through");
  }
  assert.strictEqual(db.agent_marketing_uploads[0].status, "pending");
  const ok = await call({ action: "confirm", uploadId: up.id, correct: true, scope: ROSE, propertyTypes: SF, dataThrough: "2026-10-31" });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
  const f = db.agent_marketing_uploads[0].facts;
  assert.deepStrictEqual([f.period.coverage.through, f.period.coverage.provenance, f.period.coverage.independentlyVerified], ["2026-10-31", "subscriber_attested", false]);
  assert.strictEqual(f.period.end, null);
  assert.match(rl.attributionNotice(f), /through Oct(?:ober)? 31, 2026\.$/);
  assert.ok(f.warnings.some((w) => /not independently verified/.test(w)));
  assert.match(f.period.label, /Year to Date \(through October 31, 2026\)/);
});

test("a matching year-to-date report supports the coverage date (cross-report) and wins over a different date typed by the subscriber", async () => {
  reset(); const p = mkProject();
  const ytd = (await upload(p, "ytd", { geography: CITY })).json.upload;
  const a = await call({ action: "confirm", uploadId: ytd.id, correct: true, scope: ROSE, propertyTypes: SF, dataThrough: "2026-10-31" });
  assert.strictEqual(a.status, 200, JSON.stringify(a.json));
  const yr = (await upload(p, "yearly", { geography: CITY })).json.upload;
  assert.ok(!yr.summary.review.needed.includes("dataThrough"), "the year-to-date report already supports the date");
  const ok = await call({ action: "confirm", uploadId: yr.id, correct: true, dataThrough: "2026-11-02" });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
  const f = db.agent_marketing_uploads.find((r) => r.id === yr.id).facts;
  assert.deepStrictEqual([f.period.coverage.provenance, f.period.coverage.independentlyVerified], ["cross_report", true]);
  assert.strictEqual(f.period.disclosureEnd, f.period.coverage.through);
  assert.ok(f.period.coverage.note, "the conflicting typed date is explained, not silently used");
});

test("a report that prints its own period is document-derived; the notice uses it", async () => {
  reset(); const p = mkProject();
  const up = (await upload(p, "monthly", { geography: CITY })).json.upload;
  await call({ action: "confirm", uploadId: up.id, correct: true, scope: ROSE, propertyTypes: SF });
  const f = db.agent_marketing_uploads[0].facts;
  assert.strictEqual(f.period.coverage.provenance, "document");
  assert.strictEqual(rl.attributionNotice(f), "Based on information from MetroList Services, Inc. for the period Oct 1, 2026 through Oct 31, 2026.");
});

// ── 4. geographyCheck: exact area versus broader combined coverage ───────────────────────────────────────────────────────
const attest = (kind, scope, opts) => { const f = fx[kind](opts); return mr.readMarketReview(f.pages, { items: f.items, scope: mr.confirmScope(scope).confirmed, propertyTypes: mr.confirmPropertyTypes(SF).confirmed, dataThrough: kind === "yearly" ? "2026-10-31" : undefined }).facts; };
test("geographyCheck: an exact area matches only itself; combined and county reports are broader-market context, never a match for one part", () => {
  const one = attest("monthly", ROSE);
  assert.strictEqual(rl.geographyCheck(one, { type: "city", name: "Roseville" }).status, "match");
  assert.strictEqual(rl.geographyCheck(one, { type: "city", name: "Rocklin" }).status, "different");
  const combo = attest("monthly", { type: "cities", names: ["Roseville", "Rocklin", "Lincoln"] });
  for (const n of ["Roseville", "Rocklin", "Lincoln"]) {
    const g = rl.geographyCheck(combo, { type: "city", name: n });
    assert.strictEqual(g.status, "combined", n); assert.match(g.message, /combined market/); assert.match(g.message, /broader-market context/);
  }
  assert.strictEqual(rl.geographyCheck(combo, { type: "neighborhood", name: "Sunrise Ranch", city: "Roseville" }).status, "combined");
  const county = attest("monthly", { type: "county", names: ["Placer"] });
  assert.strictEqual(rl.geographyCheck(county, { type: "city", name: "Roseville" }).status, "combined");
  assert.strictEqual(rl.geographyCheck(county, { type: "county", name: "Placer County" }).status, "match");
  const zips = attest("monthly", { type: "zips", names: ["95678", "95661"] });
  assert.strictEqual(rl.geographyCheck(zips, { type: "zip", name: "95678" }).status, "combined");
  assert.strictEqual(rl.geographyCheck(attest("monthly", { type: "zips", names: ["95678"] }), { type: "zip", name: "95678" }).status, "match");
  // non-Market-Review layouts keep their old behavior
  assert.strictEqual(rl.geographyCheck({ geography: { cities: ["Roseville", "Rocklin"] } }, { type: "city", name: "Roseville" }).status, "match");
});

// ── 5. Research, topic freezing, Trend Intelligence ──────────────────────────────────────────────────────────────────────
test("an unconfirmed Market Review never enters Trend Intelligence; a confirmed one keeps its scope and period", () => {
  const f = fx.monthly();
  const raw = mr.readMarketReview(f.pages, { items: f.items }).facts;
  assert.strictEqual(rr.buildContext([{ id: "u1", facts: raw }], {}).reports.length, 0);
  const half = mr.readMarketReview(f.pages, { items: f.items, scope: mr.confirmScope(ROSE).confirmed }).facts;
  assert.strictEqual(rr.buildContext([{ id: "u1", facts: half }], {}).reports.length, 0, "property types are required as well");
  const ctx = rr.buildContext([{ id: "u1", facts: attest("monthly", { type: "cities", names: ["Roseville", "Rocklin"] }) }], { geography: CITY });
  assert.strictEqual(ctx.reports.length, 1);
  assert.strictEqual(ctx.reports[0].scopeKind, "combined");
  assert.strictEqual(ctx.reports[0].geoStatus, "combined");
  const a = ti.analyze(ctx);
  assert.ok(a.caveats.some((c) => /combined|broader market/i.test(c)));
});

const webTopic = (extra) => ({ origin: "web", sources: [{ title: "Local article", url: "https://example.com/a" }], question: "What does the new Foxwood project mean for sellers?", whyItMatters: "A new project opened.", trendSignals: [], editorial: { development: "Foxwood" }, ...extra });
test("topic freezing: figures carry their area and role; for a development topic even an exact-city figure is broader-market context", () => {
  const combo = rr.buildContext([{ id: "u1", facts: attest("monthly", { type: "cities", names: ["Roseville", "Rocklin"] }) }], {});
  const [t] = rr.applyReportPrecedence([webTopic()], combo);
  assert.ok(t.reportFigures.length && t.reportFigures.every((x) => x.role === "broader_market_context" && /^Roseville and Rocklin combined/.test(x.text) && /broader-market context/.test(x.text)));
  assert.deepStrictEqual(t.reportScope[0].places, ["Roseville", "Rocklin"]);
  assert.strictEqual(t.reportScope[0].scopeKind, "combined"); assert.strictEqual(t.reportScope[0].development, "Foxwood");
  const exact = rr.buildContext([{ id: "u1", facts: attest("monthly", ROSE) }], {});
  const [plain] = rr.applyReportPrecedence([webTopic({ editorial: {} })], exact);
  assert.ok(plain.reportFigures.every((x) => x.role === "area_statistic" && !/broader-market/.test(x.text)), "an exact area without a development is that area's own statistic");
  const [dev] = rr.applyReportPrecedence([webTopic()], exact);
  assert.ok(dev.reportFigures.every((x) => x.role === "broader_market_context" && /not the development's own/.test(x.text)));
  assert.ok(t.reportPeriods[0].label && t.reportPeriods[0].comparisons.length);
});

test("planner: rule 2m and the scope fields appear only for a scoped topic; every other prompt is unchanged", () => {
  const plan = require("../netlify/functions/lib/agent-marketing-plan-lib");
  assert.ok(!/REPORT SCOPE AND PERIOD/.test(plan.buildSystemPrompt()));
  assert.match(plan.buildSystemPrompt(undefined, { scoped: true }), /2m\. REPORT SCOPE AND PERIOD/);
  const ctx = rr.buildContext([{ id: "u1", facts: attest("monthly", { type: "cities", names: ["Roseville", "Rocklin"] }) }], {});
  const [t] = rr.applyReportPrecedence([webTopic()], ctx);
  const brief = plan.topicBrief(t, {});
  assert.deepStrictEqual(brief.report_scope[0], { area: "Roseville and Rocklin combined", kind: "combined", role: "broader_market_context", development: "Foxwood" });
  assert.ok(brief.report_periods[0].period && brief.figures_you_may_state.every((x) => /broader-market context/.test(x)));
  assert.ok(!("report_scope" in plan.topicBrief({ ...t, reportScope: undefined, reportPeriods: undefined }, {})), "no scope fields without a Market Review");
});

// ── 6. Final script validation (structural, with targeted phrase checks) ─────────────────────────────────────────────────
function scopeFor(facts, development) {
  const ctx = rr.buildContext([{ id: "u1", facts }], {});
  const [t] = rr.applyReportPrecedence([webTopic({ editorial: development ? { development } : {} })], ctx);
  return gate.verifiedFromTopic(t, {}).scope;
}
const scan = (text, scope) => { const blocks = []; gate.scanReportScope(text, "narration", scope, blocks); return blocks.map((b) => b.rule); };
const num = (facts, key) => rl.formatFigure(facts.figures.find((f) => f.key === key)).replace(/[^\d,.]/g, "");

test("script gate: a combined figure may not be stated for the development or for one constituent place, but may be stated as the combined market", () => {
  const facts = attest("monthly", { type: "cities", names: ["Roseville", "Rocklin"] });
  const sc = scopeFor(facts, "Foxwood");
  const n = num(facts, "count_closed");
  assert.ok(sc && sc.combined && sc.development === "Foxwood");
  assert.deepStrictEqual(scan(`Foxwood saw ${n} closed sales last month.`, sc), ["report_scope_development"]);
  assert.deepStrictEqual(scan(`Across Roseville and Rocklin combined, there were ${n} closed sales.`, sc), []);
  assert.deepStrictEqual(scan(`In the combined market, near Foxwood, there were ${n} closed sales.`, sc), []);
  const noDev = scopeFor(facts, null);
  assert.deepStrictEqual(scan(`Roseville had ${n} closed sales.`, noDev), ["report_scope_constituent"]);
  assert.deepStrictEqual(scan(`Roseville and Rocklin together had ${n} closed sales.`, noDev), []);
  assert.deepStrictEqual(scan("Roseville is a lovely place with 3 parks.", noDev), [], "a sentence that states no report figure is not touched");
});

test("script gate: a partial year is never a full year, and its counts are not compared with a completed year; legitimate comparisons are untouched", () => {
  const yearly = attest("yearly", ROSE);
  const sc = scopeFor(yearly, null);
  const n = num(yearly, "count_closed");
  assert.ok(sc.figures.some((f) => f.partial && f.partialComparison));
  assert.deepStrictEqual(scan(`There were ${n} closed sales for the full year.`, sc), ["report_partial_year"]);
  assert.deepStrictEqual(scan(`Closed sales were ${n}, down year-over-year.`, sc), ["report_partial_year"]);
  assert.deepStrictEqual(scan(`Closed sales were ${n} so far in 2026.`, sc), []);
  const q = attest("quarterly", ROSE);
  const qsc = scopeFor(q, null);
  assert.deepStrictEqual(scan(`Median price was ${num(q, "median_close_price")}, compared to the prior quarter.`, qsc), []);
  const m = attest("monthly", ROSE), msc = scopeFor(m, null);
  assert.deepStrictEqual(scan(`Median price was ${num(m, "median_close_price")}, up year-over-year.`, msc), [], "a like-with-like year-over-year comparison is not forbidden");
  assert.deepStrictEqual(scan(`There were ${num(m, "count_closed")} closed sales.`, null), []);
});

test("a partial year's counts are not offered as changes and the label says it is not a completed year", () => {
  const yearly = attest("yearly", ROSE);
  const ctx = rr.buildContext([{ id: "u1", facts: yearly }], {});
  const [t] = rr.applyReportPrecedence([webTopic({ editorial: {} })], ctx);
  assert.ok(t.reportFigures.every((x) => /not a completed year/.test(x.text)));
  assert.ok(t.reportFigures.find((x) => x.key === "count_closed").partialComparison);
  assert.strictEqual(t.reportPeriods[0].partial, true);
});

// ── Phase 3, step 1: carry-forward applies only to a report the earlier attestation still fits ───────────────────────────
test("carry-forward: not applied when the project's current area or property types contradict the earlier attestation", async () => {
  reset(); const p = mkProject();
  const first = (await upload(p, "monthly", { geography: CITY, propertyTypes: SF })).json.upload;
  assert.strictEqual((await call({ action: "confirm", uploadId: first.id, correct: true, scope: ROSE, propertyTypes: SF })).status, 200);
  const same = (await upload(p, "quarterly", { geography: CITY, propertyTypes: SF })).json.upload;
  assert.deepStrictEqual(same.summary.review.needed, [], "same header, same area and types: carried");
  const other = (await upload(p, "weekly", { geography: { type: "city", name: "Rocklin" } })).json.upload;
  assert.deepStrictEqual(other.summary.review.needed.sort(), ["geography", "propertyTypes"], "a different area is not covered by the earlier attestation");
  assert.strictEqual(other.summary.review.attested.carriedFrom, null);
  db.agent_marketing_uploads.pop();
  const types = (await upload(p, "weekly", { geography: CITY, propertyTypes: ["Condo"] })).json.upload;
  assert.ok(types.summary.review.needed.includes("propertyTypes"), "different property types are not carried");
});

test("carry-forward: a selection the subscriber changes at confirmation is theirs and is not recorded as carried", async () => {
  reset(); const p = mkProject();
  const first = (await upload(p, "monthly", { geography: CITY })).json.upload;
  await call({ action: "confirm", uploadId: first.id, correct: true, scope: ROSE, propertyTypes: SF });
  const second = (await upload(p, "quarterly", { geography: CITY })).json.upload;
  assert.ok(second.summary.review.attested.carriedFrom);
  const ok = await call({ action: "confirm", uploadId: second.id, correct: true, scope: { type: "cities", names: ["Roseville", "Rocklin"] }, propertyTypes: SF });
  assert.strictEqual(ok.status, 200);
  const f = db.agent_marketing_uploads.find((r) => r.id === second.id).facts;
  assert.strictEqual(f.attestation.carriedFrom, null);
  assert.strictEqual(f.geography.scopeKind, "combined");
  const unchanged = (await upload(p, "weekly", { geography: CITY })).json.upload;
  await call({ action: "confirm", uploadId: unchanged.id, correct: true, scope: ROSE, propertyTypes: SF });
  assert.ok(db.agent_marketing_uploads.find((r) => r.id === unchanged.id).facts.attestation.carriedFrom, "re-sending the same selection keeps it carried");
});

test("carry-forward: a header that contradicts the carried selection still requires acknowledgement", async () => {
  reset(); const p = mkProject();
  const first = (await upload(p, "monthly", { geography: CITY })).json.upload;
  await call({ action: "confirm", uploadId: first.id, correct: true, scope: ROSE, propertyTypes: SF });
  const cond = (await call({ action: "upload", projectId: p.id, fileName: "m.pdf", fileBase64: (await pdfFromItems(fx.monthly({ scopeLine: "Includes Condo in all Counties" }))).toString("base64"), permission: true, geography: CITY })).json.upload;
  assert.ok(cond.summary.review.needed.includes("propertyTypes") || cond.summary.review.needed.includes("conflicts"));
  assert.strictEqual(cond.summary.review.canConfirm, false);
});

// ── Phase 3 review: deterministic scope/period safeguards stay on when creative editorial checks are relaxed ──────────────────
test("Test environment: creative editorial checks are relaxed, but geographic-attribution and partial-year checks still block", () => {
  const combo = attest("monthly", { type: "cities", names: ["Roseville", "Rocklin"] });
  const yearly = attest("yearly", ROSE);
  const topic = (facts, dev) => { const ctx = rr.buildContext([{ id: "u1", facts }], {}); return rr.applyReportPrecedence([webTopic({ editorial: dev ? { development: dev } : {} })], ctx)[0]; };
  const run = (t, text, keep) => gate.evaluate({ template: "local_market_insider", intake: {}, verified: gate.verifiedFromProject({ template: "local_market_insider", selected_topic: t }), generated: { narration: text, captions: "" }, cta: { text: "Ask me.", source: "claude" }, ...(keep ? { keepEditorialChecks: true } : {}) }).blocks.map((b) => b.rule);
  const saved = { b1: process.env.AGENT_MARKETING_B1_EVIDENCE, db: process.env.SUPABASE_URL };
  try {
    Object.assign(process.env, { AGENT_MARKETING_B1_EVIDENCE: "dev", SUPABASE_URL: "https://notprod.supabase.co" });
    assert.strictEqual(gate.testEvaluation(), true, "this is the relaxed Test environment");
    const n = num(combo, "count_closed"), ny = num(yearly, "count_closed");
    assert.ok(run(topic(combo, "Foxwood"), `Foxwood saw ${n} closed sales last month.`).includes("report_scope_development"));
    assert.ok(run(topic(combo, null), `Roseville had ${n} closed sales.`).includes("report_scope_constituent"));
    assert.ok(run(topic(yearly, null), `There were ${ny} closed sales for the full year.`).includes("report_partial_year"));
    assert.ok(run(topic(yearly, null), `Closed sales were ${ny}, down year-over-year.`).includes("report_partial_year"));
    assert.deepStrictEqual(run(topic(combo, "Foxwood"), `Across Roseville and Rocklin combined there were ${n} closed sales.`).filter((r) => /^report_scope/.test(r)), []);
    // the creative editorial checks remain relaxed there: a superseded web figure is not blocked (report_priority is an editorial check)
    const prec = { ...topic(combo, null), reportPrecedence: [{ key: "count_closed", label: "Closed sales", reportText: "Closed sales: 1", supersededNumbers: ["777"] }] };
    assert.ok(!run(prec, "Closed sales were 777 last month.").includes("report_priority"));
    assert.ok(run(prec, "Closed sales were 777 last month.", true).includes("report_priority"), "and it still runs when the editorial checks are kept");
  } finally { for (const [k, v] of [["AGENT_MARKETING_B1_EVIDENCE", saved.b1], ["SUPABASE_URL", saved.db]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});
