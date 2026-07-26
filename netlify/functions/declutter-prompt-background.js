// declutter-prompt-background.js — Netlify Background Function
// FIX (this session): this analysis used to run synchronously inside
// declutter-prompt.js. That worked fine on Haiku, but broke once the model
// was upgraded to Sonnet (for AB 723-critical window/shutter accuracy) with
// a higher max_tokens for the fuller windowInventory requirements — Sonnet's
// slower generation pushed real-world duration to 30-35s, well past
// Netlify's synchronous function ceiling (10s default, 26s max even with an
// increase). Netlify kills the function at that point and returns its own
// HTML error page instead of JSON, which is what surfaced client-side as
// "Unexpected token '<'... is not valid JSON".
//
// Background Functions have no such timeout, so the actual Sonnet call now
// runs here. declutter-prompt.js is now a thin dispatcher (see that file):
// it fires this function and returns a jobId immediately. The client polls
// check-declutter-prompt.js for the result — same three-piece shape
// (dispatcher / background worker / poll endpoint) already proven out by
// stage-openai.js + stage-openai-background.js + check-openai.js.
//
// Reads occupied room via Sonnet, builds inpainting prompt to remove
// furniture/decor. Preserves all architecture (walls, cabinets, fixtures,
// window treatments, exterior views) per AB 723.

const https = require("https");
const sharp = require("sharp");
const { getStore } = require("@netlify/blobs");

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

// Compress image before sending to the vision model — mobile photos can be 3-5MB
// The model only needs to READ the room, not reproduce it — 768px is plenty
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
  console.log('declutter-prompt-background: compressed ' + meta.width + 'x' + meta.height + ' ' + sizeKB + 'KB → ' + Math.round(compressed.length/1024) + 'KB');
  return { base64: compressed.toString('base64'), mimeType: 'image/jpeg' };
}

const AB723_HEADER = `PRIMARY ROLE: Remove furniture and decor ONLY. Preserve architecture exactly.

IMMUTABLE LOCK: Never alter, move, remove, replace, or touch: structural walls | ceilings | kitchen/bathroom cabinets (including upper vanity cabinets and medicine cabinets) | countertops | lighting fixtures | doors | windows (exact original size and position) | built-in appliances | closet hanging rods | shower/tub surrounds and hardware. These must be preserved exactly as photographed.

NEVER INVENT NEW ELEMENTS: Do not add anything that is not visible in the original photo — this includes shower doors, glass enclosures, sliding panels, a second/lower closet rod, or any hardware not present in the source image. Do not convert a window into a door, doorway, or opening. Window curtains, drapes, shutters, and blinds are NOT removed — see the window-coverings rule below; they stay exactly as photographed. If something else is being removed (e.g. a shower curtain), leave the space as an open, bare fixture exactly as it would look with just that item taken away. Do not "complete" or "upgrade" a fixture.

AB 723 COMPLIANCE: Decluttering removes movable objects only. Any alteration to permanent architecture makes the result non-compliant and subject to MLS removal.

═══════════════════════════════════════════════════════════════════════════════

`;

