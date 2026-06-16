// stage-vacant-prompt.js — Single Room Vacant Staging
// Reads empty room via Haiku, builds zone-bounded prompt for GPT Image 2
// Returns editable prompt to frontend for user modification

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
  console.log('prepareImage: ' + meta.width + 'x' + meta.height + ' ' + sizeKB + 'KB → ' + Math.round(compressed.length/1024) + 'KB');
  return { base64: compressed.toString('base64'), mimeType: 'image/jpeg' };
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

const STYLE_LABELS = {
  'organicmodern':'Organic Modern','transitional':'Transitional','contemporary':'Contemporary',
  'modern':'Modern','scandinavian':'Scandinavian','minimalist':'Minimalist',
  'coastal':'Coastal','farmhouse':'Farmhouse','midcenturymodern':'Mid-Century Modern',
  'industrial':'Industrial','bohemian':'Bohemian','traditional':'Traditional',
  'japandi':'Japandi','warmminimalist':'Warm Minimalist','luxemodern':'Luxe Modern',
  'artdeco':'Art Deco','mediterranean':'Mediterranean','rustic':'Rustic',
  'grandmillennial':'Grand Millennial','wabi_sabi':'Wabi Sabi',
};

const PALETTE_TONES = {
  'Warm Neutrals':    'warm cream, taupe, and honey tones',
  'Bright Airy':      'soft white, pale sage, and warm wood tones',
  'Soft Luxury':      'blue, gray, and champagne tones',
  'Cool Gray':        'cool gray, slate, and white tones',
  'Earth Tones':      'terracotta, rust, and warm brown tones',
  'Bold Contrast':    'black, white, and bold accent tones',
  'Coastal Blue':     'ocean blue, sandy neutral, and white tones',
  'Sage Green':       'sage green, warm white, and natural wood tones',
  'Jewel Tones':      'emerald, sapphire, and warm gold tones',
  'Desert Modern':    'sand, clay, and muted terracotta tones',
};

// ✅ AB 723 COMPLIANCE HEADER — Every prompt starts with this
const AB723_HEADER = `PRIMARY ROLE: Stage furniture and decor ONLY.

IMMUTABLE LOCK: Never alter, move, remove, replace, or touch: structural walls | partial walls | half-walls | pass-through openings and their surrounding wall sections | ceilings | kitchen/bathroom cabinets | countertops | lighting fixtures. These must be preserved exactly as photographed. If a wall has a pass-through opening, both the opening AND the solid wall sections above and below it must remain exactly as photographed — do not enlarge, remove, or modify any wall section.

ABSOLUTE PROHIBITION: Never ADD architectural elements that do not exist in the original photo. Do NOT add: built-in shelving | niches | alcoves | recessed shelves | bookcases built into walls | fireplace surrounds | wall openings | cabinetry | any structural element. If it is not visible in the original photograph, it cannot appear in the staged image.

AB 723 COMPLIANCE: Virtual staging adds furniture only. Any alteration to permanent architecture — including ADDING elements not present — makes the listing non-compliant and subject to MLS removal.

═══════════════════════════════════════════════════════════════════════════════

`;

