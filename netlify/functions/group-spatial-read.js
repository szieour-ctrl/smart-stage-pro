// group-spatial-read.js — Dispatcher + Preserve Mode
//
// MODE: spatial — Dispatches to background function, returns jobId immediately.
//   Client polls check-spatial-read.js every 3 seconds.
//   Background handles the slow Haiku multi-image read (~30s).
//
// MODE: preserve — Runs inline (fast, ~2-3s single image).
//   Reads one image for PRESERVE list.
//   Assembles final GPT prompt from zone assignments + PRESERVE + session DNA.
//   Returns promptText ready for GPT Image 2.

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
  'Earth Tones':      'terracotta, rust, and warm brown tones',
  'Bold Contrast':    'black, white, and bold accent tones',
  'Coastal Blue':     'ocean blue, sandy neutral, and white tones',
  'Sage Green':       'sage green, warm white, and natural wood tones',
  'Jewel Tones':      'emerald, sapphire, and warm gold tones',
  'Desert Modern':    'sand, clay, and muted terracotta tones',
};

// ✅ AB 723 COMPLIANCE HEADER — Prepended to every prompt
const AB723_HEADER = `PRIMARY ROLE: Stage furniture and decor ONLY.

IMMUTABLE LOCK: Never alter, move, remove, replace, or touch: structural walls | ceilings | kitchen/bathroom cabinets | countertops | lighting fixtures. These must be preserved exactly as photographed.

AB 723 COMPLIANCE: Virtual staging adds furniture only. Any alteration to permanent architecture makes the listing non-compliant and subject to MLS removal.

═══════════════════════════════════════════════════════════════════════════════

`;

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
    '11. Wall openings: describe exactly what is visible — e.g. "partition wall with rectangular opening upper left", "sliding glass door right wall", "archway to hallway".',
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

  if (result.status !== 200) throw new Error("Preserve read failed: " + (result.body?.error?.message || result.status));
  const text = result.body?.content?.[0]?.text?.trim() || "{}";
  const clean = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(clean); }
  catch(e) { throw new Error("Preserve read returned invalid JSON"); }
}

