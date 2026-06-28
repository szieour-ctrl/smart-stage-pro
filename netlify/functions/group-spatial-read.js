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

  if (result.status !== 200) throw new Error("Haiku preserve read failed: " + (result.body?.error?.message || result.status));
  const text = result.body.content?.find(c => c.type === 'text')?.text?.trim() || "{}";
  const clean = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(clean); }
  catch(e) { throw new Error("Preserve read returned invalid JSON"); }
}

// Flex Room: pass through whatever room type the user typed (Office, Den, Media, Dining, etc.)
// with NO scripted furniture list — GPT Image 2 decides furniture from the room type name alone.
// This matches the Phase 6 architecture direction: the assembler hands GPT2 the zone name,
// not a pre-written placement script.
function buildFlexZoneInstruction(flex) {
  const roomType = (flex.roomType || '').trim();
  const label = roomType ? roomType.toUpperCase() + ' (FLEX ROOM)' : 'FLEX ROOM';
  const wallNote = flex.backWall ? ' Anchor the main furniture piece against the ' + flex.backWall + '.' : '';
  const fixtureNote = flex.ceilingFixture ? ' Existing ceiling fixture (' + flex.ceilingFixture + ') must remain exactly as photographed.' : '';
  return label + ' ZONE: Stage this room appropriately for its function as a ' + (roomType || 'flex space') + '.' + wallNote + fixtureNote;
}

