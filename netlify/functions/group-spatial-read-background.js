// group-spatial-read-background.js — BULLETPROOF DIAGNOSTIC VERSION
// Logs EVERYTHING to Blobs so we can debug even with hidden background logs

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

TIER 1 ANCHORS (60%+ confidence — Explicit furnishing instructions):

Physical fixtures located IN the zone that anchor seating:
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

STRICT RULES FOR EACH OUTPUT FIELD:

**zoneName:** Exact zone type ONLY. Examples: "Kitchen", "Dining Zone", "Living/Great Room", "Hallway/Circulation", "Bedroom"

**boundaries:** ONLY walls, partitions, openings physically visible IN this zone. NO relationships to other zones.

**fixtures:** ONLY ceiling and wall-mounted fixtures physically located IN this zone at 70%+ confidence. If none: "None"

**cabinetry:** ONLY built-in cabinetry physically present IN this zone at 70%+ confidence. If none: "None"

**windowsDoors:** ONLY windows and doors that open FROM this zone at 70%+ confidence. If none: "None"

**anchorPoint:** Tier 1 anchor physically located IN this zone at 60%+ confidence. Examples: "Fireplace (center-back wall)", "Ceiling fan (center-ceiling)", "Chandelier (center-zone)", "None"

**focalPoint:** Architectural feature or fixture physically located IN this zone at 70%+ confidence. NOT furniture placement.

**furnishing:** EXACT instruction from logic rules above. Do NOT modify.

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
  if (!Array.isArray(zones)) return zones;
  
  return zones.map(zone => {
    const zoneName = (zone.zoneName || '').trim().toLowerCase();
    const anchorPoint = (zone.anchorPoint || '').trim();
    const hasAnchor = anchorPoint && anchorPoint !== 'None' && anchorPoint.length > 0;
    const anchorLower = hasAnchor ? anchorPoint.toLowerCase() : '';
    
    let furnishing = '';

    if (zoneName.includes('hallway') || zoneName.includes('circulation') || zoneName.includes('entry') || zoneName.includes('foyer')) {
      furnishing = 'LEAVE VACANT';
    }
    else if (zoneName.includes('kitchen')) {
      furnishing = 'Style & Main Pieces: Kitchen island (1), bar stools (quantity per clearance), cabinetry (built-in, fixed). Incorporate tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic.';
    }
    else if (zoneName.includes('dining') && (anchorLower.includes('chandelier') || anchorLower.includes('pendant'))) {
      furnishing = 'Place an area rug proportional to seating group with a round or rectangular dining table and seating not to exceed 6 chairs, in the open space. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic. Floor runners are prohibited.';
    }
    else if (zoneName.includes('dining') && !hasAnchor) {
      furnishing = 'Style & Main Pieces: [Transitional]. A round or rectangular dining table and seating not to exceed 6 chairs. Place an area rug proportional to seating group. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic. Floor runners are prohibited.';
    }
    else if ((zoneName.includes('living') || zoneName.includes('great room')) && anchorLower.includes('fireplace')) {
      furnishing = 'Place an area rug proportional for the seating group 18" in front of the Fireplace anchoring the seating group to the Fireplace wall. Place a coffee table centered on the rug and Fireplace. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic.';
    }
    else if ((zoneName.includes('living') || zoneName.includes('great room')) && anchorLower.includes('ceiling fan')) {
      furnishing = 'Place an area rug proportional for the seating group centered beneath the ceiling fan. Place a coffee table centered on the rug and ceiling fan. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic.';
    }
    else if ((zoneName.includes('living') || zoneName.includes('great room')) && !hasAnchor) {
      furnishing = 'Style & Main Pieces: [Transitional]. Seating arrangement with sofa and accent chairs. Place an area rug proportional to seating group. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic. Floor runners are prohibited.';
    }

    return { ...zone, furnishing };
  });
}

// ════════════════════════════════════════════════════════════════════════════════
// MAIN HANDLER — With comprehensive logging stored in Blobs
// ════════════════════════════════════════════════════════════════════════════════

