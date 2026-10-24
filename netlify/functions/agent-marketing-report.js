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
    if (!["upload", "confirm", "remove"].includes(action)) return reply(400, { error: "Unknown action" });

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
      const saved = await supabase("PATCH", "agent_marketing_uploads", { status: "confirmed", confirmed_at: now, updated_at: now }, `?id=eq.${up.id}&user_id=eq.${userId}`);
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

    const bytes = Buffer.from(raw, "base64");
    const read = await readLib.readReport(bytes, String(b.fileName || "").slice(0, 200));
    if (!read.ok) return reply(read.code === "too_big" ? 413 : 422, { error: read.message, code: read.code });

    const geo = rl.validateGeography(b.geography);
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
