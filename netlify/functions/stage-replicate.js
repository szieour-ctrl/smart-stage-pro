const https = require("https");
const zlib = require("zlib");

// ── HTTPS helper ──────────────────────────────────────────────────────────────
function httpsRequest(options, bodyStr) {
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
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Fetch image as base64 ─────────────────────────────────────────────────────
function fetchImageAsBase64(url, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) { reject(new Error("Too many redirects")); return; }
    const u = new URL(url);
    https.request({ hostname: u.hostname, path: u.pathname + u.search, method: "GET" }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        fetchImageAsBase64(res.headers.location, hops + 1).then(resolve).catch(reject);
        return;
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("base64")));
    }).on("error", reject).end();
  });
}

// ── Get image dimensions from JPEG/PNG header ─────────────────────────────────
function getImageDimensions(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 8) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if ((marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xC7)) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  return { width: 1024, height: 768 };
}

// ── PNG helpers ───────────────────────────────────────────────────────────────
let _ct = null;
function crc32(buf) {
  if (!_ct) {
    _ct = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      _ct[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ _ct[(c ^ buf[i]) & 0xff];
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crcBuf]);
}

// ── Build precise PNG mask from Claude Vision regions ─────────────────────────
// regions: array of {rowStart, rowEnd, colStart, colEnd} as 0-1 fractions
// white = inpaint (empty floor), black = preserve (everything else)
function buildSmartMaskPNG(width, height, fillRegions) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(width + 1);
    row[0] = 0; // PNG filter: None
    const yFrac = y / height;
    for (let x = 0; x < width; x++) {
      const xFrac = x / width;
      let val = 0; // default: black = preserve
      for (const r of fillRegions) {
        if (yFrac >= r.rowStart && yFrac <= r.rowEnd &&
            xFrac >= r.colStart && xFrac <= r.colEnd) {
          val = 255; // white = fill here
          break;
        }
      }
      row[x + 1] = val;
    }
    rows.push(row);
  }
  const raw = Buffer.concat(rows);
  const compressed = zlib.deflateSync(raw);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = pngChunk("IHDR", Buffer.from([
    (width >> 24) & 0xff, (width >> 16) & 0xff, (width >> 8) & 0xff, width & 0xff,
    (height >> 24) & 0xff, (height >> 16) & 0xff, (height >> 8) & 0xff, height & 0xff,
    8, 0, 0, 0, 0
  ]));
  return Buffer.concat([sig, ihdr, pngChunk("IDAT", compressed), pngChunk("IEND", Buffer.alloc(0))]);
}

