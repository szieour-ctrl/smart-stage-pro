// video-notify.js — Netlify Function
// Webhook receiver — Railway calls this when a render job completes or fails.
// Updates the video_jobs row in Supabase. This is the ONLY way Railway's
// result reaches Supabase — Railway never writes to Supabase directly.
//
// REFUND LOGIC (bug 2g, built July 2026): before this, a Kling job that
// failed after real fal.ai cost was incurred left the charged Images
// permanently un-refunded — confirmed via a real failed job that left 5
// Images uncredited with no correction. Two distinct refund rules:
//   - status "failed": refund the ENTIRE kling_images_charged amount for
//     this generation, regardless of how many Kling clips genuinely
//     succeeded before the failure — the user received no usable video, so
//     no charge is defensible.
//   - status "complete": refund only per-frame, only for billable Kling
//     frames that silently fell back to Ken Burns — the user did receive a
//     usable video, so only the specific unearned premium charge is
//     corrected. Relies on klingFrameOutcomes (from renderPipeline.js) and
//     kling_billed (from video_job_frames, written at generation time by
//     video-job.js's computeKlingBilledFlags) — NOT re-derived from the
//     aggregate charge after the fact, since re-deriving "which frames were
//     the free 3" on a second pass is an easy place for order-dependent
//     logic to quietly drift out of sync with the original charge.

const https = require("https");
const crypto = require("crypto");

function supabase(method, table, body, queryParams = "") {
  return new Promise((resolve, reject) => {
    const url     = new URL(`${process.env.SUPABASE_URL}/rest/v1/${table}${queryParams}`);
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method,
      headers: {
        "apikey":        process.env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type":  "application/json",
        "Prefer":        "return=representation",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {})
      }
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data || "[]") }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Constant-time comparison to avoid timing attacks on the shared secret
function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// SYNC WARNING: this must mirror KLING_IMAGE_COST_PER_FRAME in video-job.js
// exactly — same duplication pattern already accepted elsewhere in this
// codebase (see SINGLE_IMAGE_INTERIOR_ALLOWED_PRESETS in video-job.js /
// klingMotion.js). If the per-frame Kling cost ever changes, update both.
const KLING_IMAGE_COST_PER_FRAME = 5;

// Same HTTP call video-job.js uses to charge — reused here in reverse
// (isRefund: true) so refunds get the exact same ledger write path, active-
// subscription handling, and audit trail as charges. Not shared as an
// imported module since these are two independent Netlify functions in this
// codebase's existing pattern (see the same duplication note above).
function callDebitCredit(userId, cost, reason, isRefund = true) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${process.env.SITE_URL}/.netlify/functions/debit-credit`);
    const bodyStr = JSON.stringify({ userId, cost, reason, isRefund });

    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname,
      method:   "POST",
      headers: {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
      }
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data || "{}") }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
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

  try {
    const { jobId, status, urls, error, klingFrameOutcomes } = JSON.parse(event.body || "{}");
    if (!jobId || !status) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing jobId or status" }) };
    }

    // Fetch the current job row FIRST — needed both for the idempotency
    // check below and for the refund logic (user_id, kling_images_charged).
    const jobRes = await supabase("GET", "video_jobs", null,
      `?id=eq.${jobId}&select=id,user_id,status,kling_images_charged`);
    const existingJob = jobRes.data?.[0];
    if (!existingJob) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: `video_jobs row ${jobId} not found` }) };
    }

    // IDEMPOTENCY GUARD: Railway webhooks can be retried (network blip,
    // timeout before Railway saw our 200, etc). If this job already has the
    // terminal status being reported, the refund logic below has already
    // run once for this job — running it again would double-refund. Update
    // fields idempotently either way (harmless to re-write the same status/
    // URLs), but skip the refund block entirely on a detected duplicate.
    const isDuplicateDelivery = existingJob.status === status &&
      (status === "complete" || status === "failed");
    if (isDuplicateDelivery) {
      console.warn(`Video job ${jobId}: duplicate "${status}" webhook detected — skipping refund logic to avoid double-refund.`);
    }

    const updateFields = { status };

    if (status === "complete") {
      updateFields.output_16x9_url = urls?.["16x9"] || null;
      updateFields.output_9x16_url = urls?.["9x16"] || null;
      updateFields.completed_at = new Date().toISOString();
    }

    if (status === "failed") {
      updateFields.error_message = error || "Unknown render failure";
      updateFields.completed_at = new Date().toISOString();
    }

    await supabase("PATCH", "video_jobs", updateFields, `?id=eq.${jobId}`);

    // ── REFUND LOGIC (bug 2g) — only runs on a genuine status transition ──
    if (!isDuplicateDelivery) {
      if (status === "failed") {
        const chargedAmount = existingJob.kling_images_charged || 0;
        if (chargedAmount > 0) {
          const refundResult = await callDebitCredit(
            existingJob.user_id,
            chargedAmount,
            "kling_generation_failed_refund",
            true
          );
          if (refundResult.status !== 200) {
            // Log loudly but don't throw — the job status update above
            // already succeeded and is the more important write to land.
            // An un-refunded failed job is bad; a failed job that ALSO
            // never got marked failed in Supabase is worse (Railway would
            // have no way to know to retry telling us).
            console.error(`Video job ${jobId}: full refund of ${chargedAmount} Images FAILED (status ${refundResult.status}): ${JSON.stringify(refundResult.data)}`);
          } else {
            console.log(`Video job ${jobId}: refunded full ${chargedAmount} Images (generation failed, no usable video produced).`);
          }
        }
      }

      if (status === "complete" && Array.isArray(klingFrameOutcomes) && klingFrameOutcomes.length > 0) {
        const fallbackSequenceOrders = klingFrameOutcomes
          .filter(o => o.outcome === "ken_burns_fallback")
          .map(o => o.sequenceOrder);

        if (fallbackSequenceOrders.length > 0) {
          // Look up which of the fallen-back frames were actually billed —
          // a fallback frame that was within the free-3 allowance was never
          // charged in the first place, so refunding it would be a phantom
          // credit, not a correction.
          const framesRes = await supabase("GET", "video_job_frames", null,
            `?job_id=eq.${jobId}&select=sequence_order,kling_billed`);
          const billedBySequenceOrder = new Map(
            (framesRes.data || []).map(f => [f.sequence_order, f.kling_billed])
          );

          const billedFallbackCount = fallbackSequenceOrders
            .filter(seq => billedBySequenceOrder.get(seq) === true)
            .length;

          if (billedFallbackCount > 0) {
            const refundAmount = billedFallbackCount * KLING_IMAGE_COST_PER_FRAME;
            const refundResult = await callDebitCredit(
              existingJob.user_id,
              refundAmount,
              "kling_fallback_refund",
              true
            );
            if (refundResult.status !== 200) {
              console.error(`Video job ${jobId}: per-frame refund of ${refundAmount} Images FAILED (status ${refundResult.status}): ${JSON.stringify(refundResult.data)}`);
            } else {
              console.log(`Video job ${jobId}: refunded ${refundAmount} Images for ${billedFallbackCount} billed frame(s) that fell back to Ken Burns.`);
            }
          }
        }
      }
    }

    console.log(`Video job ${jobId} updated to status: ${status}`);

    return { statusCode: 200, headers, body: JSON.stringify({ received: true }) };

  } catch (err) {
    console.error("video-notify error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
