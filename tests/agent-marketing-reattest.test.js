// Editing a confirmed report's attestations (area, property types, the subscriber's own data-through date) without re-uploading the file.
// The extracted figures and document metadata must not move; the existing attestation and conflict checks apply; and anything made under the
// OLD attestation (research sets, the selected topic, its script) is marked, never silently kept.
const test = require("node:test");
const assert = require("node:assert");
const PDFDocument = require("pdfkit");
const fx = require("./helpers/market-review-fixture");

const U1 = "11111111-1111-4111-8111-111111111111";
const db = { agent_marketing_projects: [], agent_marketing_uploads: [], agent_marketing_feedback: [], agent_marketing_research: [] };
let nextId = 1;
const uuid = (n) => `eeeeeeee-eeee-4eee-8eee-${String(n).padStart(12, "0")}`;
function fakeSupabase(method, table, body, qs = "") {
  const rows = db[table];
  if (!rows) throw new Error("unexpected table " + table);
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
const researchHandler = require("../netlify/functions/agent-marketing-research").handler;
const projectHandler = require("../netlify/functions/agent-marketing-project").handler;
const mr = require("../netlify/functions/lib/agent-marketing-market-review-lib");

const post = (h) => async (body) => { const res = await h({ httpMethod: "POST", headers: {}, body: JSON.stringify(body), queryStringParameters: null }); return { status: res.statusCode, json: JSON.parse(res.body) }; };
const call = post(handler), callResearch = post(researchHandler), callProject = post(projectHandler);
const getResearch = async (projectId) => { const res = await researchHandler({ httpMethod: "GET", headers: {}, body: null, queryStringParameters: { projectId } }); return { status: res.statusCode, json: JSON.parse(res.body) }; };
const mkProject = (over) => { const row = { id: uuid(nextId++), user_id: U1, template: "local_market_insider", status: "draft", intake: {}, ...over }; db.agent_marketing_projects.push(row); return row; };
const reset = () => { Object.values(db).forEach((a) => (a.length = 0)); process.env.AGENT_MARKETING_ENABLED = "true"; delete process.env.AGENT_MARKETING_USER_IDS; process.env.AGENT_MARKETING_MARKET_REVIEW = "dev"; };

const cache = {};
function pdfFrom(f) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 0, size: [612, 842] }), chunks = [];
    doc.on("data", (c) => chunks.push(c)); doc.on("end", () => resolve(Buffer.concat(chunks))); doc.fontSize(8);
    f.items.forEach((i) => { if (i.s === "↑") return; const w = doc.widthOfString(i.s); doc.text(i.s, i.x - w / 2, i.y - 6, { lineBreak: false }); });
    doc.end();
  });
}
const b64 = async (kind, opts) => { const k = kind + JSON.stringify(opts || {}); return (cache[k] = cache[k] || (await pdfFrom(fx[kind](opts))).toString("base64")); };
const SF = ["Single Family Homes"], ROSE = { type: "city", names: ["Roseville"] }, COMBINED = { type: "cities", names: ["Roseville", "Rocklin"] };
const CITY = { type: "city", name: "Roseville" };

/** A confirmed report on a fresh project; returns { p, id }. */
async function confirmed(kind = "monthly", opts, extra = {}) {
  const p = mkProject();
  const up = await call({ action: "upload", projectId: p.id, fileName: `${kind}.pdf`, fileBase64: await b64(kind, opts), permission: true, geography: CITY });
  assert.strictEqual(up.status, 201, JSON.stringify(up.json));
  const c = await call({ action: "confirm", uploadId: up.json.upload.id, correct: true, scope: ROSE, propertyTypes: SF, ...extra });
  assert.strictEqual(c.status, 200, JSON.stringify(c.json));
  return { p, id: up.json.upload.id };
}
const row = (id) => db.agent_marketing_uploads.find((u) => u.id === id);
const edit = (id, over) => call({ action: "reattest", uploadId: id, scope: ROSE, propertyTypes: SF, ...over });

