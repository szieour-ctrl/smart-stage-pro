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

// Vision layer targets specifically the case text-scanning can't see at
// all: zero disclosure language, zero URL/QR, so the ONLY possible
// evidence is in the photos themselves. Deliberately scoped to a capped
// number of photos, not the full gallery (can run 70-90+ photos per
// listing) — cost and Netlify's 30s function timeout both matter here.
// Zillow galleries commonly front-load hero rooms (exterior, living,
// kitchen, primary) early in photo order — not guaranteed, but a strong
// enough convention to cap here rather than analyze every photo.
const MAX_PHOTOS_FOR_VISUAL_CHECK = 24;
const VISION_MODEL = "claude-haiku-4-5-20251001"; // matches the established pattern already used elsewhere in this codebase (detect-hero-shots.js) for photographic vision analysis

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

// Pulls a moderate-resolution URL for each photo — large enough to read
// structural detail (window shape/placement, flooring pattern, ceiling
// features) needed to confidently match the SAME room across two photos,
// small enough to keep download time and vision-call payload size
// reasonable across up to MAX_PHOTOS_FOR_VISUAL_CHECK images in one call.
function extractPhotoUrls(listing) {
  const photos = listing.original_photos || listing.responsive_photos || [];
  return photos.slice(0, MAX_PHOTOS_FOR_VISUAL_CHECK).map(p => {
    const jpegSources = p.mixed_sources?.jpeg || [];
    // Prefer something in the 700-1000px range if available; fall back to
    // whatever's there rather than skip a photo entirely.
    const preferred = jpegSources.find(s => Number(s.width) >= 700 && Number(s.width) <= 1000);
    return (preferred || jpegSources[jpegSources.length - 1] || jpegSources[0])?.url;
  }).filter(Boolean);
}

function fetchImageAsBase64(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`Photo fetch failed: ${res.statusCode}`)); return; }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("base64")));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Photo fetch timed out")); });
  });
}

