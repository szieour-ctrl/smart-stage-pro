// autoSelect-background.js — Netlify Background Function
// Runs the actual Claude Vision auto-selection call (generateAutoSelection,
// from ./autoSelect.js) asynchronously, and stores the result in Netlify
// Blobs for check-autoSelect.js to poll.
//
// WHY THIS EXISTS (July 21, 2026 postmortem, same root cause as narration's
// — see generate-narration-background.js's own header): action=autoSelect
// was originally built INLINE inside video-job.js, awaited synchronously in
// one request/response cycle. A single Claude Vision call analyzing every
// photo in a listing (up to 20, MAX_FRAMES) and reasoning through
// order/grouping/structure/motion for each one is a genuinely slow call —
// real-world testing hit Netlify's synchronous function timeout (10s
// default, 26s hard ceiling even on paid tiers), which made Netlify itself
// return its own HTML timeout page instead of anything this function
// controls — surfaced client-side as "Unexpected token '<', <HE... is not
// valid JSON," not as any error this file could catch or report.
//
// Mirrors generate-narration-background.js's pattern exactly, not a new
// invention — same Blobs store shape, same status vocabulary
// (processing/done/error), same siteID/token env var fallback chain,
// same heartbeat-first ordering. Background Functions run up to 15 minutes
// (netlify.toml timeout=900), comfortably clear of even a slow 20-photo call.

const { getStore } = require("@netlify/blobs");
const { generateAutoSelection } = require("./autoSelect");

exports.handler = async (event) => {
  let jobId;
  try {
    const body = JSON.parse(event.body || "{}");
    jobId = body.jobId;
    const { frames, narrationEnabled, hasExteriorEnhancement, poolRemaining } = body;

    if (!jobId) {
      console.error("[autoSelect-background] Missing jobId in request body — cannot write a status any client could poll for.");
      return { statusCode: 400, body: JSON.stringify({ error: "Missing jobId" }) };
    }

    const siteID = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
    const token = process.env.NETLIFY_ACCESS_TOKEN;
    const store = getStore({ name: "autoselect-jobs", siteID, token });

    // Heartbeat FIRST, before the slow Claude call — matches
    // generate-narration-background.js exactly. check-autoSelect.js treats
    // "no blob yet" and "status: processing" identically (both → "pending"
    // to the client), so this isn't strictly load-bearing for correctness,
    // but it means a poll that lands in the few-hundred-ms window between
    // dispatch and this write sees an explicit "processing" record instead
    // of relying on the get()-returns-null fallback path.
    await store.setJSON(jobId, { status: "processing", startedAt: Date.now() });

    if (!process.env.ANTHROPIC_API_KEY) {
      console.error(`[autoSelect-background] Job ${jobId}: missing ANTHROPIC_API_KEY.`);
      await store.setJSON(jobId, { status: "error", error: "Auto-selection is not configured (missing ANTHROPIC_API_KEY)" });
      return { statusCode: 200, body: "" };
    }

    const plan = await generateAutoSelection({
      frames,
      narrationEnabled: !!narrationEnabled,
      hasExteriorEnhancement: !!hasExteriorEnhancement,
      anthropicKey: process.env.ANTHROPIC_API_KEY,
      poolRemaining,
    });

    await store.setJSON(jobId, { status: "done", plan });
    return { statusCode: 200, body: "" };
  } catch (err) {
    console.error(`[autoSelect-background] Job ${jobId || "unknown"} failed:`, err.message);
    if (jobId) {
      try {
        const siteID = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
        const token = process.env.NETLIFY_ACCESS_TOKEN;
        const store = getStore({ name: "autoselect-jobs", siteID, token });
        await store.setJSON(jobId, { status: "error", error: err.message });
      } catch (storeErr) {
        console.error(`[autoSelect-background] Job ${jobId}: also failed to write the error status itself:`, storeErr.message);
      }
    }
    return { statusCode: 200, body: "" };
  }
};
