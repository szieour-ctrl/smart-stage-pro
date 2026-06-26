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

// ════════════════════════════════════════════════════════════════════════════════
// PHASE 5A TIER 1/2 ANCHOR LOGIC — Apply furnishing instructions based on anchors
// ════════════════════════════════════════════════════════════════════════════════

function applyTierLogic(zones) {
  console.log('applyTierLogic called with:', JSON.stringify(zones).slice(0, 200));
  
  if (!Array.isArray(zones)) zones = [zones];
  
  return zones.map((zone, idx) => {
    const zoneName = (zone.name || '').toLowerCase();
    const anchorPoint = (zone.anchor_point?.location || '').toLowerCase();
    const hasAnchor = anchorPoint && anchorPoint !== 'none' && anchorPoint.length > 0;
    
    console.log(`Zone ${idx}: name="${zone.name}" anchor="${zone.anchor_point?.location}" → furnishing applied`);
    
    let furnishing = '';

    // HALLWAY / CIRCULATION
    if (zoneName.includes('hallway') || zoneName.includes('circulation') || zoneName.includes('entry') || zoneName.includes('foyer')) {
      furnishing = 'LEAVE VACANT';
    }
    // KITCHEN
    else if (zoneName.includes('kitchen')) {
      furnishing = 'Style & Main Pieces: Kitchen island (1), bar stools (quantity per clearance), cabinetry (built-in, fixed). Incorporate tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic.';
    }
    // DINING + CHANDELIER/PENDANT (TIER 1)
    else if (zoneName.includes('dining') && (anchorPoint.includes('chandelier') || anchorPoint.includes('pendant'))) {
      furnishing = 'Place an area rug proportional to seating group with a round or rectangular dining table and seating not to exceed 6 chairs, in the open space. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic. Floor runners are prohibited.';
    }
    // DINING + NO ANCHOR (TIER 2)
    else if (zoneName.includes('dining') && !hasAnchor) {
      furnishing = 'Style & Main Pieces: [Transitional]. A round or rectangular dining table and seating not to exceed 6 chairs. Place an area rug proportional to seating group. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic. Floor runners are prohibited.';
    }
    // LIVING + FIREPLACE (TIER 1)
    else if ((zoneName.includes('living') || zoneName.includes('great room')) && anchorPoint.includes('fireplace')) {
      furnishing = 'Place an area rug proportional for the seating group 18" in front of the Fireplace anchoring the seating group to the Fireplace wall. Place a coffee table centered on the rug and Fireplace. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic.';
    }
    // LIVING + CEILING FAN (TIER 1)
    else if ((zoneName.includes('living') || zoneName.includes('great room')) && anchorPoint.includes('ceiling fan')) {
      furnishing = 'Place an area rug proportional for the seating group centered beneath the ceiling fan. Place a coffee table centered on the rug and ceiling fan. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic.';
    }
    // LIVING + NO ANCHOR (TIER 2)
    else if ((zoneName.includes('living') || zoneName.includes('great room')) && !hasAnchor) {
      furnishing = 'Style & Main Pieces: [Transitional]. Seating arrangement with sofa and accent chairs. Place an area rug proportional to seating group. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic. Floor runners are prohibited.';
    }
    // BEDROOM
    else if (zoneName.includes('bedroom')) {
      furnishing = 'Style & Main Pieces: Bed (1), nightstands (2), accent seating (optional). Incorporate tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic.';
    }

    return { 
      ...zone, 
      furnishing 
    };
  });
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

// ✅ HAIKU READS SINGLE VACANT ROOM — Returns 4-field zones
// For open plan rooms (roomType contains '+'), reads multiple zones
// For single rooms, reads one zone
async function readVacantRoom({ imageBase64, roomType, claudeKey }) {
  try {
    if (!imageBase64 || !roomType || !claudeKey) {
      throw new Error('Missing required params: imageBase64, roomType, claudeKey');
    }
    
    const isOpenPlan = roomType.includes('+');
    const zoneList = isOpenPlan
      ? roomType.split('+').map(z => z.trim()).filter(Boolean)
      : [roomType];

  const prompt = `You are reading a real estate listing photo to identify furnishing zones.

Room Type: ${roomType}
Zone type: ${isOpenPlan ? 'OPEN PLAN (multiple interconnected zones)' : 'SINGLE ROOM (one zone)'}

TASK: For each zone visible, return ONLY factual architectural data — no staging instructions, no furniture recommendations, no prose.

RULES:
1. ZONE IDENTIFICATION: Zones are bounded by permanent architectural elements (walls, partitions, openings, fireplaces, islands, windows).
2. ONE ZONE PER BOUNDED AREA: Kitchen = one zone. Dining = one zone. Living = one zone.
3. FLOATING ZONES (no enclosing walls): Use TIER 3 anchoring (position in frame + neighbor relationships).
4. FIXTURE FACTS ONLY: Report what is ACTUALLY VISIBLE. Do not infer. If no fixture visible, set to null.
5. BOUNDARY NAMING: Name neighbors on EVERY edge. Example: "Left: kitchen island. Right: fireplace wall. Front: circulation. Back: great room."
6. PRESERVED ARCHITECTURE: Name all permanent elements per zone — distribute across zones, no laundry list.

ANCHOR TIER CLASSIFICATION:
TIER 1 (HIGHEST PRECISION) — Zone has a dominant fixture:
  Examples: Chandelier, fireplace, ceiling fan, island with sink, appliances.

TIER 2 (MEDIUM PRECISION) — Zone has clear wall position but no fixture:
  Examples: Seating wall with windows, headboard wall, kitchen perimeter wall.

TIER 3 (LOWER PRECISION) — Zone is floating (no walls, no fixtures):
  Examples: Dining nook in open plan, flex room with no boundaries.
  Use: FOREGROUND / MIDGROUND / BACKGROUND + LEFT / CENTER / RIGHT + neighbor relationships.

EDGE CASES:
• Flex Room: Flag flexRoomType as null or inferred (home_office / sitting_room / formal_dining / etc).
• Multiple recessed lights: Name SPECIFIC location. "Recessed lights centered above dining zone".
• Sliding doors: Flag doorType: sliding. Clearance is ONE-SIDED.
• Swinging doors: Flag doorType: swinging. Clearance is ARC-BASED.
• Ceiling cut off: Flag ceilingVisibility: partial and low confidence.
• Hallway: Mark isHallway: true, keep empty.

RETURN ONLY THIS JSON — no markdown, no preamble:

{
  "zones": [
    {
      "name": "Zone name (Kitchen / Dining / Living / Bedroom / Flex Room / Hallway / etc)",
      "boundaries": "Reciprocal description of boundaries and neighbors on each edge.",
      "fixtures": "Comma-separated list of ceiling/structural fixtures visible in THIS ZONE ONLY, or null.",
      "cabinetry": "Kitchen/bathroom built-ins in THIS ZONE ONLY, or null.",
      "windows_doors": "All openings (windows, doors, pass-throughs) in THIS ZONE's boundaries, or null.",
      "anchor_point": {
        "tier": "TIER 1 or TIER 2 or TIER 3",
        "location": "Specific physical location.",
        "instruction": "How to use this anchor.",
        "confidence": "high / medium / low"
      },
      "negative_constraints": ["Do not extend past [boundary].", "Do not block [feature]."],
      "furnishing_specification": {
        "pieces": "Furniture types with FIXED COUNTS (not ranges).",
        "decor": "Decorative elements by count, or null.",
        "notes": "Additional context, or null."
      },
      "flags": {
        "flexRoomType": "null or inferred type",
        "doorType": "swinging / sliding / null",
        "ceilingVisibility": "full / partial",
        "isHallway": "true / false"
      }
    }
  ],
  "metadata": {
    "roomType": "${roomType}",
    "groupType": "${isOpenPlan ? 'open_plan' : 'single_room'}",
    "totalZones": "[count]",
    "conflictsDetected": [],
    "notes": "Any overall observations."
  }
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
  catch(e) {
    console.error('Vacant room JSON parse failed:', e.message);
    console.error('Attempted to parse:', clean.substring(0, 200));
    throw new Error("Vacant room JSON parse failed: " + e.message);
  }
  } catch(error) {
    console.error('readVacantRoom error:', error.message);
    throw error;
  }
}

// ✅ TRANSFORM 4-FIELD ZONES INTO ANCHORS (backwards compatibility)
function zonesIntoAnchors(zones) {
  if (!zones || zones.length === 0) {
    // Fallback: no zones, return minimal anchors
    return {
      focal: 'primary wall',
      ceiling: 'ceiling fixture',
      backWall: 'back wall',
      leftBoundary: 'left boundary',
      rightBoundary: 'right boundary',
      frontBoundary: 'front circulation'
    };
  }

  const zone = zones[0]; // Use first/primary zone
  const anchorTier = zone.anchor_point || {};

  // Extract boundaries from string
  const boundaryStr = zone.boundaries || '';
  const parseBoundary = (pattern) => {
    const match = boundaryStr.match(new RegExp(pattern + ': ([^.]+)', 'i'));
    return match ? match[1].trim() : 'not specified';
  };

  return {
    focal: anchorTier.location || anchorTier.instruction || 'primary focal point',
    ceiling: zone.fixtures || 'ceiling fixture',
    backWall: parseBoundary('Back') || 'back wall',
    leftBoundary: parseBoundary('Left') || 'left boundary',
    rightBoundary: parseBoundary('Right') || 'right boundary',
    frontBoundary: parseBoundary('Front') || 'front circulation'
  };
}

// ✅ BUILD ROOMDATA FROM HAIKU 4-FIELD ZONES

// ✅ BUILD PROMPT FOR VACANT ROOM STAGING — TEMPLATE STRUCTURE (COMPLETE REBUILD)
function buildVacantPrompt({ roomData, designStyle, colorPalette }) {
  const rawStyle = designStyle || 'Organic Modern';
  const style = STYLE_LABELS[rawStyle?.toLowerCase().replace(/[^a-z]/g, '')] || rawStyle;
  const palette = colorPalette || 'Warm Neutrals';
  const paletteTones = PALETTE_TONES[palette] || (palette + ' tones');
  
  let p = '';

  // ════════════════════════════════════════════════════════════════════════════════
  // SECTION 1-8: BOILERPLATE (IDENTICAL FOR ALL IMAGES)
  // ════════════════════════════════════════════════════════════════════════════════

  p += `PRIMARY ROLE: You are a professional luxury real estate interior designer, home stager, and architectural photographer.\n\n`;

  p += `AB 723 COMPLIANCE REQUIREMENTS (HIGHEST PRIORITY)\n\n`;

  p += `IMMUTABLE LOCK: Never alter, move, remove, replace, or touch: structural walls | partial walls | half-walls | pass-through openings and their surrounding wall sections | ceilings | kitchen/bathroom cabinets | countertops | lighting fixtures. These must be preserved exactly as photographed. If a wall has a pass-through opening, both the opening AND the solid wall sections above and below it must remain exactly as photographed — do not enlarge, remove, or modify any wall section.\n\n`;

  p += `ABSOLUTE PROHIBITION: Never ADD architectural elements that do not exist in the original photo. Do NOT add: built-in shelving | niches | alcoves | recessed shelves | bookcases built into walls | fireplace surrounds | wall openings | cabinetry | any structural element. If it is not visible in the original photograph, it cannot appear in the staged image.\n\n`;

  p += `AB 723 COMPLIANCE: Virtual staging adds furniture only. Any alteration to permanent architecture — including ADDING elements not present — makes the listing non-compliant and subject to MLS removal.\n\n`;

  p += `════════════════════════════════════════════════════════════════════════════════\n\n`;

  p += `(SPATIAL READ) TASK\n`;
  p += `Analyze the uploaded room photograph and identify all functional furnishing zones based solely on the visible architecture, fixtures, openings, windows, cabinetry, fireplaces, built-ins, ceiling features, and circulation paths.\n`;
  p += `Determine a visual spatial map that clearly illustrates where furniture should be placed within the room or zone.\n\n`;

  p += `ZONE IDENTIFICATION RULES\n`;
  p += `Determine zone boundaries using architectural cues including: walls, partial walls, openings, doorways, windows, sliding glass doors, fireplaces, kitchen islands, cabinetry, ceiling changes, chandeliers, pendant lighting, ceiling fans, built-ins, hallways (stay unobstructed), and circulation paths.\n\n`;

  p += `PRESERVE EXACTLY: All architectural elements, room dimensions, ceiling heights, wall locations, window locations, door locations, fireplaces, cabinetry, countertops, appliances, flooring, lighting fixtures, HVAC vents, trim, skylights, built-ins, and all permanent fixtures.\n`;
  p += `Do not add, remove, relocate, resize, conceal, replace, or alter any permanent architectural feature.\n`;
  p += `Do not modify room dimensions, ceiling heights, window sizes, window locations, door locations, cabinetry, fireplaces, flooring, or structural openings.\n`;
  p += `Virtual staging may add furniture, rugs, artwork, plants, electronics, lighting accessories, and decorative objects only.\n`;
  p += `Any alteration to permanent architecture violates California AB 723 compliance standards.\n\n`;

  p += `SPATIAL PRESERVATION\n`;
  p += `Respect the exact camera position, focal length, perspective, room proportions, and spatial geometry shown in the original photograph.\n`;
  p += `Maintain all architectural sightlines, circulation paths, and relationships between walls, openings, windows, cabinetry, and fixtures.\n`;
  p += `Treat each furnishing zone as an independent furnishing area bounded by permanent architectural elements.\n`;
  p += `Furniture must remain entirely within its assigned zone and may not extend into adjacent zones, hallways, kitchen work areas, doorways, fireplaces, windows, or architectural openings.\n\n`;

  p += `PHOTOGRAPHIC DEPTH & COMPOSITION\n`;
  p += `Create strong foreground, midground, and background visual layers to increase depth perception.\n`;
  p += `Arrange furnishings to create a natural visual progression through the room rather than placing all furniture against walls.\n`;
  p += `Use furniture groupings, rugs, tables, plants, artwork, and accessories to establish realistic spatial hierarchy.\n`;
  p += `Maintain proper furniture scale and realistic spacing throughout the room.\n`;
  p += `Anchor all furniture naturally to the floor with realistic contact shadows.\n\n`;

  p += `LIGHTING & REALISM\n`;
  p += `Preserve all existing natural and artificial light sources exactly as photographed.\n`;
  p += `Maintain realistic daylight behavior from windows, skylights, and glass doors.\n`;
  p += `Create natural shadow falloff, reflected light, and subtle contrast variations.\n`;
  p += `Avoid flat lighting, excessive brightness, blown highlights, or artificial HDR appearance.\n`;
  p += `Use realistic material behavior for wood, fabric, stone, metal, glass, and upholstery.\n\n`;

  p += `DESIGN EXECUTION\n`;
  p += `Stage in the selected design style and color palette.\n`;
  p += `Create a professionally designed, market-ready interior suitable for luxury real estate marketing.\n`;
  p += `Add carefully curated furniture, artwork, accessories, greenery, and styling details that support the selected buyer profile.\n`;
  p += `Avoid clutter, overcrowding, exaggerated furniture sizes, or unrealistic luxury elements.\n\n`;

  p += `FINAL IMAGE REQUIREMENTS\n`;
  p += `The finished image must appear indistinguishable from a professionally photographed and professionally staged real property.\n`;
  p += `The result should feel spatially accurate, naturally furnished, architecturally preserved, and fully compliant with California AB 723 virtual staging requirements.\n`;
  p += `The final image must look like a real photograph, not a rendering, illustration, CGI image, or AI-generated composition.\n\n`;

  p += `DESIGN STYLE & PALETTE\n`;
  p += `Stage in ${style} design style using a ${palette} palette with ${paletteTones} throughout.\n\n`;

  // ════════════════════════════════════════════════════════════════════════════════
  // SECTION 9: ZONE-BY-ZONE STAGING INSTRUCTIONS
  // ════════════════════════════════════════════════════════════════════════════════

  const isOpenPlan = Array.isArray(roomData.zones) && roomData.zones.length > 0;

  if (isOpenPlan && roomData.zones && roomData.zones.length > 0) {
    // OPEN PLAN: Per-zone bullet format
    p += `ZONE-BY-ZONE STAGING INSTRUCTIONS:\n\n`;

    roomData.zones.forEach(zone => {
      p += `Zone: ${zone.name || 'Unknown Zone'}\n`;
      p += `• Boundaries: ${zone.boundaries || 'Not specified'}\n`;
      p += `• Fixtures: ${zone.fixtures || 'None visible'}\n`;
      p += `• Cabinetry: ${zone.cabinetry || 'None visible'}\n`;
      p += `• Windows/Doors: ${zone.windows_doors || 'None visible'}\n`;
      p += `• Anchor Point: ${zone.anchor_point?.location || 'Not specified'}\n`;
      p += `• Focal Point: ${zone.anchor_point?.instruction || 'Not specified'}\n`;
      p += `• Furnishing — Style & Main Pieces: ${zone.furnishing || zone.furnishing_specification?.pieces || 'Not specified'}\n`;
      p += `  Incorporate tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic.\n\n`;
    });
  } else {
    // SINGLE ROOM: Format as single zone
    const anchors = roomData.anchors || {};
    const boundaries = roomData.zoneBoundary 
      ? `Front: ${roomData.zoneBoundary.front || 'circulation'}, Back: ${roomData.zoneBoundary.back || 'wall'}, Left: ${roomData.zoneBoundary.left || 'boundary'}, Right: ${roomData.zoneBoundary.right || 'boundary'}`
      : 'As photographed';

    p += `Zone: ${roomData.roomType || 'Room'}\n`;
    p += `• Boundaries: ${boundaries}\n`;
    p += `• Fixtures: ${anchors.ceiling || 'As photographed'}\n`;
    p += `• Cabinetry: None visible\n`;
    p += `• Windows/Doors: As photographed\n`;
    p += `• Anchor Point: ${anchors.focal || 'Primary focal wall'}\n`;
    p += `• Focal Point: ${anchors.focal || 'Primary focal point'}\n`;

    // ✅ Use tier-logic-applied furnishing if available from zones
    let furnishing = 'Furniture anchored to focal point; maintain zone boundaries.';
    if (roomData.zones && Array.isArray(roomData.zones) && roomData.zones.length > 0) {
      furnishing = roomData.zones[0].furnishing || furnishing;
    } else if (roomData.roomType) {
      // Fallback to generic furnishing per room type
      if (roomData.roomType.toLowerCase().includes('kitchen')) {
        furnishing = 'Counter seating anchored to island; minimal additional furniture for working zone function.';
      } else if (roomData.roomType.toLowerCase().includes('living') || roomData.roomType.toLowerCase().includes('great room')) {
        furnishing = 'Seating group anchored to focal point with area rug; sofa, accent chairs, coffee table arranged for conversation and flow.';
      } else if (roomData.roomType.toLowerCase().includes('bedroom')) {
        furnishing = 'Bed centered on headboard wall; matching nightstands; dresser on opposite wall; bench at foot of bed.';
      }
    }

    p += `• Furnishing — Style & Main Pieces: ${furnishing}\n`;
    p += `  Incorporate tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic.\n\n`;
  }

  p += `DO NOT STAGE BEYOND ZONE BOUNDARY:\n`;
  p += `— Do not extend furniture past left boundary\n`;
  p += `— Do not extend furniture past right boundary\n`;
  p += `— Do not stage adjacent zones (keep vacant)\n`;
  p += `— Do not alter architectural elements\n`;
  p += `— Do not remove or modify permanent fixtures\n`;
  p += `— Maintain open circulation within the zone\n\n`;

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
    const haikuOutput = await readVacantRoom({ imageBase64, roomType, claudeKey });
    
    console.log('Haiku output zones:', JSON.stringify(haikuOutput.zones).slice(0, 300));
    
    // ✅ APPLY TIER LOGIC to zones (Tier 1/2 anchor rules)
    if (haikuOutput.zones && Array.isArray(haikuOutput.zones)) {
      console.log('Applying tier logic to', haikuOutput.zones.length, 'zones');
      haikuOutput.zones = applyTierLogic(haikuOutput.zones);
      console.log('After tier logic:', JSON.stringify(haikuOutput.zones).slice(0, 300));
    }
    
    // Transform 4-field zones into anchors (if needed)
    const roomData = {
      ...haikuOutput,
      anchors: haikuOutput.anchors || zonesIntoAnchors(haikuOutput.zones),
      preserveList: haikuOutput.preserveList || 'Standard preservation'
    };

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
    console.error("Stack trace:", err.stack);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message, details: err.stack }) };
  }
};