test("editing the area and property types updates only the attestation: figures and document metadata are untouched", async () => {
  reset();
  const { id } = await confirmed();
  const before = JSON.parse(JSON.stringify(row(id).facts));
  const r = await edit(id, { scope: COMBINED, propertyTypes: ["Single Family Homes", "Condo"] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.unchanged, false);
  const after = row(id).facts;
  assert.deepStrictEqual(after.figures, before.figures, "extracted statistics are exactly as read");
  assert.deepStrictEqual(after.period.comparisons, before.period.comparisons);
  assert.strictEqual(after.period.label, before.period.label);
  assert.deepStrictEqual(after.geography.displayed, before.geography.displayed, "the printed header is kept as displayed");
  assert.strictEqual(after.propertyTypeScope.displayed, before.propertyTypeScope.displayed);
  assert.strictEqual(after.geography.areaLabel, "Roseville and Rocklin combined");
  assert.strictEqual(after.geography.scopeKind, "combined");
  assert.deepStrictEqual(after.attestation.propertyTypes.names, ["Single Family Homes", "Condo"]);
  assert.strictEqual(after.attestation.revisions, 1);
  assert.ok(after.attestation.revisedAt);
  assert.strictEqual(row(id).status, "confirmed", "it stays confirmed");
  assert.match(row(id).scope_note, /Roseville and Rocklin/);
  assert.strictEqual(r.json.upload.summary.review.attested.geography.scopeKind, "combined");
});

test("saving the same attestation again changes nothing and invalidates nothing", async () => {
  reset();
  const { p, id } = await confirmed();
  const res = mkResearch(p, id);
  const r = await edit(id, {});
  assert.strictEqual(r.status, 200); assert.strictEqual(r.json.unchanged, true);
  assert.strictEqual(r.json.revalidation.researchSets, 0);
  assert.ok(!res.upload_refs[0].outdated, "no set is marked");
  assert.strictEqual(row(id).facts.attestation.revisions, undefined);
});

test("the same validation as confirmation applies: scope and property types are required and well-formed", async () => {
  reset();
  const { id } = await confirmed();
  const none = await call({ action: "reattest", uploadId: id, propertyTypes: SF });
  assert.strictEqual(none.status, 400); assert.strictEqual(none.json.code, "scope_needed");
  const noTypes = await call({ action: "reattest", uploadId: id, scope: ROSE });
  assert.strictEqual(noTypes.status, 400); assert.strictEqual(noTypes.json.code, "property_types_needed");
  const blank = await edit(id, { scope: { type: "city", names: [] } });
  assert.strictEqual(blank.status, 400);
  assert.deepStrictEqual(row(id).facts.attestation.scope.names, ["Roseville"], "a refused edit leaves the confirmation as it was");
});

test("only a confirmed Market Review can be edited; a switch-off, an unknown report and a finished piece are refused", async () => {
  reset();
  const p = mkProject();
  const up = await call({ action: "upload", projectId: p.id, fileName: "m.pdf", fileBase64: await b64("monthly"), permission: true, geography: CITY });
  const pending = await edit(up.json.upload.id, {});
  assert.strictEqual(pending.status, 409, "an unconfirmed report is confirmed, not edited");
  const { id, p: p2 } = await confirmed();
  p2.status = "rendering";
  assert.strictEqual((await edit(id, { scope: COMBINED })).status, 409, "a piece that is rendering cannot change");
  p2.status = "draft";
  assert.strictEqual((await call({ action: "reattest", uploadId: "nope", scope: ROSE, propertyTypes: SF })).status, 404);
  row(id).facts = { ...row(id).facts, layout: "cma_table" };
  const notMr = await edit(id, {});
  assert.strictEqual(notMr.status, 409); assert.strictEqual(notMr.json.code, "not_editable");
  row(id).facts.layout = "market_review";
  delete process.env.AGENT_MARKETING_MARKET_REVIEW;
  assert.strictEqual((await edit(id, { scope: COMBINED })).status, 404, "off by default");
  process.env.AGENT_MARKETING_MARKET_REVIEW = "dev";
});

test("conflicts: a header that contradicts the new selection must be acknowledged again, and an earlier acknowledgement is never carried over", async () => {
  reset();
  // A report whose header says Condo, confirmed once with the conflict acknowledged.
  const { id } = await confirmed("monthly", { scopeLine: "Includes Condo in all Counties" }, { acknowledgeConflicts: true });
  assert.strictEqual(row(id).facts.confirmation.conflictsAcknowledged, true);
  const keep = JSON.stringify(row(id).facts);
  const refused = await edit(id, { scope: COMBINED });
  assert.strictEqual(refused.status, 409, JSON.stringify(refused.json));
  assert.strictEqual(refused.json.code, "confirmation_needed");
  assert.ok(refused.json.needed.includes("conflicts"));
  assert.ok(refused.json.review.attested.conflicts.length > 0, "the conflict is returned so the form can show it");
  assert.strictEqual(JSON.stringify(row(id).facts), keep, "nothing is saved while the conflict is unacknowledged");
  const ok = await edit(id, { scope: COMBINED, acknowledgeConflicts: true });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
  assert.strictEqual(row(id).facts.geography.areaLabel, "Roseville and Rocklin combined");
});

test("partial year: the subscriber's own data-through date can be revised; an impossible one is refused; leaving it blank keeps the last", async () => {
  reset();
  const { id } = await confirmed("yearly", undefined, { dataThrough: "2026-10-15" });
  assert.strictEqual(row(id).facts.attestation.dataThrough.provenance, "subscriber_attested");
  const figures = JSON.stringify(row(id).facts.figures);
  const r = await edit(id, { dataThrough: "2026-09-30" });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(row(id).facts.attestation.dataThrough.date, "2026-09-30");
  assert.strictEqual(row(id).facts.attestation.dataThrough.provenance, "subscriber_attested");
  assert.strictEqual(row(id).facts.period.coverage.independentlyVerified, false, "still recorded as unverified");
  assert.strictEqual(row(id).facts.period.disclosureEnd, "2026-09-30", "the MetroList period follows the new date");
  assert.strictEqual(JSON.stringify(row(id).facts.figures), figures);
  const bad = await edit(id, { dataThrough: "2027-03-01" });
  assert.strictEqual(bad.status, 400); assert.strictEqual(bad.json.code, "bad_data_through");
  assert.strictEqual(row(id).facts.attestation.dataThrough.date, "2026-09-30", "a refused date changes nothing");
  const same = await edit(id, {});
  assert.strictEqual(same.json.unchanged, true, "no date typed: the previous one stands");
});

function mkResearch(p, uploadId, over = {}) {
  const r = { id: uuid(nextId++), project_id: p.id, user_id: U1, status: "ready", mode: "market_update", audience: "buyers", geography: { type: "city", name: "Roseville" }, focus: {}, data_source: "both", topics: [{ id: "t1", question: "Q", researchId: null }], upload_refs: [{ id: uploadId, scope_note: "old" }], created_at: new Date().toISOString(), ...over };
  db.agent_marketing_research.push(r); return r;
}

test("downstream: sets, the selected topic and its approved script are marked when the attestation changes; unrelated sets are not", async () => {
  reset();
  const { p, id } = await confirmed();
  const a = mkResearch(p, id), b = mkResearch(p, id), other = mkResearch(p, uuid(9999)), none = mkResearch(p, id, { upload_refs: [] });
  Object.assign(p, { selected_research_id: a.id, selected_topic: { id: "t1", researchId: a.id, question: "Q" }, status: "narrative_approved", intake: { market: "Roseville" }, narrative: { narrationTagged: true, intakeHash: "x", scenes: [] }, narrative_approved: { approvedAt: "x" } });
  const r = await edit(id, { scope: COMBINED });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.deepStrictEqual(r.json.revalidation, { researchSets: 2, restoredSets: 0, topicSelected: true, topicRestored: false, scriptMarked: true, scriptReopened: true });
  for (const x of [a, b]) {
    assert.ok(x.upload_refs[0].outdated, "marked");
    assert.strictEqual(x.upload_refs[0].outdated.was.area, "Roseville");
    assert.strictEqual(x.upload_refs[0].outdated.now.area, "Roseville and Rocklin combined");
  }
  assert.ok(!other.upload_refs[0].outdated && !none.upload_refs.length, "sets that did not use this report are left alone");
  assert.ok(p.selected_topic.reportOutdated, "the selected topic carries the flag");
  assert.strictEqual(p.status, "draft", "an approved script drops back to a draft");
  assert.ok(p.narrative && p.narrative.narrationTagged, "the script is kept for the subscriber to see, never deleted");
  assert.strictEqual(a.topics.length, 1, "the old topics are kept, only flagged");
});

test("downstream: nothing marked means the message says so; a topic from another report is not touched", async () => {
  reset();
  const { p, id } = await confirmed();
  Object.assign(p, { selected_research_id: "zzz", selected_topic: { id: "t9", researchId: "zzz" }, status: "draft" });
  const r = await edit(id, { scope: COMBINED });
  assert.deepStrictEqual(r.json.revalidation, { researchSets: 0, restoredSets: 0, topicSelected: false, topicRestored: false, scriptMarked: false, scriptReopened: false });
  assert.ok(!p.selected_topic.reportOutdated);
});

test("an outdated set cannot be chosen, is reported to the page as outdated, and an outdated selected topic stops intake, planning and approval", async () => {
  reset();
  const { p, id } = await confirmed();
  const a = mkResearch(p, id);
  Object.assign(p, { selected_research_id: a.id, selected_topic: { id: "t1", researchId: a.id, question: "Q" }, intake: { market: "Roseville" } });
  await edit(id, { scope: COMBINED });
  const list = await getResearch(p.id);
  assert.strictEqual(list.status, 200, JSON.stringify(list.json));
  const mine = (list.json.research || []).find((x) => x.id === a.id);
  assert.ok(mine && mine.reportOutdated && mine.reportOutdated.now.area === "Roseville and Rocklin combined", "the page is told the set is outdated");
  const sel = await callResearch({ action: "select", projectId: p.id, researchId: a.id, topicId: "t1" });
  assert.strictEqual(sel.status, 409); assert.strictEqual(sel.json.code, "report_changed");
  for (const action of ["save_intake", "plan", "approve_narrative", "save_narrative"]) {
    const x = await callProject({ action, id: p.id, intake: {}, narrative: {} });
    assert.strictEqual(x.status, 409, action); assert.strictEqual(x.json.code, "report_changed", action);
  }
});

test("an outdated set is never reopened as 'the same request'; the source says so and the confirm/research billing code is untouched", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "netlify/functions/agent-marketing-research.js"), "utf8");
  assert.match(src, /r\.status === "ready" && !outdatedRef\(r\) && keyOfRow\(r\) === wantKey/);
  const rep = require("fs").readFileSync(require("path").join(__dirname, "..", "netlify/functions/agent-marketing-report.js"), "utf8");
  const act = rep.slice(rep.indexOf('if (action === "reattest")'), rep.indexOf('if (action === "confirm" || action === "remove")'));
  assert.doesNotMatch(act, /charge|debit|session|quota|credit/i, "editing a confirmation never touches research sessions or credits");
  assert.doesNotMatch(act, /agent_marketing_uploads", \{ *project_id/, "no new copy of the report is stored");
});

