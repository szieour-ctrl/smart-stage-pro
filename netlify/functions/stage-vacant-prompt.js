// stage-vacant-prompt.js — Single Room Vacant Staging
// Reads empty room via Haiku, builds zone-bounded prompt for GPT Image 2
// Returns editable prompt to frontend for user modification

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

IMMUTABLE LOCK: Never alter, move, remove, replace, or touch: structural walls | ceilings | kitchen/bathroom cabinets | countertops | lighting fixtures. These must be preserved exactly as photographed.

AB 723 COMPLIANCE: Virtual staging adds furniture only. Any alteration to permanent architecture makes the listing non-compliant and subject to MLS removal.

═══════════════════════════════════════════════════════════════════════════════

`;

// ✅ HAIKU READS SINGLE VACANT ROOM — Returns anchors, zones, boundaries
async function readVacantRoom({ imageBase64, roomType, claudeKey }) {
  const prompt = `You are reading a single vacant room for MLS virtual staging.

Room Type: ${roomType}

TASK: Read this room and return ONLY the anchors, zone boundaries, and adjacent visible zones.

Return ONLY valid JSON — no markdown, no preamble:

{
  "roomType": "${roomType}",
  "preserveList": "Comprehensive list of every permanent architectural element visible: walls, ceiling, flooring material/color, windows with frame color, doors, built-ins, appliances, fixtures, finishes. End with: DO NOT alter any permanent architectural element.",
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
    max_tokens: 1500,
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

  // Anchors
  p += `ANCHORS (use these to place furniture):\n`;
  p += `Focal Wall: ${roomData.anchors.focal}\n`;
  if (roomData.anchors.ceiling) p += `Ceiling: ${roomData.anchors.ceiling}\n`;
  p += `Back Wall: ${roomData.anchors.backWall}\n`;
  p += `Left Boundary: ${roomData.anchors.leftBoundary}\n`;
  p += `Right Boundary: ${roomData.anchors.rightBoundary}\n`;
  p += `Front Boundary: ${roomData.anchors.frontBoundary}\n\n`;

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

  // Room-specific staging instructions
  if (roomData.roomType.toLowerCase().includes('kitchen')) {
    p += `KITCHEN STAGING:\n`;
    p += `Place counter stools below pendant lights (if island present)\n`;
    p += `Place bowl of fruit or small plant on island/counter\n`;
    p += `Keep backsplash and cabinetry exactly as shown\n`;
    p += `Do not extend beyond left/right boundaries\n`;
    p += `Do not stage into dining area visible through opening\n\n`;
  } else if (roomData.roomType.toLowerCase().includes('living') || roomData.roomType.toLowerCase().includes('great room')) {
    p += `LIVING ROOM STAGING:\n`;
    p += `Place area rug centered under ceiling fixture, extending from ${roomData.anchors.frontBoundary} to 18 inches in front of ${roomData.anchors.backWall}\n`;
    p += `Place sofa with back against ${roomData.anchors.backWall}, centered on rug, facing ${roomData.anchors.focal}\n`;
    p += `Place two accent chairs on rug angled inward toward focal point\n`;
    p += `Place coffee table centered on rug between sofa and focal point\n`;
    p += `Place console against right wall (${roomData.anchors.rightBoundary})\n`;
    p += `Place plant right of focal point\n`;
    p += `Place art piece above focal point\n`;
    p += `Place arc floor lamp behind left accent chair\n`;
    p += `Keep all furniture within zone boundary (do not extend past ${roomData.anchors.leftBoundary} or ${roomData.anchors.rightBoundary})\n\n`;
  } else if (roomData.roomType.toLowerCase().includes('bedroom')) {
    p += `BEDROOM STAGING:\n`;
    p += `Place bed headboard against ${roomData.anchors.backWall}, centered\n`;
    p += `Place matching nightstands flanking bed\n`;
    p += `Place dresser on opposite wall (${roomData.anchors.focal})\n`;
    p += `Place bench at foot of bed\n`;
    p += `Keep all furniture within zone boundary\n\n`;
  }

  // Critical rules
  p += `DO NOT stage beyond zone boundary:\n`;
  p += `— Do not extend furniture past left boundary (${roomData.anchors.leftBoundary})\n`;
  p += `— Do not extend furniture past right boundary (${roomData.anchors.rightBoundary})\n`;
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
    const { imageBase64, mimeType, roomType, designStyle, colorPalette } = JSON.parse(event.body);
    const claudeKey = process.env.ANTHROPIC_API_KEY;

    if (!imageBase64) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing imageBase64" }) };
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
