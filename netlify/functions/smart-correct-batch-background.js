// smart-correct-batch-background.js — Netlify Function
// Smart Connect™ / Smart Correct™ — Module 1/2 deterministic batch correction
//
// REVISED July 7, 2026: this file's first version assumed Railway would
// hold the HTTP connection open and return the full corrected batch in one
// response. After reviewing the actual Railway render-service convention
// (server.js's /render endpoint: accept fast with 202, process async,
// report the result via a webhook), this was rewritten to match that same
// pattern exactly, via the new /correct-batch Railway endpoint and the new
// smart-correct-notify.js webhook receiver:
//
//   1. This function (dispatchToRailway-style, same as video-job.js) POSTs
//      the batch to Railway's /correct-batch and gets a 202 back in
//      milliseconds — it does NOT wait for correction to finish.
//   2. Railway processes the whole batch in parallel and, when done, POSTs
//      the result to smart-correct-notify.js (Netlify webhook).
//   3. smart-correct-notify.js writes the final result into the same
//      smart-correct-jobs Blobs store this function writes its initial
//      heartbeat to.
//   4. check-smart-correct-batch.js (unchanged, already correct) polls
//      that store — pending until the webhook lands, then done/error.
//
// This is no longer strictly a "background" function in the Netlify sense
// (it returns almost immediately, well under the 26-30s sync limit) — kept
// as one anyway since there's no cost to it and it matches the file's
// existing name across everything already built against it (frontend call
// site, Notion decision docs).

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
  const siteID = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_ACCESS_TOKEN;
  const railwayUrl = process.env.RAILWAY_SMART_CORRECT_URL;
  const railwaySecret = process.env.RAILWAY_SECRET; // reuses the same shared secret /render already uses
  let batchId;

  try {
    const { batchId: bId, images } = JSON.parse(event.body);
    batchId = bId;

    console.log(`Smart Correct batch ${batchId}: dispatching, ${Array.isArray(images) ? images.length : 0} images. siteID=${siteID ? "SET" : "MISSING"} token=${token ? "SET" : "MISSING"} railwayUrl=${railwayUrl ? "SET" : "MISSING"}`);

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

  } catch (err) {
    console.error(`Smart Correct batch ${batchId} error:`, err.message);
    try {
      const store = getJobStore(siteID, token);
      await store.setJSON(batchId, { status: "error", error: err.message });
    } catch (e) {}
  }
};
