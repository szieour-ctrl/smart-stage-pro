// netlify/functions/zillow-compliance-scan.js
//
// The real AB 723 compliance checker — supersedes zillow-scan-test.js for
// actual use (that file stays in place as a raw diagnostic tool for
// troubleshooting the Bright Data connection itself, separate from the
// compliance logic here).
//
// Same trigger+poll architecture as zillow-scan-test.js, for the same
// reason: Netlify's standard function timeout defaults to 30 seconds, and
// a real PerimeterX-protected Zillow scrape genuinely takes longer than
// that — confirmed directly, not assumed (zillow-scan-test.js's first
// real run timed out at exactly that mark). Bright Data's own snapshot_id
// + progress/snapshot pattern is the correct way to work within that,
// not a fallback.
//
// WHAT THE CHECK ACTUALLY LOOKS FOR, per Sam's own framing of how the
// comparable competitor tool works: "reads the listing looking for the
// presence of a QR code or a URL published in the consumer property
// description." That's the primary signal here too — the actual statute
// (B&P Code §10140.8(a)(1)) requires a disclosure statement AND a link/QR
// to the original image, "reasonably conspicuous and located on or
// adjacent to the image." For a Zillow-syndicated listing, the public
// description is the one place such a link would realistically appear in
// a way this kind of check can read at all — a disclosure that exists
// only as a watermark burned into a photo isn't something this function
// can see; that's a real, honest limitation, not a gap to paper over.
//
// A SECOND, weaker signal is also checked: whether the description
// mentions virtual staging/digital alteration at all. This is NOT a
// stand-in for the real disclosure requirement — it just gives a fuller
// picture (e.g., "staging language present, no link found" is a much
// stronger red flag than "no staging language, no link" which may
// legitimately mean nothing needed disclosing in the first place).
//
// USAGE:
//   Trigger: GET ?action=trigger&url=<zillow listing URL>
//     → returns {snapshotId} immediately
//   Check:   GET ?action=check&snapshotId=<id>
//     → returns {status:"running"} while processing, or the real verdict
//       once Bright Data's scrape completes

const https = require("https");

const BRIGHTDATA_DATASET_ID = "gd_m794g571225l6vm7gh"; // "Zillow Full Properties Information" — confirmed against a real successful run to include description + photos

// Strong, multi-word phrases only — avoids false positives from a bare
// word like "staged" (e.g. "staged for showing," a completely unrelated,
// common real-estate phrase that has nothing to do with virtual/digital
// staging).
const STAGING_LANGUAGE_PATTERN = /virtually staged|virtual staging|digitally altered|digitally enhanced|ai[\s-]?staged|ai[\s-]?generated|ai[\s-]?enhanced|virtually enhanced|virtually furnished|computer[\s-]?generated imagery|\bcgi\b|rendered image|digital rendering/i;

// A real URL, OR an explicit mention of a QR code — either satisfies the
// statute's "link... or QR code" language.
const URL_OR_QR_PATTERN = /https?:\/\/[^\s)]+|www\.[a-z0-9-]+\.[a-z]{2,}(?:\/[^\s)]*)?|\bqr\s?code\b/i;

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
      timeout: 20000,
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

