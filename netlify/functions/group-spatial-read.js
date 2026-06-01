// group-spatial-read.js — Multi-Angle Spatial Pre-Read
// Phase 1: Haiku reads ALL images simultaneously → builds Master Spatial Plan JSON
//   - PRESERVE list with zone-assigned ceiling fixtures
//   - zoneAnchorLocks: ceiling + front wall + back wall anchors per zone
//   - masterFurniturePlan: one furniture set used across all images
//   - perImageAnchors: per-image boundary anchors + visible zones
//   - positiveStagingInstructions: per-image, per-zone, in correct build order
//   - conflictsDetected / globalProhibitions
// Phase 2: assemblePlainTextPrompt → one plain text string per image
//   Sequence: PRESERVE → Zone Anchor Locks → Boundary Anchors →
//             Positive Staging Instructions → Prohibitions → Footer
// This string is what user reads/edits in Review modal and what goes to GPT Image 2.

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

// ── MIME TYPE DETECTOR ───────────────────────────────────────────────────────
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

// ── PHASE 1: HAIKU MULTI-IMAGE SPATIAL READ ──────────────────────────────────
async function runSpatialPreRead({ images, groupType, claudeKey }) {
  const imageBlocks = images.map((img, i) => ([
    {
      type: "image",
      source: { type: "base64", media_type: detectMime(img.base64), data: img.base64 }
    },
    { type: "text", text: `IMAGE ${i + 1} — ${img.label || img.fileName || ('Angle ' + (i + 1))}` }
  ])).flat();

  const isBedroom = groupType === 'bedroom';

  const prompt = `You are analyzing ${images.length} photos of the same ${isBedroom ? 'bedroom' : 'open plan living space'} from different camera angles.
All images show the same physical space. Your job is to build a unified spatial inventory for MLS virtual staging.

CRITICAL RULES:
1. Every ceiling fixture MUST be assigned to its correct zone by name in the PRESERVE list and in zoneAnchorLocks. Never describe a fixture without naming its zone.
2. Every placement instruction MUST reference a visible architectural landmark — ceiling fixture, wall, column, hearth, window frame. No abstract spatial concepts.
3. The PRESERVE list must describe only elements that are actually visible in the photos. Do not invent features (no pools, no decks, no prep zones) that are not photographed.
4. positiveStagingInstructions must appear for EVERY visible zone in EVERY image. Never leave a zone without positive instructions.
5. Prohibitions come LAST — never instead of positive instructions.
6. Zone anchor fixtures LOCK zone identity. When identified, they ALWAYS fire the same anchor staging instruction regardless of camera angle.

CEILING FIXTURE → ZONE ASSIGNMENT RULES (open plan):
- Chandelier over open floor area = DINING ZONE anchor. Always. Never kitchen.
- Pendant lights over island = KITCHEN ZONE anchor. Always.
- Ceiling fan = LIVING/GREAT ROOM ZONE anchor. Always.

WALL ANCHOR RULES (living zone):
- Back wall anchor = the wall the sofa back goes against (pass-through wall, structural wall, or rear wall — whichever defines the depth of the living zone).
- Front wall anchor = the fireplace wall or feature wall all seating faces.
- Sofa ALWAYS goes back-against-back-wall facing front wall. Never floats in the middle.

Return ONLY valid JSON — no markdown, no preamble, no trailing text.

{
  "groupType": "${groupType}",
  "anglesRead": ${images.length},

  "masterPreserve": "Comprehensive comma-separated PRESERVE list. Every ceiling fixture described with: fixture type, arm/bulb count, finish, shade description, AND zone assignment in parentheses. Example: '5-arm brushed nickel chandelier with clear glass cone shades (DINING ZONE ANCHOR), 2-light clear seeded glass drum pendants on brushed nickel chain over island (KITCHEN ZONE ANCHOR), 3-blade brushed nickel ceiling fan with integrated light kit (LIVING ZONE ANCHOR)'. Include all cabinetry, countertops, flooring, windows with exact pane description, all door types and locations, fireplace surround, island base and countertop, backsplash, appliances. Only describe what is photographed. End with: DO NOT alter any permanent architectural element.",

  "zoneAnchorLocks": {
    "diningZone": {
      "present": true or false,
      "ceilingAnchor": "Full description of chandelier — e.g. '5-arm brushed nickel chandelier with clear glass cone shades' — or null if no dining zone",
      "ceilingAnchorInstruction": "Place [rug shape and material] area rug centered directly under the [chandelier description]. Place [table description] centered on rug. Place [N] [chair description] chairs around the table. — or null",
      "backWallAnchor": null,
      "frontWallAnchor": null
    },
    "kitchenZone": {
      "present": true or false,
      "ceilingAnchor": "Full description of pendant lights over island — or null",
      "ceilingAnchorInstruction": "Place [N] [stool description] bar stools on the dining-zone-facing side of the island only, directly below the pendant lights. — or null",
      "islandNote": "FLOATING KITCHEN ISLAND CABINET — do not remove, relocate, resize, or alter. — or null"
    },
    "livingZone": {
      "present": true or false,
      "ceilingAnchor": "Full description of ceiling fan — or null",
      "ceilingAnchorInstruction": "Place [rug description] area rug centered directly under the [ceiling fan description].",
      "backWallAnchor": "Description of the wall the sofa back goes against — e.g. 'pass-through wall on the left', 'rear structural wall', 'wall with pass-through opening above it'. This is the wall visible in the image that defines the depth of the living zone.",
      "backWallAnchorInstruction": "Place [sofa description] sofa with its back against the [back wall description], centered on the rug, facing the fireplace.",
      "frontWallAnchor": "Description of the fireplace wall — e.g. 'white painted fireplace surround centered on back wall'",
      "frontWallAnchorInstruction": "All living zone seating faces the [fireplace description] on the [front wall description]."
    },
    "bedroomZone": {
      "present": ${isBedroom ? 'true' : 'false'},
      "backWallAnchor": "${isBedroom ? 'Solid wall with no doors or windows — confirmed clear across angles — headboard wall' : 'null'}",
      "backWallAnchorInstruction": "${isBedroom ? 'Place bed with headboard against the [back wall description]. Center bed on the wall.' : 'null'}",
      "leftClearance": "${isBedroom ? 'Description of left wall element requiring clearance — door, closet, window — or null' : 'null'}",
      "rightClearance": "${isBedroom ? 'Description of right wall element requiring clearance — door, closet, window — or null' : 'null'}"
    }
  },

  "conflictsDetected": [
    {
      "element": "Name of element that was ambiguous or contradictory across angles",
      "conflict": "What was ambiguous — e.g. 'appeared to be window from angle 1, patio door from angle 2'",
      "resolution": "The correct interpretation — e.g. 'Confirmed sliding glass patio door adjacent to two fixed grid windows on right wall'"
    }
  ],

  "masterFurniturePlan": {
    "style": "One phrase design style",
    "livingZone": {
      "sofa": "fabric, color, profile description",
      "accentChairs": "count, style, fabric — placed where sofa would traditionally be, angled toward fireplace",
      "coffeeTable": "material, shape",
      "rug": "large, shape, material",
      "console": "dark wood console or credenza, right wall under windows — or null if no window wall",
      "plant": "one large plant, type, pot, placement right of fireplace — or null",
      "art": "one landscape art piece centered above fireplace surround, 50-60% surround width — or null",
      "floorLamp": "arc floor lamp behind left accent chair — or null"
    },
    "diningZone": {
      "table": "material, shape, size",
      "chairs": "count, style, fabric",
      "rug": "large round jute or natural fiber",
      "centerpiece": "one tall vase with stems or greenery"
    },
    "kitchenZone": {
      "stools": "count, style, frame finish",
      "props": "one small bowl of fruit on island countertop only — all other surfaces clean"
    }
  },

  "perImageAnchors": [
    ${images.map((img, i) => `{
      "imageIndex": ${i},
      "imageLabel": "${img.label || img.fileName || ('Angle ' + (i + 1))}",
      "cameraPosition": "Brief description of where camera is positioned and what direction it faces",
      "visibleZones": ["zones clearly visible in this image — kitchen, dining, living, bedroom"],
      "primaryAnchor": "The single most prominent visible ceiling fixture or architectural feature that orients this image",
      "furnitureBoundaryAnchors": {
        "livingRugCenter": "Center rug under [specific ceiling fan description visible in this image] — or null if living zone not visible",
        "livingRugDepth": "Rug spans from approximately 18 inches in front of [fireplace hearth description] back to approximately 18 inches in front of [back wall description] — or null",
        "livingLeftBoundary": "Left furniture boundary: [specific visible wall, column, or element] — or null",
        "livingRightBoundary": "Right furniture boundary: [specific visible wall or window] — or null",
        "livingSofaNote": "Sofa back against [back wall description], centered on rug, facing [fireplace description] — or null",
        "livingZoneScale": "normal — or 'background scale: this zone is in the far rear of the frame, scale furniture smaller than foreground zones' if living zone is in the deep background",
        "diningRugCenter": "Center dining rug under [chandelier description] — or null if dining not visible",
        "diningBoundary": "Dining rug does not extend past [specific landmark] on kitchen side or [specific landmark] on living side — or null",
        "islandStoolSide": "Stools on [dining-zone-facing / far] side of island only — or null if kitchen not visible"
      },
      "positiveStagingInstructions": {
        "diningZone": "Full positive staging sequence for dining zone visible in this image, using anchor fixture as starting point. Format: 'DINING ZONE: Place [rug] centered under [chandelier]. Place [table] centered on rug. Place [N chairs]. Place [centerpiece].' — or null if dining not visible in this image",
        "kitchenZone": "Full positive staging sequence for kitchen zone. Format: 'KITCHEN ZONE: Place [N stools] on the dining-zone-facing side of the island below the [pendant description]. Place [props] on island. Keep all surfaces clean.' — or null if kitchen not visible",
        "livingZone": "Full positive staging sequence for living zone. ALWAYS starts with rug under fan, then sofa against back wall, then chairs angled toward fireplace, then coffee table, then accessories. Format: 'LIVING ZONE: Place [rug] centered under [ceiling fan]. Rug spans from 18 inches in front of [hearth] to 18 inches in front of [back wall]. Place [sofa] with back against [back wall description], centered on rug, facing [fireplace]. Place [N accent chairs] on rug angled inward toward fireplace. Place [coffee table] centered on rug between sofa and fireplace. Place [console] against [wall]. Place [plant]. Place [art] above fireplace. Place [floor lamp].' — or null if living not visible",
        "bedroomZone": "Full positive staging sequence for bedroom if present — or null"
      },
      "imageSpecificProhibitions": [
        "DO NOT [specific prohibition derived from what IS visible in this image and confirmed by cross-angle read — e.g. DO NOT convert the two fixed grid windows into a patio door, DO NOT extend furniture past the end of the pass-through wall, DO NOT place bar stools on the camera-facing side of the island]"
      ]
    }`).join(',\n    ')}
  ],

  "globalProhibitions": [
    "DO NOT add walls, half-walls, or enclosures between zones.",
    "DO NOT alter room proportions, ceiling height, or spatial geometry — furniture and decor additions only.",
    "DO NOT add exterior features, pools, decks, or any element not visible in the photographs.",
    "Additional global prohibition derived from cross-angle findings if any."
  ]
}`;

  const payload = JSON.stringify({
    model: "claude-haiku-4-5",
    max_tokens: 4000,
    messages: [{
      role: "user",
      content: [
        ...imageBlocks,
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

  if (result.status !== 200) {
    console.error("Haiku spatial pre-read error:", JSON.stringify(result.body).slice(0, 300));
    throw new Error("Haiku spatial pre-read failed: " + (result.body?.error?.message || result.status));
  }

  const text = result.body?.content?.[0]?.text?.trim() || "{}";
  const clean = text.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch(e) {
    console.warn("Spatial pre-read JSON truncated — attempting repair. Length:", clean.length);
    try {
      let repaired = clean;
      repaired = repaired.replace(/,\s*$/, '').replace(/"[^"]*$/, '').replace(/:\s*$/, '');
      let braces = 0, brackets = 0;
      for (const ch of repaired) {
        if (ch === '{') braces++;
        else if (ch === '}') braces--;
        else if (ch === '[') brackets++;
        else if (ch === ']') brackets--;
      }
      while (brackets > 0) { repaired += ']'; brackets--; }
      while (braces > 0) { repaired += '}'; braces--; }
      const parsed = JSON.parse(repaired);
      console.warn("Spatial pre-read JSON repaired successfully");
      return parsed;
    } catch(e2) {
      console.error("Spatial pre-read JSON parse failed after repair:", clean.slice(0, 400));
      throw new Error("Spatial pre-read returned invalid JSON — try reducing image count or check max_tokens");
    }
  }
}

// ── PHASE 2: ASSEMBLE PLAIN TEXT PROMPT PER IMAGE ────────────────────────────
// Sequence: PRESERVE → Zone Anchor Locks → Boundary Anchors →
//           Positive Staging Instructions → Prohibitions → Compliance Footer
// This is exactly what user reads/edits in Review modal and what goes to GPT Image 2.
function assemblePlainTextPrompt({ spatialPlan, imageIndex, designStyle, colorPalette }) {
  const rawStyle = designStyle || 'Organic Modern';
  const style = STYLE_LABELS[rawStyle?.toLowerCase().replace(/[^a-z]/g, '')] || rawStyle;
  const palette = colorPalette || 'Warm Neutrals';
  const paletteTones = PALETTE_TONES[palette] || `${palette} tones`;

  const locks = spatialPlan.zoneAnchorLocks || {};
  const imgAnchor = spatialPlan.perImageAnchors?.[imageIndex] || {};
  const bounds = imgAnchor.furnitureBoundaryAnchors || {};
  const positive = imgAnchor.positiveStagingInstructions || {};
  const visibleZones = imgAnchor.visibleZones || [];
  const prohibitions = [
    ...(imgAnchor.imageSpecificProhibitions || []),
    ...(spatialPlan.globalProhibitions || [])
  ];

  const hasLiving = visibleZones.includes('living');
  const hasDining = visibleZones.includes('dining');
  const hasKitchen = visibleZones.includes('kitchen');
  const hasBedroom = visibleZones.includes('bedroom');

  let p = '';

  // ── 1. PRESERVE ─────────────────────────────────────────────────────────────
  p += `PRESERVE EXACTLY: ${spatialPlan.masterPreserve}\n\n`;
  p += `Stage with furniture and decor only. Do not alter any permanent architectural element. `;
  p += `Stage this space in ${style} design style using a ${palette} palette with ${paletteTones} throughout.\n\n`;

  // ── 2. ZONE ANCHOR LOCKS ────────────────────────────────────────────────────
  const anchorLines = [];

  if (hasDining && locks.diningZone?.present && locks.diningZone?.ceilingAnchor) {
    anchorLines.push(
      `DINING ZONE ANCHOR LOCK — ${locks.diningZone.ceilingAnchor}: ` +
      `This fixture is the permanent anchor for the Dining Zone. ` +
      `The dining rug and table center directly under this fixture. ` +
      `This is NOT a kitchen fixture and does NOT hang over the island.`
    );
  }

  if (hasKitchen && locks.kitchenZone?.present && locks.kitchenZone?.ceilingAnchor) {
    anchorLines.push(
      `KITCHEN ZONE ANCHOR LOCK — ${locks.kitchenZone.ceilingAnchor}: ` +
      `These fixtures anchor the Kitchen Zone over the island. ` +
      `${locks.kitchenZone.islandNote || 'DO NOT remove, relocate, resize, or alter the floating kitchen island cabinet.'}`
    );
  }

  if (hasLiving && locks.livingZone?.present) {
    const lz = locks.livingZone;
    let livingLock = `LIVING ZONE ANCHOR LOCKS:\n`;
    if (lz.ceilingAnchor) livingLock += `  Ceiling anchor: ${lz.ceilingAnchor} — rug centers directly under this fixture.\n`;
    if (lz.frontWallAnchor) livingLock += `  Front wall anchor: ${lz.frontWallAnchor} — all seating faces this wall.\n`;
    if (lz.backWallAnchor) livingLock += `  Back wall anchor: ${lz.backWallAnchor} — sofa back goes against this wall, centered, facing the fireplace.\n`;
    anchorLines.push(livingLock.trim());
  }

  if (hasBedroom && locks.bedroomZone?.present) {
    const bz = locks.bedroomZone;
    let bedroomLock = `BEDROOM ZONE ANCHOR LOCKS:\n`;
    if (bz.backWallAnchor) bedroomLock += `  Headboard wall: ${bz.backWallAnchor} — bed headboard goes against this wall centered.\n`;
    if (bz.leftClearance && bz.leftClearance !== 'null') bedroomLock += `  Left clearance required: ${bz.leftClearance}.\n`;
    if (bz.rightClearance && bz.rightClearance !== 'null') bedroomLock += `  Right clearance required: ${bz.rightClearance}.\n`;
    anchorLines.push(bedroomLock.trim());
  }

  if (anchorLines.length) {
    p += anchorLines.join('\n\n') + '\n\n';
  }

  // ── 3. FURNITURE BOUNDARY ANCHORS ───────────────────────────────────────────
  const boundaryLines = [];

  if (hasLiving) {
    if (bounds.livingRugCenter) boundaryLines.push(bounds.livingRugCenter + '.');
    if (bounds.livingRugDepth) boundaryLines.push(bounds.livingRugDepth + '.');
    if (bounds.livingSofaNote) boundaryLines.push(bounds.livingSofaNote + '.');
    if (bounds.livingLeftBoundary) boundaryLines.push(bounds.livingLeftBoundary + '.');
    if (bounds.livingRightBoundary) boundaryLines.push(bounds.livingRightBoundary + '.');
    if (bounds.livingZoneScale && bounds.livingZoneScale !== 'normal') boundaryLines.push(bounds.livingZoneScale + '.');
  }
  if (hasDining) {
    if (bounds.diningRugCenter) boundaryLines.push(bounds.diningRugCenter + '.');
    if (bounds.diningBoundary) boundaryLines.push(bounds.diningBoundary + '.');
  }
  if (hasKitchen) {
    if (bounds.islandStoolSide) boundaryLines.push(bounds.islandStoolSide + '.');
  }

  if (boundaryLines.length) {
    p += `FURNITURE BOUNDARY ANCHORS:\n${boundaryLines.join(' ')}\n\n`;
  }

  // ── 4. POSITIVE STAGING INSTRUCTIONS ────────────────────────────────────────
  // Zone order: Dining → Kitchen → Living → Bedroom
  // Each zone gets its full positive sequence before any prohibitions.
  const positiveBlocks = [];

  if (hasDining && positive.diningZone && positive.diningZone !== 'null') {
    positiveBlocks.push(positive.diningZone);
  }
  if (hasKitchen && positive.kitchenZone && positive.kitchenZone !== 'null') {
    positiveBlocks.push(positive.kitchenZone);
  }
  if (hasLiving && positive.livingZone && positive.livingZone !== 'null') {
    positiveBlocks.push(positive.livingZone);
  }
  if (hasBedroom && positive.bedroomZone && positive.bedroomZone !== 'null') {
    positiveBlocks.push(positive.bedroomZone);
  }

  if (positiveBlocks.length) {
    p += `POSITIVE STAGING INSTRUCTIONS:\n${positiveBlocks.join('\n\n')}\n\n`;
  }

  // ── 5. PROHIBITIONS ─────────────────────────────────────────────────────────
  if (prohibitions.length) {
    p += prohibitions.filter(Boolean).join('\n') + '\n\n';
  }

  // ── 6. COMPLIANCE FOOTER ────────────────────────────────────────────────────
  // Hardcoded — cannot be removed or varied by Haiku output
  p += `Use ${style} furniture with clean architectural lines, refined materials, soft layered textures, and metallic accents. `;
  p += `Maintain open circulation, realistic furniture scale proportional to the room size visible in the photograph, and MLS-photorealistic quality throughout. `;
  p += `Do not scale furniture up to fill the frame — scale to the actual room geometry. `;
  p += `Preserve all architectural features, room dimensions, lighting placement, flooring, and camera perspective exactly as photographed. `;
  p += `This image will be used for MLS listing per California AB 723 §10140.6. `;
  p += `Room proportions and spatial relationships must be preserved exactly. `;
  p += `Virtual staging adds furniture and decor only — any alteration to perceived room size or spatial geometry is prohibited.`;

  return p.trim();
}

// ── HANDLER ───────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const { images, groupType, designStyle, colorPalette } = JSON.parse(event.body);

    if (!images || !Array.isArray(images) || images.length < 2) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "At least 2 images required for group spatial read" }) };
    }
    if (images.length > 5) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Maximum 5 images per group" }) };
    }

    const claudeKey = process.env.ANTHROPIC_API_KEY;
    if (!claudeKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }) };

    console.log(`Group spatial read: ${images.length} images, type=${groupType}`);

    // Phase 1: Haiku reads all images simultaneously
    const spatialPlan = await runSpatialPreRead({ images, groupType: groupType || 'openplan', claudeKey });

    console.log(`Spatial plan built: ${spatialPlan.conflictsDetected?.length || 0} conflicts, ${spatialPlan.perImageAnchors?.length || 0} per-image anchor sets`);

    // Phase 2: Assemble one plain text prompt per image
    const perImagePrompts = images.map((img, i) => ({
      imageIndex: i,
      imageLabel: img.label || img.fileName || `Angle ${i + 1}`,
      promptText: assemblePlainTextPrompt({ spatialPlan, imageIndex: i, designStyle, colorPalette }),
      anchors: spatialPlan.perImageAnchors?.[i] || {},
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        spatialPlan,
        perImagePrompts,
        conflictsResolved: spatialPlan.conflictsDetected?.length || 0,
        anglesRead: images.length,
      })
    };

  } catch (err) {
    console.error("group-spatial-read error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
