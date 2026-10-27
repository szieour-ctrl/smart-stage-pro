// agent-marketing-render.js — Netlify Function. Starts and tracks an Agent Marketing Reel render (Oct 26, 2026).
//   POST { projectId, formats?, advertisingConfirmed:true }  -> { jobId }                    starts asset preparation (background) then the render
//   POST { jobId, retry:true }                                -> { jobId }                    retries a stopped job; paid work already done is reused
//   GET  ?projectId=... -> the project's most recent render in the same shape (plus jobId), or { status: "none" }
//   GET  ?jobId=...  -> { status, step, error?, formats, usage?, videos?: { "9x16": url, "16x9": url }, checks?, warnings? }
// The durable record is the agent_marketing_jobs row. Railway keeps only a status cache; if it forgot the job, the row says what is left to do.
// Beta: nothing is charged here.
const https = require("https");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { supabase } = require("./lib/marketing-profile-lib");
const am = require("./lib/agent-marketing-lib");
const { requireUser } = require("./lib/reel-auth-lib");

const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Cache-Control": "no-store" };
const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });
const DRAFT_PREFIX = "smart-stage-reel-drafts/";
const s3 = new S3Client({ region: process.env.S3_REGION, credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } });
async function presignDraft(key, secs) {
  if (!key || !String(key).startsWith(DRAFT_PREFIX)) return null;
  try { return await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: key }), { expiresIn: secs }); } catch (e) { console.error("agent-marketing presign failed:", e.message); return null; }
}
function railwayGet(pathname) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${process.env.RAILWAY_RENDER_URL}${pathname}`);
    const req = https.request({ hostname: url.hostname, path: url.pathname, method: "GET", headers: { "x-railway-secret": process.env.RAILWAY_SECRET } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch { /* */ } resolve({ status: res.statusCode, json: j }); });
    });
    req.setTimeout(15000, () => req.destroy(new Error("Railway request timed out")));
    req.on("error", reject); req.end();
  });
}
async function patchJob(id, fields) { await supabase("PATCH", "agent_marketing_jobs", { ...fields, updated_at: new Date().toISOString() }, `?id=eq.${encodeURIComponent(id)}`); }
async function dispatchPrepare(jobId, retry) {
  const siteUrl = (process.env.SITE_URL || process.env.URL || "https://smartstagepro.com").replace(/\/+$/, "");
  await fetch(`${siteUrl}/.netlify/functions/agent-marketing-prepare-background`, { method: "POST", headers: { "Content-Type": "application/json", "x-internal-key": process.env.INTERNAL_API_KEY }, body: JSON.stringify({ jobId, retry: !!retry }) });
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" }, body: "" };
  if (!process.env.RAILWAY_RENDER_URL || !process.env.RAILWAY_SECRET || !process.env.INTERNAL_API_KEY) return reply(500, { error: "Reel rendering is not configured" });
  const auth = await requireUser(event);
  if (auth.error) return reply(auth.error.status, auth.error.body);
  const userId = auth.user.id;
  if (!am.isEnabledFor(userId)) return reply(404, { error: "Not found" });

  const loadJob = async (jobId) => {
    if (!/^[\w-]{6,80}$/.test(String(jobId || ""))) return { err: reply(400, { error: "Missing or invalid jobId" }) };
    const r = await supabase("GET", "agent_marketing_jobs", null, `?id=eq.${encodeURIComponent(jobId)}&select=*&limit=1`);
    const job = Array.isArray(r.data) ? r.data[0] : null;
    if (!job) return { err: reply(404, { error: "Render not found" }) };
    if (job.user_id !== userId) return { err: reply(403, { error: "This render belongs to another account" }) };
    return { job };
  };

  if (event.httpMethod === "GET") {
    const qs = event.queryStringParameters || {};
    let job, err;
    if (qs.projectId && !qs.jobId) {
      // The page asks for a project's latest render when it opens, so a finished or running Reel is still there on return.
      if (!am.UUID_RE.test(String(qs.projectId))) return reply(400, { error: "Missing or invalid projectId" });
      const lr = await supabase("GET", "agent_marketing_jobs", null, `?project_id=eq.${qs.projectId}&user_id=eq.${userId}&select=*&order=created_at.desc&limit=1`);
      job = Array.isArray(lr.data) ? lr.data[0] : null;
      if (!job) return reply(200, { status: "none" });
    } else ({ job, err } = await loadJob(qs.jobId));
    if (err) return err;
    try {
      if (job.status === "rendering") {
        const r = await railwayGet(`/agent-marketing-status/${encodeURIComponent(job.id)}`);
        if (r.status === 404) { await patchJob(job.id, { status: "error", error: "The renderer restarted during this render. Retry to render again without paying for images or narration twice.", step: "Stopped" }); job.status = "error"; job.error = "The renderer restarted during this render. Retry to render again without paying for images or narration twice."; }
        else if (r.json && r.json.status === "error") { await patchJob(job.id, { status: "error", error: r.json.error || "Render failed", step: "Stopped" }); job.status = "error"; job.error = r.json.error || "Render failed"; }
        else if (r.json && r.json.status === "done") { const result = { keys: r.json.result.keys || {}, checks: r.json.result.checks || {}, warnings: r.json.result.warnings || [], durationSec: r.json.result.durationSec }; await patchJob(job.id, { status: "done", result, step: "Done" }); job.status = "done"; job.result = result; }
        else if (r.json) job.step = r.json.step || job.step;
      }
      const out = { jobId: job.id, status: job.status, step: job.step, error: job.error || null, formats: job.formats, usage: job.usage || {}, validation: job.validation ? { ok: job.validation.ok, warnings: job.validation.warnings } : null };
      if (job.status === "done" && job.result) {
        out.videos = {}; for (const [f, k] of Object.entries(job.result.keys || {})) out.videos[f] = await presignDraft(k, 3600);
        out.checks = job.result.checks; out.warnings = job.result.warnings; out.durationSec = job.result.durationSec;
      }
      return reply(200, out);
    } catch (e) { console.error("agent-marketing-render status error:", e.message); return reply(200, { status: job.status, step: job.step || "Working" }); }
  }

  if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" });
  let b; try { b = JSON.parse(event.body || "{}"); } catch { return reply(400, { error: "Invalid JSON" }); }

  if (b.retry) {
    const { job, err } = await loadJob(b.jobId);
    if (err) return err;
    if (job.status !== "error") return reply(409, { error: "Only a stopped render can be retried." });
    try { await dispatchPrepare(job.id, true); } catch (e) { console.error("agent-marketing retry dispatch failed:", e.message); return reply(502, { error: "Could not restart the render" }); }
    return reply(200, { jobId: job.id });
  }

  if (!am.UUID_RE.test(String(b.projectId || ""))) return reply(400, { error: "Missing projectId" });
  if (b.advertisingConfirmed !== true) return reply(400, { error: "Please confirm that the market statistics and claims in this Reel are accurate and comply with applicable advertising requirements." });
  const pr = await supabase("GET", "agent_marketing_projects", null, `?id=eq.${b.projectId}&user_id=eq.${userId}&select=id,formats,music,narrative_approved_at,status&limit=1`);
  const project = Array.isArray(pr.data) ? pr.data[0] : null;
  if (!project) return reply(404, { error: "Project not found" });
  if (!project.narrative_approved_at) return reply(400, { error: "Approve the narration first." });
  let formats = Array.isArray(b.formats) && b.formats.length ? b.formats : project.formats;
  formats = am.FORMATS.filter((f) => formats.includes(f) && (project.formats || []).includes(f));
  if (!formats.length) return reply(400, { error: "Choose 9:16, 16:9 or both." });
  // one live job per project at a time
  const live = await supabase("GET", "agent_marketing_jobs", null, `?project_id=eq.${project.id}&status=in.(queued,preparing,ready,rendering)&select=id&limit=1`);
  if (Array.isArray(live.data) && live.data[0]) return reply(409, { error: "A render for this project is already running.", jobId: live.data[0].id });
  const jobId = `amj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ins = await supabase("POST", "agent_marketing_jobs", { id: jobId, project_id: project.id, user_id: userId, formats, status: "queued", step: "Queued" });
  if (ins.status >= 300) { console.error("agent_marketing_jobs insert failed:", ins.status, JSON.stringify(ins.data).slice(0, 200)); return reply(500, { error: "Could not start the render" }); }
  try { await dispatchPrepare(jobId, false); } catch (e) { console.error("agent-marketing dispatch failed:", e.message); await patchJob(jobId, { status: "error", error: "Could not start preparation", step: "Stopped" }); return reply(502, { error: "Could not start the render" }); }
  return reply(200, { jobId, formats });
};
