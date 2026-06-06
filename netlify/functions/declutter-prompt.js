// declutter-prompt.js — Remove Objects/Declutter
// Reads occupied room via Haiku, builds inpainting prompt to remove furniture/decor
// Preserves all architecture (walls, cabinets, fixtures) per AB 723
// Sends to stage-openai-background.js for GPT Image 2 inpainting

const https = require("https");

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

function detectMime(base64) {
  try {
    const buf = Buffer.from(base64.slice(0, 16), 'base64');
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
    if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
    if (buf[0] === 0x52 && buf[1] === 0x49) return 'image/webp';
  } catch(e) {}
  return 'image/jpeg';
}

// ✅ AB 723 COMPLIANCE HEADER — Every prompt starts with this
const AB723_HEADER = `PRIMARY ROLE: Remove furniture and decor ONLY. Preserve architecture exactly.

IMMUTABLE LOCK: Never alter, move, remove, replace, or touch: structural walls | ceilings | kitchen/bathroom cabinets | countertops | lighting fixtures | doors | windows | built-in appliances. These must be preserved exactly as photographed.

AB 723 COMPLIANCE: Decluttering removes movable objects only. Any alteration to permanent architecture makes the result non-compliant and subject to MLS removal.

═══════════════════════════════════════════════════════════════════════════════

`;

// ✅ HAIKU READS OCCUPIED ROOM — Identifies what to remove vs. preserve
async function analyzeRoomForDeclutter({ imageBase64, claudeKey }) {
  const prompt = `You are analyzing an occupied room to prepare it for decluttering (furniture/decor removal).

TASK: Identify what must be REMOVED vs. what must be PRESERVED.

REMOVE (movable objects only):
- Furniture (sofas, chairs, tables, beds, dressers, etc.)
- Decor (art, plants, throw pillows, lamps, rugs, etc.)
- Personal items (books, photos, decorations)
- Any movable object not listed in PRESERVE

PRESERVE (permanent architecture - IMMUTABLE):
- Structural walls, ceilings, flooring
- Windows (frames, glass, shutters)
- Doors (frames, hinges)
- Kitchen cabinetry, countertops, backsplash, appliances (stove, oven, microwave, refrigerator, dishwasher, hood)
- Bathroom fixtures (vanity, toilet, shower, tub)
- Fireplace surround, hearth, insert
- Built-in shelving, bookcases
- Ceiling fans, chandeliers, light fixtures (in situ)
- Architectural elements (columns, beams, trim)

Return ONLY valid JSON — no markdown:

{
  "roomType": "kitchen|living|bedroom|bathroom|dining|etc",
  "preserveList": "Comprehensive list of every permanent element visible: walls, ceiling, flooring, windows, doors, cabinets, appliances, fixtures, finishes. DO NOT alter any of these.",
  "removeList": "All furniture and decor to remove: sofas, chairs, tables, rugs, lamps, art, plants, etc.",
  "architecturePreserved": [
    "wall color and texture",
    "ceiling and fixtures",
    "flooring type and color",
    "windows and frames",
    "doors and frames",
    "cabinetry",
    "appliances",
    "etc"
  ],
  "declutteringStrategy": "Brief description of what will be removed while preserving architecture"
}`;

  const payload = JSON.stringify({
    model: "claude-haiku-4-5",
    max_tokens: 1200,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: detectMime(imageBase64), data: imageBase64 } },
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

  if (result.status !== 200) throw new Error("Haiku declutter analysis failed: " + (result.body?.error?.message || result.status));

  const text = result.body?.content?.[0]?.text?.trim() || "{}";
  const clean = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(clean); }
  catch(e) { throw new Error("Declutter analysis JSON parse failed"); }
}

// ✅ BUILD INPAINTING PROMPT FOR GPT IMAGE 2
function buildDeclutterPrompt({ roomData }) {
  let p = AB723_HEADER;

  p += `TASK: Remove all furniture and decor from this room. Preserve all architecture exactly.\n\n`;

  p += `PRESERVE EXACTLY (do not alter):\n${roomData.preserveList}\n\n`;

  p += `REMOVE (inpaint/fill with appropriate background):\n${roomData.removeList}\n\n`;

  p += `DECLUTTERING STRATEGY:\n${roomData.declutteringStrategy}\n\n`;

  p += `IMMUTABLE ARCHITECTURE (absolutely preserve):\n`;
  roomData.architecturePreserved.forEach(item => {
    p += `— ${item}\n`;
  });

  p += `\nINPAINTING RULES:\n`;
  p += `1. Remove all furniture and decor\n`;
  p += `2. Fill empty areas with matching floor, wall, and ceiling surfaces\n`;
  p += `3. Keep all architectural elements in exact original positions\n`;
  p += `4. Preserve all fixtures, appliances, and built-ins\n`;
  p += `5. Do NOT alter wall colors, ceiling finish, or flooring\n`;
  p += `6. Do NOT remove or modify windows, doors, or frames\n`;
  p += `7. Do NOT alter kitchen cabinets, countertops, or appliances\n`;
  p += `8. Do NOT modify bathroom fixtures\n`;
  p += `9. Maintain realistic perspective and proportions\n`;
  p += `10. Result must be a completely empty room ready for staging\n\n`;

  p += `COMPLIANCE:\n`;
  p += `This room will be prepared per California AB 723 §10140.6 for virtual staging.\n`;
  p += `Removing furniture and decor only — preserving permanent architecture.\n`;
  p += `The decluttered room becomes the base for subsequent staging.`;

  return p.trim();
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const { imageBase64, mimeType } = JSON.parse(event.body);
    const claudeKey = process.env.ANTHROPIC_API_KEY;

    if (!imageBase64) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing imageBase64" }) };
    if (!claudeKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }) };

    // Analyze room via Haiku
    const roomData = await analyzeRoomForDeclutter({ imageBase64, claudeKey });

    // Build inpainting prompt
    const declutterPrompt = buildDeclutterPrompt({ roomData });

    // Return prompt to frontend (user can edit in textarea)
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        roomData,
        declutterPrompt,
        message: "Declutter prompt ready. Review and modify if needed, then click DECLUTTER to send to GPT Image 2."
      })
    };

  } catch (err) {
    console.error("declutter-prompt error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