// ✅ HAIKU READS SINGLE VACANT ROOM — Returns anchors, zones, boundaries
// For open plan rooms (roomType contains '+'), reads per-zone fixtures
async function readVacantRoom({ imageBase64, roomType, claudeKey }) {
  const isOpenPlan = roomType.includes('+');

  // Build zone list for open plan reads
  const zoneList = isOpenPlan
    ? roomType.split('+').map(z => z.trim()).filter(Boolean)
    : null;

  // Pre-build zone template string to avoid nested backtick conflicts
  const zonesTemplate = isOpenPlan
    ? zoneList.map(zone => `{
      "name": "${zone}",
      "ceilingFixture": "Ceiling fixture directly above this zone — specify type, finish, style, and exact position. If none visible, say NONE.",
      "focalPoint": "Primary anchor for furniture placement in this zone",
      "stagingInstruction": "Specific furniture to place in this zone. Every user-labeled zone MUST be staged — never leave a user-labeled zone vacant."
    }`).join(',\n    ')
    : '';

  const prompt = isOpenPlan ? `You are reading a single open-plan space for MLS virtual staging.

Room Type: ${roomType}
Zones visible: ${zoneList.join(', ')}

STEP 1 — SPATIAL INVENTORY (do this first):
Before assigning anything to zones, identify every ceiling fixture and architectural anchor by its PHYSICAL POSITION in the image frame:
- Where is it? (left side of frame / center of frame / right side of frame)
- How far from camera? (foreground / midground / background)
- What is it? (chandelier, ceiling fan, pendant cluster, recessed lights, etc.)

STEP 2 — ZONE MAPPING:
The user has labeled zones in the order they appear in the space. Map each fixture to a zone based on SPATIAL POSITION ONLY — never by fixture type or zone name assumption. A chandelier over the dining area is a DINING anchor even if it is near the kitchen. A ceiling fan over the living area is a LIVING anchor even if it is near the fireplace.

STEP 3 — STAGING INSTRUCTION:
For each zone, write a staging instruction that uses the ceiling fixture as the PRIMARY anchor. Furniture must be placed centered beneath or oriented toward that zone's ceiling fixture — not the adjacent zone's fixture.

CRITICAL RULES:
- A fireplace is a LIVING ZONE focal point ONLY — sofas and seating face it. A dining table NEVER goes near a fireplace unless a chandelier is directly above that location.
- A chandelier/pendant cluster hanging from the ceiling over open floor space = DINING anchor → dining table + chairs MUST be centered directly beneath it — regardless of what else is nearby
- Island pendant lights = KITCHEN anchor → counter stools beneath them
- Ceiling fan = LIVING anchor → sofa/seating group oriented beneath it facing the fireplace
- Never place a dining table near a fireplace if a chandelier exists elsewhere in the space
- The chandelier position IS the dining table position — always

Return ONLY valid JSON — no markdown, no preamble:

{
  "roomType": "${roomType}",
  "preserveList": "Comprehensive list of every permanent architectural element visible: walls (including partial walls, half-walls, partition walls, and pass-through openings with their wall sections), ceiling, flooring material/color, windows with frame color, doors, appliances, fixtures, finishes. If a pass-through or opening exists in a wall, describe the full wall including the solid sections — these wall sections are permanent architecture. End with: DO NOT alter any permanent architectural element.",
  "fixtureInventory": [
    {
      "fixture": "description of fixture",
      "framePosition": "left/center/right of frame",
      "depth": "foreground/midground/background",
      "assignedZone": "which zone this belongs to"
    }
  ],
  "zones": [
    ${zonesTemplate}
  ],
  "zoneBoundary": {
    "front": "Front boundary description",
    "back": "Back boundary description",
    "left": "Left boundary description",
    "right": "Right boundary description",
    "shape": "rectangular or other"
  },
  "adjacentVisibleZones": [
    {
      "zone": "zone name",
      "visible": "HOW visible (through opening, window, doorway)",
      "staging": "KEEP VACANT - do not stage this zone"
    }
  ]
}` : `You are reading a single vacant room for MLS virtual staging.

Room Type: ${roomType}

TASK: Read this room and return ONLY the anchors, zone boundaries, and adjacent visible zones.

Return ONLY valid JSON — no markdown, no preamble:

{
  "roomType": "${roomType}",
  "preserveList": "Comprehensive list of every permanent architectural element visible: walls (including partial walls, half-walls, partition walls, and pass-through openings with their wall sections), ceiling, flooring material/color, windows with frame color, doors, appliances, fixtures, finishes. If a pass-through or opening exists in a wall, describe the full wall including the solid sections — these wall sections are permanent architecture. End with: DO NOT alter any permanent architectural element.",
  "anchors": {
    "focal": "Primary focal point (fireplace, window wall, feature wall) — sofa/seating faces this",
    "ceiling": "Ceiling fixture description if present (fan, chandelier, recessed lights) with finish and style ONLY",
    "backWall": "Wall where furniture back goes against (opposite focal wall)",
    "leftBoundary": "Left wall or architectural element that stops furniture extension",
    "rightBoundary": "Right wall or architectural element that stops furniture extension",
    "frontBoundary": "Distance in front of focal wall before furniture starts (e.g., 18 inches from fireplace)"
  },
  "zoneBoundary": {
    "front": "Front boundary description (distance from focal wall)",
    "back": "Back boundary description (wall or distance)",
    "left": "Left boundary description (wall edge or opening)",
    "right": "Right boundary description (wall edge or opening)",
    "shape": "rectangular or other"
  },
  "adjacentVisibleZones": [
    {
      "zone": "zone name (dining, kitchen, flex, etc.)",
      "visible": "HOW visible (through opening, window, doorway, etc.)",
      "staging": "KEEP VACANT - do not stage this zone"
    }
  ]
}`;

  const payload = JSON.stringify({
    model: "claude-haiku-4-5",
    max_tokens: 2000,
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

  if (result.status !== 200) throw new Error("Haiku vacant read failed: " + (result.body?.error?.message || result.status));

  const text = result.body?.content?.[0]?.text?.trim() || "{}";
  const clean = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(clean); }
  catch(e) { throw new Error("Vacant room JSON parse failed"); }
}

// ✅ BUILD PROMPT FOR VACANT ROOM STAGING
function buildVacantPrompt({ roomData, designStyle, colorPalette }) {
  const rawStyle = designStyle || 'Organic Modern';
  const style = STYLE_LABELS[rawStyle?.toLowerCase().replace(/[^a-z]/g, '')] || rawStyle;
  const palette = colorPalette || 'Warm Neutrals';
  const paletteTones = PALETTE_TONES[palette] || (palette + ' tones');
  const isOpenPlan = Array.isArray(roomData.zones) && roomData.zones.length > 0;

  let p = AB723_HEADER;

  // Preserve list
  p += `PRESERVE EXACTLY: ${roomData.preserveList}\n\n`;

  // Room type and boundaries
  p += `STAGING: ${roomData.roomType} — Stage ONLY within this room boundary\n\n`;

  // Zone boundary definition
  p += `ZONE BOUNDARY (do not stage beyond):\n`;
  p += `Front: ${roomData.zoneBoundary.front}\n`;
  p += `Back: ${roomData.zoneBoundary.back}\n`;
  p += `Left: ${roomData.zoneBoundary.left}\n`;
  p += `Right: ${roomData.zoneBoundary.right}\n`;
  p += `Shape: ${roomData.zoneBoundary.shape}\n\n`;

  if (isOpenPlan) {
    // ── OPEN PLAN: per-zone anchor instructions ──────────────────────────────
    p += `ZONE-BY-ZONE STAGING INSTRUCTIONS:\n`;
    roomData.zones.forEach(zone => {
      p += `\n${zone.name.toUpperCase()} ZONE:\n`;
      if (zone.ceilingFixture && zone.ceilingFixture !== 'NONE') {
        p += `Ceiling fixture: ${zone.ceilingFixture} — use this as the anchor for furniture placement in this zone\n`;
      }
      p += `Focal point: ${zone.focalPoint}\n`;
      p += `Staging: ${zone.stagingInstruction}\n`;
    });
    p += `\n`;
  } else {
    // ── SINGLE ROOM: original anchor block ───────────────────────────────────
    p += `ANCHORS (use these to place furniture):\n`;
    p += `Focal Wall: ${roomData.anchors.focal}\n`;
    if (roomData.anchors.ceiling) p += `Ceiling: ${roomData.anchors.ceiling}\n`;
    p += `Back Wall: ${roomData.anchors.backWall}\n`;
    p += `Left Boundary: ${roomData.anchors.leftBoundary}\n`;
    p += `Right Boundary: ${roomData.anchors.rightBoundary}\n`;
    p += `Front Boundary: ${roomData.anchors.frontBoundary}\n\n`;

    // Room-specific staging instructions (single room only)
    if (roomData.roomType.toLowerCase().includes('kitchen')) {
      p += `KITCHEN STAGING:\n`;
      p += `Place counter stools below pendant lights (if island present)\n`;
      p += `Place bowl of fruit or small plant on island/counter\n`;
      p += `Keep backsplash and cabinetry exactly as shown\n`;
      p += `Do not extend beyond left/right boundaries\n`;
      p += `Do not stage into dining area visible through opening\n\n`;
    } else if (roomData.roomType.toLowerCase().includes('living') || roomData.roomType.toLowerCase().includes('great room')) {
      p += `LIVING ROOM STAGING:\n`;
      p += `CIRCULATION RULE: The foreground floor space nearest the camera is a walk path between zones — keep it completely empty. All furniture must be placed in the MIDGROUND anchored to the fireplace. Do not place any furniture in the front half of the frame.\n`;
      p += `Place area rug in the midground centered under ceiling fixture, anchored toward the fireplace — rug must NOT extend into the foreground half of the frame.\n`;
      p += `Place sofa with back against ${roomData.anchors.backWall}, centered on rug, facing ${roomData.anchors.focal}\n`;
      p += `Place two accent chairs on rug angled inward toward focal point\n`;
      p += `Place coffee table centered on rug between sofa and focal point\n`;
      p += `Place console against right wall (${roomData.anchors.rightBoundary})\n`;
      p += `Place plant right of focal point\n`;
      p += `Place art piece above focal point\n`;
      p += `Place arc floor lamp behind left accent chair\n`;
      p += `Keep all furniture within zone boundary (do not extend past ${roomData.anchors.leftBoundary} or ${roomData.anchors.rightBoundary})\n`;
      p += `Keep foreground floor completely empty — this is the circulation path between zones.\n\n`;
    } else if (roomData.roomType.toLowerCase().includes('bedroom')) {
      p += `BEDROOM STAGING:\n`;
      p += `Place bed headboard against ${roomData.anchors.backWall}, centered\n`;
      p += `Place matching nightstands flanking bed\n`;
      p += `Place dresser on opposite wall (${roomData.anchors.focal})\n`;
      p += `Place bench at foot of bed\n`;
      p += `Keep all furniture within zone boundary\n\n`;
    }
  }

  // Design style
  p += `Stage in ${style} design style using a ${palette} palette with ${paletteTones} throughout.\n\n`;

  // Adjacent zones to preserve
  if (roomData.adjacentVisibleZones && roomData.adjacentVisibleZones.length > 0) {
    p += `ADJACENT ZONES (KEEP VACANT - do NOT stage):\n`;
    roomData.adjacentVisibleZones.forEach(zone => {
      p += `${zone.zone}: Visible ${zone.visible} — Keep completely empty, do not add furniture\n`;
    });
    p += `\n`;
  }

  // Critical rules
  p += `DO NOT stage beyond zone boundary:\n`;
  if (isOpenPlan) {
    p += `— Do not extend furniture past left boundary (${roomData.zoneBoundary.left})\n`;
    p += `— Do not extend furniture past right boundary (${roomData.zoneBoundary.right})\n`;
  } else {
    p += `— Do not extend furniture past left boundary (${roomData.anchors.leftBoundary})\n`;
    p += `— Do not extend furniture past right boundary (${roomData.anchors.rightBoundary})\n`;
  }
  p += `— Do not stage adjacent zones (keep vacant)\n`;
  p += `— Do not alter architectural elements\n`;
  p += `— Do not remove or modify permanent fixtures\n`;
  p += `— Maintain open circulation within the zone\n\n`;

  // Compliance footer
  p += `Use ${style} furniture with clean architectural lines, refined materials, and metallic accents.\n`;
  p += `Maintain realistic furniture scale proportional to the room.\n`;
  p += `Do not scale furniture up to fill the frame.\n`;
  p += `Preserve all architectural features, room dimensions, and camera perspective exactly as photographed.\n`;
  p += `This image is for MLS listing per California AB 723 §10140.6.\n`;
  p += `Room proportions must be preserved exactly.\n`;
  p += `Virtual staging adds furniture and decor only — any alteration to architecture or spatial geometry is prohibited.`;

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
    const { imageBase64: rawBase64, mimeType, roomType, designStyle, colorPalette } = JSON.parse(event.body);
    const claudeKey = process.env.ANTHROPIC_API_KEY;

    if (!rawBase64) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing imageBase64" }) };

    // Compress before Haiku — mobile iPhone photos are 3-5MB
    const { base64: imageBase64 } = await prepareImage(rawBase64, mimeType);
    if (!roomType) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing roomType" }) };
    if (!claudeKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }) };

    // Read room via Haiku
    const roomData = await readVacantRoom({ imageBase64, roomType, claudeKey });

    // Build prompt
    const stagingPrompt = buildVacantPrompt({ roomData, designStyle, colorPalette });

    // Return prompt to frontend (user can edit in textarea)
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        roomData,
        stagingPrompt,
        message: "Prompt ready for editing. Review and modify if needed, then click STAGE to send to GPT Image 2."
      })
    };

  } catch (err) {
    console.error("stage-vacant-prompt error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