// The actual compliance logic — pure function, no I/O, so it's directly
// testable against known text without needing a real Bright Data call.
function evaluateCompliance(listing) {
  const description = listing.description || "";
  const hasStagingLanguage = STAGING_LANGUAGE_PATTERN.test(description);
  const urlOrQrMatch = description.match(URL_OR_QR_PATTERN);
  const hasUrlOrQr = !!urlOrQrMatch;

  let verdict, summary;
  if (hasStagingLanguage && hasUrlOrQr) {
    verdict = "likely_compliant";
    summary = "Description mentions virtual staging/digital alteration AND includes a link or QR code reference — the two required elements are both present in the public description.";
  } else if (hasStagingLanguage && !hasUrlOrQr) {
    verdict = "likely_non_compliant";
    summary = "Description mentions virtual staging/digital alteration, but no URL or QR code reference was found anywhere in the description text. AB 723 (B&P Code §10140.8(a)(1)) requires a disclosure statement AND a link or QR code to the original, unaltered image.";
  } else if (!hasStagingLanguage && hasUrlOrQr) {
    verdict = "inconclusive_link_present";
    summary = "A URL or QR code reference was found in the description, but no virtual staging/digital alteration language was detected. Could mean the link is unrelated to AB 723 disclosure (e.g. a virtual tour or the agent's own site) — worth a manual check.";
  } else {
    verdict = "inconclusive_no_staging_detected";
    summary = "No virtual staging/digital alteration language and no URL/QR reference found in the description. This may genuinely mean no digitally altered images were used, in which case there is nothing to disclose — or a disclosure could exist only as a visual overlay on a photo itself, which this check cannot see.";
  }

  return {
    verdict,
    summary,
    hasStagingLanguage,
    hasUrlOrQr,
    urlOrQrFound: urlOrQrMatch ? urlOrQrMatch[0] : null,
    photoCount: listing.photo_count ?? null,
    mlsName: listing.attribution_info?.mls_name || null,
    mlsNumber: listing.attribution_info?.mls_id || null,
    listingAgent: listing.attribution_info?.agent_name || null,
    address: listing.address ? `${listing.address.street_address}, ${listing.address.city}, ${listing.address.state} ${listing.address.zipcode}` : null,
    // Honest, explicit limitation — always included, not just when relevant.
    // A compliance checker that doesn't say what it can't see is more
    // dangerous than one that does.
    limitation: "This check only reads the public listing description text. It cannot detect a disclosure that exists solely as a visual overlay/watermark on a photo, and cannot verify that a found link actually leads to a real unaltered original image (only that a URL/QR reference exists in the text).",
  };
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

  const action = event.queryStringParameters?.action;

  // ── ACTION: CHECK ────────────────────────────────────────────────────
  if (action === "check") {
    const snapshotId = event.queryStringParameters?.snapshotId;
    if (!snapshotId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing snapshotId." }) };
    }
    try {
      const { statusCode, body } = await brightDataRequest(
        `/datasets/v3/snapshot/${snapshotId}?format=json`, "GET", apiKey, null
      );

      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = null; }

      const stillRunning = statusCode === 202 ||
        (parsed && parsed.status && /running|building|pending/i.test(parsed.status));
      if (stillRunning) {
        return { statusCode: 200, headers, body: JSON.stringify({ snapshotId, status: "running" }) };
      }

      const results = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
      const listing = results[0];
      if (!listing || !listing.zpid) {
        return { statusCode: 200, headers, body: JSON.stringify({ snapshotId, status: "error", error: "No usable listing data in Bright Data's response.", raw: parsed }) };
      }

      const compliance = evaluateCompliance(listing);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ snapshotId, status: "ready", listingUrl: listing.url, ...compliance }, null, 2),
      };
    } catch (err) {
      return { statusCode: 200, headers, body: JSON.stringify({ snapshotId, status: "error", error: err.message }) };
    }
  }

  // ── ACTION: TRIGGER ──────────────────────────────────────────────────
  const url = event.queryStringParameters?.url;
  if (!url) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Pass ?action=trigger&url=<zillow listing URL>, or ?action=check&snapshotId=<id>." }) };
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
      return { statusCode: 200, headers, body: JSON.stringify({ requestedUrl: url, brightDataHttpStatus: statusCode, error: "Trigger response wasn't valid JSON", rawBodySample: body.slice(0, 500) }) };
    }
    if (!parsed.snapshot_id) {
      return { statusCode: 200, headers, body: JSON.stringify({ requestedUrl: url, brightDataHttpStatus: statusCode, error: "No snapshot_id in trigger response", raw: parsed }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ requestedUrl: url, snapshotId: parsed.snapshot_id, status: "triggered" }, null, 2),
    };
  } catch (err) {
    return { statusCode: 200, headers, body: JSON.stringify({ requestedUrl: url, error: "Trigger request failed", errorMessage: err.message }) };
  }
};

// Exported separately so evaluateCompliance() can be exercised directly in
// a quick local test without needing a real Bright Data call — see the
// verification run in this session's build notes.
exports._evaluateCompliance = evaluateCompliance;
