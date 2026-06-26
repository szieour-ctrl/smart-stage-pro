// group-spatial-read-background.js — ULTRA-SIMPLE BULLETPROOF VERSION
// Minimal code, maximal reliability. No parsing errors.

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
        try { 
          resolve({ status: res.statusCode, body: JSON.parse(raw) }); 
        } catch (e) { 
          resolve({ status: res.statusCode, body: { raw } }); 
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

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
  return { base64: compressed.toString('base64'), mimeType: 'image/jpeg' };
}

function buildHaikuSpatialReadPrompt() {
  return `YOU ARE A PROFESSIONAL SPATIAL ARCHITECT ANALYZING REAL ESTATE PHOTOGRAPHS.

YOUR TASK: Read the uploaded room photo and identify FURNISHING ZONES based ONLY on visible architecture, fixtures, and boundaries present in each zone.

CRITICAL RULE: List ONLY what is physically present in or attached to each zone. NO relationships to other zones. NO directional language.

═════════════════════════════════════════════════════════════════════════════════

ZONE IDENTIFICATION — What makes a zone?

A ZONE is a distinct spatial area bounded by:
- Walls or partial walls present in the zone
- Architectural openings (doorways, pass-throughs) that mark zone boundaries
- Permanent built-in fixtures located IN the zone (island, fireplace, built-ins)
- Ceiling changes or architectural divisions visible IN the zone

DO NOT identify zones by: relationships to other zones, proximity, or spatial relationships.

═════════════════════════════════════════════════════════════════════════════════

CONFIDENCE THRESHOLDS (Below = "None", no inference):

- Boundaries: 70%+ confidence only
- Fixtures: 70%+ confidence only
- Cabinetry: 70%+ confidence only
- Windows/Doors: 70%+ confidence only
- Anchor Point: 60%+ confidence IF Tier 1 anchor physically located IN this zone
- Focal Point: 70%+ confidence only

═════════════════════════════════════════════════════════════════════════════════

TIER 1 ANCHORS (60%+ confidence):
- Fireplace (gas or wood-burning insert visible IN the zone)
- Ceiling fan (mounted IN the zone ceiling)
- Chandelier or pendant light groups (mounted IN the zone ceiling)
- Recessed light groups positioned to anchor dining or seating

═════════════════════════════════════════════════════════════════════════════════

FURNISHING LOGIC:

IF Zone = Kitchen:
"Style & Main Pieces: Kitchen island (1), bar stools (quantity per clearance), cabinetry (built-in, fixed). Incorporate tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic."

IF Zone = Dining & Tier 1 Anchor (Chandelier/Pendant):
"Place an area rug proportional to seating group with a round or rectangular dining table and seating not to exceed 6 chairs, in the open space. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic. Floor runners are prohibited."

IF Zone = Dining & NO Tier 1 Anchor:
"Style & Main Pieces: [Transitional]. A round or rectangular dining table and seating not to exceed 6 chairs. Place an area rug proportional to seating group. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic. Floor runners are prohibited."

IF Zone = Living/Great Room & Tier 1 Anchor (Fireplace):
"Place an area rug proportional for the seating group 18\\" in front of the Fireplace anchoring the seating group to the Fireplace wall. Place a coffee table centered on the rug and Fireplace. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic."

IF Zone = Living/Great Room & Tier 1 Anchor (Ceiling Fan):
"Place an area rug proportional for the seating group centered beneath the ceiling fan. Place a coffee table centered on the rug and ceiling fan. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic."

IF Zone = Living/Great Room & NO Tier 1 Anchor:
"Style & Main Pieces: [Transitional]. Seating arrangement with sofa and accent chairs. Place an area rug proportional to seating group. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic. Floor runners are prohibited."

IF Zone = Hallway, Circulation, Entry, Foyer, Passage, Corridor:
"LEAVE VACANT"

IF Zone = Bedroom:
"Style & Main Pieces: Bed (1), nightstands (2), accent seating (optional). Incorporate tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic."

═════════════════════════════════════════════════════════════════════════════════

OUTPUT FORMAT (STRICT JSON ONLY):

Return ONLY a valid JSON array. One object per zone. NO additional text.

[
  {
    "zoneName": "Kitchen",
    "boundaries": "...",
    "fixtures": "...",
    "cabinetry": "...",
    "windowsDoors": "...",
    "anchorPoint": "...",
    "focalPoint": "...",
    "furnishing": "..."
  }
]

Now analyze the uploaded photo. Return ONLY valid JSON.`;
}

