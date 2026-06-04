// remove-objects.js — Claude Vision room analyzer
// Returns a removal prompt. Client then fires callStageAPI() with it.
// No function-to-function calls — client orchestrates both steps.

const https = require("https");
const sharp = require("sharp");

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

async function prepareImage(imageBase64, mimeType) {
  const buffer = Buffer.from(imageBase64, "base64");
  const meta = await sharp(buffer).metadata();
  const sizeKB = Math.round(buffer.length / 1024);
  const maxDim = Math.max(meta.width || 0, meta.height || 0);
  if (maxDim <= 1536 && sizeKB <= 1500) {
    return { base64: imageBase64, mimeType };
  }
  const compressed = await sharp(buffer)
    .resize(1536, 1536, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer();
  console.log(`remove-objects: compressed ${meta.width}x${meta.height} ${sizeKB}KB → ${Math.round(compressed.length/1024)}KB`);
  return { base64: compressed.toString("base64"), mimeType: "image/jpeg" };
}

async function analyzeRoom(imageBase64, mimeType, claudeKey) {
  const payload = JSON.stringify({
    model: "claude-haiku-4-5",
    max_tokens: 512,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mimeType || "image/jpeg", data: imageBase64 } },
        { type: "text", text: `You are analyzing a real estate room photo for virtual staging preparation.
Identify the room type and list ALL permanent structural elements that must be preserved exactly as-is.
Return ONLY valid JSON, no markdown, no preamble.

{
  "roomType": "living room|bedroom|kitchen|dining room|bathroom|office|other",
  "preserveElements": ["list every structural/permanent element — walls, floors, ceiling, windows, doors, built-in cabinets, countertops, fireplace, staircase, crown molding, baseboards, light fixtures mounted to ceiling/wall, etc."],
  "removeElements": ["list all movable items visible — furniture, rugs, lamps, art, decor, plants, personal items, appliances on counters, etc."]
}` }
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

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" } };
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
    if (!claudeKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }) };

    // Compress if large
    const { base64: readyBase64, mimeType: readyMime } = await prepareImage(imageBase64, mimeType);

    // Claude Vision — identify what to preserve vs remove
    console.log("remove-objects: Claude Vision analyzing room...");
    const roomAnalysis = await analyzeRoom(readyBase64, readyMime, claudeKey);
    console.log("remove-objects: Room type:", roomAnalysis.roomType,
      "preserve:", (roomAnalysis.preserveElements || []).length,
      "remove:", (roomAnalysis.removeElements || []).length);

    // Build removal prompt — return to client
    const preserveList = (roomAnalysis.preserveElements || []).join(", ");
    const removeList   = (roomAnalysis.removeElements   || []).join(", ");
    const roomType     = roomAnalysis.roomType || "room";

    const removalPrompt = `This is an empty ${roomType} prepared for virtual staging. Remove ALL furniture, rugs, decor, personal items, lamps, art, plants, and movable objects. ` +
      (removeList ? `Items to remove: ${removeList}. ` : "") +
      `PRESERVE EXACTLY as-is: all walls, floors, ceilings, windows, doors, and all permanent/structural elements. ` +
      (preserveList ? `Structural elements to keep unchanged: ${preserveList}. ` : "") +
      `Where furniture was, show only the clean floor, wall, or ceiling behind it. ` +
      `Do NOT add any new furniture, staging, or objects. Result must be a completely empty room ready for virtual staging.`;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ removalPrompt, roomType: roomAnalysis.roomType })
    };

  } catch (err) {
    console.error("remove-objects error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