// ✅ HAIKU READS OCCUPIED ROOM — Identifies what to remove vs. preserve
async function analyzeRoomForDeclutter({ imageBase64, claudeKey }) {
  const prompt = `You are analyzing an occupied room to prepare it for decluttering (furniture/decor removal).

TASK: Identify what must be REMOVED vs. what must be PRESERVED.

REMOVE (movable objects only):
- Furniture (sofas, chairs, tables, beds, dressers, etc.)
- Beds — the ENTIRE bed, not just what's on it: mattress, box spring, frame, headboard, footboard, and slats all get removed completely. Stripping the bedding/pillows/clothing off a bed but leaving the frame or headboard standing is INCOMPLETE and INCORRECT — a bed is furniture like a sofa or dresser, and gets removed the same way: entirely. If a bed is in the room, "removeList" must explicitly say the bed/frame/headboard is being removed, not only the items on top of it.
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

CRITICAL INPAINTING RULE FOR BEDS:
A bed — mattress, box spring, frame, headboard, footboard, slats, everything — is furniture and must be removed COMPLETELY, exactly like a sofa, dresser, or table would be.
Removing only the bedding, pillows, and clothing while leaving the bed frame or headboard standing is WRONG — that is not a decluttered room, it's a stripped bed.
Fill the entire footprint where the bed stood with matching floor surface, exactly as you would for any other removed furniture piece.
If unsure whether "the bed" means the whole structure or just the linens: it means the whole structure. There is no partial removal of a bed.

CRITICAL INPAINTING RULE FOR WINDOWS AND WINDOW COVERINGS:
Windows are permanent architecture and are NEVER removed, resized, repositioned, or converted into anything else.
CHANGE (this session — Sam's call, after repeated real-world hallucinations): curtains, drapes, sheers, shutters, and blinds are now treated as PRESERVED, not removed. Earlier versions of this prompt tried to have you identify what's behind each curtain so it could be stripped away — after several rounds of real testing, this consistently produced confident, wrong guesses (shutters invented on windows that don't have them, window proportions redrawn incorrectly). The fix is to stop asking for that inference at all: leave every window covering exactly as photographed, fabric and hardware included. This is not a stylistic choice, it's the fix — you do not need to determine what is or isn't behind any curtain, and you must not alter, part, open, or remove any curtain, drape, sheer, shutter, or blind on any window for any reason.

CRITICAL RULE — THE VIEW THROUGH UNCOVERED GLASS IS FIXED CONTENT, NEVER INVENTED:
Some glass (typically French/patio doors, and any window with no curtain covering it) is directly visible with nothing in front of it. Whatever is visible through that glass — sky, yard, pool, fence, trees, neighboring structures, patio furniture, umbrellas — is part of the original photograph, not a backdrop to invent or approximate. Describe factually, for the largest uncovered glass area, exactly what's visible through it (e.g., "pool and patio furniture visible through French doors" — not a generic guess like "grass" if a pool is actually what's there), so that exact scene can be preserved rather than replaced with different or generic exterior content once furniture in front of the glass is removed. If you cannot tell precisely what's outside (e.g. overexposed/blown-out glass), say so plainly rather than guessing a specific object.

PRESERVE (permanent architecture - IMMUTABLE):
- Structural walls, ceilings, flooring
- Windows — frame, glass, trim, sill, at their EXACT original size and position. A window must never be resized, repositioned, or turned into a door/opening.
- ALL window coverings (curtains, drapes, sheers, shutters, blinds) exactly as photographed — these are preserved along with the window itself now, not removed. See the critical rule above.
- The exact scene visible through any uncovered glass (sky, yard, pool, fences, structures, plants) — never regenerated or altered, see the critical rule above.
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
- Wainscoting / chair-rail paneling, if present on any wall — note its height (e.g. "wainscoting runs to roughly 1/3 wall height, aligning with the bottom of the windows") so that height can be preserved exactly once furniture in front of it is removed

Return ONLY valid JSON — no markdown:

{
  "roomType": "kitchen|living|bedroom|bathroom|dining|etc",
  "exteriorView": "For any UNCOVERED glass (French/patio doors, windows with no curtain in front of them): a brief, factual description of what's actually visible through it — e.g. 'pool and patio furniture visible through French doors' or 'wood fence and lawn visible through side window'. If glass is overexposed/blown-out or nothing meaningful is distinguishable, say so plainly rather than guessing. Omit or leave brief if all windows are curtain-covered.",
  "preserveList": "Comprehensive list of every permanent element visible: walls, ceiling, flooring, doors, cabinets, appliances, fixtures, finishes, AND all window coverings (curtains, drapes, shutters, blinds — these are preserved now, not removed).",
  "removeList": "All furniture and decor to remove: sofas, chairs, tables, rugs, lamps, art, plants, etc. Do NOT include curtains, drapes, shutters, or blinds in this list — window coverings are preserved, not removed.",
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
    model: "claude-sonnet-4-6", // upgraded from claude-haiku-4-5 (this session) — Sonnet's
    // stronger vision accuracy is worth the ~3x cost here (still well under a cent per call)
    // for a compliance-critical read: Haiku was confidently misreading shutters behind
    // curtains it couldn't actually see through, which no amount of prompt wording fixed.
    max_tokens: 1800, // reduced from 3000 (this session) — that raise was to
    // accommodate windowInventory's verbose per-window entries (treatment +
    // height anchor + exterior view, repeated per window), which are gone
    // now that window coverings are preserved wholesale instead of analyzed
    // per-window. Shorter expected output = faster generation = less
    // pressure on the 900s background-function ceiling. Still comfortably
    // above the original 1200 that caused truncation before any of this.
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

  const stopReason = result.body?.stop_reason;
  const text = result.body?.content?.[0]?.text?.trim() || "{}";
  const clean = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(clean); }
  catch(e) {
    // Diagnostic (this session — the max_tokens truncation bug this replaces
    // was invisible until Sam pulled Netlify function logs manually): log
    // stop_reason (max_tokens = truncated response, the actual cause last
    // time) plus response length and tail, so this is debuggable from logs
    // alone next time instead of needing a live repro.
    console.error(`Declutter analysis JSON parse failed. stop_reason=${stopReason}, length=${clean.length} chars. Tail: ...${clean.slice(-200)}`);
    throw new Error(`Declutter analysis JSON parse failed${stopReason === 'max_tokens' ? ' (response was truncated — max_tokens too low for this room)' : ''}`);
  }
}

// ✅ BUILD INPAINTING PROMPT FOR GPT IMAGE 2
function buildDeclutterPrompt({ roomData }) {
  let p = AB723_HEADER;

  p += `TASK: Remove all furniture and decor from this room. Preserve all architecture exactly.\n\n`;

  p += `PRESERVE EXACTLY (do not alter):\n${roomData.preserveList}\n\n`;

  // CHANGE (this session — replaces the earlier per-window shutter
  // itemization approach): window coverings are now preserved wholesale
  // (see rule 17 below), so there's no need to itemize each window's
  // treatment anymore. What's still needed is factual grounding for
  // whatever's visible through UNCOVERED glass, so rule 20's "don't
  // invent" instruction has something concrete to anchor against rather
  // than just a prohibition with nothing to preserve toward.
  if (roomData.exteriorView && roomData.exteriorView.trim()) {
    p += `EXTERIOR VIEW THROUGH UNCOVERED GLASS (factual — preserve exactly, do not invent anything different):\n${roomData.exteriorView}\n\n`;
  }

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
  p += `17. Window coverings (curtains, drapes, sheers, shutters, blinds) are preserved exactly as photographed — do NOT remove, part, open, alter, or attempt to reveal anything behind any of them. The window itself (frame, glass, trim, sill) must also stay the EXACT original size and position — do not shrink, enlarge, shift, or convert a window into a door or opening\n`;
  p += `18. Beds: remove the ENTIRE bed — mattress, box spring, frame, headboard, footboard, slats — not just the bedding/linens/clothing on top of it. A stripped bed frame or headboard left standing is an incomplete removal, not a correct one\n`;
  p += `19. Wainscoting / chair-rail paneling (if present on any wall): preserve its EXACT height, horizontal line, and profile along every wall it appears on. The top edge of the wainscoting must stay at precisely the same height after furniture is removed as it was in the original photo — do not raise, lower, shift, or redraw the wainscoting line, even in areas that were previously blocked by furniture\n`;
  p += `20. CRITICAL WINDOW RULE: Use only information already present in the source image. Do not invent, reconstruct, replace, complete, or clarify into existence any view through windows or glass doors. Do not add, remove, or change buildings, fences, trees, sky, patios, landscaping, reflections, window frames, mullions, shutters, or glass details. If exterior detail is clipped, blurry, obscured, or unavailable, leave it naturally bright\n\n`;

  p += `COMPLIANCE:\n`;
  p += `This room will be prepared per California AB 723 §10140.6 for virtual staging.\n`;
  p += `Removing furniture and decor only — preserving permanent architecture.\n`;
  p += `The decluttered room becomes the base for subsequent staging.`;

  return p.trim();
}


exports.handler = async (event) => {
  const siteID = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_ACCESS_TOKEN;
  let jobId;
  try {
    const { jobId: jId, imageBase64: rawBase64, mimeType } = JSON.parse(event.body);
    jobId = jId;
    console.log(`Declutter job ${jobId} starting... siteID=${siteID ? "SET" : "MISSING"} token=${token ? "SET" : "MISSING"}`);

    if (!siteID) throw new Error("NETLIFY_SITE_ID not configured");
    if (!token)  throw new Error("NETLIFY_ACCESS_TOKEN not configured");
    const claudeKey = process.env.ANTHROPIC_API_KEY;
    if (!claudeKey) throw new Error("ANTHROPIC_API_KEY not configured");
    if (!rawBase64) throw new Error("Missing imageBase64");

    const store = getStore({ name: "declutter-jobs", siteID, token });

    // Write heartbeat immediately — confirms background function is running
    await store.setJSON(jobId, { status: "processing", startedAt: Date.now() });
    console.log(`Declutter job ${jobId}: heartbeat written`);

    // Compress before sending to Sonnet — mobile iPhone photos are 3-5MB
    const { base64: imageBase64 } = await prepareImage(rawBase64, mimeType);

    // Analyze room via Sonnet — this is the call that used to time out
    // synchronously; no timeout ceiling here.
    const roomData = await analyzeRoomForDeclutter({ imageBase64, claudeKey });

    // Build inpainting prompt
    const declutterPrompt = buildDeclutterPrompt({ roomData });

    await store.setJSON(jobId, {
      status: "done",
      roomData,
      declutterPrompt,
      message: "Declutter prompt ready. Review and modify if needed, then click DECLUTTER to send to GPT Image 2."
    });
    console.log(`Declutter job ${jobId}: stored in Blobs`);

  } catch (err) {
    console.error(`Declutter job ${jobId} error:`, err.message);
    try {
      const store = getStore({ name: "declutter-jobs", siteID, token });
      await store.setJSON(jobId, { status: "error", error: err.message });
    } catch(e) {}
  }
};