function assemblePrompt({ imageAssignment, preserveData, designStyle, colorPalette, groupSpatialPlan, imageLabel }) {
  const rawStyle = designStyle || 'Organic Modern';
  const style = STYLE_LABELS[rawStyle?.toLowerCase().replace(/[^a-z]/g, '')] || rawStyle;
  const palette = colorPalette || 'Warm Neutrals';
  const paletteTones = PALETTE_TONES[palette] || (palette + ' tones');

  const zones = [...(imageAssignment.visibleZones || [])];
  const anchors = JSON.parse(JSON.stringify(imageAssignment.zoneAnchors || {}));
  const boundaries = imageAssignment.boundaryAnchors || {};
  const wallOpenings = imageAssignment.wallOpenings || [];

  // ✅ ZONE FILTER — If user labeled this as a single room, ONLY stage that zone
  // "Living Room" → living only. "Kitchen" → kitchen only.
  // "Open Plan: Kitchen + Dining + Living" → keep all zones (no filter)
  let isSingleRoomLabel = false;
  if (imageLabel) {
    const label = imageLabel.toLowerCase();
    const isOpenPlan = label.includes('open plan') || (label.includes('+') && (label.includes('kitchen') || label.includes('dining') || label.includes('living')));
    
    if (!isOpenPlan) {
      isSingleRoomLabel = true;
      let allowedZone = null;
      if (label.includes('living') || label.includes('great room') || label.includes('family room')) allowedZone = 'living';
      else if (label.includes('kitchen'))  allowedZone = 'kitchen';
      else if (label.includes('dining'))   allowedZone = 'dining';
      else if (label.includes('bedroom'))  allowedZone = 'bedroom';
      
      if (allowedZone) {
        // Remove all zones except the labeled one
        while (zones.length) zones.pop();
        zones.push(allowedZone);
        console.log('ZONE FILTER: imageLabel="' + imageLabel + '" → staging ONLY: ' + allowedZone);
      }
    }
  }

  // MULTI-ANGLE MERGE: pull confirmed zone anchors from other images in the group
  // ✅ SKIP merge for single-room labels — prevents phantom zone injection
  if (!isSingleRoomLabel && groupSpatialPlan?.perImageAssignments) {
    for (const otherImage of groupSpatialPlan.perImageAssignments) {
      if (otherImage === imageAssignment) continue;

      // Merge confirmed dining anchor
      if (!anchors.dining?.present && otherImage.zoneAnchors?.dining?.present && otherImage.zoneAnchors?.dining?.ceilingFixture) {
        anchors.dining = { ...otherImage.zoneAnchors.dining, confirmedFromOtherAngle: true };
        if (!zones.includes('dining')) zones.push('dining');
        // Use boundary anchors from this image if available, else from confirming image
        if (!boundaries.diningLeft  && otherImage.boundaryAnchors?.diningLeft)  boundaries.diningLeft  = otherImage.boundaryAnchors.diningLeft;
        if (!boundaries.diningRight && otherImage.boundaryAnchors?.diningRight) boundaries.diningRight = otherImage.boundaryAnchors.diningRight;
      }

      // Merge confirmed living anchor (ceiling fan) if missing
      if (!anchors.living?.ceilingFixture && otherImage.zoneAnchors?.living?.ceilingFixture) {
        anchors.living = anchors.living || {};
        anchors.living.ceilingFixture = otherImage.zoneAnchors.living.ceilingFixture;
      }
    }
  }
  const preserveList = preserveData?.preserveList || '';
  const adjacentRooms = preserveData?.adjacentRoomsVisible || [];

  const hasLiving  = zones.includes('living');
  const hasDining  = zones.includes('dining');
  const hasKitchen = zones.includes('kitchen');
  const hasBedroom = zones.includes('bedroom');

  let p = AB723_HEADER;

  p += 'PRESERVE EXACTLY: ' + preserveList + '\n\n';
  p += 'Stage with furniture and decor only. Do not alter any permanent architectural element. ';
  p += 'Stage in ' + style + ' design style using a ' + palette + ' palette with ' + paletteTones + ' throughout.\n\n';

  // ✅ EXPLICIT ZONE SCOPE — tells GPT exactly which zones to stage
  p += 'STAGING ZONE SCOPE — Stage ONLY these zones visible in THIS image: ' + zones.map(z => z.toUpperCase()).join(', ') + '.\n';
  if (!zones.includes('kitchen')) p += 'Kitchen is NOT visible — DO NOT add kitchen furniture, stools, or island accessories.\n';
  if (!zones.includes('dining'))  p += 'Dining zone is NOT visible — DO NOT add a dining table, dining chairs, or dining rug.\n';
  if (!zones.includes('living'))  p += 'Living zone is NOT visible — DO NOT add sofas, accent chairs, coffee tables, or living room furniture.\n';
  if (!zones.includes('bedroom')) p += 'Bedroom is NOT visible — DO NOT add beds, nightstands, or bedroom furniture.\n';
  p += '\n';

  const anchorBlocks = [];
  if (hasDining && anchors.dining?.present) {
    if (anchors.dining.ceilingFixture) {
      anchorBlocks.push('DINING ZONE ANCHOR LOCK — ' + anchors.dining.ceilingFixture + ': This fixture is the permanent anchor for the Dining Zone. Dining rug and table center directly under this fixture. This is NOT a kitchen fixture. DO NOT replace, alter, remove, restyle, or substitute this fixture. It must remain exactly as photographed — same arm count, same finish, same shades, same position.');
    } else {
      const leftB  = boundaries.diningLeft  ? boundaries.diningLeft  : 'kitchen island';
      const rightB = boundaries.diningRight ? boundaries.diningRight : 'living zone';
      anchorBlocks.push('DINING ZONE: No chandelier visible in this image. Center dining table and rug in the open floor area between ' + leftB + ' and ' + rightB + '.');
    }
  }
  if (hasKitchen && anchors.kitchen?.present && anchors.kitchen?.ceilingFixture) {
    anchorBlocks.push('KITCHEN ZONE ANCHOR LOCK — ' + anchors.kitchen.ceilingFixture + ': Kitchen Zone anchor over island. DO NOT replace, alter, or substitute these fixtures. ' + (anchors.kitchen.islandDescription ? 'FLOATING KITCHEN ISLAND CABINET: ' + anchors.kitchen.islandDescription + ' — do not remove, relocate, resize, or alter.' : 'DO NOT alter the floating kitchen island cabinet.'));
  }
  if (hasLiving && anchors.living?.present) {
    const lv = anchors.living;
    let ll = 'LIVING ZONE ANCHOR LOCKS:\n';
    if (lv.ceilingFixture) ll += '  Ceiling: ' + lv.ceilingFixture + ' — rug centers directly under this fixture. DO NOT replace, alter, or substitute this fixture.\n';
    if (lv.frontWall)      ll += '  Front wall: ' + lv.frontWall + ' — all seating faces this wall.\n';
    if (lv.backWall)       ll += '  Back wall: ' + lv.backWall + ' — sofa back goes against this wall facing the fireplace.\n';
    anchorBlocks.push(ll.trim());
  }
  if (hasBedroom && anchors.bedroom?.present && anchors.bedroom?.headboardWall) {
    anchorBlocks.push('BEDROOM ZONE ANCHOR LOCKS:\n  Headboard wall: ' + anchors.bedroom.headboardWall + ' — place bed headboard against this wall centered.');
  }
  if (anchorBlocks.length) p += anchorBlocks.join('\n\n') + '\n\n';

  const boundaryLines = [];
  if (hasLiving) {
    if (boundaries.livingFront) boundaryLines.push(boundaries.livingFront + '.');
    if (boundaries.livingBack)  boundaryLines.push(boundaries.livingBack + '.');
    if (boundaries.livingLeft)  boundaryLines.push('Left boundary: ' + boundaries.livingLeft + '.');
    if (boundaries.livingRight) boundaryLines.push('Right boundary: ' + boundaries.livingRight + '.');
    if (anchors.living?.zoneScale === 'background') boundaryLines.push('Living zone is in far background — scale as background depth, do not extend toward camera.');
  }
  if (hasDining) {
    if (boundaries.diningLeft)  boundaryLines.push('Dining left boundary: ' + boundaries.diningLeft + '.');
    if (boundaries.diningRight) boundaryLines.push('Dining right boundary: ' + boundaries.diningRight + '.');
  }
  if (boundaryLines.length) p += 'FURNITURE BOUNDARY ANCHORS:\n' + boundaryLines.join(' ') + '\n\n';

  const stagingBlocks = [];
  if (hasDining && anchors.dining?.present) {
    if (anchors.dining.ceilingFixture) {
      // Confirmed chandelier anchor
      stagingBlocks.push('DINING ZONE: Place a round area rug centered directly under the ' + anchors.dining.ceilingFixture + '. Place a round dining table centered on the rug. Place 6 upholstered dining chairs around the table. Place one tall vase with stems on the table center.');
    } else {
      // No confirmed chandelier — center in open floor between boundaries
      const leftB  = boundaries.diningLeft  ? ' to the right of the ' + boundaries.diningLeft  : '';
      const rightB = boundaries.diningRight ? ' and to the left of the ' + boundaries.diningRight : '';
      stagingBlocks.push('DINING ZONE: Place a round area rug centered in the open floor area' + leftB + rightB + '. Place a round dining table centered on the rug. Place 6 upholstered dining chairs around the table. Place one tall vase with stems on the table center.');
    }
  }
  if (hasKitchen && anchors.kitchen?.present && anchors.kitchen?.ceilingFixture) {
    if (anchors.kitchen.islandBarOverhang) {
      stagingBlocks.push('KITCHEN ZONE: Place 3 counter stools on the dining-zone-facing side of the island only, directly below the ' + anchors.kitchen.ceilingFixture + '. Place one small bowl of fruit on the island countertop. Keep all other surfaces clean.');
    } else {
      stagingBlocks.push('KITCHEN ZONE: No bar overhang — DO NOT add stools. Place one small bowl of fruit on the island countertop. Keep all other surfaces clean.');
    }
  }
  if (hasLiving && anchors.living?.present) {
    const lv = anchors.living;
    const fan   = lv.ceilingFixture || 'ceiling fan';
    const front = lv.frontWall      || 'fireplace';
    // Safety check — never allow glass door, window, or exterior wall as sofa back wall
    const backRaw = lv.backWall || 'back wall';
    const badBack = /glass|window|exterior|sliding|door|patio/i.test(backRaw);
    const back = badBack ? 'partition wall or interior wall opposite the fireplace' : backRaw;
    const leftB = boundaries.livingLeft ? ', not extending past ' + boundaries.livingLeft : '';
    stagingBlocks.push('LIVING ZONE: Place a large area rug centered directly under the ' + fan + ', extending from 18 inches in front of the ' + front + ' back to 18 inches in front of the ' + back + leftB + '. Place a light linen sofa with its back against the ' + back + ', centered on the rug, facing the fireplace. Place two upholstered accent chairs on the rug angled inward toward the fireplace. Place a round coffee table centered on the rug between the sofa and the fireplace. Place a dark wood console against the right wall. Place one large plant right of the fireplace. Place one landscape art piece centered above the fireplace surround. Place one arc floor lamp behind the left accent chair.');
  }
  if (hasBedroom && anchors.bedroom?.present) {
    stagingBlocks.push('BEDROOM ZONE: Place bed with headboard against the ' + (anchors.bedroom.headboardWall || 'back wall') + '. Place matching nightstands flanking the bed. Place a dresser on the opposite wall. Place a bench at the foot of the bed.');
  }
  if (stagingBlocks.length) p += 'POSITIVE STAGING INSTRUCTIONS:\n\n' + stagingBlocks.join('\n\n') + '\n\n';

  const prohibitions = [];
  if (wallOpenings.length) {
    prohibitions.push('DO NOT stage furniture inside or through wall openings — ' + wallOpenings.join('; ') + '.');
    prohibitions.push('DO NOT add ceiling fixtures, pendants, cabinetry, or counters through or near wall openings.');
    prohibitions.push('DO NOT add architectural elements, furniture, or objects inside the room visible through any wall opening.');
  }
  if (adjacentRooms.length) prohibitions.push('DO NOT stage rooms visible through wall openings: ' + adjacentRooms.join('; ') + '.');
  if (hasKitchen) {
    prohibitions.push('DO NOT place bar stools on the camera-facing side of the island.');
    prohibitions.push('DO NOT remove, relocate, resize, or alter the floating kitchen island cabinet.');
  }
  if (!hasKitchen) prohibitions.push('DO NOT add kitchen cabinetry, island, or kitchen fixtures — kitchen is not visible in this photograph.');
  if (!hasDining)  prohibitions.push('DO NOT add a dining table, dining chairs, or dining chandelier — dining zone is not visible in this photograph.');
  if (hasDining && anchors.dining?.present && !anchors.dining?.ceilingFixture) {
    prohibitions.push('DINING ZONE: Open floor area is visible but the dining anchor fixture (chandelier) is NOT in this frame. DO NOT stage the dining area in this image. DO NOT add any chandelier, pendant, dining table, or dining chairs. This zone will be staged from a different angle where the chandelier is visible.');
  }
  prohibitions.push('DO NOT replace, alter, restyle, or substitute any existing ceiling fixture — chandeliers, pendants, fans, and recessed lights must remain exactly as photographed.');
  prohibitions.push('DO NOT add ceiling fixtures or chandeliers not visible in this photograph.');
  prohibitions.push('DO NOT add walls, enclosures, or any architectural element not photographed.');
  prohibitions.push('DO NOT add exterior features not visible in this photograph.');
  p += prohibitions.join('\n') + '\n\n';

  p += 'Use ' + style + ' furniture with clean architectural lines, refined materials, and metallic accents. ';
  p += 'Maintain realistic furniture scale proportional to the room. Do not scale furniture up to fill the frame. ';
  p += 'Preserve all architectural features, room dimensions, and camera perspective exactly as photographed. ';
  p += 'This image is for MLS listing per California AB 723 §10140.6. Room proportions must be preserved exactly. ';
  p += 'Virtual staging adds furniture and decor only — any alteration to architecture or spatial geometry is prohibited.';

  return p.trim();
}