function applyTierLogic(zones) {
  if (!Array.isArray(zones)) zones = [zones];
  
  return zones.map(zone => {
    const zoneName = (zone.zoneName || '').toLowerCase();
    const anchorPoint = (zone.anchorPoint || '').toLowerCase();
    const hasAnchor = anchorPoint && anchorPoint !== 'none' && anchorPoint.length > 0;
    
    let furnishing = '';

    if (zoneName.includes('hallway') || zoneName.includes('circulation') || zoneName.includes('entry') || zoneName.includes('foyer')) {
      furnishing = 'LEAVE VACANT';
    }
    else if (zoneName.includes('kitchen')) {
      furnishing = 'Style & Main Pieces: Kitchen island (1), bar stools (quantity per clearance), cabinetry (built-in, fixed). Incorporate tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic.';
    }
    else if (zoneName.includes('dining') && (anchorPoint.includes('chandelier') || anchorPoint.includes('pendant'))) {
      furnishing = 'Place an area rug proportional to seating group with a round or rectangular dining table and seating not to exceed 6 chairs, in the open space. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic. Floor runners are prohibited.';
    }
    else if (zoneName.includes('dining') && !hasAnchor) {
      furnishing = 'Style & Main Pieces: [Transitional]. A round or rectangular dining table and seating not to exceed 6 chairs. Place an area rug proportional to seating group. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic. Floor runners are prohibited.';
    }
    else if ((zoneName.includes('living') || zoneName.includes('great room')) && anchorPoint.includes('fireplace')) {
      furnishing = 'Place an area rug proportional for the seating group 18" in front of the Fireplace anchoring the seating group to the Fireplace wall. Place a coffee table centered on the rug and Fireplace. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic.';
    }
    else if ((zoneName.includes('living') || zoneName.includes('great room')) && anchorPoint.includes('ceiling fan')) {
      furnishing = 'Place an area rug proportional for the seating group centered beneath the ceiling fan. Place a coffee table centered on the rug and ceiling fan. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic.';
    }
    else if ((zoneName.includes('living') || zoneName.includes('great room')) && !hasAnchor) {
      furnishing = 'Style & Main Pieces: [Transitional]. Seating arrangement with sofa and accent chairs. Place an area rug proportional to seating group. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic. Floor runners are prohibited.';
    }

    return { ...zone, furnishing };
  });
}

// ════════════════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ════════════════════════════════════════════════════════════════════════════════

exports.handler = async (event) => {
  console.log('🚀 Handler start');
  
  try {
    // Parse body safely
    let body = {};
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body || {};
    } catch (e) {
      console.error('Body parse error:', e.message);
      body = {};
    }

    const { images, groupType, jobId: incomingJobId } = body;
    const jobId = incomingJobId || `gsr-${Date.now()}`;

    console.log(`jobId: ${jobId}, images: ${images?.length || 0}`);

    if (!images || images.length === 0) {
      throw new Error('No images');
    }

    // Initialize Blobs
    const siteID = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
    const token = process.env.NETLIFY_ACCESS_TOKEN;
    const store = getStore({ name: 'spatial-jobs', siteID, token });

    // Prepare images
    console.log('Preparing images...');
    const preparedImages = await Promise.all(
      images.map(img => prepareImage(img.base64, img.mimeType))
    );

    // Build Haiku request
    console.log('Calling Haiku...');
    const prompt = buildHaikuSpatialReadPrompt();
    const imageContent = preparedImages.map(img => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mimeType, data: img.base64 }
    }));
    imageContent.push({ type: 'text', text: prompt });

    const payload = JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 2000,
      messages: [{ role: 'user', content: imageContent }]
    });

    const claudeKey = process.env.ANTHROPIC_API_KEY;
    if (!claudeKey) throw new Error('ANTHROPIC_API_KEY missing');

    const haikuResponse = await httpsRequest({
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, payload);

    if (haikuResponse.status !== 200) {
      throw new Error(`Haiku error: ${haikuResponse.status}`);
    }

    // Parse Haiku response
    console.log('Parsing Haiku response...');
    const textContent = haikuResponse.body.content?.find(c => c.type === 'text');
    if (!textContent) throw new Error('No text in Haiku response');

    let zones = [];
    try {
      zones = JSON.parse(textContent.text);
    } catch (e) {
      console.error('Zone parse error:', e.message);
      zones = [];
    }

    if (!Array.isArray(zones)) zones = [zones];
    if (zones.length === 0) throw new Error('No zones parsed');

    // Apply tier logic
    console.log('Applying tier logic...');
    const tieredZones = applyTierLogic(zones);

    // Store in Blobs
    console.log('Storing in Blobs...');
    const result = {
      status: 'done',
      spatialData: {
        zones: tieredZones,
        confidence: 'HIGH'
      },
      timestamp: new Date().toISOString()
    };

    await store.set(jobId, result, { type: 'json' });
    console.log('✅ Stored in Blobs');

    return { 
      statusCode: 200, 
      body: JSON.stringify({ success: true, jobId }) 
    };

  } catch (err) {
    console.error('❌ Handler error:', err.message);
    
    // Try to store error
    try {
      const siteID = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
      const token = process.env.NETLIFY_ACCESS_TOKEN;
      const store = getStore({ name: 'spatial-jobs', siteID, token });
      
      const jobId = `gsr-error-${Date.now()}`;
      await store.set(jobId, { 
        status: 'error', 
        error: err.message,
        timestamp: new Date().toISOString()
      }, { type: 'json' });
    } catch (e) {
      console.error('Failed to store error:', e.message);
    }

    return { 
      statusCode: 500, 
      body: JSON.stringify({ error: err.message }) 
    };
  }
};
