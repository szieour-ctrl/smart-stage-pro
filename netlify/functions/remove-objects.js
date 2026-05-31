// remove-objects.js — Netlify Function
// Replaces Decor8 /remove_objects_from_room
// Uses Claude Vision to identify furniture/clutter, then GPT Image 2 to remove it
// Preserves: walls, floors, ceilings, windows, doors, built-ins, cabinets, counters, structural elements
// Removes: all furniture, decor, personal items, rugs, lamps, art, plants, appliances on counters

const https = require("https");

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
function buildRemoveMultipart(imageBuffer, imageMime, prompt) {
  const boundary = "----RemoveBoundary" + Math.random().toString(36).slice(2);
  const parts = [];
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-2`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${prompt}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="n"\r\n\r\n1`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\n1024x1024`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="quality"\r\n\r\nhigh`);
  const textBuf = Buffer.from(parts.join("\r\n") + "\r\n", "utf8");
  const fileHdr = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="room.jpg"\r\nContent-Type: ${imageMime}\r\n\r\n`,
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

  const imageBuffer = Buffer.from(imageBase64, "base64");
  const { body, boundary } = buildRemoveMultipart(imageBuffer, mimeType || "image/jpeg", prompt);

  console.log(`Remove prompt: ${prompt.length} chars, image: ${Math.round(imageBuffer.length / 1024)}KB`);

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
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const { imageBase64, mimeType } = JSON.parse(event.body);
    if (!imageBase64) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing imageBase64" }) };

    const claudeKey = process.env.ANTHROPIC_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!claudeKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }) };
    if (!openaiKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "OPENAI_API_KEY not configured" }) };

    // Step 1: Claude Vision — identify what to preserve vs remove
    console.log("Step 1: Claude Vision analyzing room...");
    const roomAnalysis = await analyzeRoom(imageBase64, mimeType, claudeKey);
    console.log("Room type:", roomAnalysis.roomType);
    console.log("Preserve:", (roomAnalysis.preserveElements || []).length, "elements");
    console.log("Remove:", (roomAnalysis.removeElements || []).length, "items");

    // Step 2: GPT Image 2 — remove objects
    console.log("Step 2: GPT Image 2 removing objects...");
    const removedBase64 = await removeWithGPT(imageBase64, mimeType, roomAnalysis, openaiKey);
    console.log("Remove complete:", Math.round(removedBase64.length / 1024), "KB");

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        removedBase64,
        roomType: roomAnalysis.roomType,
        preserveElements: roomAnalysis.preserveElements,
        removeElements: roomAnalysis.removeElements,
      }),
    };

  } catch (err) {
    console.error("remove-objects error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
