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
- Wall-mounted mirrors (decorative, not medicine cabinet)
- Wall art, framed photos, picture frames
- TVs, TV wall mount brackets, and all electronics
- Large rectangular wall-mounted objects (whether mirror, TV, or art — remove all)
- Freestanding shelving — remove the ENTIRE unit (frame + shelves + contents). This includes: ladder shelves, A-frame shelves, leaning shelves, bookcases standing on the floor, etageres, display racks, and any shelf unit that stands on its own or leans against a wall. If it can be picked up and carried out of the room, it is furniture — REMOVE IT COMPLETELY.
- Wall-mounted floating shelves (unless recessed into wall cavity)
- Personal items (books, photos, decorations, collectibles)
- Curtains, drapes, window treatments (shutters/blinds stay)
- Any movable object not listed in PRESERVE

CRITICAL INPAINTING RULE FOR MIRRORS, TVs, AND WALL ART:
When removing a mirror, TV, or art from a wall, fill that area with MATCHING WALL PAINT AND TEXTURE.
Remove ALL mounting hardware (TV brackets, picture hangers, mirror clips) and fill with matching wall.
Do NOT create a doorway, window, opening, niche, or alcove where any wall object was removed.
Do NOT leave any mounting bracket, hardware, or outline visible.
The result must be a flat, continuous wall surface matching the surrounding wall color and finish.

PRESERVE (permanent architecture - IMMUTABLE):
- Structural walls, ceilings, flooring
- Windows (frames, glass, shutters, plantation blinds)
- Doors (frames, hinges)
- Kitchen cabinetry, countertops, backsplash, appliances (stove, oven, microwave, refrigerator, dishwasher, hood)
- Bathroom fixtures (vanity, toilet, shower, tub, medicine cabinet mirrors)
- Fireplace surround, hearth, insert
- Built-in shelving ONLY if permanently constructed into the wall (recessed, nailed to studs, part of wall construction). A shelf leaning against a wall is NOT built-in.
- Ceiling fans, chandeliers, light fixtures (in situ)
- Architectural elements (columns, beams, trim, crown molding)

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
  p += `1. Remove ALL furniture, decor, freestanding shelves, mirrors, and art\n`;
  p += `2. Fill empty areas with MATCHING floor, wall, and ceiling surfaces\n`;
  p += `3. Where a mirror or art was removed, fill with FLAT WALL matching surrounding paint color — NEVER create a doorway, window, opening, niche, or alcove\n`;
  p += `4. Where shelving was removed, fill with matching wall surface\n`;
  p += `5. Keep all architectural elements in exact original positions\n`;
  p += `6. Preserve all fixtures, appliances, and built-ins\n`;
  p += `7. Do NOT alter wall colors, ceiling finish, or flooring\n`;
  p += `8. Do NOT remove or modify windows, doors, or frames\n`;
  p += `9. Do NOT create new doorways, openings, or architectural features\n`;
  p += `10. Do NOT alter kitchen cabinets, countertops, or appliances\n`;
  p += `11. Maintain realistic perspective and proportions\n`;
  p += `12. Maintain the EXACT same camera angle, field of view, and framing as the original — do NOT crop, zoom, or reframe\n`;
  p += `13. Result must be a completely empty room with bare walls ready for staging\n\n`;

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
