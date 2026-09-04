const https = require("https");
const sharp = require("sharp");
const heicConvert = require("heic-convert");

// ── HEIC DETECTION + CONVERSION (added this session) ────────────────────────
// Neither Claude's vision API (analyze-floorplan) nor OpenAI's
// /v1/images/edits endpoint (staging) accepts HEIC — both need
// JPEG/PNG/WebP. iPhones default to shooting HEIC, so any photo an agent
// uploads straight from Photos can arrive here as HEIC.
//
// Detection can't rely on mimeType alone: Safari/iOS sometimes sends an
// empty or generic mimeType (e.g. "application/octet-stream") for HEIC
// files instead of "image/heic". So this checks the actual file bytes
// (the ISO-BMFF "ftyp" box + brand) as a fallback, not just the reported
// mimeType.
//
// heic-convert is pure JS (no native binary/libheif dependency), which
// matters in a Netlify Functions environment where sharp's own HEIC
// support usually isn't compiled in.
function isHeic(buffer, mimeType) {
  if (mimeType && /^image\/(heic|heif)/i.test(mimeType)) return true;
  if (!buffer || buffer.length < 12) return false;
  if (buffer.toString("ascii", 4, 8) !== "ftyp") return false;
  const brand = buffer.toString("ascii", 8, 12).toLowerCase();
  return ["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"].includes(brand);
}

async function convertHeicIfNeeded(buffer, mimeType) {
  if (!isHeic(buffer, mimeType)) return { buffer, mimeType: mimeType || "image/jpeg", converted: false };
  console.log("stage-image: HEIC input detected, converting to JPEG before sending to any AI model");
  const jpegBuffer = await heicConvert({ buffer, format: "JPEG", quality: 0.92 });
  return { buffer: Buffer.from(jpegBuffer), mimeType: "image/jpeg", converted: true };
}

// ── Shared HTTPS helper ──────────────────────────────────────────────────────
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (e) { resolve({ status: res.statusCode, body: { raw } }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Claude vision: analyze floorplan ────────────────────────────────────────
async function analyzeFloorplan(base64, mimeType, claudeKey) {
  const payload = JSON.stringify({
    model: "claude-opus-4-5-20251001",
    max_tokens: 1024,
    messages: [{
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: mimeType || "image/jpeg", data: base64 }
        },
        {
          type: "text",
          text: `You are analyzing a 2D real estate floor plan. Return ONLY valid JSON — no markdown, no explanation.

Identify every room visible. For each room provide:
- name: common real estate name (e.g. "Great Room", "Kitchen", "Primary Suite", "Dining Room", "Office", "Loft", "Garage", "Entry", "Primary Bath", "Bedroom 2", "Bedroom 3", "Laundry", "Covered Patio", "Backyard")
- id: slug version of name (e.g. "great-room", "kitchen")
- floor: 1 or 2 (or null if unclear)
- adjacentTo: array of room ids that share a wall or open sightline

Return this exact shape:
{"rooms": [{"id":"...","name":"...","floor":1,"adjacentTo":["..."]}]}`
        }
      ]
    }]
  });

  const result = await httpsRequest({
    hostname: "api.anthropic.com",
    path: "/v1/messages",
    method: "POST",
    headers: {
      "x-api-key": claudeKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload)
    }
  }, payload);

  if (result.status !== 200) throw new Error("Claude error: " + JSON.stringify(result.body).slice(0, 200));

  const text = result.body?.content?.[0]?.text || "{}";
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// FIX (this session — real bug, confirmed from a real 4-image comparison:
// original → Smart Correct → Staged → Iterated, showing the left edge of
// the room progressively cropped away at each generative step). Root
// cause: this always requested a hardcoded 1024x1024 SQUARE output from
// OpenAI's image-edit API, regardless of the input photo's actual aspect
// ratio. A wide real estate interior forced into a square canvas means
// the model has to recompose the whole scene to fit — cropping edges to
// do it — and since Iterate edits the PRIOR staged result (not the
// original), every additional edit pass forces another square recompose
// on top of an already-narrower image, compounding the crop each time.
// resizeToMatch() in index.html was never the bug — it faithfully
// cover-fits whatever composition the model returns; this is what
// decides that composition in the first place.
// gpt-image-1's /v1/images/edits endpoint only accepts three fixed sizes
// (not arbitrary ratios): 1024x1024, 1536x1024 (landscape), 1024x1536
// (portrait). gpt-image-2 additionally supports arbitrary WIDTHxHEIGHT
// (divisible by 16, aspect ratio between 1:3 and 3:1) -- but this function
// intentionally keeps returning the same three standard sizes rather than
// requesting an exact-match custom size. Reasoning: none of this session's
// zone/anchor diagnosis has isolated whether arbitrary sizing helps or
// hurts spatial placement, and changing two variables (model AND sizing
// strategy) in the same deploy would make a regression impossible to
// attribute. Revisit only after the model swap alone has been validated
// against the known-good regression set.
async function pickOutputSize(imageBuffer) {
  try {
    const meta = await sharp(imageBuffer).metadata();
    const w = meta.width || 0, h = meta.height || 0;
    if (w > h * 1.15) return "1536x1024"; // landscape
    if (h > w * 1.15) return "1024x1536"; // portrait
    return "1024x1024"; // genuinely near-square input
  } catch (e) {
    console.warn("pickOutputSize: could not read input dimensions, defaulting to 1024x1024 —", e.message);
    return "1024x1024";
  }
}

