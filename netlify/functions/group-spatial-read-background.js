// group-spatial-read-background.js — Netlify Background Function
// Runs Haiku multi-image spatial pre-read + prompt assembly.
// Stores result in Netlify Blobs. Client polls check-spatial-read.js.
// No timeout risk — background functions run up to 15 minutes.

const https = require("https");
const sharp = require("sharp");
const { getStore } = require("@netlify/blobs");

// Compress images for Haiku — 800px max is sufficient for spatial reading
// Keeps total Anthropic API payload manageable across multiple images
async function compressForRead(imageBase64) {
  try {
    const buffer = Buffer.from(imageBase64, "base64");
    const meta = await sharp(buffer).metadata();
    const maxDim = Math.max(meta.width || 0, meta.height || 0);
    const sizeKB = Math.round(buffer.length / 1024);
    if (maxDim <= 800 && sizeKB <= 600) return imageBase64;
    const compressed = await sharp(buffer)
      .resize(800, 800, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    console.log(`Compressed for spatial read: ${maxDim}px ${sizeKB}KB → ${Math.round(compressed.length/1024)}KB`);
    return compressed.toString("base64");
  } catch(e) {
    console.warn("Compression failed, using original:", e.message);
    return imageBase64;
  }
}

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
      "present": true,
      "ceilingAnchor": "chandelier description",
      "ceilingAnchorInstruction": "Place rug under chandelier. Place table on rug. Place chairs.",
      "backWallAnchor": null,
      "frontWallAnchor": null
    },
    "kitchenZone": {
      "present": true,
      "ceilingAnchor": "pendant description over island",
      "ceilingAnchorInstruction": "Place N stools on dining-zone-facing side below pendants.",
      "islandNote": "FLOATING KITCHEN ISLAND CABINET — do not remove, relocate, resize, or alter."
    },
    "livingZone": {
      "present": true,
      "ceilingAnchor": "ceiling fan description",
      "ceilingAnchorInstruction": "Place rug centered under ceiling fan.",
      "backWallAnchor": "wall the sofa back goes against — pass-through wall, rear wall, etc.",
      "backWallAnchorInstruction": "Place sofa back against [back wall], centered on rug, facing fireplace.",
      "frontWallAnchor": "fireplace wall description",
      "frontWallAnchorInstruction": "All seating faces [fireplace] on [front wall]."
    },
    "bedroomZone": {
      "present": ${isBedroom ? 'true' : 'false'},
      "backWallAnchor": ${isBedroom ? '"solid wall confirmed clear — headboard wall"' : 'null'},
      "backWallAnchorInstruction": ${isBedroom ? '"Place bed headboard against [back wall], centered."' : 'null'},
      "leftClearance": ${isBedroom ? '"[door/closet/window on left] — or null"' : 'null'},
      "rightClearance": ${isBedroom ? '"[door/closet/window on right] — or null"' : 'null'}
    }
  },

  "conflictsDetected": [
    {
      "element": "Name of element that was ambiguous or contradictory across angles",
      "conflict": "What was ambiguous",
      "resolution": "The correct interpretation"
    }
  ],

  "masterFurniturePlan": {
    "style": "one phrase",
    "livingZone": {
      "sofa": "fabric+color+profile",
      "accentChairs": "count+style+fabric",
      "coffeeTable": "material+shape",
      "rug": "shape+material",
      "console": "description+placement — or null",
      "plant": "type+pot+placement — or null",
      "art": "description — or null",
      "floorLamp": "description — or null"
    },
    "diningZone": {
      "table": "material+shape+size",
      "chairs": "count+style+fabric",
      "rug": "shape+material",
      "centerpiece": "description"
    },
    "kitchenZone": {
      "stools": "count+style+frame",
      "props": "one item only"
    }
  },

  "perImageAnchors": [
    ${images.map((img, i) => `{
      "imageIndex": ${i},
      "imageLabel": "${img.label || img.fileName || ('Angle ' + (i + 1))}",
      "cameraPosition": "one sentence — camera position and facing direction",
      "visibleZones": ["kitchen","dining","living"],
      "primaryAnchor": "most prominent visible ceiling fixture or architectural element",
      "furnitureBoundaryAnchors": {
        "livingRugCenter": "Center rug under [fan name] — or null",
        "livingRugDepth": "Rug from 18in in front of [hearth] to 18in in front of [back wall] — or null",
        "livingLeftBoundary": "[visible element] — or null",
        "livingRightBoundary": "[visible element] — or null",
        "livingSofaNote": "Sofa back against [back wall], facing [fireplace] — or null",
        "livingZoneScale": "normal — or background scale if living zone is in deep background of frame",
        "diningRugCenter": "Center under [chandelier name] — or null",
        "diningBoundary": "Rug edge stops at [landmark] — or null",
        "islandStoolSide": "Stools on dining-zone-facing side only — or null"
      },
      "positiveStagingInstructions": {
        "diningZone": "DINING ZONE: Place [rug] under [chandelier]. Place [table] on rug. Place [N chairs]. Place [centerpiece]. — or null",
        "kitchenZone": "KITCHEN ZONE: Place [N stools] on dining-zone-facing side below [pendants]. Place [props]. Keep surfaces clean. — or null",
        "livingZone": "LIVING ZONE: Place [rug] under [fan]. Rug from 18in of [hearth] to 18in of [back wall]. Place [sofa] back against [back wall] facing [fireplace]. Place [N chairs] angled toward fireplace. Place [coffee table]. Place [console]. Place [plant]. Place [art] above fireplace. Place [lamp]. — or null",
        "bedroomZone": "BEDROOM: Place [bed] headboard against [back wall]. Place [nightstands]. Place [dresser]. — or null"
      },
      "imageSpecificProhibitions": ["DO NOT [specific visible-landmark-based prohibition]"]
    }`).join(',\n    ')}
  ],

  "globalProhibitions": [
    "DO NOT add walls, half-walls, or enclosures between zones.",
    "DO NOT alter room proportions, ceiling height, or spatial geometry — furniture and decor additions only.",
    "DO NOT add exterior features, pools, decks, or any element not visible in the photographs."
  ]
}`;

  const payload = JSON.stringify({
    model: "claude-haiku-4-5",
    max_tokens: 6000,
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

  const hasLiving  = visibleZones.includes('living');
  const hasDining  = visibleZones.includes('dining');
  const hasKitchen = visibleZones.includes('kitchen');
  const hasBedroom = visibleZones.includes('bedroom');

  let p = '';

  // 1. PRESERVE
  p += `PRESERVE EXACTLY: ${spatialPlan.masterPreserve}\n\n`;
  p += `Stage with furniture and decor only. Do not alter any permanent architectural element. `;
  p += `Stage this space in ${style} design style using a ${palette} palette with ${paletteTones} throughout.\n\n`;

  // 2. ZONE ANCHOR LOCKS
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
    let ll = `LIVING ZONE ANCHOR LOCKS:\n`;
    if (lz.ceilingAnchor) ll += `  Ceiling anchor: ${lz.ceilingAnchor} — rug centers directly under this fixture.\n`;
    if (lz.frontWallAnchor) ll += `  Front wall anchor: ${lz.frontWallAnchor} — all seating faces this wall.\n`;
    if (lz.backWallAnchor) ll += `  Back wall anchor: ${lz.backWallAnchor} — sofa back goes against this wall, centered, facing the fireplace.\n`;
    anchorLines.push(ll.trim());
  }
  if (hasBedroom && locks.bedroomZone?.present) {
    const bz = locks.bedroomZone;
    let bl = `BEDROOM ZONE ANCHOR LOCKS:\n`;
    if (bz.backWallAnchor) bl += `  Headboard wall: ${bz.backWallAnchor}.\n`;
    if (bz.leftClearance && bz.leftClearance !== 'null') bl += `  Left clearance: ${bz.leftClearance}.\n`;
    if (bz.rightClearance && bz.rightClearance !== 'null') bl += `  Right clearance: ${bz.rightClearance}.\n`;
    anchorLines.push(bl.trim());
  }
  if (anchorLines.length) p += anchorLines.join('\n\n') + '\n\n';

  // 3. FURNITURE BOUNDARY ANCHORS
  const boundaryLines = [];
  if (hasLiving) {
    if (bounds.livingRugCenter) boundaryLines.push(bounds.livingRugCenter + '.');
    if (bounds.livingRugDepth)  boundaryLines.push(bounds.livingRugDepth + '.');
    if (bounds.livingSofaNote)  boundaryLines.push(bounds.livingSofaNote + '.');
    if (bounds.livingLeftBoundary)  boundaryLines.push(bounds.livingLeftBoundary + '.');
    if (bounds.livingRightBoundary) boundaryLines.push(bounds.livingRightBoundary + '.');
    if (bounds.livingZoneScale && bounds.livingZoneScale !== 'normal') boundaryLines.push(bounds.livingZoneScale + '.');
  }
  if (hasDining) {
    if (bounds.diningRugCenter) boundaryLines.push(bounds.diningRugCenter + '.');
    if (bounds.diningBoundary)  boundaryLines.push(bounds.diningBoundary + '.');
  }
  if (hasKitchen) {
    if (bounds.islandStoolSide) boundaryLines.push(bounds.islandStoolSide + '.');
  }
  if (boundaryLines.length) p += `FURNITURE BOUNDARY ANCHORS:\n${boundaryLines.join(' ')}\n\n`;

  // 4. POSITIVE STAGING INSTRUCTIONS — Dining → Kitchen → Living → Bedroom
  const positiveBlocks = [];
  if (hasDining  && positive.diningZone  && positive.diningZone  !== 'null') positiveBlocks.push(positive.diningZone);
  if (hasKitchen && positive.kitchenZone && positive.kitchenZone !== 'null') positiveBlocks.push(positive.kitchenZone);
  if (hasLiving  && positive.livingZone  && positive.livingZone  !== 'null') positiveBlocks.push(positive.livingZone);
  if (hasBedroom && positive.bedroomZone && positive.bedroomZone !== 'null') positiveBlocks.push(positive.bedroomZone);
  if (positiveBlocks.length) p += `POSITIVE STAGING INSTRUCTIONS:\n${positiveBlocks.join('\n\n')}\n\n`;

  // 5. PROHIBITIONS
  if (prohibitions.length) p += prohibitions.filter(Boolean).join('\n') + '\n\n';

  // 6. COMPLIANCE FOOTER — hardcoded, cannot be removed
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
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const siteID    = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
  const token     = process.env.NETLIFY_ACCESS_TOKEN;
  let jobId;

  try {
    const { jobId: jId, images, groupType, designStyle, colorPalette } = JSON.parse(event.body);
    jobId = jId;

    console.log(`Group spatial read background: jobId=${jobId} images=${images.length} type=${groupType}`);

    const store = getStore({ name: "staging-jobs", siteID, token });

    // Heartbeat — confirms background function is alive
    await store.setJSON(jobId, { status: "processing", startedAt: Date.now() });
    console.log(`Job ${jobId}: heartbeat written`);

    // Compress images for Haiku — spatial reading only needs 800px
    const readyImages = await Promise.all(
      images.map(async (img) => ({
        ...img,
        base64: await compressForRead(img.base64),
        mimeType: "image/jpeg"
      }))
    );
    console.log(`Job ${jobId}: images compressed, running spatial pre-read...`);

    // Phase 1: Haiku reads all images
    const spatialPlan = await runSpatialPreRead({ images: readyImages, groupType: groupType || 'openplan', claudeKey });
    console.log(`Job ${jobId}: spatial plan built — ${spatialPlan.conflictsDetected?.length || 0} conflicts, ${spatialPlan.perImageAnchors?.length || 0} anchor sets`);

    // Phase 2: Assemble plain text prompt per image
    const perImagePrompts = images.map((img, i) => ({
      imageIndex: i,
      imageLabel: img.label || img.fileName || `Angle ${i + 1}`,
      promptText: assemblePlainTextPrompt({ spatialPlan, imageIndex: i, designStyle, colorPalette }),
      anchors: spatialPlan.perImageAnchors?.[i] || {},
    }));

    // Store complete result
    await store.setJSON(jobId, {
      status: "done",
      spatialPlan,
      perImagePrompts,
      conflictsResolved: spatialPlan.conflictsDetected?.length || 0,
      anglesRead: images.length,
    });

    console.log(`Job ${jobId}: complete — stored in Blobs`);

  } catch (err) {
    console.error(`Job ${jobId} error:`, err.message);
    try {
      const store = getStore({ name: "staging-jobs", siteID, token });
      await store.setJSON(jobId, { status: "error", error: err.message });
    } catch(e) {}
  }
};