async function triggerBackground(payload, siteUrl) {
  const body = Buffer.from(JSON.stringify(payload));
  console.log('Triggering group-spatial-read-background: payload ' + Math.round(body.length / 1024) + 'KB');
  const url = new URL(siteUrl + '/.netlify/functions/group-spatial-read-background');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": body.length }
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        console.log('Background response: status=' + res.statusCode + ' body=' + Buffer.concat(chunks).toString("utf8").slice(0, 200));
        resolve(res.statusCode);
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Content-Type": "application/json" };

  try {
    const body = JSON.parse(event.body);
    const claudeKey = process.env.ANTHROPIC_API_KEY;
    if (!claudeKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }) };

    // MODE: spatial — fire background, return jobId
    if (body.mode === 'spatial' || (!body.mode && body.images && !body.imageBase64)) {
      const { images, groupType } = body;
      if (!images || images.length < 1) return { statusCode: 400, headers, body: JSON.stringify({ error: "At least 1 image required" }) };
      if (images.length > 5)            return { statusCode: 400, headers, body: JSON.stringify({ error: "Maximum 5 images" }) };

      const siteUrl = process.env.URL || process.env.DEPLOY_URL;
      if (!siteUrl) return { statusCode: 500, headers, body: JSON.stringify({ error: "Site URL not configured" }) };

      const readyImages = await Promise.all(images.map(async (img) => ({
        ...img, base64: await compressForRead(img.base64), mimeType: "image/jpeg"
      })));

      const jobId = "gsr-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      console.log('Group spatial read dispatch: jobId=' + jobId + ' images=' + images.length);

      const triggerStatus = await triggerBackground({ jobId, mode: 'spatial', images: readyImages, groupType }, siteUrl);
      console.log('Job ' + jobId + ': background trigger status = ' + triggerStatus);

      if (triggerStatus !== 202) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Background trigger failed: ' + triggerStatus }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ jobId }) };
    }

    // MODE: preserve — inline, fast (~2-3s)
    if (body.mode === 'preserve') {
      const { imageBase64, imageLabel, imageAssignment, designStyle, colorPalette } = body;
      if (!imageBase64)     return { statusCode: 400, headers, body: JSON.stringify({ error: "imageBase64 required" }) };
      if (!imageAssignment) return { statusCode: 400, headers, body: JSON.stringify({ error: "imageAssignment required" }) };

      console.log('Preserve read: ' + imageLabel);
      const compressedBase64 = await compressForRead(imageBase64);
      const preserveData = await runPreserveRead({ imageBase64: compressedBase64, imageLabel, claudeKey });
      const promptText = assemblePrompt({ imageAssignment, preserveData, designStyle, colorPalette, groupSpatialPlan: body.groupSpatialPlan || null, imageLabel });

      console.log('Preserve + assembly complete: ' + promptText.length + ' chars');
      return { statusCode: 200, headers, body: JSON.stringify({ mode: 'preserve', preserveData, promptText }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid mode — use spatial or preserve" }) };

  } catch (err) {
    console.error("group-spatial-read error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