// ── Build multipart for OpenAI image edits ───────────────────────────────────
// MODEL (Aug 20, 2026): switched from gpt-image-1 to gpt-image-2. gpt-image-1
// is OpenAI's previous-generation model, scheduled to sunset Oct 23, 2026;
// gpt-image-2 (Apr 2026) is the current flagship and was, until this change,
// never actually in this pipeline despite months of prompt/template tuning
// being diagnosed against it. gpt-image-2 reasons before rendering (plans
// layout, self-checks) rather than rendering directly, which is directly
// relevant to the open-plan zone/anchor placement problems this pipeline has
// been fighting. Confirmed via OpenAI's own docs: standard sizes
// (1024x1024/1536x1024/1024x1536) and the low/medium/high quality params
// below are unchanged across the model family, so no other logic in this
// file needed to change for this swap.
function buildMultipart(boundary, imageBuffer, imageMime, prompt, quality, size) {
  const parts = [];
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-2`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${prompt}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="n"\r\n\r\n1`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\n${size}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="quality"\r\n\r\n${quality || "low"}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="output_format"\r\n\r\npng`);

  const textBuf = Buffer.from(parts.join("\r\n") + "\r\n", "utf8");
  const fileHdr = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="room_${Date.now()}_${Math.random().toString(36).slice(2,6)}.jpg"\r\nContent-Type: ${imageMime}\r\n\r\n`,
    "utf8"
  );
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return Buffer.concat([textBuf, fileHdr, imageBuffer, closing]);
}

// ── Main handler ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const body = JSON.parse(event.body);
    const { action } = body;

    const openaiKey = process.env.OPENAI_API_KEY;
    const claudeKey = process.env.ANTHROPIC_API_KEY;

    // ── ACTION: analyze floorplan ──────────────────────────────────────────
    if (action === "analyze-floorplan") {
      if (!claudeKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }) };
      const { imageBase64, mimeType } = body;

      const rawBuffer = Buffer.from(imageBase64, "base64");
      const { buffer: floorplanBuffer, mimeType: floorplanMime } = await convertHeicIfNeeded(rawBuffer, mimeType);
      const floorplanBase64 = floorplanBuffer.toString("base64");

      const result = await analyzeFloorplan(floorplanBase64, floorplanMime, claudeKey);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // ── ACTION: stage image ────────────────────────────────────────────────
    if (!openaiKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "OPENAI_API_KEY not configured" }) };

    const { imageBase64, mimeType, stagingPrompt, quality } = body;
    if (!imageBase64 || !stagingPrompt) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing imageBase64 or stagingPrompt" }) };

    const rawImageBuffer = Buffer.from(imageBase64, "base64");
    const { buffer: imageBuffer, mimeType: imageMime } = await convertHeicIfNeeded(rawImageBuffer, mimeType);

    const outputSize = await pickOutputSize(imageBuffer);
    console.log(`stage-image: requesting OpenAI output size ${outputSize} to match input aspect ratio`);
    const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);
    const formData = buildMultipart(boundary, imageBuffer, imageMime, stagingPrompt, quality || "low", outputSize);

    const result = await httpsRequest({
      hostname: "api.openai.com",
      path: "/v1/images/edits",
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": formData.length,
      }
    }, formData);

    if (result.status !== 200) {
      console.error("OpenAI error:", JSON.stringify(result.body));
      return { statusCode: result.status, headers, body: JSON.stringify({ error: result.body?.error?.message || "OpenAI API error", details: result.body }) };
    }

    const stagedBase64 = result.body?.data?.[0]?.b64_json;
    if (!stagedBase64) {
      console.error("No b64_json in response:", JSON.stringify(result.body).slice(0, 300));
      return { statusCode: 500, headers, body: JSON.stringify({ error: "No image data returned", shape: JSON.stringify(result.body).slice(0, 200) }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ stagedBase64 }) };

  } catch (err) {
    console.error("Function error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