// ── Claude Vision: analyze photo and return fill regions ──────────────────────
async function analyzePhotoForMask(imageBase64, mimeType, roomName, claudeKey) {
  const prompt = `You are analyzing a real estate listing photo of a ${roomName || "room"} to generate an inpainting mask for AI virtual staging.

Your job: identify the empty floor areas where furniture can be placed. Be GENEROUS — virtual staging needs meaningful floor space to work.

ALWAYS PRESERVE (must stay black — never include these as fill regions):
- Kitchen islands, peninsulas, countertops, base cabinets
- Appliances (refrigerator, dishwasher, oven, microwave, range hood)
- Upper wall cabinets
- Fireplace box, surround, and mantel
- Window frames and glass
- Door frames
- Structural walls, columns, load-bearing elements
- Ceiling (top 15% of image always black)
- The sink, faucet, hardware

FILL (mark as white — empty floor space where furniture goes):
- Any open floor area NOT directly occupied by a permanent fixture
- Floor space around and behind the island (bar stool side, living room side)
- The entire living/great room floor area visible beyond the kitchen
- Dining area floor space
- Any empty wall areas in the lower 2/3 of the image (for sofas against walls)
- Be generous — if floor is visible and clear of permanent fixtures, include it
- Bar stool area: the side of the island away from camera (far side) is a FILL region
- Living room floor beyond island: large FILL region

Return ONLY valid JSON, no markdown:
{
  "roomDescription": "brief description of camera angle and room layout",
  "preservedElements": ["list key elements being preserved"],
  "fillRegions": [
    {
      "label": "e.g. floor left of island",
      "rowStart": 0.0,
      "rowEnd": 1.0,
      "colStart": 0.0,
      "colEnd": 1.0,
      "note": "why this area is safe to fill"
    }
  ],
  "avoidRegions": ["describe any tricky areas to avoid"],
  "stagingNote": "key instruction for furniture placement based on room geometry"
}

CRITICAL: rowStart/rowEnd are vertical (0=top, 1=bottom). colStart/colEnd are horizontal (0=left, 1=right).
Be GENEROUS with floor space — virtual staging requires meaningful area to place furniture. 
The living/great room area visible beyond a kitchen island should be ONE LARGE fill region covering most of that floor space.
Aim for fill regions that cover at least 15-20% of image area each. Small regions produce no visible furniture.
Only exclude areas with permanent fixtures DIRECTLY in them.`;

  const payload = JSON.stringify({
    model: "claude-opus-4-5",
    max_tokens: 1200,
    messages: [{
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: mimeType || "image/jpeg", data: imageBase64 }
        },
        { type: "text", text: prompt }
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

  if (result.status !== 200) {
    throw new Error("Claude Vision failed: " + JSON.stringify(result.body).slice(0, 200));
  }

  const text = result.body?.content?.[0]?.text || "{}";
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ── Poll prediction ───────────────────────────────────────────────────────────
async function pollPrediction(id, apiKey, maxMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await new Promise(r => setTimeout(r, 4000));
    const r = await httpsRequest({
      hostname: "api.replicate.com",
      path: `/v1/predictions/${id}`,
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }
    });
    const { status, output, error } = r.body;
    console.log("Poll:", status);
    if (status === "succeeded") return output;
    if (status === "failed" || status === "canceled") {
      throw new Error("Prediction " + status + ": " + (error || "unknown error"));
    }
  }
  throw new Error("Prediction timed out after 90 seconds");
}

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const { imageBase64, mimeType, stagingPrompt, roomName } = JSON.parse(event.body);
    if (!imageBase64 || !stagingPrompt) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing required fields" }) };
    }

    const replicateKey = process.env.REPLICATE_API_KEY;
    const claudeKey = process.env.ANTHROPIC_API_KEY;
    if (!replicateKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "REPLICATE_API_KEY not configured" }) };
    if (!claudeKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }) };

    // Step 1: Get actual image dimensions
    const imgBuf = Buffer.from(imageBase64, "base64");
    const dims = getImageDimensions(imgBuf);
    console.log(`Image: ${dims.width}x${dims.height}`);

    // Step 2: Claude Vision analyzes photo → returns precise fill regions
    console.log("Claude Vision analyzing photo for mask regions...");
    const maskAnalysis = await analyzePhotoForMask(imageBase64, mimeType, roomName, claudeKey);
    console.log("Mask analysis:", JSON.stringify(maskAnalysis).slice(0, 400));

    const fillRegions = maskAnalysis.fillRegions || [];
    if (fillRegions.length === 0) {
      // Safety fallback: very conservative bottom strip only
      console.log("No fill regions returned — using conservative fallback");
      fillRegions.push({ label: "floor strip", rowStart: 0.80, rowEnd: 0.98, colStart: 0.05, colEnd: 0.95 });
    }

    // Step 3: Build precise mask from Claude's regions
    console.log(`Building mask with ${fillRegions.length} fill region(s)...`);
    const maskBuf = buildSmartMaskPNG(dims.width, dims.height, fillRegions);
    const maskBase64 = maskBuf.toString("base64");

    // Step 4: Build staging note into prompt if Claude provided one
    const stagingNote = maskAnalysis.stagingNote || "";
    const enhancedPrompt = stagingNote
      ? `${stagingPrompt}\nROOM GEOMETRY NOTE: ${stagingNote}`
      : stagingPrompt;

    // Step 5: Build data URIs
    const imgMime = mimeType || "image/jpeg";
    const imageDataUri = `data:${imgMime};base64,${imageBase64}`;
    const maskDataUri = `data:image/png;base64,${maskBase64}`;

    const negativePrompt = "blurry, distorted walls, floating furniture, warped architecture, unrealistic scale, oversized furniture, cluttered, cartoon, illustration, low quality, duplicate objects, impossible shadows, fake windows, extra rooms, hallucinated spaces, people, text, changed cabinets, changed countertops, changed appliances, changed flooring";

    // Step 6: Start Replicate prediction
    console.log("Starting Replicate prediction...");
    // Replicate SDXL requires dimensions from exact allowed list (multiples of 64, up to 1024)
    const ALLOWED = [64,128,192,256,320,384,448,512,576,640,704,768,832,896,960,1024];
    const snapTo = (v) => ALLOWED.reduce((a,b) => Math.abs(b-v)<Math.abs(a-v)?b:a);
    const safeW = snapTo(Math.min(dims.width, 1024));
    const safeH = snapTo(Math.min(dims.height, 1024));
    console.log(`Output dimensions: ${safeW}x${safeH}`);

    const payload = JSON.stringify({
      version: "95b7223104132402a9ae91cc677285bc5eb997834bd2349fa486f53910fd68b3",
      input: {
        image: imageDataUri,
        mask: maskDataUri,
        prompt: enhancedPrompt,
        negative_prompt: negativePrompt,
        num_inference_steps: 50,
        guidance_scale: 9.0,
        strength: 0.99,
        num_outputs: 1,
        scheduler: "DPMSolverMultistep",
        width: safeW,
        height: safeH,
      }
    });

    const startResult = await httpsRequest({
      hostname: "api.replicate.com",
      path: "/v1/predictions",
      method: "POST",
      headers: {
        Authorization: `Bearer ${replicateKey}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      }
    }, payload);

    if (startResult.status !== 201) {
      console.error("Replicate start failed:", JSON.stringify(startResult.body).slice(0, 300));
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Replicate start failed: " + JSON.stringify(startResult.body).slice(0, 200) }) };
    }

    const predictionId = startResult.body.id;
    console.log("Prediction ID:", predictionId);

    // Step 7: Poll for result
    const output = await pollPrediction(predictionId, replicateKey);
    const outputUrl = Array.isArray(output) ? output[0] : output;
    if (!outputUrl) throw new Error("No output URL from Replicate");

    console.log("Fetching result...");
    const stagedBase64 = await fetchImageAsBase64(outputUrl);

    // Return result with mask analysis so frontend can show what was detected
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        stagedBase64,
        engine: "replicate-sdxl-smart-mask",
        maskRegions: fillRegions.length,
        roomDescription: maskAnalysis.roomDescription,
        stagingNote: maskAnalysis.stagingNote,
      })
    };

  } catch (err) {
    console.error("stage-replicate error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
