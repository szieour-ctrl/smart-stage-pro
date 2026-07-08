// smart-correct-batch-dispatch.js — Netlify Function
// Smart Connect™ / Smart Correct™ — Module 1/2 deterministic batch correction
//
// CONVERTED July 7, 2026 from smart-correct-batch-background.js: that
// version was a Netlify background function (`*-background.js` naming)
// and, per Netlify's platform contract, background functions never return
// a response body to the client — Netlify just acks the invocation. That
// file's handler also never returned an HTTP response object in any code
// path, which is valid ONLY for a true background function. When the
// frontend started getting a generic platform-level "Internal Error" (no
// error body, background function logs not visible in the dashboard on
// this site), converting to a regular function was the fastest way to
// both restore real error visibility AND rule out background-function
// detection/config as the actual root cause.
//
// This never needed to be a background function in the first place —
// Railway now accepts a batch and returns 202 in well under a second
// (confirmed repeatedly in Railway logs during testing), nowhere close to
// Netlify's ~26-30s sync function wall-clock limit. Regular function,
// same dispatch logic, now with a real response in every path.
//
// Frontend note: index.html's runSmartCorrectBatch() must POST to
// '/.netlify/functions/smart-correct-batch-dispatch' (not
// '...-batch-background') — updated in the same delivery as this file.

const https = require("https");
const { getStore } = require("@netlify/blobs");

function getJobStore(siteID, token) {
  return getStore({ name: "smart-correct-jobs", siteID, token });
}

// Same shape as video-job.js's dispatchToRailway — plain https.request,
// no special timeout needed since Railway acknowledges in milliseconds.
function dispatchToRailway(railwayUrl, railwaySecret, batchId, images) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${railwayUrl.replace(/\/$/, "")}/correct-batch`);
    const bodyStr = JSON.stringify({ batchId, images });

    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-railway-secret": railwaySecret,
        "Content-Length": Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  const siteID = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_ACCESS_TOKEN;
  const railwayUrl = process.env.RAILWAY_SMART_CORRECT_URL;
  const railwaySecret = process.env.RAILWAY_SECRET; // reuses the same shared secret /render already uses
  let batchId;

  try {
    const { batchId: bId, images } = JSON.parse(event.body || "{}");
    batchId = bId;

    console.log(`Smart Correct batch ${batchId}: dispatching, ${Array.isArray(images) ? images.length : 0} images. siteID=${siteID ? "SET" : "MISSING"} token=${token ? "SET" : "MISSING"} railwayUrl=${railwayUrl ? "SET" : "MISSING"}`);

    if (!batchId) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing batchId" }) };
    if (!siteID) throw new Error("NETLIFY_SITE_ID not configured");
    if (!token) throw new Error("NETLIFY_ACCESS_TOKEN not configured");
    if (!railwayUrl) throw new Error("RAILWAY_SMART_CORRECT_URL not configured");
    if (!railwaySecret) throw new Error("RAILWAY_SECRET not configured");
    if (!Array.isArray(images) || images.length === 0) throw new Error("No images provided in batch");

    const store = getJobStore(siteID, token);

    // Write heartbeat BEFORE dispatching — if Railway's webhook somehow
    // races ahead of this write (unlikely given Railway's own processing
    // time, but not impossible), check-smart-correct-batch.js should never
    // see a bare "not found" and report something misleading.
    await store.setJSON(batchId, { status: "processing", startedAt: Date.now(), imageCount: images.length });
    console.log(`Smart Correct batch ${batchId}: heartbeat written`);

    const dispatchResult = await dispatchToRailway(railwayUrl, railwaySecret, batchId, images);
    if (dispatchResult.status !== 202) {
      throw new Error(`Railway did not accept the batch (status ${dispatchResult.status}): ${dispatchResult.data.slice(0, 300)}`);
    }
    console.log(`Smart Correct batch ${batchId}: accepted by Railway (202), awaiting webhook`);

    return { statusCode: 200, headers, body: JSON.stringify({ dispatched: true, batchId }) };

  } catch (err) {
    console.error(`Smart Correct batch ${batchId} error:`, err.message);
    try {
      const store = getJobStore(siteID, token);
      await store.setJSON(batchId, { status: "error", error: err.message });
    } catch (e) {}
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
