// smart-correct-batch-dispatch.js — Netlify Function
// Smart Connect™ / Smart Correct™ — Module 1/2 deterministic batch correction
//
// REBUILT (this session) — real bug: batches of typical iPhone photos
// were failing with a generic "Failed to start batch correction" error.
// Root cause: the old version relayed every photo's full base64, for the
// whole batch, in ONE request body to Railway — and this being a regular
// (non-background) Netlify Function, that request is hard-capped by AWS
// Lambda at 6MB (effectively ~4.5MB of real image data after base64
// overhead). A batch of even 2-3 real iPhone photos (commonly 3-8MB
// each) can exceed that combined ceiling easily — this wasn't an edge
// case, it was close to the common case.
//
// This function no longer touches image bytes AT ALL. Its only job now
// is minting a short-lived, single-use-per-batch upload token — a
// stateless HMAC over `${batchId}:${expiresAt}`, signed with
// RAILWAY_SECRET (the same shared secret /render and the old
// /correct-batch route already used server-to-server). The browser then
// uploads each photo directly to Railway, one photo per request, using
// that token — see server.js's /correct-image route for the matching
// verification. No Netlify Blobs job store, no webhook, no polling
// needed for this feature anymore: Railway processes each image
// synchronously and returns its real result directly in that request's
// response, so the browser's own Promise.allSettled across the batch IS
// the completion signal.
//
// Frontend note: index.html's runSmartCorrectBatch() calls this ONCE per
// batch (not per image) to get the token, then uploads photos directly
// to Railway — updated in the same delivery as this file.

const crypto = require("crypto");

const TOKEN_TTL_MS = 15 * 60 * 1000; // matches server.js's SMART_CORRECT_TOKEN_TTL_MS — keep these two in sync if either changes

function mintToken(batchId, expiresAt, secret) {
  return crypto.createHmac("sha256", secret).update(`${batchId}:${expiresAt}`).digest("hex");
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  const railwayUploadUrl = process.env.RAILWAY_SMART_CORRECT_UPLOAD_URL || process.env.RAILWAY_SMART_CORRECT_URL;
  const railwaySecret = process.env.RAILWAY_SECRET; // same shared secret /render already uses — never sent to the browser, only used here to SIGN the token

  try {
    const { batchId } = JSON.parse(event.body || "{}");

    if (!batchId) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing batchId" }) };
    if (!railwayUploadUrl) throw new Error("RAILWAY_SMART_CORRECT_UPLOAD_URL (or RAILWAY_SMART_CORRECT_URL) not configured");
    if (!railwaySecret) throw new Error("RAILWAY_SECRET not configured");

    const expiresAt = Date.now() + TOKEN_TTL_MS;
    const token = mintToken(batchId, expiresAt, railwaySecret);

    console.log(`Smart Correct batch ${batchId}: minted upload token, expires ${new Date(expiresAt).toISOString()}`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        batchId,
        token,
        expiresAt,
        // Base URL only — the browser appends /correct-image itself, so
        // this env var can point at the same Railway service /render
        // already uses without needing a second, redundant env var.
        railwayUploadUrl: `${railwayUploadUrl.replace(/\/$/, "")}/correct-image`,
      }),
    };

  } catch (err) {
    console.error(`Smart Correct batch dispatch error:`, err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
