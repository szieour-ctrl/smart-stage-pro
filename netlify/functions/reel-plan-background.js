// reel-plan-background.js — Netlify Background Function (15 min ceiling, see netlify.toml).
// Runs the Reel Vision plan (lib/reel-plan-lib.js) and stores the result in Netlify Blobs for
// reel-plan.js to poll. Same shape as autoSelect-background.js (processing → done | error).
const { getStore } = require("@netlify/blobs");
const { generateReelPlan } = require("./lib/reel-plan-lib");

function store() {
  return getStore({ name: "reelplan-jobs", siteID: process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_ACCESS_TOKEN });
}

exports.handler = async (event) => {
  let jobId; let owner = null;
  try {
    const body = JSON.parse(event.body || "{}");
    jobId = body.jobId; owner = body.owner || null;
    if (!jobId) return { statusCode: 400, body: JSON.stringify({ error: "Missing jobId" }) };
    const s = store();
    await s.setJSON(jobId, { status: "processing", owner, startedAt: Date.now() });
    if (!process.env.ANTHROPIC_API_KEY) {
      await s.setJSON(jobId, { status: "error", owner, error: "Reel planning is not configured (missing ANTHROPIC_API_KEY)" });
      return { statusCode: 200, body: "" };
    }
    const plan = await generateReelPlan({ event: body.event, lengthSec: Number(body.lengthSec), photos: body.photos, intake: body.intake || {}, anthropicKey: process.env.ANTHROPIC_API_KEY });
    await s.setJSON(jobId, { status: "done", owner, plan });
  } catch (err) {
    console.error(`[reel-plan-background] Job ${jobId || "unknown"} failed:`, err.message);
    if (jobId) { try { await store().setJSON(jobId, { status: "error", owner, error: err.message }); } catch (e) { console.error("[reel-plan-background] could not write error status:", e.message); } }
  }
  return { statusCode: 200, body: "" };
};