function callClaudeVisionForStagingPair(imageBase64List, apiKey) {
  const imageBlocks = imageBase64List.flatMap((b64, i) => ([
    { type: "text", text: `Photo ${i + 1}:` },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
  ]));

  const body = JSON.stringify({
    model: VISION_MODEL,
    max_tokens: 1024,
    messages: [{
      role: "user",
      content: [
        ...imageBlocks,
        { type: "text", text:
          "You are looking at numbered photos from a real estate listing. This listing's public description contains NO virtual-staging disclosure language and NO link/QR code — so the only possible evidence of undisclosed virtual staging is in the photos themselves.\n\n" +
          "TASK: Look specifically for a LIVING ROOM, KITCHEN, or PRIMARY BEDROOM that appears TWICE among these photos — once VACANT (empty, no furniture) and once FURNISHED (staged with furniture/decor) — where both photos show the SAME physical room.\n\n" +
          "To confirm it's the same room, match STRUCTURAL features that furniture can't change: window shape/position, ceiling features (beams, fans, light fixture location), flooring pattern, wall layout, door/opening positions, outlet/switch locations. Do NOT match rooms just because they're a similar style or size — many rooms in a listing look generically similar. Only report a match if you can point to specific structural details that are identical between the two photos.\n\n" +
          "If you are not genuinely confident two specific photos show the exact same room, report no match — a false positive is worse than a missed one here, since this flags a listing as a possible real violation.\n\n" +
          "Return ONLY valid JSON, no other text, no markdown fences. Exact shape:\n" +
          "{\n" +
          '  "pairFound": <true or false>,\n' +
          '  "roomType": "<living room | kitchen | primary bedroom>" or null,\n' +
          '  "vacantPhotoNumber": <integer or null>,\n' +
          '  "furnishedPhotoNumber": <integer or null>,\n' +
          '  "confidence": "high" | "medium" | "low",\n' +
          '  "reasoning": "<one or two sentences citing the SPECIFIC structural features that matched>"\n' +
          "}"
        }
      ]
    }]
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 25000, // leaves headroom under Netlify's 30s cap for the surrounding fetch/parse work — real risk this whole action exceeds 30s combined with image downloads; see comment on the visual-check handler below
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (res.statusCode !== 200) reject(new Error(`Claude API error ${res.statusCode}: ${JSON.stringify(parsed).slice(0, 300)}`));
          else resolve(parsed);
        } catch (e) { reject(new Error("Claude API response parse error")); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Claude Vision call timed out after 25s")); });
    req.write(body);
    req.end();
  });
}
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

  // ── ACTION: VISUAL-CHECK ─────────────────────────────────────────────
  // On-demand deeper check, per Sam's direction — NOT run automatically
  // as part of every scan. Meant to be called specifically for listings
  // that already came back inconclusive_no_staging_detected from the text
  // check (action=check), where the only possible evidence is in the
  // photos. Re-fetches the same snapshot's data (Bright Data snapshots
  // are downloadable repeatedly, confirmed in their own docs) rather than
  // requiring the caller to pass photo data through separately.
  //
  // REAL RISK, stated plainly rather than hidden: downloading up to
  // MAX_PHOTOS_FOR_VISUAL_CHECK (24) images AND running one large vision
  // call, all inside Netlify's 30-second standard function timeout, is
  // genuinely tight — images are fetched in parallel to minimize this,
  // but if this proves too slow in real testing, the fix is converting
  // this action to the same trigger/poll pattern already used for the
  // Bright Data calls, not raising a timeout number and hoping.
  if (action === "visual-check") {
    const snapshotId = event.queryStringParameters?.snapshotId;
    if (!snapshotId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing snapshotId." }) };
    }
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicApiKey) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY is not set in Netlify environment variables." }) };
    }

    try {
      const { statusCode, body } = await brightDataRequest(
        `/datasets/v3/snapshot/${snapshotId}?format=json`, "GET", apiKey, null
      );
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = null; }
      const stillRunning = statusCode === 202 || (parsed && parsed.status && /running|building|pending/i.test(parsed.status));
      if (stillRunning) {
        return { statusCode: 200, headers, body: JSON.stringify({ snapshotId, status: "running" }) };
      }
      const results = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
      const listing = results[0];
      if (!listing || !listing.zpid) {
        return { statusCode: 200, headers, body: JSON.stringify({ snapshotId, status: "error", error: "No usable listing data in Bright Data's response." }) };
      }

      // BUILDER/NEW-CONSTRUCTION GATE — skip the visual check entirely for
      // these, don't just let a low confidence score quietly absorb it.
      // New-construction listings routinely use model-home photos or
      // renderings instead of photos of the actual unit being sold — a
      // standard industry practice, often with its own "photos may not
      // represent actual home" disclaimer. The vacant/furnished
      // pair-matching logic below assumes both photos show the SAME
      // physical room; for a builder listing that assumption can be
      // false by design, which would turn a real model-home photo into a
      // false "possible violation" flag. Gated on confirmed real fields
      // (listing_sub_type.is_new_home, is_premier_builder) rather than
      // guessed at.
      const isBuilderListing = !!listing.listing_sub_type?.is_new_home || !!listing.is_premier_builder;
      if (isBuilderListing) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            snapshotId,
            status: "ready",
            pairFound: false,
            skipped: true,
            skipReason: "This is flagged as a new-construction/builder listing (listing_sub_type.is_new_home or is_premier_builder is true). Builder listings commonly use model-home photos or renderings that legitimately depict a different physical space than the actual unit for sale — the vacant/furnished same-room matching this check relies on isn't reliable here, so it was skipped rather than risk a false positive.",
          }, null, 2),
        };
      }

      const photoUrls = extractPhotoUrls(listing);
      if (photoUrls.length === 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ snapshotId, status: "ready", pairFound: false, note: "No usable photos found for this listing." }) };
      }

      const imageBase64List = await Promise.all(photoUrls.map(u => fetchImageAsBase64(u)));
      const visionResponse = await callClaudeVisionForStagingPair(imageBase64List, anthropicApiKey);

      const textBlock = visionResponse.content?.find(b => b.type === "text");
      if (!textBlock) {
        return { statusCode: 200, headers, body: JSON.stringify({ snapshotId, status: "error", error: "No text content in Claude's response.", raw: visionResponse }) };
      }

      let visionResult;
      try {
        visionResult = JSON.parse(textBlock.text.trim().replace(/^```json\s*|\s*```$/g, ""));
      } catch (err) {
        return { statusCode: 200, headers, body: JSON.stringify({ snapshotId, status: "error", error: "Could not parse Claude's response as JSON.", rawText: textBlock.text }) };
      }

      // Map Claude's 1-indexed photo NUMBERS back to the real Bright
      // Data/Zillow photo URLs — this is the whole point: a flagged
      // listing needs to point at actual evidence, not just assert a
      // finding.
      const vacantUrl = visionResult.vacantPhotoNumber ? photoUrls[visionResult.vacantPhotoNumber - 1] || null : null;
      const furnishedUrl = visionResult.furnishedPhotoNumber ? photoUrls[visionResult.furnishedPhotoNumber - 1] || null : null;

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          snapshotId,
          status: "ready",
          listingUrl: listing.url,
          photosAnalyzed: photoUrls.length,
          pairFound: !!visionResult.pairFound,
          roomType: visionResult.roomType || null,
          confidence: visionResult.confidence || null,
          reasoning: visionResult.reasoning || null,
          vacantPhotoUrl: vacantUrl,
          furnishedPhotoUrl: furnishedUrl,
          limitation: `Analyzed the first ${photoUrls.length} photos only (Zillow galleries commonly front-load hero rooms, but this isn't guaranteed for every listing). This is a probabilistic visual signal, not a verdict — it can miss well-executed staging entirely, and a "pairFound: true" result should be manually confirmed by looking at the two linked photos, not treated as conclusive on its own.`,
        }, null, 2),
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
