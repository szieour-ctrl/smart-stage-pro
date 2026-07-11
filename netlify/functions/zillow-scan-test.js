// netlify/functions/zillow-scan-test.js
//
// DIAGNOSTIC/TEST function, trigger+poll pattern.
//
// CHANGE (this session): the previous version waited synchronously inside
// one function call for Bright Data's scrape to fully complete. That's
// confirmed broken — Netlify's standard function timeout defaults to 30
// seconds (confirmed against Netlify's own docs), and a real-world
// PerimeterX-protected Zillow scrape legitimately takes longer than that.
// Bright Data's own confirmation email for a real run showed exactly this:
// the request converted to an async job with a snapshot_id, with two
// SEPARATE curl commands to check progress and download results — that's
// the actual intended usage pattern, not a fallback. This rewrite follows
// that pattern directly, and also matches this repo's own established
// pattern for long-running work (see video-job.js's action=create + poll
// action=status + action=download).
//
// USAGE:
//   Trigger a new scan:
//     GET /.netlify/functions/zillow-scan-test?url=<zillow listing URL>
//     → returns immediately with a snapshotId, does NOT wait for completion
//   Check on / retrieve a triggered scan:
//     GET /.netlify/functions/zillow-scan-test?snapshotId=<id from above>
//     → returns {status: "running"} while still processing, or the real
//       results once ready. Safe to call repeatedly — cheap, fast checks,
//       no risk of hitting a timeout since neither call blocks waiting on
//       Bright Data's actual scrape completion.

const https = require("https");

const BRIGHTDATA_DATASET_ID = "gd_m794g571225l6vm7gh"; // "Zillow Full Properties Information"

function brightDataRequest(path, method, apiKey, bodyObj) {
  return new Promise((resolve, reject) => {
    const bodyStr = bodyObj ? JSON.stringify(bodyObj) : null;
    const req = https.request({
      hostname: "api.brightdata.com",
      path,
      method,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        ...(bodyStr ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
      timeout: 20000, // well under Netlify's 30s cap — this call itself should be fast either way (trigger returns a snapshot_id quickly; progress/snapshot checks are quick reads), it's only the underlying SCRAPE that's slow, and we never wait on that in-process anymore
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error(`Request to ${path} timed out after 20s`)); });
    if (bodyStr) req.write(bodyStr);
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

  const apiKey = process.env.BRIGHTDATA_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "BRIGHTDATA_API_KEY is not set in Netlify environment variables." }) };
  }

  const { url, snapshotId } = event.queryStringParameters || {};

  // ── MODE 2: check on / retrieve an already-triggered scan ──────────────
  if (snapshotId) {
    try {
      const { statusCode, body } = await brightDataRequest(
        `/datasets/v3/snapshot/${snapshotId}?format=json`, "GET", apiKey, null
      );

      let parsed;
      try { parsed = JSON.parse(body); }
      catch { parsed = null; }

      // Bright Data returns a plain-text/short-JSON "not ready yet" style
      // response while still running, and the real array of results once
      // done — the exact shape of the "still running" response isn't
      // confirmed yet from a real call, so this checks a few reasonable
      // signals rather than assuming one specific format.
      const stillRunning = statusCode === 202 ||
        (parsed && parsed.status && /running|building|pending/i.test(parsed.status));

      if (stillRunning) {
        return { statusCode: 200, headers, body: JSON.stringify({ snapshotId, status: "running", raw: parsed || body }, null, 2) };
      }

      const results = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
      const first = results[0] || {};
      const fieldNames = Object.keys(first);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          snapshotId,
          brightDataHttpStatus: statusCode,
          status: "ready",
          resultCount: results.length,
          actualFieldNamesReturned: fieldNames,
          photosFieldPresent: fieldNames.some(f => /photo/i.test(f)),
          descriptionFieldPresent: fieldNames.some(f => /description/i.test(f)),
          rawFirstResult: first,
        }, null, 2),
      };
    } catch (err) {
      return { statusCode: 200, headers, body: JSON.stringify({ snapshotId, error: "Snapshot check failed", errorMessage: err.message }, null, 2) };
    }
  }

  // ── MODE 1: trigger a new scan ──────────────────────────────────────────
  if (!url) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Pass either ?url=<zillow listing URL> to trigger a new scan, or ?snapshotId=<id> to check an existing one." }) };
  }
  if (!/^https:\/\/(www\.)?zillow\.com\/homedetails\//.test(url)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "URL doesn't look like a Zillow listing detail page (expected https://www.zillow.com/homedetails/...)." }) };
  }

  try {
    const { statusCode, body } = await brightDataRequest(
      `/datasets/v3/trigger?dataset_id=${BRIGHTDATA_DATASET_ID}&notify=false&include_errors=true`,
      "POST", apiKey, { input: [{ url }], limit_per_input: null }
    );

    let parsed;
    try { parsed = JSON.parse(body); }
    catch {
      return { statusCode: 200, headers, body: JSON.stringify({ requestedUrl: url, brightDataHttpStatus: statusCode, error: "Trigger response wasn't valid JSON", rawBodySample: body.slice(0, 500) }, null, 2) };
    }

    if (!parsed.snapshot_id) {
      return { statusCode: 200, headers, body: JSON.stringify({ requestedUrl: url, brightDataHttpStatus: statusCode, error: "No snapshot_id in trigger response — see raw response", raw: parsed }, null, 2) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        requestedUrl: url,
        snapshotId: parsed.snapshot_id,
        status: "triggered",
        nextStep: `Wait a bit, then GET this same function with ?snapshotId=${parsed.snapshot_id} to check progress and retrieve results once ready.`,
      }, null, 2),
    };
  } catch (err) {
    return { statusCode: 200, headers, body: JSON.stringify({ requestedUrl: url, error: "Trigger request failed", errorMessage: err.message }, null, 2) };
  }
};
