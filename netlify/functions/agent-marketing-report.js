// agent-marketing-report.js — Netlify Function. Local Market Insider: the agent's own MLS report or CMA (Oct 24, 2026).
// Behind AGENT_MARKETING_ENABLED (see lib/agent-marketing-lib.js): when the switch is off, or the user is not allowed,
// every call answers 404 as if the endpoint did not exist.
//
//   GET  ?projectId=<uuid>
//        → { uploads: [ { id, status, kind, summary } ] }   (this project's reports, newest first)
//   POST { action: "upload", projectId, fileName, fileBase64, permission: true, geography? }
//        → 201 { upload }   The file is read in memory and only its market-level figures are kept. The agent must still confirm.
//   POST { action: "confirm", uploadId, correct: true | false }
//        → correct true: the report becomes usable (status "confirmed"); false: it is deleted.
//   POST { action: "reattest", uploadId, scope, propertyTypes, dataThrough?, acknowledgeConflicts? }
//        → a Market Review that is already confirmed: the subscriber revises the area, property types or their own data-through date. The same
//          attestation and conflict checks as "confirm" run; the extracted figures and document metadata are never touched. If the attestation really
//          changed, research sets made with the old one, the selected topic and its script are marked for revalidation (see markDependents).
//   POST { action: "remove", uploadId }
//        → deletes the stored figures.
//
// What is stored: figures only (see lib/agent-marketing-report-lib.js). The file, its text, its name and anything that names a
// person or a property are never stored, logged or returned. The permission checkbox is required for every upload and its
// timestamp and version are saved with the figures.
const { supabase } = require("./lib/marketing-profile-lib");
const { requireUser } = require("./lib/reel-auth-lib");
const am = require("./lib/agent-marketing-lib");
const rl = require("./lib/agent-marketing-research-lib");
const lib = require("./lib/agent-marketing-report-lib");
const readLib = require("./lib/agent-marketing-report-read-lib");
const mr = require("./lib/agent-marketing-market-review-lib");

const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Cache-Control": "no-store" };
const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });
const MAX_BASE64_CHARS = Math.ceil(readLib.MAX_BYTES / 3) * 4 + 16;

function forClient(row, geography) {
  if (!row) return null;
  return { id: row.id, projectId: row.project_id, status: row.status, kind: row.file_kind, createdAt: row.created_at, confirmedAt: row.confirmed_at || null, summary: lib.summarize(row.facts, { geography }) };
}

async function loadProject(id, userId) {
  if (!am.UUID_RE.test(String(id || ""))) return { error: reply(400, { error: "Missing or invalid project id" }) };
  const r = await supabase("GET", "agent_marketing_projects", null, `?id=eq.${id}&user_id=eq.${userId}&select=*&limit=1`);
  const row = Array.isArray(r.data) ? r.data[0] : null;
  if (!row) return { error: reply(404, { error: "Project not found" }) };
  return { row };
}

// Other reports in this project, for cross-report support of a partial year's coverage date (a matching year-to-date report).
async function companionReports(projectId, userId, exceptId) {
  const r = await supabase("GET", "agent_marketing_uploads", null, `?project_id=eq.${projectId}&user_id=eq.${userId}&select=id,facts,status&limit=10`);
  return (Array.isArray(r.data) ? r.data : []).filter((x) => x.id !== exceptId && x.facts && x.facts.layout === "market_review").map((x) => x.facts);
}


// Everything made from this report under its OLD attestation is marked, not deleted and not quietly kept: research sets that used it get
// an "outdated" flag on their report reference, the selected topic (if it came from one of them) gets the same flag, and an approved script
// drops back to a draft. Nothing here is a new table: the flags live in the existing upload_refs and selected_topic JSON.
async function markDependents(project, userId, uploadId, flag) {
  const rr = await supabase("GET", "agent_marketing_research", null, `?project_id=eq.${project.id}&user_id=eq.${userId}&select=id,upload_refs`);
  const hit = (Array.isArray(rr.data) ? rr.data : []).filter((r) => Array.isArray(r.upload_refs) && r.upload_refs.some((x) => x && x.id === uploadId));
  const now = new Date().toISOString();
  for (const r of hit) {
    await supabase("PATCH", "agent_marketing_research", { upload_refs: r.upload_refs.map((x) => (x && x.id === uploadId ? { ...x, outdated: flag } : x)), updated_at: now }, `?id=eq.${r.id}&user_id=eq.${userId}`);
  }
  const ids = new Set(hit.map((r) => r.id));
  const sel = project.selected_topic;
  const out = { researchSets: hit.length, topicSelected: false, scriptMarked: false, scriptReopened: false };
  if (sel && typeof sel === "object" && (ids.has(sel.researchId) || ids.has(project.selected_research_id))) {
    const fields = { selected_topic: { ...sel, reportOutdated: flag }, updated_at: now };
    out.topicSelected = true;
    out.scriptMarked = !!(project.narrative && project.narrative.narrationTagged);
    if (["narrative_approved", "images"].includes(project.status)) { fields.status = "draft"; out.scriptReopened = true; }
    await supabase("PATCH", "agent_marketing_projects", fields, `?id=eq.${project.id}&user_id=eq.${userId}`);
  }
  return out;
}

