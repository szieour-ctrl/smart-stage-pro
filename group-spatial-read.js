// group-spatial-read.js — Single long-running function
// Runs Haiku spatial pre-read + prompt assembly inline.
// timeout = 900 in netlify.toml — no background function needed.
// Client waits for response (same pattern as generate-staging-prompt).

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
    console.log(`Compressed: ${maxDim}px ${sizeKB}KB -> ${Math.round(compressed.length/1024)}KB`);
    return compressed.toString("base64");
  } catch(e) {
    console.warn("Compression failed, using original:", e.message);
    return imageBase64;
  }
}

async function runSpatialPreRead({ images, groupType, claudeKey }) {
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
      '  "cameraPosition": "one sentence",',
      '  "visibleZones": ["kitchen","dining","living"],',
      '  "primaryAnchor": "most prominent ceiling fixture or architectural element",',
      '  "furnitureBoundaryAnchors": {',
      '    "livingRugCenter": "Center rug under [fan] or null",',
      '    "livingRugDepth": "Rug from 18in of [hearth] to 18in of [back wall] or null",',
      '    "livingLeftBoundary": "[visible element] or null",',
      '    "livingRightBoundary": "[visible element] or null",',
      '    "livingSofaNote": "Sofa back against [back wall] facing [fireplace] or null",',
      '    "livingZoneScale": "normal or background scale",',
      '    "diningRugCenter": "Center under [chandelier] or null",',
      '    "diningBoundary": "Rug edge stops at [landmark] or null",',
      '    "islandStoolSide": "Stools on dining-zone-facing side only or null"',
      '  },',
      '  "positiveStagingInstructions": {',
      '    "diningZone": "DINING ZONE: Place [rug] under [chandelier]. Place [table]. Place [chairs]. Place [centerpiece]. or null",',
      '    "kitchenZone": "KITCHEN ZONE: Place [N stools] below [pendants] on dining side. Place [props]. or null",',
      '    "livingZone": "LIVING ZONE: Place [rug] under [fan]. Rug from 18in of [hearth] to 18in of [back wall]. Place [sofa] back against [back wall] facing [fireplace]. Place [chairs]. Place [coffee table]. Place [console]. Place [plant]. Place [art]. Place [lamp]. or null",',
      '    "bedroomZone": "BEDROOM: Place [bed] headboard against [back wall]. Place [nightstands]. or null"',
      '  },',
      '  "imageSpecificProhibitions": ["DO NOT [landmark-based prohibition]"]',
      '}'
    ].join('\n');
  }).join(',\n');

  const rules = [
    'CRITICAL RULES:',
    '1. Every ceiling fixture MUST have zone assignment in PRESERVE and zoneAnchorLocks.',
    '2. Every instruction MUST reference a visible landmark.',
    '3. PRESERVE only what is photographed — no pools, decks, or invented features.',
    '4. positiveStagingInstructions required for EVERY visible zone in EVERY image.',
    '5. Prohibitions come LAST.',
    '6. Chandelier over floor = DINING ZONE. Pendants over island = KITCHEN ZONE. Ceiling fan = LIVING ZONE.',
    '7. Sofa back goes against back wall facing fireplace. Never floats.',
  ].join('\n');

  const schema = [
    '{',
    '  "groupType": "' + groupType + '",',
    '  "anglesRead": ' + images.length + ',',
    '  "masterPreserve": "All permanent elements with zone assignments for fixtures. End: DO NOT alter any permanent architectural element.",',
    '  "zoneAnchorLocks": {',
    '    "diningZone": { "present": true, "ceilingAnchor": "chandelier desc", "ceilingAnchorInstruction": "Place rug under chandelier. Place table. Place chairs.", "backWallAnchor": null, "frontWallAnchor": null },',
    '    "kitchenZone": { "present": true, "ceilingAnchor": "pendant desc", "ceilingAnchorInstruction": "Place N stools on dining-side below pendants.", "islandNote": "FLOATING KITCHEN ISLAND — do not alter." },',
    '    "livingZone": { "present": true, "ceilingAnchor": "fan desc", "ceilingAnchorInstruction": "Place rug under fan.", "backWallAnchor": "wall sofa back goes against", "backWallAnchorInstruction": "Place sofa back against [wall] facing fireplace.", "frontWallAnchor": "fireplace wall", "frontWallAnchorInstruction": "All seating faces fireplace." },',
    '    "bedroomZone": { "present": ' + (isBedroom ? 'true' : 'false') + ', "backWallAnchor": ' + (isBedroom ? '"headboard wall"' : 'null') + ', "backWallAnchorInstruction": ' + (isBedroom ? '"Place bed headboard against [wall]."' : 'null') + ' }',
    '  },',
    '  "conflictsDetected": [{ "element": "name", "conflict": "what was ambiguous", "resolution": "correct interpretation" }],',
    '  "masterFurniturePlan": {',
    '    "style": "one phrase",',
    '    "livingZone": { "sofa": "desc", "accentChairs": "desc", "coffeeTable": "desc", "rug": "desc", "console": "desc or null", "plant": "desc or null", "art": "desc or null", "floorLamp": "desc or null" },',
    '    "diningZone": { "table": "desc", "chairs": "desc", "rug": "desc", "centerpiece": "desc" },',
    '    "kitchenZone": { "stools": "desc", "props": "one item" }',
    '  },',
    '  "perImageAnchors": [' + perImageSchema + '],',
    '  "globalProhibitions": ["DO NOT add walls between zones.", "DO NOT alter room geometry.", "DO NOT add exterior features not photographed."]',
    '}'
  ].join('\n');

  const promptText = 'You are analyzing ' + images.length + ' photos of the same ' +
    (isBedroom ? 'bedroom' : 'open plan living space') + ' from different camera angles.\n' +
    'All images show the same physical space. Build a unified spatial inventory for MLS virtual staging.\n\n' +
    rules + '\n\nReturn ONLY valid JSON — no markdown, no preamble.\n\n' + schema;

  const payload = JSON.stringify({
    model: "claude-haiku-4-5",
    max_tokens: 6000,
    messages: [{ role: "user", content: [...imageBlocks, { type: "text", text: promptText }] }]
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

  if (result.status !== 200) throw new Error("Haiku failed: " + (result.body?.error?.message || result.status));

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
      throw new Error("Spatial pre-read returned invalid JSON");
    }
  }
}

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
  const prohibitions = [...(imgAnchor.imageSpecificProhibitions || []), ...(spatialPlan.globalProhibitions || [])];

  const hasLiving  = visibleZones.includes('living');
  const hasDining  = visibleZones.includes('dining');
  const hasKitchen = visibleZones.includes('kitchen');
  const hasBedroom = visibleZones.includes('bedroom');

  let p = `PRESERVE EXACTLY: ${spatialPlan.masterPreserve}\n\n`;
  p += `Stage with furniture and decor only. Do not alter any permanent architectural element. `;
  p += `Stage in ${style} design style using a ${palette} palette with ${paletteTones} throughout.\n\n`;

  const anchorLines = [];
  if (hasDining && locks.diningZone?.ceilingAnchor) {
    anchorLines.push(`DINING ZONE ANCHOR LOCK — ${locks.diningZone.ceilingAnchor}: This is the Dining Zone anchor. Dining rug and table center directly under this fixture. NOT a kitchen fixture.`);
  }
  if (hasKitchen && locks.kitchenZone?.ceilingAnchor) {
    anchorLines.push(`KITCHEN ZONE ANCHOR LOCK — ${locks.kitchenZone.ceilingAnchor}: Kitchen Zone anchor over island. ${locks.kitchenZone.islandNote || 'DO NOT alter the floating kitchen island.'}`);
  }
  if (hasLiving && locks.livingZone?.present) {
    const lz = locks.livingZone;
    let ll = 'LIVING ZONE ANCHOR LOCKS:\n';
    if (lz.ceilingAnchor) ll += `  Ceiling: ${lz.ceilingAnchor} — rug centers under this.\n`;
    if (lz.frontWallAnchor) ll += `  Front wall: ${lz.frontWallAnchor} — all seating faces this.\n`;
    if (lz.backWallAnchor) ll += `  Back wall: ${lz.backWallAnchor} — sofa back against this wall.\n`;
    anchorLines.push(ll.trim());
  }
  if (hasBedroom && locks.bedroomZone?.present) {
    const bz = locks.bedroomZone;
    let bl = 'BEDROOM ZONE ANCHOR LOCKS:\n';
    if (bz.backWallAnchor) bl += `  Headboard wall: ${bz.backWallAnchor}.\n`;
    anchorLines.push(bl.trim());
  }
  if (anchorLines.length) p += anchorLines.join('\n\n') + '\n\n';

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
  if (hasKitchen && bounds.islandStoolSide) boundaryLines.push(bounds.islandStoolSide + '.');
  if (boundaryLines.length) p += `FURNITURE BOUNDARY ANCHORS:\n${boundaryLines.join(' ')}\n\n`;

  const positiveBlocks = [];
  if (hasDining  && positive.diningZone  && positive.diningZone  !== 'null') positiveBlocks.push(positive.diningZone);
  if (hasKitchen && positive.kitchenZone && positive.kitchenZone !== 'null') positiveBlocks.push(positive.kitchenZone);
  if (hasLiving  && positive.livingZone  && positive.livingZone  !== 'null') positiveBlocks.push(positive.livingZone);
  if (hasBedroom && positive.bedroomZone && positive.bedroomZone !== 'null') positiveBlocks.push(positive.bedroomZone);
  if (positiveBlocks.length) p += `POSITIVE STAGING INSTRUCTIONS:\n${positiveBlocks.join('\n\n')}\n\n`;

  if (prohibitions.length) p += prohibitions.filter(Boolean).join('\n') + '\n\n';

  p += `Use ${style} furniture with clean lines, refined materials, and metallic accents. `;
  p += `Maintain realistic furniture scale proportional to the room. Do not scale furniture up to fill the frame. `;
  p += `Preserve all architectural features, room dimensions, and camera perspective exactly as photographed. `;
  p += `This image is for MLS listing per California AB 723 §10140.6. Room proportions must be preserved exactly.`;

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
    const { images, groupType, designStyle, colorPalette } = JSON.parse(event.body);

    if (!images || images.length < 2) return { statusCode: 400, headers, body: JSON.stringify({ error: "At least 2 images required" }) };
    if (images.length > 5)           return { statusCode: 400, headers, body: JSON.stringify({ error: "Maximum 5 images" }) };

    const claudeKey = process.env.ANTHROPIC_API_KEY;
    if (!claudeKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }) };

    console.log(`Group spatial read: ${images.length} images, type=${groupType}`);

    // Compress images
    const readyImages = await Promise.all(images.map(async (img) => ({
      ...img, base64: await compressForRead(img.base64), mimeType: "image/jpeg"
    })));

    // Run Haiku spatial pre-read
    const spatialPlan = await runSpatialPreRead({ images: readyImages, groupType: groupType || 'openplan', claudeKey });
    console.log(`Spatial plan: ${spatialPlan.conflictsDetected?.length || 0} conflicts, ${spatialPlan.perImageAnchors?.length || 0} anchor sets`);

    // Assemble per-image prompts
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
