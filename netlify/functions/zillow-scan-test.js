// netlify/functions/zillow-scan-test.js
//
// DIAGNOSTIC/TEST function — not the real compliance scanner yet. Purpose:
// find out, from Netlify's own actual server-side request path (not
// Anthropic's fetch infrastructure, which is a genuinely different network
// path and got a clean result that doesn't guarantee this one will), what
// actually comes back when this Netlify Function requests a real Zillow
// listing page directly.
//
// Returns full diagnostic detail on purpose — status code, whether a
// bot-challenge page was detected, and both extraction strategies' results
// — so the real answer ("does this work reliably from our own backend")
// is visible immediately from the response, not something to guess at
// from a blank failure.
//
// USAGE: GET /.netlify/functions/zillow-scan-test?url=<zillow listing URL>

const https = require("https");
const cheerio = require("cheerio");

// A real desktop Chrome UA + realistic Accept headers — a bare Node
// request with no headers at all is an immediate, trivial bot fingerprint.
// This doesn't defeat behavioral anti-bot systems (PerimeterX/HUMAN look
// at far more than headers), but there's no reason to fail on the easy,
// obvious signal when it costs nothing to set correctly.
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "identity", // deliberately no gzip/br — keeps response handling simple for this diagnostic; real version can add decompression later if needed
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
};

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: BROWSER_HEADERS, timeout: 15000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out after 15s")); });
  });
}

// Common bot-challenge/block-page signals — PerimeterX, Cloudflare, and
// generic "are you human" interstitials all tend to share at least one of
// these markers. Checked so the response can say plainly "you got blocked"
// instead of silently returning an empty extraction that looks like a
// parsing bug.
function detectBlockPage(html, statusCode) {
  const signals = [];
  if (statusCode === 403 || statusCode === 429) signals.push(`HTTP ${statusCode}`);
  if (/px-captcha|perimeterx|_px3|human-challenge/i.test(html)) signals.push("PerimeterX/HUMAN challenge marker found");
  if (/cf-browser-verification|cloudflare.*checking your browser/i.test(html)) signals.push("Cloudflare challenge marker found");
  if (/captcha/i.test(html) && html.length < 5000) signals.push("Short page containing 'captcha' — likely a block page, not real content");
  if (html.length < 1000) signals.push(`Suspiciously short response (${html.length} chars) — likely blocked or redirected, not a real listing page`);
  return signals;
}

// STRATEGY 1 (preferred if it works): Zillow's site is built on Next.js,
// which typically embeds the full page's data as JSON in a
// <script id="__NEXT_DATA__"> tag. If present, this is far more reliable
// than parsing rendered HTML/CSS classes — those change with every
// redesign, structured JSON embedded for the app's own hydration is much
// more stable. Genuinely don't know yet whether Zillow's real page
// includes this tag in what a plain server-side request receives (vs.
// only after client-side JS runs) — that's exactly what this test is for.
function tryNextDataExtraction($) {
  const script = $("#__NEXT_DATA__").html();
  if (!script) return { found: false };
  try {
    const json = JSON.parse(script);
    return { found: true, raw: json };
  } catch (err) {
    return { found: false, error: "Found __NEXT_DATA__ tag but couldn't parse it as JSON: " + err.message };
  }
}

// STRATEGY 2 (fallback): pattern-based extraction directly against the
// HTML/text, for whatever comes back if there's no usable __NEXT_DATA__ in
// a plain server-side fetch (e.g. if Zillow's page requires client-side JS
// to hydrate real content, common on modern React sites — in which case a
// plain HTTP GET may only ever see a mostly-empty shell, regardless of
// bot-blocking).
function tryPatternExtraction(html, $) {
  const photoUrls = [...html.matchAll(/https:\/\/photos\.zillowstatic\.com\/fp\/[a-zA-Z0-9_-]+\.jpg/g)]
    .map(m => m[0]);
  const uniquePhotoUrls = [...new Set(photoUrls)];

  // "What's special" is the real section heading seen in a manual fetch of
  // a live listing — used as an anchor to locate the description text.
  // Fragile by nature (exact heading text/structure could differ by
  // listing type or change over time) — that fragility is itself useful
  // diagnostic information if this comes back empty.
  let description = null;
  $("h2, h3").each((i, el) => {
    const heading = $(el).text().trim();
    if (/what.?s special/i.test(heading)) {
      description = $(el).next().text().trim() || $(el).parent().text().trim();
    }
  });

  return {
    photoCount: uniquePhotoUrls.length,
    photoUrlsSample: uniquePhotoUrls.slice(0, 5),
    description: description ? description.slice(0, 500) : null,
    descriptionFound: !!description,
  };
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

  try {
    const { statusCode, body: html } = await fetchHtml(url);
    const blockSignals = detectBlockPage(html, statusCode);
    const $ = cheerio.load(html);

    const nextData = tryNextDataExtraction($);
    const patternResult = tryPatternExtraction(html, $);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        requestedUrl: url,
        httpStatusCode: statusCode,
        responseLength: html.length,
        likelyBlocked: blockSignals.length > 0,
        blockSignals,
        strategy1_nextData: {
          found: nextData.found,
          error: nextData.error || null,
          // Full raw JSON is large — only a size hint here on purpose,
          // not dumped into the response. If found:true, that's the
          // signal to actually go dig into the real structure next.
          approxSizeIfFound: nextData.found ? JSON.stringify(nextData.raw).length : null,
        },
        strategy2_patternMatch: patternResult,
      }, null, 2),
    };
  } catch (err) {
    return {
      statusCode: 200, // 200, not 500 — this IS the diagnostic result, a caught network/timeout error is itself useful information, not a server bug
      headers,
      body: JSON.stringify({
        requestedUrl: url,
        error: "Request failed",
        errorMessage: err.message,
        interpretation: "Could be a timeout, a connection reset, or Netlify's outbound IP being blocked outright before any response body was even returned. Worth knowing this is a DIFFERENT failure mode than a block page — this means the connection itself didn't succeed.",
      }, null, 2),
    };
  }
};
