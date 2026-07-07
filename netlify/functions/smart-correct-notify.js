// smart-correct-notify.js — Netlify Function
// Webhook receiver — Railway's correctPipeline.js calls this when a Smart
// Correct batch finishes (done or error). Same auth pattern as
// video-notify.js (x-webhook-secret header, constant-time compare), but a
// SEPARATE endpoint/URL (SMART_CORRECT_WEBHOOK_URL, not VIDEO_WEBHOOK_URL)
// so a batchId-shaped payload never lands on video-notify.js, which expects
// jobId + Supabase video_jobs fields and would reject or mishandle this shape.
//
// Unlike video-notify.js, this has no Supabase/credit-refund logic — Smart
// Correct batches aren't charged at generation time (same as staged image
// drafts), only at "Generate Corrected Final" (generate-corrected-final.js).
// This function's only job is to write the batch result into the same
// smart-correct-jobs Blobs store that check-smart-correct-batch.js polls —
// it completes the loop that smart-correct-batch-background.js starts.

const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");

function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json" };

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const providedSecret = event.headers["x-webhook-secret"];
  if (!safeEqual(providedSecret, process.env.WEBHOOK_SECRET || "")) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  const siteID = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_ACCESS_TOKEN;
  if (!siteID || !token) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Storage not configured" }) };
  }

  try {
    const { batchId, status, results, error } = JSON.parse(event.body || "{}");
    if (!batchId || !status) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing batchId or status" }) };
    }

    const store = getStore({ name: "smart-correct-jobs", siteID, token });

    if (status === "done") {
      if (!Array.isArray(results)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing results array for done status" }) };
      }
      await store.setJSON(batchId, { status: "done", results });
      const doneCount = results.filter(r => r.status === "done").length;
      const errorCount = results.filter(r => r.status === "error").length;
      console.log(`smart-correct-notify: batch ${batchId} done — ${doneCount} corrected, ${errorCount} errored`);
    } else {
      await store.setJSON(batchId, { status: "error", error: error || "Unknown Railway error" });
      console.log(`smart-correct-notify: batch ${batchId} error — ${error}`);
    }

    return { statusCode: 200, headers, body: JSON.stringify({ received: true }) };

  } catch (err) {
    console.error("smart-correct-notify error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