function assemblePrompt({ imageAssignment, preserveData, designStyle, colorPalette, groupSpatialPlan, imageLabel }) {
  if (!imageAssignment) throw new Error("imageAssignment required");
  if (!preserveData) throw new Error("preserveData required");

  const style = STYLE_LABELS[designStyle?.toLowerCase()] || designStyle || 'Transitional';
  const palette = PALETTE_TONES[colorPalette] || colorPalette || 'Warm Neutrals';

  let p = AB723_HEADER;

  // Real schema (matches the Haiku spatial-read JSON shown in the UI editable textarea):
  // imageAssignment.visibleZones / .zoneAnchors / .boundaryAnchors / .wallOpenings
  const zones = imageAssignment.visibleZones || imageAssignment.zones || [];
  const anchors = imageAssignment.zoneAnchors || {};
  const boundaries = imageAssignment.boundaryAnchors || {};
  const wallOpenings = imageAssignment.wallOpenings || preserveData.wallOpenings || [];
  const adjacentRooms = preserveData.adjacentRoomsVisible || [];
  const preserveList = preserveData.preserveList || '';

  const hasKitchen = zones.includes('kitchen');
  const hasDining = zones.includes('dining');
  const hasLiving = zones.includes('living');
  const hasFamily = zones.includes('family');
  const hasBedroom = zones.includes('bedroom');
  const hasFlex = zones.includes('flex');

  // 1. PRESERVE
  if (preserveList) p += 'PRESERVE EXACTLY: ' + preserveList + '\n\n';

  const stagingBlocks = [];

  // Dining zone
  if (hasDining && anchors.dining?.present) {
    if (anchors.dining.ceilingFixture) {
      stagingBlocks.push('DINING ZONE: Place an area rug centered in the open floor area under the ' + anchors.dining.ceilingFixture + '. Place a round dining table centered on the rug. Place 6 upholstered dining chairs around the table. Place one tall vase with stems on the table center.');
    } else {
      const leftB  = boundaries.diningLeft  ? ' to the right of the ' + boundaries.diningLeft  : '';
      const rightB = boundaries.diningRight ? ' and to the left of the ' + boundaries.diningRight : '';
      stagingBlocks.push('DINING ZONE: Place a round area rug centered in the open floor area' + leftB + rightB + '. Place a round dining table centered on the rug. Place 6 upholstered dining chairs around the table. Place one tall vase with stems on the table center.');
    }
  }
  if (hasKitchen && anchors.kitchen?.present && anchors.kitchen?.ceilingFixture) {
    if (anchors.kitchen.islandBarOverhang) {
      stagingBlocks.push('KITCHEN ZONE: Place 3 counter stools on the dining-zone-facing side of the island only, directly below the ' + anchors.kitchen.ceilingFixture + '. ' + (anchors.kitchen.islandDescription ? 'FLOATING KITCHEN ISLAND CABINET: ' + anchors.kitchen.islandDescription + ' — do not remove, relocate, resize, or alter. ' : '') + 'Place one small bowl of fruit on the island countertop. Keep all other surfaces clean.');
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
  if (hasFamily && anchors.family?.present) {
    const fm = anchors.family;
    const fixture = fm.ceilingFixture || 'ceiling fixture';
    const front = fm.frontWall || 'focal wall';
    const backRaw = fm.backWall || 'back wall';
    const badBack = /glass|window|exterior|sliding|door|patio/i.test(backRaw);
    const back = badBack ? 'partition wall or interior wall opposite the focal wall' : backRaw;
    const compact = fm.roomScale !== 'standard'; // default to compact unless explicitly read as standard-sized
    if (compact) {
      stagingBlocks.push('FAMILY ROOM ZONE: This is a smaller, casual gathering space — keep furniture scaled down and informal, not a formal living room layout. Place a medium area rug centered under the ' + fixture + '. Place a compact sectional or loveseat with its back against the ' + back + ', facing the ' + front + '. Place one accent chair angled toward the seating. Place a small coffee table or ottoman centered on the rug. Place one media console or low cabinet against the ' + front + ' wall if no fireplace is present. Keep the layout open and uncluttered given the smaller footprint.');
    } else {
      stagingBlocks.push('FAMILY ROOM ZONE: Casual gathering space, standard scale. Place an area rug centered under the ' + fixture + '. Place a sectional or sofa with its back against the ' + back + ', facing the ' + front + '. Place one or two accent chairs. Place a coffee table centered on the rug. Keep the overall feel relaxed and informal rather than editorial-formal.');
    }
  }
  if (hasFlex && anchors.flex?.present) {
    stagingBlocks.push(buildFlexZoneInstruction(anchors.flex));
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
  if (!hasFamily)  prohibitions.push('DO NOT add family room seating furniture — family room zone is not visible in this photograph.');
  if (!hasFlex && wallOpenings.some(w => /flex|arch|enclosed|semi-enclosed|walled room/i.test(w))) {
    prohibitions.push('A Flex Room is visible through a wall opening — DO NOT stage furniture inside the Flex Room. DO NOT assign any fixture inside the Flex Room as a dining anchor. Any chandelier inside an enclosed or semi-enclosed space with walls is a Flex Room fixture, not a dining/nook anchor.');
  }
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
        const resp = Buffer.concat(chunks).toString("utf8");
        console.log('Background response: status=' + res.statusCode + ' body=' + resp.slice(0, 200));
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
    console.log('🔍 DISPATCHER RECEIVED body:', JSON.stringify({ mode: body.mode, imagesCount: body.images?.length, hasImageBase64: !!body.imageBase64 }));
    const claudeKey = process.env.ANTHROPIC_API_KEY;
    if (!claudeKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }) };

    // MODE: spatial — fire background, return jobId
    if (body.mode === 'spatial' || (!body.mode && body.images && !body.imageBase64)) {
      console.log('📡 SPATIAL MODE DETECTED - extracting images');
      const { images, groupType, designStyle, colorPalette, groupSpatialPlan } = body;
      console.log('✅ Extracted images count:', images?.length || 'undefined');
      if (images.length > 5)            return { statusCode: 400, headers, body: JSON.stringify({ error: "Maximum 5 images" }) };

      const siteUrl = process.env.URL || process.env.DEPLOY_URL;
      if (!siteUrl) return { statusCode: 500, headers, body: JSON.stringify({ error: "Site URL not configured" }) };

      const readyImages = await Promise.all(images.map(async (img) => ({
        ...img, base64: await compressForRead(img.base64), mimeType: "image/jpeg"
      })));

      const jobId = "gsr-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      console.log('✅ Generated jobId:', jobId);

      // ✅ FIXED: Pass images (NOT imageDataArray), designStyle, colorPalette, groupSpatialPlan
      console.log('📤 Triggering background with:', { jobId, imagesCount: readyImages.length });
      const triggerStatus = await triggerBackground({ 
        jobId, 
        mode: 'spatial', 
        images: readyImages,
        designStyle: designStyle || 'Transitional',
        colorPalette: colorPalette || 'Warm Neutrals',
        groupSpatialPlan: groupSpatialPlan || null
      }, siteUrl);
      console.log('Job ' + jobId + ': background trigger status = ' + triggerStatus);

      if (triggerStatus !== 202) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Background trigger failed: ' + triggerStatus }) };
      }
      console.log('✅ RETURNING jobId SUCCESS');
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
    console.error("🔴 DISPATCHER ERROR:", err.message);
    console.error("🔴 ERROR STACK:", err.stack);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
