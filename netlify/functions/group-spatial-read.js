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

// NOTE: runPreserveRead (Haiku-based PRESERVE list generation) was removed here in Phase 6.2.
// The "preserve" mode name is kept for frontend/endpoint compatibility, but it no longer calls
// Haiku — see assembleSpatialZonePrompt below for the new template-substitution approach.

// ══════════════════════════════════════════════════════════════════════════
// SPATIAL ZONE ANALYSIS MODE — proofed prompt template (Phase 6.2)
// Two variable slots only: {{room_assignment_variables}} and the Design DNA block.
// GPT Image 2 does its own spatial/anchor reasoning — no Haiku description layer,
// no per-zone hand-written furniture scripts. The user's own zone selections are
// the only "translation" — everything else is the fixed template text below, verbatim.
// ══════════════════════════════════════════════════════════════════════════
const SPATIAL_ZONE_TEMPLATE = [
'SPATIAL ZONE ANALYSIS MODE',
'',
'PRIMARY ROLE: You are an architectural space planning analyst specializing in residential interiors.',
'SECONDARY ROLE: You are a professional luxury real estate interior designer, home stager, and architectural photographer.',
'',
'TASK',
'Analyze the uploaded room photograph and identify all functional furnishing zones based solely on the visible architecture, fixtures, openings, windows, cabinetry, fireplaces, built-ins, ceiling features, and circulation paths before you place furnishings',
'',
'ZONE IDENTIFICATION RULES',
'Identify each functional furnishing zone visible in the image.',
'Examples include:',
'• Living Room',
'• Dining Area',
'• Kitchen',
'• Breakfast Nook',
'• Flex Room',
'• Office',
'• Entry',
'• Loft',
'• Primary Bedroom',
'• Sitting Area',
'',
'Determine zone boundaries using architectural cues including:',
'• Walls',
'• Partial walls',
'• Openings',
'• Doorways',
'• Windows',
'• Sliding glass doors',
'• Fireplaces',
'• Kitchen islands',
'• Cabinetry',
'• Ceiling changes',
'• Chandeliers',
'• Pendant lighting',
'• Ceiling fans',
'• Built-ins',
'• Hallways',
'• Circulation paths',
'',
'SPATIAL ACCURACY RULES',
'Respect the exact perspective, geometry, scale, camera angle, and architectural proportions shown in the original photograph.',
'Zone boundaries must align with actual architectural features and not arbitrary visual estimates.',
'',
'Use zone anchors whenever present:',
'• Chandeliers typically define dining zones.',
'• Pendant lights typically define seating zones.',
'• Ceiling fans typically define living zones.',
'• Fireplaces typically define living zones',
'',
'Your job is to identify the find and stage only the Zones that are listed, if the zone is not listed the area is to be left vacant:',
'Find: {{room_assignment_variables}} go here',
'',
'"IF" Zone Anchors exist or do not exist you must follow these rules:',
'• "IF" Chandelier is found, this is the dining zone, place an area rug, table and chairs sized for the space centered directly below chandelier',
'• "If "no Chandelier is found, place an area rug, table and chairs sized for the dining zone sized appropriately for the open space',
'• "IF", Fireplace is found, place an area rug 18" from the front on the floor and centered on the fireplace with a coffee table',
'• "IF, Entry or Hallway is found, a 48" circular pathway must be maintained',
'• IF, Ceiling fan is found center furniture grouping around it.',
'',
'Identify the most logical furniture placement for each zone Incorporate tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic. circulation paths between zone boundaries.',
'',
'DESIGN STYLE & PALETTE',
'{{all_design_style_&_palette}} variables go here User Selected DNA {{variables}}',
'',
'OUTPUT REQUIREMENTS',
'Do not alter architecture.',
'',
'AB 723 COMPLIANCE',
'This analysis is for planning and visualization purposes only.',
'Do not alter, remove, relocate, resize, conceal, or modify any architectural element including walls, windows, doors, cabinetry, fireplaces, flooring, ceilings, lighting fixtures, appliances, or built-in features.',
'All architectural elements must remain exactly as photographed.'
].join('\n');

// Build the {{room_assignment_variables}} value: plain zone names, Flex Room inlined with its
// user-typed freetext (e.g. "Kitchen, Dining, Office (Flex Room)") — a name only, never a furniture script.
function buildRoomAssignmentVariable({ zoneList, flexNote, roomName, isOpenPlan }) {
  if (!isOpenPlan) return roomName || 'this room';
  if (!zoneList || !zoneList.length) return roomName || 'this room';
  const names = zoneList.map(z => {
    const zo = OPEN_PLAN_ZONE_LABELS[z] || z;
    return (z === 'flex' && flexNote) ? `${flexNote} (Flex Room)` : zo;
  });
  return names.join(', ');
}
const OPEN_PLAN_ZONE_LABELS = { kitchen: 'Kitchen', dining: 'Dining', living: 'Living Room', family: 'Family Room', flex: 'Flex Room' };

