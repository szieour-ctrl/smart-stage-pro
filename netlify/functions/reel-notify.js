// reel-notify.js — Railway -> Netlify webhook when a Reel render finishes or fails.
// POST { jobId, status: "done"|"error", keys:{branded,unbranded} } with header x-webhook-secret.
// Counts the render toward the not-downloaded tally even if the user left the page (the status poll
// in reel-render.js does the same thing; counting is idempotent per job).
const crypto = require("crypto");
const quota = require("./lib/reel-quota-lib");
const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });
function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" });
  const got = (event.headers && (event.headers["x-webhook-secret"] || event.headers["X-Webhook-Secret"])) || "";
  if (!safeEqual(got, process.env.WEBHOOK_SECRET || "")) return reply(401, { error: "Unauthorized" });
  let b; try { b = JSON.parse(event.body || "{}"); } catch { return reply(400, { error: "Invalid JSON" }); }
  const jobId = String(b.jobId || "");
  if (!/^[\w-]{6,80}$/.test(jobId)) return reply(400, { error: "Invalid jobId" });
  try {
    if (b.status === "error") { await quota.rpc("reel_mark_failed", { p_job_id: jobId }); return reply(200, { ok: true, counted: false }); }
    if (b.status !== "done") return reply(400, { error: "Unknown status" });
    const r = await quota.countCompletion(jobId, b.keys || {});
    return reply(200, { ok: true, counted: !!r.counted, waste: !!r.waste });
  } catch (e) {
    console.error("reel-notify error:", e.message);
    return reply(500, { error: e.message });
  }
};
