// group-spatial-read.js — Two-mode function
//
// MODE 1: "spatial" — Step 1
//   Haiku reads ALL images simultaneously.
//   Returns ONLY zone/anchor assignments per image — no PRESERVE, no furniture prose.
//   User reviews/edits in Group Session panel. Approves zones.
//
// MODE 2: "preserve" — Step 3 (fires when user clicks Stage This Room)
//   Haiku reads ONE image only.
//   Returns PRESERVE list from what is actually visible in that single frame.
//   JS assembler combines: approved zone anchors (Step 1) + PRESERVE (Step 2) + session DNA
//   → final GPT Image 2 prompt.
//
// Credit cost: 0 credits. GPT Image 2 generation is 1 credit, handled by stage-openai.js.

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
  'Earth Tones':      'terracotta, rust, and warm wood tones',
  'Bold Contrast':    'black, white, and bold accent tones',
  'Coastal Blue':     'ocean blue, sandy neutral, and white tones',
  'Sage Green':       'sage green, warm white, and natural wood tones',
  'Jewel Tones':      'emerald, sapphire, and warm gold tones',
  'Desert Modern':    'sand, clay, and muted terracotta tones',
};

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
    console.log(`Compressed: ${maxDim}px ${sizeKB}KB -> ${Math.round(compressed.length/1024)}KB`);
    return compressed.toString("base64");
  } catch(e) {
    console.warn("Compression failed:", e.message);
    return imageBase64;
  }
}