exports.handler = async (event, context) => {
  const startTime = Date.now();
  const diagnosticLogs = [];
  let jobId = null;

  function log(msg) {
    const timestamp = new Date().toISOString();
    const fullMsg = `[${timestamp}] ${msg}`;
    console.log(fullMsg);
    diagnosticLogs.push(fullMsg);
  }

  try {
    log('🚀 Handler started');
    
    // Parse request
    log('Parsing request body...');
    const body = JSON.parse(event.body || '{}');
    const { images, groupType, jobId: incomingJobId } = body;
    jobId = incomingJobId || `gsr-${Date.now()}-auto`;

    log(`jobId: ${jobId}`);
    log(`groupType: ${groupType}`);
    log(`images count: ${images?.length || 0}`);

    if (!images || images.length === 0) {
      throw new Error('No images provided');
    }

    // Get Blobs store
    log('Initializing Blobs store...');
    const siteID = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
    const token = process.env.NETLIFY_ACCESS_TOKEN;
    const store = getStore({ name: 'spatial-jobs', siteID, token });
    log(`Store initialized: siteID=${siteID}`);

    // Prepare images
    log('Preparing images...');
    const preparedImages = await Promise.all(
      images.map((img, idx) => {
        log(`  Preparing image ${idx}...`);
        return prepareImage(img.base64, img.mimeType);
      })
    );
    log(`✅ ${preparedImages.length} images prepared`);

    // Build Haiku prompt
    log('Building Haiku prompt...');
    const prompt = buildHaikuSpatialReadPrompt();
    log(`✅ Prompt built (${prompt.length} chars)`);

    // Prepare Haiku request
    log('Preparing Haiku API request...');
    const claudeKey = process.env.ANTHROPIC_API_KEY;
    if (!claudeKey) throw new Error('ANTHROPIC_API_KEY not configured');

    const imageContent = preparedImages.map((img, idx) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mimeType, data: img.base64 }
    }));
    imageContent.push({ type: 'text', text: prompt });

    const payload = JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 2000,
      messages: [{ role: 'user', content: imageContent }]
    });

    log(`Payload size: ${(Buffer.byteLength(payload) / 1024).toFixed(1)}KB`);

    // Call Haiku
    log('🧠 Calling Haiku API...');
    const haikuStart = Date.now();
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
    const haikuDuration = Date.now() - haikuStart;

    log(`✅ Haiku response: status=${haikuResponse.status}, duration=${haikuDuration}ms`);

    if (haikuResponse.status !== 200) {
      throw new Error(`Haiku API error: ${haikuResponse.status} - ${JSON.stringify(haikuResponse.body).slice(0, 200)}`);
    }

    // Parse Haiku response
    log('Parsing Haiku response...');
    const textContent = haikuResponse.body.content?.find(c => c.type === 'text');
    if (!textContent) throw new Error('No text content in Haiku response');

    let zones = [];
    try {
      zones = JSON.parse(textContent.text);
      log(`✅ Parsed zones: ${zones.length}`);
    } catch (e) {
      log(`⚠️  JSON parse failed: ${e.message}`);
      log(`Raw response (first 500 chars): ${textContent.text.slice(0, 500)}`);
      throw new Error(`Failed to parse Haiku JSON: ${e.message}`);
    }

    if (!Array.isArray(zones)) zones = [zones];

    // Apply tier logic
    log('Applying tier logic...');
    const tieredZones = applyTierLogic(zones);
    log(`✅ Tier logic applied to ${tieredZones.length} zones`);

    // Store in Blobs
    log('💾 Storing results in Blobs...');
    const result = {
      status: 'done',
      spatialData: {
        zones: tieredZones,
        confidence: 'HIGH'
      },
      diagnosticLogs: diagnosticLogs,
      timestamp: new Date().toISOString(),
      duration: Date.now() - startTime
    };

    await store.set(jobId, result, { type: 'json' });
    log(`✅ Results stored in Blobs`);

    // SUCCESS
    log(`✅ Handler completed successfully in ${Date.now() - startTime}ms`);
    return { statusCode: 200, body: JSON.stringify({ success: true, jobId, duration: Date.now() - startTime }) };

  } catch (err) {
    log(`❌ ERROR: ${err.message}`);
    log(`Stack: ${err.stack?.slice(0, 300) || 'N/A'}`);

    // Store error in Blobs
    try {
      if (jobId) {
        const siteID = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
        const token = process.env.NETLIFY_ACCESS_TOKEN;
        const store = getStore({ name: 'spatial-jobs', siteID, token });
        
        const errorResult = {
          status: 'error',
          error: err.message,
          diagnosticLogs: diagnosticLogs,
          timestamp: new Date().toISOString(),
          duration: Date.now() - startTime
        };
        
        await store.set(jobId, errorResult, { type: 'json' });
        log(`✅ Error stored in Blobs`);
      }
    } catch (storageErr) {
      log(`⚠️  Failed to store error in Blobs: ${storageErr.message}`);
    }

    return { statusCode: 500, body: JSON.stringify({ error: err.message, diagnosticLogs }) };
  }
};