async function loadUpload(id, userId) {
  if (!am.UUID_RE.test(String(id || ""))) return null;
  const r = await supabase("GET", "agent_marketing_uploads", null, `?id=eq.${id}&user_id=eq.${userId}&select=*&limit=1`);
  return Array.isArray(r.data) ? r.data[0] || null : null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" }, body: "" };
  const auth = await requireUser(event);
  if (auth.error) return reply(auth.error.status, auth.error.body);
  const userId = auth.user.id;
  if (!am.isEnabledFor(userId)) return reply(404, { error: "Not found" });

  try {
    if (event.httpMethod === "GET") {
      const qs = event.queryStringParameters || {};
      if (qs.schema) return reply(200, { maxBytes: readLib.MAX_BYTES, maxUploads: rl.MAX_UPLOADS, permissionText: lib.PERMISSION_TEXT, accepts: ["pdf", "csv", "xlsx"] });
      const p = await loadProject(qs.projectId, userId);
      if (p.error) return p.error;
      const r = await supabase("GET", "agent_marketing_uploads", null, `?project_id=eq.${p.row.id}&user_id=eq.${userId}&select=*&order=created_at.desc&limit=10`);
      return reply(200, { uploads: (Array.isArray(r.data) ? r.data : []).map((row) => forClient(row)) });
    }

    if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" });
    if ((event.body || "").length > MAX_BASE64_CHARS + 4096) return reply(413, { error: "That file is larger than 4 MB. Try one property type or a shorter date range.", code: "too_big" });
    let b;
    try { b = JSON.parse(event.body || "{}"); } catch { return reply(400, { error: "Invalid JSON" }); }
    const action = String(b.action || "");
    if (!["upload", "confirm", "remove", "feedback", "reattest"].includes(action)) return reply(400, { error: "Unknown action" });

    // "Not right": the agent says what is wrong (reasons and a short note). The note is kept for us with a small, file-free context, and the
    // report is removed exactly as "Not right, remove" always did.
    if (action === "feedback") {
      const up = await loadUpload(b.uploadId, userId);
      if (!up) return reply(404, { error: "That report was not found." });
      const p = await loadProject(up.project_id, userId);
      if (p.error) return p.error;
      if (am.NOT_EDITABLE_AFTER.includes(p.row.status)) return reply(409, { error: "This piece is already rendering or finished. Start a new one to change it." });
      const fb = lib.cleanFeedback(b);
      if (fb.error) return reply(400, { error: fb.error });
      const ctx = lib.feedbackContext(up.facts);
      const ins = await supabase("POST", "agent_marketing_feedback", { project_id: p.row.id, user_id: userId, stage: "report", reasons: fb.reasons, message: fb.message, context: ctx });
      if (ins.status >= 300) console.error("agent-marketing-report feedback insert failed:", ins.status, JSON.stringify(ins.data).slice(0, 200));
      await supabase("DELETE", "agent_marketing_uploads", null, `?id=eq.${up.id}&user_id=eq.${userId}`);
      return reply(200, { removed: true, saved: ins.status < 300 });
    }

    // Edit a confirmation: the subscriber revises what THEY attested about an already-confirmed Market Review. No new upload, no new storage.
    if (action === "reattest") {
      if (!am.marketReviewEnabled()) return reply(404, { error: "Not found" });
      const up = await loadUpload(b.uploadId, userId);
      if (!up) return reply(404, { error: "That report was not found." });
      const p = await loadProject(up.project_id, userId);
      if (p.error) return p.error;
      if (am.NOT_EDITABLE_AFTER.includes(p.row.status)) return reply(409, { error: "This piece is already rendering or finished. Start a new one to change it." });
      if (up.status !== "confirmed") return reply(409, { error: "Confirm the report first." });
      if (!up.facts || up.facts.layout !== "market_review") return reply(409, { error: "Only a Market Review's confirmation can be edited. Replace the report instead.", code: "not_editable" });
      const sc = mr.confirmScope(b.scope); if (!sc.ok) return reply(400, { error: sc.question, code: "scope_needed" });
      const pt = mr.confirmPropertyTypes(b.propertyTypes); if (!pt.ok) return reply(400, { error: pt.question, code: "property_types_needed" });
      const extra = { scope: sc.confirmed, propertyTypes: pt.confirmed, acknowledgeConflicts: b.acknowledgeConflicts === true };   // an acknowledgement is never carried over: conflicts are re-read against the new selection
      if (b.dataThrough != null && b.dataThrough !== "") extra.dataThrough = String(b.dataThrough).slice(0, 10);
      extra.companions = await companionReports(p.row.id, userId, up.id);
      const was = mr.attestationSummary(up.facts), wasPrint = mr.attestationFingerprint(up.facts), priorRevs = (up.facts.attestation && up.facts.attestation.revisions) || 0;   // read before reapply, which must never be trusted to leave its input alone
      const next = mr.reapply(JSON.parse(JSON.stringify(up.facts)), extra);
      if (next.error === "bad_data_through") return reply(400, { error: next.message, code: "bad_data_through", review: mr.readBackView(next.facts) });
      if (next.error) return reply(422, { error: "That change could not be saved." });
      if (next.facts.confirmation.needed.length) return reply(409, { error: next.facts.confirmation.question || "Confirm the details before this change can be saved.", code: "confirmation_needed", needed: next.facts.confirmation.needed, review: mr.readBackView(next.facts) });
      if (mr.attestationFingerprint(next.facts) === wasPrint) return reply(200, { upload: forClient(up), unchanged: true, revalidation: { researchSets: 0, topicSelected: false, scriptMarked: false, scriptReopened: false } });
      const now = new Date().toISOString(), prior = priorRevs;
      next.facts.attestation = { ...next.facts.attestation, revisedAt: now, revisions: prior + 1 };
      const saved = await supabase("PATCH", "agent_marketing_uploads", { facts: next.facts, scope_note: lib.scopeNote(next.facts), updated_at: now }, `?id=eq.${up.id}&user_id=eq.${userId}&status=eq.confirmed`);
      const row = Array.isArray(saved.data) ? saved.data[0] : null;
      if (saved.status >= 300 || !row) return reply(500, { error: "Could not save your change" });
      const revalidation = await markDependents(p.row, userId, up.id, { at: now, was, now: mr.attestationSummary(next.facts) });
      return reply(200, { upload: forClient(row), unchanged: false, revalidation });
    }

    if (action === "confirm" || action === "remove") {
      const up = await loadUpload(b.uploadId, userId);
      if (!up) return reply(404, { error: "That report was not found." });
      const p = await loadProject(up.project_id, userId);
      if (p.error) return p.error;
      if (am.NOT_EDITABLE_AFTER.includes(p.row.status)) return reply(409, { error: "This piece is already rendering or finished. Start a new one to change it." });
      if (action === "remove" || b.correct === false) {
        await supabase("DELETE", "agent_marketing_uploads", null, `?id=eq.${up.id}&user_id=eq.${userId}`);
        return reply(200, { removed: true });
      }
      if (b.correct !== true) return reply(400, { error: "Say whether the summary is correct." });
      const now = new Date().toISOString();
      const patch = { status: "confirmed", confirmed_at: now, updated_at: now };
      if (up.facts && up.facts.layout === "market_review") {
        // Development switch: a Market Review only becomes usable once the subscriber has attested the area and property types. Those are the
        // subscriber's statements about the report's filters; they are stored beside what the document reported and never described as verified.
        if (!am.marketReviewEnabled()) return reply(404, { error: "Not found" });
        const extra = {};
        if (b.scope != null) { const sc = mr.confirmScope(b.scope); if (!sc.ok) return reply(400, { error: sc.question, code: "scope_needed" }); extra.scope = sc.confirmed; }
        if (b.propertyTypes != null) { const pt = mr.confirmPropertyTypes(b.propertyTypes); if (!pt.ok) return reply(400, { error: pt.question, code: "property_types_needed" }); extra.propertyTypes = pt.confirmed; }
        if (b.dataThrough != null && b.dataThrough !== "") extra.dataThrough = String(b.dataThrough).slice(0, 10);
        if (b.acknowledgeConflicts === true) extra.acknowledgeConflicts = true;
        extra.companions = await companionReports(p.row.id, userId, up.id);
        const next = mr.reapply(up.facts, extra);
        if (next.error === "bad_data_through") return reply(400, { error: next.message, code: "bad_data_through", review: mr.readBackView(next.facts) });
        if (next.error) return reply(422, { error: "That report could not be confirmed." });
        if (next.facts.confirmation.needed.length) return reply(409, { error: next.facts.confirmation.question || "Confirm the details below before this report can be used.", code: "confirmation_needed", needed: next.facts.confirmation.needed, review: mr.readBackView(next.facts) });
        patch.facts = next.facts;
        patch.scope_note = lib.scopeNote(next.facts);
      }
      const saved = await supabase("PATCH", "agent_marketing_uploads", patch, `?id=eq.${up.id}&user_id=eq.${userId}`);
      const row = Array.isArray(saved.data) ? saved.data[0] : null;
      if (saved.status >= 300 || !row) return reply(500, { error: "Could not save your confirmation" });
      return reply(200, { upload: forClient(row) });
    }

    // upload
    const p = await loadProject(b.projectId, userId);
    if (p.error) return p.error;
    const project = p.row;
    if (project.template !== "local_market_insider") return reply(409, { error: "Reports are only used by Local Market Insider." });
    if (am.NOT_EDITABLE_AFTER.includes(project.status)) return reply(409, { error: "This piece is already rendering or finished. Start a new one to change it." });
    if (b.permission !== true) return reply(400, { error: "Tick the box to confirm you may use this data before it can be read.", code: "permission_required" });
    const raw = String(b.fileBase64 || "").replace(/^data:[^,]*,/, "");
    if (!raw) return reply(400, { error: "Choose a file to upload." });
    if (raw.length > MAX_BASE64_CHARS) return reply(413, { error: "That file is larger than 4 MB. Try one property type or a shorter date range.", code: "too_big" });
    const existing = await supabase("GET", "agent_marketing_uploads", null, `?project_id=eq.${project.id}&user_id=eq.${userId}&select=id&limit=10`);
    if (Array.isArray(existing.data) && existing.data.length >= rl.MAX_UPLOADS) return reply(409, { error: `You can attach up to ${rl.MAX_UPLOADS} reports. Remove one first.`, code: "too_many" });

    const win = lib.validateWindow(b.window);
    if (win.error) return reply(400, { error: win.error, code: "bad_window" });
    const bytes = Buffer.from(raw, "base64");
    const geo = rl.validateGeography(b.geography);
    const useReview = am.marketReviewEnabled();
    const read = await readLib.readReport(bytes, String(b.fileName || "").slice(0, 200), { window: win.window, marketReview: useReview, suggestions: useReview ? mr.suggestFrom(geo.ok ? geo.geography : null, b.propertyTypes) : null });
    if (!read.ok) return reply(read.code === "too_big" ? 413 : 422, { error: read.message, code: read.code });
    if (read.facts && read.facts.layout === "market_review") {
      // Not a second confirmation: when this project already holds a confirmed Market Review with the same displayed header, its area and
      // property-type attestation is reused and marked as carried forward. Companion reports can also support a partial year's date.
      const sibs = await supabase("GET", "agent_marketing_uploads", null, `?project_id=eq.${project.id}&user_id=eq.${userId}&status=eq.confirmed&select=id,facts&limit=10`);
      const prior = (Array.isArray(sibs.data) ? sibs.data : []).find((x) => x.facts && x.facts.layout === "market_review" && x.facts.attestation && x.facts.attestation.scope && x.facts.attestation.propertyTypes && mr.carryApplies(x.facts.attestation, read.facts.suggestions) && ((x.facts.geography || {}).displayed || {}).raw === ((read.facts.geography || {}).displayed || {}).raw && (x.facts.propertyTypeScope || {}).displayed === (read.facts.propertyTypeScope || {}).displayed);
      const comps = await companionReports(project.id, userId, null);
      const re = mr.reapply(read.facts, { scope: prior && prior.facts.attestation.scope, propertyTypes: prior && prior.facts.attestation.propertyTypes, companions: comps, carriedFrom: prior ? "an earlier confirmed report in this piece" : null });
      if (re.facts) read.facts = re.facts;
    }
    const now = new Date().toISOString();
    const ins = await supabase("POST", "agent_marketing_uploads", {
      project_id: project.id, user_id: userId, file_kind: read.kind, file_bytes: bytes.length, status: "pending",
      facts: read.facts, scope_note: lib.scopeNote(read.facts), permission_at: now, permission_version: lib.PERMISSION_VERSION,
    });
    const row = Array.isArray(ins.data) ? ins.data[0] : null;
    if (ins.status >= 300 || !row) { console.error("agent-marketing-report insert failed:", ins.status, JSON.stringify(ins.data).slice(0, 200)); return reply(500, { error: "Could not save the report" }); }
    return reply(201, { upload: forClient(row, geo.ok ? geo.geography : null) });
  } catch (e) {
    console.error("agent-marketing-report error:", e.message);
    return reply(500, { error: "Something went wrong. Please try again." });
  }
};