// Build the Design DNA block: full Session DNA — Buyer Profile, Desired Feeling, Style, Staging Level, Palette —
// plus, when this image is part of a Multi-Angle Group locked to an already-staged Open Plan anchor,
// the captured furnishings DNA from extract-staging-dna.js (continuity only — no placement language).
function buildDesignDnaVariable({ style, palette, buyerProfile, desiredFeeling, stagingLevel, furnishingsDNA }) {
  const parts = [];
  if (style)         parts.push('Design Style: ' + style);
  if (palette)        parts.push('Color Palette: ' + palette);
  if (buyerProfile)   parts.push('Buyer Profile: ' + buyerProfile);
  if (desiredFeeling)  parts.push('Desired Feeling: ' + desiredFeeling);
  if (stagingLevel)    parts.push('Staging Level: ' + stagingLevel);
  let dnaText = parts.join('. ') + (parts.length ? '.' : '');
  if (furnishingsDNA) {
    const f = furnishingsDNA;
    const furnishingParts = [];
    if (f.continuityPrompt) furnishingParts.push(f.continuityPrompt);
    else {
      if (f.sofa) furnishingParts.push('Sofa: ' + f.sofa + '.');
      if (f.woodTones) furnishingParts.push('Wood tones: ' + f.woodTones + '.');
      if (f.metalFinishes) furnishingParts.push('Metal finishes: ' + f.metalFinishes + '.');
      if (f.colorPalette) furnishingParts.push('Palette: ' + (Array.isArray(f.colorPalette) ? f.colorPalette.join(', ') : f.colorPalette) + '.');
    }
    if (furnishingParts.length) {
      dnaText += '\n\nMATCH ESTABLISHED FURNISHINGS (from the staged anchor image in this group): ' + furnishingParts.join(' ');
    }
  }
  return dnaText;
}

// assembleSpatialZonePrompt — pure template substitution, no Haiku, no scripted per-zone furniture.
// zones: { zoneList, flexNote, roomName, isOpenPlan } — the user's own Image Assignment selections.
// dna: { style, palette, buyerProfile, desiredFeeling, stagingLevel } — Session DNA.
function assembleSpatialZonePrompt({ zones, dna }) {
  const roomAssignmentValue = buildRoomAssignmentVariable(zones || {});
  const designDnaValue = buildDesignDnaVariable(dna || {});
  return SPATIAL_ZONE_TEMPLATE
    .replace('{{room_assignment_variables}} go here', roomAssignmentValue)
    .replace('{{all_design_style_&_palette}} variables go here User Selected DNA {{variables}}', designDnaValue);
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

    // MODE: spatial — fire background, return jobId
    if (body.mode === 'spatial' || (!body.mode && body.images && !body.imageBase64)) {
      const claudeKey = process.env.ANTHROPIC_API_KEY;
      if (!claudeKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }) };
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

    // MODE: preserve — kept as the endpoint name for frontend compatibility, but no longer
    // calls Haiku. Phase 6.2: assembles the SPATIAL ZONE ANALYSIS template directly from the
    // user's own Image Assignment selections + Session DNA. No AI translation layer.
    if (body.mode === 'preserve') {
      const { imageLabel, zoneList, flexNote, roomName, isOpenPlan, designStyle, colorPalette, buyerProfile, desiredFeeling, stagingLevel, furnishingsDNA } = body;

      console.log('Assembling spatial zone prompt: ' + imageLabel + (furnishingsDNA ? ' (with furnishings DNA)' : ''));
      const promptText = assembleSpatialZonePrompt({
        zones: { zoneList: zoneList || [], flexNote: flexNote || '', roomName: roomName || imageLabel, isOpenPlan: !!isOpenPlan },
        dna: {
          style: STYLE_LABELS[designStyle?.toLowerCase()] || designStyle || 'Transitional',
          palette: PALETTE_TONES[colorPalette] || colorPalette || 'Warm Neutrals',
          buyerProfile: buyerProfile || '',
          desiredFeeling: desiredFeeling || '',
          stagingLevel: stagingLevel || '',
          furnishingsDNA: furnishingsDNA || null,
        }
      });

      console.log('Prompt assembly complete: ' + promptText.length + ' chars');
      return { statusCode: 200, headers, body: JSON.stringify({ mode: 'preserve', promptText }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid mode — use spatial or preserve" }) };

  } catch (err) {
    console.error("🔴 DISPATCHER ERROR:", err.message);
    console.error("🔴 ERROR STACK:", err.stack);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