// ── MODE 1: SPATIAL PRE-READ ─────────────────────────────────────────────────
// Reads ALL images together. Returns zone/anchor assignments only.
// NO masterPreserve. NO furniture prose. NO staging instructions.
// Output is structured JSON that user reviews and approves.
async function runSpatialRead({ images, groupType, claudeKey }) {
  const isBedroom = groupType === 'bedroom';

  const imageBlocks = images.map((img, i) => ([
    { type: "image", source: { type: "base64", media_type: detectMime(img.base64), data: img.base64 } },
    { type: "text", text: `IMAGE ${i + 1} — ${img.label || img.fileName || ('Angle ' + (i + 1))}` }
  ])).flat();

  const perImageSchema = images.map((img, i) => {
    const label = img.label || img.fileName || ('Angle ' + (i + 1));
    return [
      '{',
      '  "imageIndex": ' + i + ',',
      '  "imageLabel": "' + label + '",',
      '  "visibleZones": ["list ONLY zones with stageable floor area visible in THIS image: kitchen, dining, living, bedroom"],',
      '  "cameraPosition": "one sentence — where camera is and what direction it faces",',
      '  "zoneAnchors": {',
      '    "dining": {',
      '      "present": true or false,',
      '      "ceilingFixture": "exact description of chandelier hanging over open floor — or null if dining not visible",',
      '      "instruction": "Center dining rug and table directly under [fixture description] — or null"',
      '    },',
      '    "kitchen": {',
      '      "present": true or false,',
      '      "ceilingFixture": "exact description of pendant lights over island — or null if kitchen not visible",',
      '      "islandDescription": "exact island description: base color, countertop, fixtures — or null",',
      '      "stoolSide": "dining-zone-facing side only — or null",',
      '      "instruction": "Place [N] stools on dining-zone-facing side below [pendant description] — or null"',
      '    },',
      '    "living": {',
      '      "present": true or false,',
      '      "ceilingFixture": "exact description of ceiling fan — or null if living not visible",',
      '      "frontWall": "exact description of fireplace wall — or null",',
      '      "backWall": "exact description of wall sofa back goes against — or null",',
      '      "zoneScale": "foreground or background — background if living zone is in far rear of frame",',
      '      "instruction": "Place rug under [fan]. Sofa back against [back wall] facing [fireplace] — or null"',
      '    },',
      '    "bedroom": {',
      '      "present": ' + (isBedroom ? 'true' : 'false') + ',',
      '      "headboardWall": "solid wall confirmed clear of doors and windows — or null",',
      '      "instruction": "Place bed headboard against [wall] — or null"',
      '    }',
      '  },',
      '  "wallOpenings": [',
      '    "description of any wall opening visible in this image — e.g. partition wall opening leading to flex room, sliding glass door to exterior, archway to hallway. DO NOT assign zone anchors to rooms visible through openings."',
      '  ],',
      '  "boundaryAnchors": {',
      '    "livingLeft": "visible landmark that stops living zone furniture on left — or null",',
      '    "livingRight": "visible landmark that stops living zone furniture on right — or null",',
      '    "livingFront": "18 inches in front of [fireplace hearth description] — or null",',
      '    "livingBack": "18 inches in front of [back wall description] — or null",',
      '    "diningLeft": "visible landmark that stops dining zone on kitchen side — or null",',
      '    "diningRight": "visible landmark that stops dining zone on living side — or null"',
      '  }',
      '}'
    ].join('\n');
  }).join(',\n');

  const prompt = [
    'You are reading ' + images.length + ' real estate listing photos of the same ' +
    (isBedroom ? 'bedroom' : 'open plan space') + ' from different camera angles.',
    '',
    'TASK: For each image, identify what zones are visible and what ceiling fixtures anchor each zone.',
    'Return ONLY zone/anchor assignments — no PRESERVE lists, no furniture selections, no staging prose.',
    '',
    'CRITICAL RULES:',
    '1. visibleZones must list ONLY zones with stageable floor area actually visible in THIS image.',
    '   A zone is visible only if its floor area is in frame and furniture can be placed there.',
    '   If the kitchen is not visible — do not list kitchen.',
    '   If the dining zone is not visible — do not list dining.',
    '2. Ceiling fixtures visible through a wall opening belong to the room on the other side.',
    '   A chandelier seen through a partition wall opening is NOT an anchor for this space.',
    '   List wall openings in wallOpenings[] — do not assign their fixtures to this image.',
    '3. Chandelier hanging over open floor = DINING ZONE anchor. Never kitchen.',
    '4. Pendant lights over island surface = KITCHEN ZONE anchor. Never dining.',
    '5. Ceiling fan = LIVING ZONE anchor. Always.',
    '6. Do not invent features. Read only what the camera captured.',
    '',
    'Return ONLY valid JSON — no markdown, no preamble.',
    '',
    '{',
    '  "groupType": "' + groupType + '",',
    '  "anglesRead": ' + images.length + ',',
    '  "conflictsDetected": [',
    '    {',
    '      "element": "name of element ambiguous across angles",',
    '      "conflict": "what was contradictory",',
    '      "resolution": "correct interpretation after seeing all angles"',
    '    }',
    '  ],',
    '  "perImageAssignments": [' + perImageSchema + ']',
    '}'
  ].join('\n');

  const payload = JSON.stringify({
    model: "claude-haiku-4-5",
    max_tokens: 6000,
    messages: [{ role: "user", content: [...imageBlocks, { type: "text", text: prompt }] }]
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

  if (result.status !== 200) throw new Error("Haiku spatial read failed: " + (result.body?.error?.message || result.status));

  const text = result.body?.content?.[0]?.text?.trim() || "{}";
  const clean = text.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch(e) {
    console.warn("JSON truncated — attempting repair. Length:", clean.length);
    try {
      let r = clean.replace(/,\s*$/, '').replace(/"[^"]*$/, '').replace(/:\s*$/, '');
      let braces = 0, brackets = 0;
      for (const ch of r) { if (ch==='{') braces++; else if (ch==='}') braces--; else if (ch==='[') brackets++; else if (ch===']') brackets--; }
      while (brackets > 0) { r += ']'; brackets--; }
      while (braces > 0) { r += '}'; braces--; }
      return JSON.parse(r);
    } catch(e2) {
      throw new Error("Spatial read returned invalid JSON");
    }
  }
}

// ── MODE 2: SINGLE IMAGE PRESERVE READ ───────────────────────────────────────
// Reads ONE image. Returns only what is physically present in that frame.
// PRESERVE list contains ONLY elements visible in this single photo.
// No zone inference. No global data. Camera sees it — it's in the list.
async function runPreserveRead({ imageBase64, imageLabel, claudeKey }) {
  const prompt = [
    'You are reading a real estate listing photo to generate an MLS virtual staging PRESERVE list.',
    '',
    'TASK: Describe every permanent architectural element visible in this photograph.',
    'Return ONLY what the camera captured in this single image.',
    'Do not infer, assume, or describe anything outside the frame.',
    '',
    'PRESERVE LIST RULES:',
    '1. Include every ceiling fixture with exact description: fixture type, arm/bulb count, finish, shade style.',
    '2. Include all cabinetry: color, door style, hardware finish.',
    '3. Include all countertops: material and color.',
    '4. Include all flooring: material, color, plank direction.',
    '5. Include all windows: exact pane pattern, frame color, whether fixed or operable.',
    '6. Include all doors: type, color, hardware.',
    '7. Include fireplace: surround color, profile, hearth, firebox description.',
    '8. Include island: base color, countertop, fixtures, appliances visible.',
    '9. Include backsplash: material, pattern, color.',
    '10. Include all appliances visible.',
    '11. Include wall openings: describe exactly — "partition wall with rectangular opening [location] — separate room beyond, do not stage".',
    '12. Include wall colors, baseboards, crown molding.',
    '13. End with: DO NOT alter any permanent architectural element.',
    '',
    'CRITICAL: Do NOT include anything you cannot see in this photograph.',
    'If the kitchen is not visible — do not mention kitchen cabinetry.',
    'If there is no chandelier in this frame — do not mention a chandelier.',
    '',
    'Return ONLY valid JSON — no markdown, no preamble.',
    '',
    '{',
    '  "imageLabel": "' + (imageLabel || 'image') + '",',
    '  "preserveList": "comma-separated description of every permanent element visible in this image, ending with: DO NOT alter any permanent architectural element.",',
    '  "wallOpenings": ["description of each wall opening visible — partition wall, door, archway, sliding door — with location"],',
    '  "adjacentRoomsVisible": ["description of any room visible through a wall opening — do not stage these rooms from this image"]',
    '}'
  ].join('\n');

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

  if (result.status !== 200) throw new Error("Haiku preserve read failed: " + (result.body?.error?.message || result.status));

  const text = result.body?.content?.[0]?.text?.trim() || "{}";
  const clean = text.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch(e) {
    throw new Error("Preserve read returned invalid JSON");
  }
}

// ── PROMPT ASSEMBLER ─────────────────────────────────────────────────────────
// Takes: approved zone anchors (Step 1) + PRESERVE data (Step 2) + session DNA
// Returns: final plain text prompt for GPT Image 2
// NO Haiku prose enters this function — only structured JSON fields.
function assemblePrompt({ imageAssignment, preserveData, designStyle, colorPalette }) {
  const rawStyle = designStyle || 'Organic Modern';
  const style = STYLE_LABELS[rawStyle?.toLowerCase().replace(/[^a-z]/g, '')] || rawStyle;
  const palette = colorPalette || 'Warm Neutrals';
  const paletteTones = PALETTE_TONES[palette] || `${palette} tones`;

  const zones = imageAssignment.visibleZones || [];
  const anchors = imageAssignment.zoneAnchors || {};
  const boundaries = imageAssignment.boundaryAnchors || {};
  const wallOpenings = imageAssignment.wallOpenings || [];
  const preserveList = preserveData?.preserveList || '';
  const adjacentRooms = preserveData?.adjacentRoomsVisible || [];

  const hasLiving  = zones.includes('living');
  const hasDining  = zones.includes('dining');
  const hasKitchen = zones.includes('kitchen');
  const hasBedroom = zones.includes('bedroom');

  let p = '';

  // ── 1. PRESERVE ────────────────────────────────────────────────────────────
  p += `PRESERVE EXACTLY: ${preserveList}\n\n`;
  p += `Stage with furniture and decor only. Do not alter any permanent architectural element. `;
  p += `Stage in ${style} design style using a ${palette} palette with ${paletteTones} throughout.\n\n`;

  // ── 2. ZONE ANCHOR LOCKS ───────────────────────────────────────────────────
  const anchorBlocks = [];

  if (hasDining && anchors.dining?.present && anchors.dining?.ceilingFixture) {
    anchorBlocks.push(
      `DINING ZONE ANCHOR LOCK — ${anchors.dining.ceilingFixture}: ` +
      `This fixture is the permanent anchor for the Dining Zone. ` +
      `Dining rug and table center directly under this fixture. ` +
      `This is NOT a kitchen fixture and does NOT hang over the island.`
    );
  }

  if (hasKitchen && anchors.kitchen?.present && anchors.kitchen?.ceilingFixture) {
    anchorBlocks.push(
      `KITCHEN ZONE ANCHOR LOCK — ${anchors.kitchen.ceilingFixture}: ` +
      `These fixtures anchor the Kitchen Zone over the island. ` +
      `${anchors.kitchen.islandDescription ? 'FLOATING KITCHEN ISLAND CABINET: ' + anchors.kitchen.islandDescription + ' — do not remove, relocate, resize, or alter.' : 'DO NOT alter the floating kitchen island cabinet.'}`
    );
  }

  if (hasLiving && anchors.living?.present) {
    const lv = anchors.living;
    let ll = 'LIVING ZONE ANCHOR LOCKS:\n';
    if (lv.ceilingFixture) ll += `  Ceiling: ${lv.ceilingFixture} — rug centers directly under this fixture.\n`;
    if (lv.frontWall)      ll += `  Front wall: ${lv.frontWall} — all seating faces this wall.\n`;
    if (lv.backWall)       ll += `  Back wall: ${lv.backWall} — sofa back goes against this wall facing the fireplace.\n`;
    anchorBlocks.push(ll.trim());
  }

  if (hasBedroom && anchors.bedroom?.present && anchors.bedroom?.headboardWall) {
    anchorBlocks.push(
      `BEDROOM ZONE ANCHOR LOCKS:\n` +
      `  Headboard wall: ${anchors.bedroom.headboardWall} — place bed headboard against this wall centered.`
    );
  }

  if (anchorBlocks.length) p += anchorBlocks.join('\n\n') + '\n\n';

  // ── 3. FURNITURE BOUNDARY ANCHORS ─────────────────────────────────────────
  const boundaryLines = [];
  if (hasLiving) {
    if (boundaries.livingFront) boundaryLines.push(boundaries.livingFront + '.');
    if (boundaries.livingBack)  boundaryLines.push(boundaries.livingBack + '.');
    if (boundaries.livingLeft)  boundaryLines.push('Left boundary: ' + boundaries.livingLeft + '.');
    if (boundaries.livingRight) boundaryLines.push('Right boundary: ' + boundaries.livingRight + '.');
    if (anchors.living?.zoneScale === 'background') {
      boundaryLines.push('Living zone occupies the far background of this frame — scale living zone furniture as background depth, not foreground scale. Do not extend living zone furniture toward the camera.');
    }
  }
  if (hasDining) {
    if (boundaries.diningLeft)  boundaryLines.push('Dining left boundary: ' + boundaries.diningLeft + '.');
    if (boundaries.diningRight) boundaryLines.push('Dining right boundary: ' + boundaries.diningRight + '.');
  }
  if (boundaryLines.length) p += `FURNITURE BOUNDARY ANCHORS:\n${boundaryLines.join(' ')}\n\n`;

  // ── 4. POSITIVE STAGING INSTRUCTIONS ──────────────────────────────────────
  const stagingBlocks = [];

  if (hasDining && anchors.dining?.present && anchors.dining?.ceilingFixture) {
    stagingBlocks.push(
      `DINING ZONE: Place a round area rug centered directly under the ${anchors.dining.ceilingFixture}. ` +
      `Place a round dining table centered on the rug. ` +
      `Place 6 upholstered dining chairs around the table. ` +
      `Place one tall vase with stems on the table center.`
    );
  }

  if (hasKitchen && anchors.kitchen?.present && anchors.kitchen?.ceilingFixture) {
    stagingBlocks.push(
      `KITCHEN ZONE: Place 3 counter stools on the dining-zone-facing side of the island only, ` +
      `directly below the ${anchors.kitchen.ceilingFixture}. ` +
      `Place one small bowl of fruit on the island countertop. Keep all other surfaces clean.`
    );
  }

  if (hasLiving && anchors.living?.present) {
    const lv = anchors.living;
    const fan = lv.ceilingFixture || 'ceiling fan';
    const hearth = anchors.living?.frontWall || 'fireplace hearth';
    const backW = lv.backWall || 'back wall';
    const leftB = boundaries.livingLeft ? `, not extending past ${boundaries.livingLeft}` : '';

    stagingBlocks.push(
      `LIVING ZONE: Place a large area rug centered directly under the ${fan}, ` +
      `extending from 18 inches in front of the ${hearth} back to 18 inches in front of the ${backW}${leftB}. ` +
      `Place a light linen sofa with its back against the ${backW}, centered on the rug, facing the fireplace. ` +
      `Place two upholstered accent chairs on the rug angled inward toward the fireplace. ` +
      `Place a round coffee table centered on the rug between the sofa and the fireplace. ` +
      `Place a dark wood console or credenza against the right wall. ` +
      `Place one large plant right of the fireplace. ` +
      `Place one landscape art piece centered above the fireplace surround. ` +
      `Place one arc floor lamp behind the left accent chair.`
    );
  }

  if (hasBedroom && anchors.bedroom?.present) {
    stagingBlocks.push(
      `BEDROOM ZONE: Place bed with headboard against the ${anchors.bedroom.headboardWall}. ` +
      `Place matching nightstands flanking the bed. ` +
      `Place a dresser or chest on the opposite wall. ` +
      `Place a bench at the foot of the bed.`
    );
  }

  if (stagingBlocks.length) p += `POSITIVE STAGING INSTRUCTIONS:\n\n${stagingBlocks.join('\n\n')}\n\n`;

  // ── 5. PROHIBITIONS ────────────────────────────────────────────────────────
  const prohibitions = [];

  // Wall opening prohibitions — generated from actual openings Haiku identified
  if (wallOpenings.length) {
    prohibitions.push(`DO NOT stage furniture inside or through any wall opening — openings visible in this image: ${wallOpenings.join('; ')}.`);
    prohibitions.push(`DO NOT add ceiling fixtures, pendants, cabinetry, counters, or any architectural element through or near wall openings.`);
    prohibitions.push(`PRESERVE the room visible through each wall opening exactly as photographed — do not brighten, alter, or obscure.`);
  }

  if (adjacentRooms.length) {
    prohibitions.push(`DO NOT stage rooms visible through wall openings: ${adjacentRooms.join('; ')}.`);
  }

  if (hasKitchen) {
    prohibitions.push(`DO NOT place bar stools on the camera-facing side of the island.`);
    prohibitions.push(`DO NOT remove, relocate, resize, or alter the floating kitchen island cabinet.`);
  }

  if (!hasKitchen) {
    prohibitions.push(`DO NOT add kitchen cabinetry, island, counters, or kitchen fixtures — kitchen is not visible in this photograph.`);
  }

  if (!hasDining) {
    prohibitions.push(`DO NOT add a dining table, dining chairs, or dining chandelier — dining zone is not visible in this photograph.`);
  }

  prohibitions.push(`DO NOT add ceiling fixtures, pendants, or chandeliers not visible in this photograph.`);
  prohibitions.push(`DO NOT add walls, enclosures, or any architectural element not photographed.`);
  prohibitions.push(`DO NOT add exterior features, pools, decks, or patios not visible in this photograph.`);

  p += prohibitions.join('\n') + '\n\n';

  // ── 6. COMPLIANCE FOOTER ──────────────────────────────────────────────────
  p += `Use ${style} furniture with clean architectural lines, refined materials, soft layered textures, and metallic accents. `;
  p += `Maintain realistic furniture scale proportional to the room size visible in the photograph. `;
  p += `Do not scale furniture up to fill the frame. `;
  p += `Preserve all architectural features, room dimensions, lighting placement, flooring, and camera perspective exactly as photographed. `;
  p += `This image is for MLS listing per California AB 723 §10140.6. `;
  p += `Room proportions and spatial relationships must be preserved exactly. `;
  p += `Virtual staging adds furniture and decor only — any alteration to perceived room size, architectural elements, or spatial geometry is prohibited.`;

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
    const body = JSON.parse(event.body);
    const claudeKey = process.env.ANTHROPIC_API_KEY;
    if (!claudeKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }) };

    // ── MODE 1: SPATIAL READ (all images, Step 1) ───────────────────────────
    if (body.mode === 'spatial' || (!body.mode && body.images?.length > 0 && !body.imageBase64)) {
      const { images, groupType } = body;

      if (!images || images.length < 1) return { statusCode: 400, headers, body: JSON.stringify({ error: "At least 1 image required" }) };
      if (images.length > 5)            return { statusCode: 400, headers, body: JSON.stringify({ error: "Maximum 5 images" }) };

      console.log(`Mode 1 — Spatial read: ${images.length} images, type=${groupType}`);

      const readyImages = await Promise.all(images.map(async (img) => ({
        ...img, base64: await compressForRead(img.base64), mimeType: "image/jpeg"
      })));

      const spatialData = await runSpatialRead({ images: readyImages, groupType: groupType || 'openplan', claudeKey });

      console.log(`Spatial read complete: ${spatialData.conflictsDetected?.length || 0} conflicts, ${spatialData.perImageAssignments?.length || 0} images`);

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          mode: 'spatial',
          spatialData,
          anglesRead: images.length,
          conflictsDetected: spatialData.conflictsDetected?.length || 0,
        })
      };
    }

    // ── MODE 2: PRESERVE READ + PROMPT ASSEMBLY (single image, Step 3) ──────
    if (body.mode === 'preserve' || body.imageBase64) {
      const { imageBase64, imageLabel, imageAssignment, designStyle, colorPalette } = body;

      if (!imageBase64)      return { statusCode: 400, headers, body: JSON.stringify({ error: "imageBase64 required for preserve mode" }) };
      if (!imageAssignment)  return { statusCode: 400, headers, body: JSON.stringify({ error: "imageAssignment required — run spatial read first" }) };

      console.log(`Mode 2 — Preserve read + prompt assembly: ${imageLabel}`);

      // Step 3a: Read single image for PRESERVE list
      const compressedBase64 = await compressForRead(imageBase64);
      const preserveData = await runPreserveRead({ imageBase64: compressedBase64, imageLabel, claudeKey });

      // Step 3b: Assemble final GPT prompt from structured data only
      const promptText = assemblePrompt({ imageAssignment, preserveData, designStyle, colorPalette });

      console.log(`Prompt assembled: ${promptText.length} chars`);

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          mode: 'preserve',
          preserveData,
          promptText,
        })
      };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid request — specify mode: spatial or preserve" }) };

  } catch (err) {
    console.error("group-spatial-read error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