// ── Returning to the exact original context ──
test("reverting to the exact original confirmation restores the sets made under it, leaves other sets alone, and starts no research", async () => {
  reset();
  const { p, id } = await confirmed();
  const a = mkResearch(p, id), unrelated = mkResearch(p, uuid(9999));
  Object.assign(p, { selected_research_id: a.id, selected_topic: { id: "t1", researchId: a.id, question: "Q" }, status: "narrative_approved", intake: { market: "Roseville" }, narrative: { narrationTagged: "x", intakeHash: "h", scenes: [] } });
  const rowsBefore = db.agent_marketing_research.length;
  assert.strictEqual((await edit(id, { scope: COMBINED })).status, 200);
  assert.ok(a.upload_refs[0].outdated && p.selected_topic.reportOutdated);
  const back = await edit(id, {});   // same area, same types as the original
  assert.strictEqual(back.status, 200, JSON.stringify(back.json));
  assert.strictEqual(back.json.unchanged, false, "it is a change from the combined version");
  assert.strictEqual(back.json.revalidation.restoredSets, 1);
  assert.strictEqual(back.json.revalidation.topicRestored, true);
  assert.ok(!a.upload_refs[0].outdated, "the set is eligible again");
  assert.ok(!p.selected_topic.reportOutdated, "the chosen topic is valid again");
  assert.strictEqual(p.status, "draft", "the script is NOT re-approved for the subscriber");
  assert.ok(!unrelated.upload_refs[0].outdated, "unrelated sets were never touched");
  assert.strictEqual(db.agent_marketing_research.length, rowsBefore, "no research was started or created");
  const list = await getResearch(p.id);
  assert.ok(!(list.json.research || []).find((x) => x.id === a.id).reportOutdated);
  const sel = await callResearch({ action: "select", projectId: p.id, researchId: a.id, topicId: "t1" });
  assert.notStrictEqual(sel.json.code, "report_changed", "choosing a restored topic is allowed again");
});

