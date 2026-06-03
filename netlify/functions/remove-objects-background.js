// remove-objects-background.js — Netlify Background Function
// Claude Vision identifies furniture/clutter, GPT Image 2 removes it
// Stores result in Netlify Blobs — client polls check-openai.js

const https = require("https");
const sharp = require("sharp");
const { getStore } = require("@netlify/blobs");

// ── HTTPS helper ──────────────────────────────────────────────────────────────
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

// ── Step 1: Claude Vision — identify room type and structural elements ────────
async function analyzeRoom(imageBase64, mimeType, claudeKey) {
  const payload = JSON.stringify({
    model: "claude-haiku-4-5",
    max_tokens: 512,
    messages: [{
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: mimeType || "image/jpeg", data: imageBase64 }
        },
        {
          type: "text",
          text: `You are analyzing a real estate room photo for virtual staging preparation.
Identify the room type and list ALL permanent structural elements that must be preserved exactly as-is.
Return ONLY valid JSON, no markdown, no preamble.

{
  "roomType": "living room|bedroom|kitchen|dining room|bathroom|office|other",
  "preserveElements": ["list every structural/permanent element — walls, floors, ceiling, windows, doors, built-in cabinets, countertops, fireplace, staircase, crown molding, baseboards, light fixtures mounted to ceiling/wall, etc."],
  "removeElements": ["list all movable items visible — furniture, rugs, lamps, art, decor, plants, personal items, appliances on counters, etc."]
}`
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

  if (result.status !== 200) throw new Error("Claude Vision error: " + JSON.stringify(result.body).slice(0, 200));
  const text = result.body?.content?.[0]?.text || "{}";
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

// ── Step 2: GPT Image 2 — remove objects, preserve structure ─────────────────
function buildRemoveMultipart(imageBuffer, imageMime, prompt, outputSize) {
  const boundary = "----RemoveBoundary" + Math.random().toString(36).slice(2);
  const parts = [];
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-2`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${prompt}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="n"\r\n\r\n1`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\n${outputSize}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="quality"\r\n\r\nlow`);
  const textBuf = Buffer.from(parts.join("\r\n") + "\r\n", "utf8");
  const fileHdr = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="room.png"\r\nContent-Type: ${imageMime}\r\n\r\n`,
    "utf8"
  );
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return { body: Buffer.concat([textBuf, fileHdr, imageBuffer, closing]), boundary };
}

async function removeWithGPT(imageBase64, mimeType, roomAnalysis, openaiKey) {
  const preserveList = (roomAnalysis.preserveElements || []).join(", ");
  const removeList   = (roomAnalysis.removeElements   || []).join(", ");
  const roomType     = roomAnalysis.roomType || "room";

  const prompt = `This is an empty ${roomType} prepared for virtual staging. Remove ALL furniture, rugs, decor, personal items, lamps, art, plants, and movable objects. ` +
    (removeList ? `Items to remove: ${removeList}. ` : "") +
    `PRESERVE EXACTLY as-is: all walls, floors, ceilings, windows, doors, and all permanent/structural elements. ` +
    (preserveList ? `Structural elements to keep unchanged: ${preserveList}. ` : "") +
    `Where furniture was, show only the clean floor, wall, or ceiling behind it. ` +
    `Do NOT add any new furniture, staging, or objects. Result must be a completely empty room ready for virtual staging.`;

  // OpenAI edits endpoint requires PNG
  const rawBuffer = Buffer.from(imageBase64, "base64");
  const imageBuffer = await sharp(rawBuffer).png().toBuffer();

  // Auto-detect aspect ratio for correct output size
  const meta = await sharp(rawBuffer).metadata();
  const w = meta.width || 1024;
  const h = meta.height || 1024;
  let outputSize;
  if (Math.abs(w - h) < 100) outputSize = "1024x1024";
  else if (w > h) outputSize = "1536x1024";
  else outputSize = "1024x1536";

  console.log(`Remove prompt: ${prompt.length} chars, image: ${Math.round(imageBuffer.length / 1024)}KB, size=${outputSize}, input=${w}x${h}`);

  const { body, boundary } = buildRemoveMultipart(imageBuffer, "image/png", prompt, outputSize);

  const result = await httpsRequest({
    hostname: "api.openai.com",
    path: "/v1/images/edits",
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openaiKey}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": body.length,
    }
  }, body);

  if (result.status !== 200) {
    throw new Error(`GPT Image 2 error ${result.status}: ${JSON.stringify(result.body).slice(0, 300)}`);
  }

  const b64 = result.body?.data?.[0]?.b64_json;
  if (!b64) throw new Error("No image data in GPT Image 2 response");
  return b64;
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const siteID    = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
  const token     = process.env.NETLIFY_ACCESS_TOKEN;
  let jobId;

  try {
    const { jobId: jId, imageBase64, mimeType } = JSON.parse(event.body);
    jobId = jId;
    console.log(`Remove job ${jobId} starting...`);

    if (!siteID) throw new Error("NETLIFY_SITE_ID not configured");
    if (!token)  throw new Error("NETLIFY_ACCESS_TOKEN not configured");
    if (!claudeKey) throw new Error("ANTHROPIC_API_KEY not configured");
    if (!openaiKey) throw new Error("OPENAI_API_KEY not configured");

    const store = getStore({ name: "staging-jobs", siteID, token });

    // Write heartbeat
    await store.setJSON(jobId, { status: "processing", startedAt: Date.now() });
    console.log(`Remove job ${jobId}: heartbeat written`);

    // Step 1: Claude Vision — identify what to preserve vs remove
    console.log(`Remove job ${jobId}: Step 1 — Claude Vision analyzing room...`);
    const roomAnalysis = await analyzeRoom(imageBase64, mimeType, claudeKey);
    console.log(`Remove job ${jobId}: Room type: ${roomAnalysis.roomType}, preserve: ${(roomAnalysis.preserveElements || []).length}, remove: ${(roomAnalysis.removeElements || []).length}`);

    // Step 2: GPT Image 2 — remove objects
    console.log(`Remove job ${jobId}: Step 2 — GPT Image 2 removing objects...`);
    const removedBase64 = await removeWithGPT(imageBase64, mimeType, roomAnalysis, openaiKey);
    console.log(`Remove job ${jobId}: complete ${Math.round(removedBase64.length / 1024)}KB`);

    // Store result in blobs
    await store.setJSON(jobId, {
      status: "done",
      removedBase64,
      roomType: roomAnalysis.roomType,
      preserveElements: roomAnalysis.preserveElements,
      removeElements: roomAnalysis.removeElements,
    });
    console.log(`Remove job ${jobId}: stored in Blobs`);

  } catch (err) {
    console.error(`Remove job ${jobId} error:`, err.message);
    try {
      const store = getStore({ name: "staging-jobs", siteID, token });
      await store.setJSON(jobId, { status: "error", error: err.message });
    } catch(e) {}
  }
};
