// group-spatial-read-background.js — Netlify Background Function
// Runs Haiku spatial read (Mode 1) — all images simultaneously.
// Stores result in Netlify Blobs. Client polls check-spatial-read.js.
// Also exports runPreserveRead + assemblePrompt for use by dispatcher preserve mode.

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
    return compressed.toString("base64");
  } catch(e) { return imageBase64; }
}

// ── MODE 1: SPATIAL READ ─────────────────────────────────────────────────────
async function runSpatialRead({ images, groupType, claudeKey }) {
  const isBedroom = groupType === 'bedroom';

  const imageBlocks = images.map((img, i) => ([
    { type: "image", source: { type: "base64", media_type: detectMime(img.base64), data: img.base64 } },
    { type: "text", text: "IMAGE " + (i + 1) + " — " + (img.label || img.fileName || ('Angle ' + (i + 1))) }
  ])).flat();

  const perImageSchema = images.map((img, i) => {
    const label = img.label || img.fileName || ('Angle ' + (i + 1));
    return [
      '{',
      '  "imageIndex": ' + i + ',',
      '  "imageLabel": "' + label + '",',
      '  "visibleZones": ["list ONLY zones with stageable floor area visible in THIS image: kitchen, dining, living, bedroom"],',
      '  "cameraPosition": "one sentence",',
      '  "zoneAnchors": {',
      '    "dining": { "present": true/false, "ceilingFixture": "chandelier desc or null", "instruction": "Center rug and table under [fixture] or null" },',
      '    "kitchen": { "present": true/false, "ceilingFixture": "pendant desc or null", "islandDescription": "island desc or null", "stoolSide": "dining-zone-facing or null", "instruction": "Place N stools below [pendants] or null" },',
      '    "living": { "present": true/false, "ceilingFixture": "fan desc or null", "frontWall": "fireplace desc or null", "backWall": "wall the sofa back goes against — if a partition wall with opening is visible, that IS the back wall. Never use a window wall. Wall opposite fireplace if no partition visible.", "zoneScale": "foreground or background", "instruction": "Place rug under [fan]. Sofa against [backWall] facing [fireplace] or null" },',
      '    "bedroom": { "present": ' + (isBedroom ? 'true' : 'false') + ', "headboardWall": "desc or null", "instruction": "Place bed headboard against [wall] or null" }',
      '  },',
      '  "wallOpenings": ["each wall opening visible: type, location, what is beyond — do not assign zone anchors to rooms beyond openings"],',
      '  "boundaryAnchors": {',
      '    "livingLeft": "landmark stopping living zone left or null",',
      '    "livingRight": "landmark stopping living zone right or null",',
      '    "livingFront": "18 inches in front of [hearth desc] or null",',
      '    "livingBack": "18 inches in front of [back wall desc] or null",',
      '    "diningLeft": "landmark stopping dining zone on kitchen side or null",',
      '    "diningRight": "landmark stopping dining zone on living side or null"',
      '  }',
      '}'
    ].join('\n');
  }).join(',\n');

  const prompt = [
    'You are reading ' + images.length + ' listing photos of the same ' + (isBedroom ? 'bedroom' : 'open plan space') + ' from different angles.',
    'TASK: Identify visible zones and ceiling fixture anchors for each image.',
    'Return ONLY zone/anchor assignments — no PRESERVE lists, no furniture, no staging prose.',
    '',
    'RULES:',
    '1. visibleZones: list ONLY zones with stageable floor area in THIS image. If kitchen not visible — omit kitchen.',
    '2. Fixtures visible through wall openings belong to the room beyond — do not assign them here.',
    '3. FIXTURE ZONE RULES — read carefully:',
    '   DINING anchor: any chandelier or multi-pendant fixture hanging over OPEN FLOOR with no surface below it.',
    '   KITCHEN anchor: pendant lights hanging directly over an island countertop surface.',
    '   If a multi-pendant fixture hangs over open floor with no island below — it is DINING, not kitchen.',
    '   Ceiling fan = LIVING anchor. Always.',
    '4. List every wall opening in wallOpenings[] — do not stage rooms visible through openings.',
    '5. Return ONLY valid JSON — no markdown, no preamble.',
    '',
    '{',
    '  "groupType": "' + groupType + '",',
    '  "anglesRead": ' + images.length + ',',
    '  "conflictsDetected": [{ "element": "name", "conflict": "what was ambiguous", "resolution": "correct answer" }],',
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
    // Repair truncated JSON
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

// ── MODE 2: PRESERVE READ ────────────────────────────────────────────────────
async function runPreserveRead({ imageBase64, imageLabel, claudeKey }) {
  const prompt = [
    'You are reading a real estate listing photo to generate a PRESERVE list for MLS virtual staging.',
    'Describe every permanent architectural element visible in this photograph only.',
    'Do not infer or describe anything outside the frame.',
    '',
    'RULES:',
    '1. Every ceiling fixture: type, arm/bulb count, finish, shade style.',
    '2. All cabinetry: color, door style, hardware finish.',
    '3. All countertops: material and color.',
    '4. All flooring: material, color.',
    '5. All windows: pane pattern, frame color.',
    '6. All doors: type, color.',
    '7. Fireplace: surround color, profile, hearth, firebox.',
    '8. Island: base color, countertop, visible appliances.',
    '9. Backsplash: material, pattern, color.',
    '10. All visible appliances.',
    '11. Wall openings: "partition wall with rectangular opening [location] — separate room beyond, do not stage".',
    '12. End with: DO NOT alter any permanent architectural element.',
    '13. Do NOT include anything not visible in this photograph.',
    '',
    'Return ONLY valid JSON — no markdown, no preamble.',
    '',
    '{',
    '  "imageLabel": "' + (imageLabel || 'image') + '",',
    '  "preserveList": "comma-separated list of every permanent element visible, ending with: DO NOT alter any permanent architectural element.",',
    '  "wallOpenings": ["each wall opening: type and location"],',
    '  "adjacentRoomsVisible": ["each room visible through an opening — do not stage from this image"]',
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
  try { return JSON.parse(clean); }
  catch(e) { throw new Error("Preserve read returned invalid JSON"); }
}

// ── PROMPT ASSEMBLER ─────────────────────────────────────────────────────────
function assemblePrompt({ imageAssignment, preserveData, designStyle, colorPalette }) {
  const rawStyle = designStyle || 'Organic Modern';
  const style = STYLE_LABELS[rawStyle?.toLowerCase().replace(/[^a-z]/g, '')] || rawStyle;
  const palette = colorPalette || 'Warm Neutrals';
  const paletteTones = PALETTE_TONES[palette] || (palette + ' tones');

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

  // 1. PRESERVE
  p += 'PRESERVE EXACTLY: ' + preserveList + '\n\n';
  p += 'Stage with furniture and decor only. Do not alter any permanent architectural element. ';
  p += 'Stage in ' + style + ' design style using a ' + palette + ' palette with ' + paletteTones + ' throughout.\n\n';

  // 2. ZONE ANCHOR LOCKS
  const anchorBlocks = [];
  if (hasDining && anchors.dining?.present && anchors.dining?.ceilingFixture) {
    anchorBlocks.push(
      'DINING ZONE ANCHOR LOCK — ' + anchors.dining.ceilingFixture + ': ' +
      'This fixture is the permanent anchor for the Dining Zone. ' +
      'Dining rug and table center directly under this fixture. ' +
      'This is NOT a kitchen fixture and does NOT hang over the island.'
    );
  }
  if (hasKitchen && anchors.kitchen?.present && anchors.kitchen?.ceilingFixture) {
    anchorBlocks.push(
      'KITCHEN ZONE ANCHOR LOCK — ' + anchors.kitchen.ceilingFixture + ': ' +
      'Kitchen Zone anchor over island. ' +
      (anchors.kitchen.islandDescription
        ? 'FLOATING KITCHEN ISLAND CABINET: ' + anchors.kitchen.islandDescription + ' — do not remove, relocate, resize, or alter.'
        : 'DO NOT alter the floating kitchen island cabinet.')
    );
  }
  if (hasLiving && anchors.living?.present) {
    const lv = anchors.living;
    let ll = 'LIVING ZONE ANCHOR LOCKS:\n';
    if (lv.ceilingFixture) ll += '  Ceiling: ' + lv.ceilingFixture + ' — rug centers directly under this fixture.\n';
    if (lv.frontWall)      ll += '  Front wall: ' + lv.frontWall + ' — all seating faces this wall.\n';
    if (lv.backWall)       ll += '  Back wall: ' + lv.backWall + ' — sofa back goes against this wall facing the fireplace.\n';
    anchorBlocks.push(ll.trim());
  }
  if (hasBedroom && anchors.bedroom?.present && anchors.bedroom?.headboardWall) {
    anchorBlocks.push('BEDROOM ZONE ANCHOR LOCKS:\n  Headboard wall: ' + anchors.bedroom.headboardWall + ' — place bed headboard against this wall centered.');
  }
  if (anchorBlocks.length) p += anchorBlocks.join('\n\n') + '\n\n';

  // 3. BOUNDARY ANCHORS
  const boundaryLines = [];
  if (hasLiving) {
    if (boundaries.livingFront) boundaryLines.push(boundaries.livingFront + '.');
    if (boundaries.livingBack)  boundaryLines.push(boundaries.livingBack + '.');
    if (boundaries.livingLeft)  boundaryLines.push('Left boundary: ' + boundaries.livingLeft + '.');
    if (boundaries.livingRight) boundaryLines.push('Right boundary: ' + boundaries.livingRight + '.');
    if (anchors.living?.zoneScale === 'background') {
      boundaryLines.push('Living zone is in the far background — scale furniture as background depth, do not extend toward camera.');
    }
  }
  if (hasDining) {
    if (boundaries.diningLeft)  boundaryLines.push('Dining left boundary: ' + boundaries.diningLeft + '.');
    if (boundaries.diningRight) boundaryLines.push('Dining right boundary: ' + boundaries.diningRight + '.');
  }
  if (boundaryLines.length) p += 'FURNITURE BOUNDARY ANCHORS:\n' + boundaryLines.join(' ') + '\n\n';

  // 4. POSITIVE STAGING INSTRUCTIONS
  const stagingBlocks = [];
  if (hasDining && anchors.dining?.present && anchors.dining?.ceilingFixture) {
    stagingBlocks.push(
      'DINING ZONE: Place a round area rug centered directly under the ' + anchors.dining.ceilingFixture + '. ' +
      'Place a round dining table centered on the rug. ' +
      'Place 6 upholstered dining chairs around the table. ' +
      'Place one tall vase with stems on the table center.'
    );
  }
  if (hasKitchen && anchors.kitchen?.present && anchors.kitchen?.ceilingFixture) {
    stagingBlocks.push(
      'KITCHEN ZONE: Place 3 counter stools on the dining-zone-facing side of the island only, ' +
      'directly below the ' + anchors.kitchen.ceilingFixture + '. ' +
      'Place one small bowl of fruit on the island countertop. Keep all other surfaces clean.'
    );
  }
  if (hasLiving && anchors.living?.present) {
    const lv = anchors.living;
    const fan   = lv.ceilingFixture || 'ceiling fan';
    const front = lv.frontWall      || 'fireplace';
    const back  = lv.backWall       || 'back wall';
    const leftB = boundaries.livingLeft ? ', not extending past ' + boundaries.livingLeft : '';
    stagingBlocks.push(
      'LIVING ZONE: Place a large area rug centered directly under the ' + fan + ', ' +
      'extending from 18 inches in front of the ' + front + ' back to 18 inches in front of the ' + back + leftB + '. ' +
      'Place a light linen sofa with its back against the ' + back + ', centered on the rug, facing the fireplace. ' +
      'Place two upholstered accent chairs on the rug angled inward toward the fireplace. ' +
      'Place a round coffee table centered on the rug between the sofa and the fireplace. ' +
      'Place a dark wood console against the right wall. ' +
      'Place one large plant right of the fireplace. ' +
      'Place one landscape art piece centered above the fireplace surround. ' +
      'Place one arc floor lamp behind the left accent chair.'
    );
  }
  if (hasBedroom && anchors.bedroom?.present) {
    stagingBlocks.push(
      'BEDROOM ZONE: Place bed with headboard against the ' + (anchors.bedroom.headboardWall || 'back wall') + '. ' +
      'Place matching nightstands flanking the bed. Place a dresser on the opposite wall. Place a bench at the foot of the bed.'
    );
  }
  if (stagingBlocks.length) p += 'POSITIVE STAGING INSTRUCTIONS:\n\n' + stagingBlocks.join('\n\n') + '\n\n';

  // 5. PROHIBITIONS
  const prohibitions = [];
  if (wallOpenings.length) {
    prohibitions.push('DO NOT stage furniture inside or through wall openings — ' + wallOpenings.join('; ') + '.');
    prohibitions.push('DO NOT add ceiling fixtures, pendants, cabinetry, or counters through or near wall openings.');
    prohibitions.push('PRESERVE the room visible through each wall opening exactly as photographed — do not brighten, alter, or obscure.');
  }
  if (adjacentRooms.length) prohibitions.push('DO NOT stage rooms visible through wall openings: ' + adjacentRooms.join('; ') + '.');
  if (hasKitchen) {
    prohibitions.push('DO NOT place bar stools on the camera-facing side of the island.');
    prohibitions.push('DO NOT remove, relocate, resize, or alter the floating kitchen island cabinet.');
  }
  if (!hasKitchen) prohibitions.push('DO NOT add kitchen cabinetry, island, or kitchen fixtures — kitchen is not visible in this photograph.');
  if (!hasDining)  prohibitions.push('DO NOT add a dining table, dining chairs, or dining chandelier — dining zone is not visible in this photograph.');
  prohibitions.push('DO NOT add ceiling fixtures or chandeliers not visible in this photograph.');
  prohibitions.push('DO NOT add walls, enclosures, or any architectural element not photographed.');
  prohibitions.push('DO NOT add exterior features not visible in this photograph.');
  p += prohibitions.join('\n') + '\n\n';

  // 6. COMPLIANCE FOOTER
  p += 'Use ' + style + ' furniture with clean architectural lines, refined materials, and metallic accents. ';
  p += 'Maintain realistic furniture scale proportional to the room. Do not scale furniture up to fill the frame. ';
  p += 'Preserve all architectural features, room dimensions, and camera perspective exactly as photographed. ';
  p += 'This image is for MLS listing per California AB 723 §10140.6. Room proportions must be preserved exactly. ';
  p += 'Virtual staging adds furniture and decor only — any alteration to architecture or spatial geometry is prohibited.';

  return p.trim();
}

// Export for use by dispatcher preserve mode
module.exports.runPreserveRead = runPreserveRead;
module.exports.assemblePrompt  = assemblePrompt;
module.exports.compressForRead = compressForRead;

// ── BACKGROUND HANDLER ────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const siteID    = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
  const token     = process.env.NETLIFY_ACCESS_TOKEN;
  let jobId;

  try {
    const { jobId: jId, mode, images, groupType } = JSON.parse(event.body);
    jobId = jId;
    console.log('Group spatial read background: jobId=' + jobId + ' images=' + images.length + ' type=' + groupType);

    const store = getStore({ name: "staging-jobs", siteID, token });
    await store.setJSON(jobId, { status: "processing", startedAt: Date.now() });
    console.log('Job ' + jobId + ': heartbeat written');

    const spatialData = await runSpatialRead({ images, groupType: groupType || 'openplan', claudeKey });
    console.log('Job ' + jobId + ': spatial read complete — ' + (spatialData.conflictsDetected?.length || 0) + ' conflicts, ' + (spatialData.perImageAssignments?.length || 0) + ' images');

    await store.setJSON(jobId, {
      status: "done",
      spatialData,
      anglesRead: images.length,
      conflictsDetected: spatialData.conflictsDetected?.length || 0,
    });

    console.log('Job ' + jobId + ': stored in Blobs');

  } catch (err) {
    console.error('Job ' + (jobId || 'unknown') + ' error:', err.message);
    try {
      const store = getStore({ name: "staging-jobs", siteID, token });
      await store.setJSON(jobId, { status: "error", error: err.message });
    } catch(e) {}
  }
};