test("a different change is not a revert: sets stay out of date, 'was' keeps pointing at the original, and a name that merely looks similar does not restore", async () => {
  reset();
  const { p, id } = await confirmed();
  const a = mkResearch(p, id);
  await edit(id, { scope: COMBINED });
  const origWas = a.upload_refs[0].outdated.was.area;
  const r2 = await edit(id, { scope: { type: "cities", names: ["Roseville", "Granite Bay"] } });
  assert.strictEqual(r2.json.revalidation.restoredSets, 0);
  assert.ok(a.upload_refs[0].outdated, "still out of date");
  assert.strictEqual(a.upload_refs[0].outdated.was.area, origWas, "the original context is what the banner compares against");
  assert.strictEqual(a.upload_refs[0].outdated.now.area, "Roseville and Granite Bay combined");
  // same market name, different property types: not the original context
  const r3 = await edit(id, { propertyTypes: ["Condo"] });
  assert.strictEqual(r3.json.revalidation.restoredSets, 0); assert.ok(a.upload_refs[0].outdated);
  // exact original again
  const r4 = await edit(id, {});
  assert.strictEqual(r4.json.revalidation.restoredSets, 1); assert.ok(!a.upload_refs[0].outdated);
});

test("a set made AFTER an edit belongs to the edited context: it is marked when the context changes again, and restored only for that exact context", async () => {
  reset();
  const { p, id } = await confirmed();
  const old = mkResearch(p, id);
  await edit(id, { scope: COMBINED });
  const fresh = mkResearch(p, id);   // researched under the combined context
  await edit(id, {});                 // back to the original
  assert.ok(!old.upload_refs[0].outdated, "original set restored");
  assert.ok(fresh.upload_refs[0].outdated, "the combined-market set is now the out-of-date one");
  await edit(id, { scope: COMBINED });
  assert.ok(old.upload_refs[0].outdated && !fresh.upload_refs[0].outdated, "and the other way round");
});

test("a changed data-through date is a material change and a revert to the original date restores", async () => {
  reset();
  const { p, id } = await confirmed("yearly", undefined, { dataThrough: "2026-10-15" });
  const a = mkResearch(p, id);
  await edit(id, { dataThrough: "2026-09-30" });
  assert.ok(a.upload_refs[0].outdated);
  const back = await edit(id, { dataThrough: "2026-10-15" });
  assert.strictEqual(back.json.revalidation.restoredSets, 1); assert.ok(!a.upload_refs[0].outdated);
});

test("billing is untouched: the edit path creates no research, and the confirm-and-research code has no knowledge of restoration", () => {
  const rep = require("fs").readFileSync(require("path").join(__dirname, "..", "netlify/functions/agent-marketing-report.js"), "utf8");
  const md = rep.slice(rep.indexOf("async function markDependents"), rep.indexOf("async function loadUpload"));
  assert.doesNotMatch(md, /"POST", "agent_marketing_research"|charged|session|quota|credit/i);
  const res = require("fs").readFileSync(require("path").join(__dirname, "..", "netlify/functions/agent-marketing-research.js"), "utf8");
  assert.doesNotMatch(res, /restoredSets|wasFp/, "reuse and billing look only at whether a set is currently flagged");
});
