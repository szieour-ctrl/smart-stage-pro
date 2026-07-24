// declutter-prompt.js — Remove Objects/Declutter
// Reads occupied room via Haiku, builds inpainting prompt to remove furniture/decor
// Preserves all architecture (walls, cabinets, fixtures) per AB 723
// Sends to stage-openai-background.js for GPT Image 2 inpainting

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

function detectMime(base64) {
  try {
    const buf = Buffer.from(base64.slice(0, 16), 'base64');
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
    if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
    if (buf[0] === 0x52 && buf[1] === 0x49) return 'image/webp';
  } catch(e) {}
  return 'image/jpeg';
}

// Compress image before sending to Haiku — mobile photos can be 3-5MB
// Haiku only needs to READ the room, not reproduce it — 768px is plenty
async function prepareImage(imageBase64, mimeType) {
  const buffer = Buffer.from(imageBase64, 'base64');
  const meta = await sharp(buffer).metadata();
  const sizeKB = Math.round(buffer.length / 1024);
  const maxDim = Math.max(meta.width || 0, meta.height || 0);
  if (maxDim <= 768 && sizeKB <= 80) return { base64: imageBase64, mimeType };
  const compressed = await sharp(buffer)
    .rotate()
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(768, 768, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  console.log('declutter-prompt: compressed ' + meta.width + 'x' + meta.height + ' ' + sizeKB + 'KB → ' + Math.round(compressed.length/1024) + 'KB');
  return { base64: compressed.toString('base64'), mimeType: 'image/jpeg' };
}

// ✅ AB 723 COMPLIANCE HEADER — Every prompt starts with this
const AB723_HEADER = `PRIMARY ROLE: Remove furniture and decor ONLY. Preserve architecture exactly.

IMMUTABLE LOCK: Never alter, move, remove, replace, or touch: structural walls | ceilings | kitchen/bathroom cabinets (including upper vanity cabinets and medicine cabinets) | countertops | lighting fixtures | doors | windows (exact original size and position) | built-in appliances | closet hanging rods | shower/tub surrounds and hardware. These must be preserved exactly as photographed.

NEVER INVENT NEW ELEMENTS: Do not add anything that is not visible in the original photo — this includes shower doors, glass enclosures, sliding panels, a second/lower closet rod, or any hardware not present in the source image. Do not convert a window into a door, doorway, or opening, and never resize or reposition a window when its curtains are removed. If something is being removed (e.g. a shower curtain or window curtain), leave the space as an open, bare fixture exactly as it would look with just that item taken away. Do not "complete" or "upgrade" a fixture.

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
- Shower curtains and shower curtain liners (the curtain ROD stays — see PRESERVE below; do NOT add a glass door, sliding panel, or enclosure in its place)
- Any movable object not listed in PRESERVE — EXCEPT closet hanging rods and vanity cabinetry, which are never movable objects and must always be preserved (see PRESERVE)

CRITICAL INPAINTING RULE FOR MIRRORS, TVs, AND WALL ART:
When removing a mirror, TV, or art from a wall, fill that area with MATCHING WALL PAINT AND TEXTURE.
Remove ALL mounting hardware (TV brackets, picture hangers, mirror clips) and fill with matching wall.
Do NOT create a doorway, window, opening, niche, or alcove where any wall object was removed.
Do NOT leave any mounting bracket, hardware, or outline visible.
The result must be a flat, continuous wall surface matching the surrounding wall color and finish.

CRITICAL INPAINTING RULE FOR SHOWERS:
When a shower curtain is removed, the shower/tub opening becomes simply open and bare — exactly what you'd see if you physically took the curtain down and nothing else changed.
Do NOT add a glass door, sliding door, glass panel, or frame of any kind unless one is clearly visible in the original photo.
Leave the existing curtain rod in place, bare, with no curtain hanging on it.
Do NOT alter the tile, tub, or shower valve/showerhead in any way.
An open shower/tub with just a bare rod and no door is the CORRECT and expected result — never "upgrade" it to an enclosure.

CRITICAL INPAINTING RULE FOR WINDOWS:
Windows are permanent architecture, not furniture — they are NEVER removed, resized, repositioned, or converted into anything else, no matter what is covering them.
When removing curtains, drapes, or sheers from a window, the window itself (frame, glass, trim, sill, any blinds/shutters) must remain in the EXACT same size and position it was in the original photo — measure against fixed reference points in the photo (wall corners, ceiling line, adjacent furniture-free wall) rather than redrawing the window from scratch.
Do NOT shrink, enlarge, or shift a window when its curtains are removed.
Do NOT convert a window into a door, doorway, or opening of any kind. A window stays a window.
Removing a curtain/drape/sheer means ONLY the fabric and its rod/hardware disappear — the glass, frame, sill, and any blinds or shutters underneath stay exactly as photographed.

PRESERVE (permanent architecture - IMMUTABLE):
- Structural walls, ceilings, flooring
- Windows — frame, glass, trim, sill, shutters, and plantation blinds, at their EXACT original size and position. A window must never be resized, repositioned, or turned into a door/opening — see the critical rule above. When curtains are removed, only the fabric and hardware go; the window underneath is untouched.
- Doors (frames, hinges)
- Kitchen cabinetry, bathroom cabinetry, countertops, backsplash, appliances (stove, oven, microwave, refrigerator, dishwasher, hood)
- Bathroom vanity cabinetry — BOTH the lower/base cabinet AND any upper cabinets, medicine cabinets, or wall-mounted storage above the vanity. Preserve every vanity cabinet exactly as photographed, including uppers. If items are sitting on a countertop or inside an open cabinet, remove only those items — never the cabinetry itself.
- Bathroom fixtures (toilet, shower, tub, sink, faucet)
- Shower/tub surround, tile, glass panel or door (ONLY if actually present in the photo), shower valve, showerhead, and curtain rod — preserve exactly as-is. Do not add a door/enclosure that isn't already there; do not remove a door/enclosure that is already there.
- Closet hanging rod(s) — preserve the EXACT number and position of rods visible in the photo. If one rod is present, the result must have exactly one rod, in the same position. Never add a second/lower rod (no double-hang) unless a second rod is clearly visible in the original. Only clothing, hangers, bins, and shoes on the floor are removable — the rod hardware itself always stays mounted in place.
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
  p += `13. Result must be a completely empty room with bare walls ready for staging\n`;
  p += `14. Closet hanging rod(s): preserve the exact original count and position. Never remove a rod, relocate a rod, or add a second/lower rod — no double-hang unless the original photo clearly shows two rods\n`;
  p += `15. Shower/tub: if a shower curtain is removed, leave a bare curtain rod with an open shower/tub opening. Do NOT add a glass door, sliding door, or enclosure panel that was not visible in the original photo\n`;
  p += `16. Bathroom vanity cabinetry: preserve BOTH upper and lower cabinets exactly, including medicine cabinets — remove only items sitting on the counter or inside an open cabinet, never the cabinet structure itself\n`;
  p += `17. Windows: when removing curtains, drapes, or sheers, the window itself (frame, glass, trim, sill, blinds/shutters) must stay the EXACT original size and position — do not shrink, enlarge, shift, or convert a window into a door or opening\n\n`;

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
    const { imageBase64: rawBase64, mimeType } = JSON.parse(event.body);
    const claudeKey = process.env.ANTHROPIC_API_KEY;

    if (!rawBase64) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing imageBase64" }) };
    if (!claudeKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }) };

    // Compress before sending to Haiku — mobile iPhone photos are 3-5MB
    const { base64: imageBase64 } = await prepareImage(rawBase64, mimeType);

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
