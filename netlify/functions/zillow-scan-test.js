// netlify/functions/zillow-scan-test.js
//
// DIAGNOSTIC/TEST function — calls Bright Data's "Zillow Full Properties
// Information" scraper (dataset_id gd_m794g571225l6vm7gh — NOT the basic
// "Zillow properties listing information" scraper, gd_lfqkr8wm13ixtbd8f5,
// which was tried first and confirmed to lack photos/description entirely)
// and returns the RAW response alongside a lightweight summary.
//
// Deliberately still "diagnostic," not the real compliance checker: this
// is the first real call against Bright Data's actual response shape, and
// their marketing page's human-readable field names ("Photos",
// "Description") don't necessarily match the real JSON key casing
// (snake_case vs camelCase vs something else entirely). Returning the raw
// response lets that be confirmed directly from a real result instead of
// guessed at — the real AB 723 disclosure-language check gets built next,
// once the actual field names are known for certain.
//
// Direct successor to the earlier version of this file, which used a raw
// https.get() + cheerio HTML parse and was confirmed blocked outright by
// PerimeterX/HUMAN (403, block signals detected). Bright Data's service
// exists specifically to solve that — this function no longer touches
// Zillow directly at all, cheerio is no longer a dependency anywhere in
// this repo (removed from package.json alongside this rewrite), and the
// File-global polyfill this file used to need for Node 18 compatibility
// is gone too, since nothing here pulls in undici anymore.
//
// USAGE: GET /.netlify/functions/zillow-scan-test?url=<zillow listing URL>

const https = require("https");

const BRIGHTDATA_DATASET_ID = "gd_m794g571225l6vm7gh"; // "Zillow Full Properties Information" — confirmed distinct from the basic listing-info scraper

function callBrightData(zillowUrl, apiKey) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify({
      input: [{ url: zillowUrl }],
      limit_per_input: null,
    });
    const req = https.request({
      hostname: "api.brightdata.com",
      path: `/datasets/v3/scrape?dataset_id=${BRIGHTDATA_DATASET_ID}&notify=false&include_errors=true`,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
      },
      timeout: 30000, // synchronous mode can genuinely take a while — Bright Data is doing real unblocking work server-side, not just proxying instantly
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Bright Data request timed out after 30s")); });
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

  const url = event.queryStringParameters?.url;
  if (!url) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing ?url= query parameter — pass a real Zillow listing URL." }) };
  }
  if (!/^https:\/\/(www\.)?zillow\.com\/homedetails\//.test(url)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "URL doesn't look like a Zillow listing detail page (expected https://www.zillow.com/homedetails/...)." }) };
  }

  const apiKey = process.env.BRIGHTDATA_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "BRIGHTDATA_API_KEY is not set in Netlify environment variables." }) };
  }

  try {
    const { statusCode, body } = await callBrightData(url, apiKey);

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      // Bright Data returning something that isn't valid JSON is itself a
      // real, useful diagnostic result — surface the raw text rather than
      // crash, so it's visible exactly what came back instead of just
      // "something went wrong."
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          requestedUrl: url,
          brightDataHttpStatus: statusCode,
          error: "Response wasn't valid JSON",
          rawBodySample: body.slice(0, 1000),
        }, null, 2),
      };
    }

    // Synchronous mode (per the dashboard screenshot) returns results
    // directly — normalize to an array either way, since Bright Data's
    // exact top-level shape for a single-URL request isn't confirmed yet
    // from a real response.
    const results = Array.isArray(parsed) ? parsed : [parsed];
    const first = results[0] || {};
    const fieldNames = Object.keys(first);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        requestedUrl: url,
        brightDataHttpStatus: statusCode,
        resultCount: results.length,
        // The real point of this diagnostic call: see the ACTUAL field
        // names Bright Data returns, so the real extraction logic gets
        // built against confirmed reality, not the marketing page's
        // human-readable labels.
        actualFieldNamesReturned: fieldNames,
        photosFieldPresent: fieldNames.some(f => /photo/i.test(f)),
        descriptionFieldPresent: fieldNames.some(f => /description/i.test(f)),
        rawFirstResult: first,
      }, null, 2),
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        requestedUrl: url,
        error: "Request to Bright Data failed",
        errorMessage: err.message,
      }, null, 2),
    };
  }
};
