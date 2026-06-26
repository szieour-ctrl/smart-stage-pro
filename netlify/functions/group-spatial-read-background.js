// group-spatial-read-background.js — Phase 5A Multi-Angle Open-Plan Spatial Read
// Reads 3+ angles of open-plan rooms, detects Tier 1/2 anchors, returns furnishing instructions
// CRITICAL: Stores results in Netlify Blobs so check-spatial-read.js can retrieve them

const https = require("https");
const sharp = require("sharp");
const { getStore } = require("@netlify/blobs"); // ✅ CRITICAL: Blobs storage for polling

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
  console.log('prepareImage: ' + meta.width + 'x' + meta.height + ' ' + sizeKB + 'KB → ' + Math.round(compressed.length/1024) + 'KB');
  return { base64: compressed.toString('base64'), mimeType: 'image/jpeg' };
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

// ════════════════════════════════════════════════════════════════════════════════
// PHASE 5A HAIKU SPATIAL READ PROMPT — Returns 6-field zones with furnishing logic
// ════════════════════════════════════════════════════════════════════════════════

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
- Furnishing: Based on zone type + anchor presence

═════════════════════════════════════════════════════════════════════════════════

TIER 1 ANCHORS (60%+ confidence — Explicit furnishing instructions):

Physical fixtures located IN the zone that anchor seating:
- Fireplace (gas or wood-burning insert visible IN the zone)
- Ceiling fan (mounted IN the zone ceiling)
- Chandelier or pendant light groups (mounted IN the zone ceiling)
- Recessed light groups positioned to anchor dining or seating

═════════════════════════════════════════════════════════════════════════════════

FURNISHING LOGIC — Generate based on zone name + anchor presence:

IF Zone = Kitchen:
"Style & Main Pieces: Kitchen island (1), bar stools (quantity per clearance), cabinetry (built-in, fixed).
Incorporate tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic."

IF Zone = Dining & Tier 1 Anchor (Chandelier/Pendant Lights):
"Place an area rug proportional to seating group with a round or rectangular dining table and seating not to exceed 6 chairs, in the open space. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic. Floor runners are prohibited."

IF Zone = Dining & NO Tier 1 Anchor (Tier 2 Open Space):
"Style & Main Pieces: [Transitional]. A round or rectangular dining table and seating not to exceed 6 chairs. Place an area rug proportional to seating group. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic. Floor runners are prohibited."

IF Zone = Living/Great Room & Tier 1 Anchor (Fireplace):
"Place an area rug proportional for the seating group 18\" in front of the Fireplace anchoring the seating group to the Fireplace wall. Place a coffee table centered on the rug and Fireplace. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic."

IF Zone = Living/Great Room & Tier 1 Anchor (Ceiling Fan):
"Place an area rug proportional for the seating group centered beneath the ceiling fan. Place a coffee table centered on the rug and ceiling fan. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic."

IF Zone = Living/Great Room & NO Tier 1 Anchor (Tier 2 Open Space):
"Style & Main Pieces: [Transitional]. Seating arrangement with sofa and accent chairs. Place an area rug proportional to seating group. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic. Floor runners are prohibited."

IF Zone = Hallway, Circulation, Entry, Foyer, Passage, or Corridor:
"LEAVE VACANT"

IF Zone = Bedroom:
"Style & Main Pieces: Bed (1), nightstands (2), accent seating (optional).
Incorporate tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic."

═════════════════════════════════════════════════════════════════════════════════

STRICT RULES FOR EACH OUTPUT FIELD:

**zoneName:** Exact zone type ONLY. Examples: "Kitchen", "Dining Zone", "Living/Great Room", "Hallway/Circulation", "Bedroom", "Entry/Foyer"

**boundaries:** ONLY walls, partitions, openings physically visible IN this zone.
Example CORRECT: "White drywall walls on left, back, right. Single doorway opening on front edge."
Example WRONG: "Left: kitchen island. Right: fireplace wall." ← NO relationships to other zones

**fixtures:** ONLY ceiling and wall-mounted fixtures physically located IN this zone at 70%+ confidence.
Example CORRECT: "Recessed ceiling lights (3, distributed). Fireplace insert on back wall."
Example WRONG: "Chandelier over kitchen island" ← If island is NOT in this zone, don't list it.
If none at 70%+ confidence: "None"

**cabinetry:** ONLY built-in cabinetry physically present IN this zone at 70%+ confidence.
Example CORRECT: "Base cabinetry along back wall. Upper cabinetry with integrated appliances."
Example WRONG: "Island with sink" ← If island is NOT in this zone, don't mention it.
If none visible: "None"

**windowsDoors:** ONLY windows and doors that open FROM this zone at 70%+ confidence.
Example CORRECT: "Sliding glass door (4-panel, black frame). Single window (upper left)."
Example WRONG: "Pass-through to kitchen" ← If pass-through leads to adjacent zone, describe the opening itself only.
If none: "None"

**anchorPoint:** Tier 1 anchor (fireplace, ceiling fan, chandelier, etc.) physically located IN this zone at 60%+ confidence.
Examples: "Fireplace (center-back wall)", "Ceiling fan (center-ceiling)", "Chandelier (center-zone)", "None"
NEVER use spatial relationships or adjacency.

**focalPoint:** Architectural feature or fixture physically located IN this zone at 70%+ confidence. NOT furniture placement.
Examples: "Fireplace wall with marble surround", "Large window wall", "Built-in cabinetry", "Open floor plane"
NOT: "Use fireplace as anchor" or "Face towards kitchen" ← NO furniture instructions.

**furnishing:** EXACT instruction from logic rules above. Use zone name + anchor type to select correct instruction.
Do NOT modify. Do NOT add personal variations.

═════════════════════════════════════════════════════════════════════════════════

OUTPUT FORMAT (STRICT JSON ONLY):

Return ONLY a valid JSON array. One object per zone. NO additional text, NO markdown, NO explanations.

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
  },
  {
    "zoneName": "Dining Zone",
    "boundaries": "...",
    "fixtures": "None",
    "cabinetry": "None",
    "windowsDoors": "...",
    "anchorPoint": "...",
    "focalPoint": "...",
    "furnishing": "..."
  }
]

═════════════════════════════════════════════════════════════════════════════════

Now analyze the uploaded photo. Identify each distinct zone based on visible architecture and boundaries.
For each zone, return ONLY the 7-field JSON object above.
Use confidence thresholds strictly. List ONLY what is present in or attached to each zone.
Return ONLY valid JSON. No other output.`;
}

// ════════════════════════════════════════════════════════════════════════════════
// PHASE 5A TIER 1/2 ANCHOR LOGIC — Apply furnishing instructions based on anchors
// ════════════════════════════════════════════════════════════════════════════════

function applyTierLogic(zones) {
  if (!Array.isArray(zones)) return zones;
  
  return zones.map(zone => {
    const zoneName = (zone.zoneName || '').toLowerCase();
    const hasAnchor = zone.anchorPoint && zone.anchorPoint !== 'None' && zone.anchorPoint.length > 0;
    const anchorType = hasAnchor ? (zone.anchorPoint || '').toLowerCase() : '';
    
    let furnishing = zone.furnishing || '';

    // Hallway/Circulation — LEAVE VACANT
    if (zoneName.includes('hallway') || zoneName.includes('circulation') || zoneName.includes('entry') || zoneName.includes('foyer') || zoneName.includes('passage')) {
      furnishing = 'LEAVE VACANT';
    }
    // Kitchen
    else if (zoneName.includes('kitchen')) {
      furnishing = 'Style & Main Pieces: Kitchen island (1), bar stools (quantity per clearance), cabinetry (built-in, fixed).\nIncorporate tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic.';
    }
    // Dining with Tier 1 anchor (Chandelier/Pendant)
    else if (zoneName.includes('dining') && (anchorType.includes('chandelier') || anchorType.includes('pendant'))) {
      furnishing = 'Place an area rug proportional to seating group with a round or rectangular dining table and seating not to exceed 6 chairs, in the open space. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic. Floor runners are prohibited.';
    }
    // Dining Tier 2 (No anchor)
    else if (zoneName.includes('dining') && !hasAnchor) {
      furnishing = 'Style & Main Pieces: [Transitional]. A round or rectangular dining table and seating not to exceed 6 chairs. Place an area rug proportional to seating group. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic. Floor runners are prohibited.';
    }
    // Living with Fireplace Tier 1
    else if ((zoneName.includes('living') || zoneName.includes('great room')) && anchorType.includes('fireplace')) {
      furnishing = 'Place an area rug proportional for the seating group 18" in front of the Fireplace anchoring the seating group to the Fireplace wall. Place a coffee table centered on the rug and Fireplace. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic.';
    }
    // Living with Ceiling Fan Tier 1
    else if ((zoneName.includes('living') || zoneName.includes('great room')) && anchorType.includes('ceiling fan')) {
      furnishing = 'Place an area rug proportional for the seating group centered beneath the ceiling fan. Place a coffee table centered on the rug and ceiling fan. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic.';
    }
    // Living Tier 2 (No anchor)
    else if ((zoneName.includes('living') || zoneName.includes('great room')) && !hasAnchor) {
      furnishing = 'Style & Main Pieces: [Transitional]. Seating arrangement with sofa and accent chairs. Place an area rug proportional to seating group. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic. Floor runners are prohibited.';
    }

    return { ...zone, furnishing };
  });
}

// ════════════════════════════════════════════════════════════════════════════════
// PHASE 5A HAIKU SPATIAL READ — Multi-angle group read
// ════════════════════════════════════════════════════════════════════════════════

async function runSpatialRead({ imageDataArray, claudeKey }) {
  if (!imageDataArray || imageDataArray.length === 0) {
    throw new Error('No images provided');
  }

  const prompt = buildHaikuSpatialReadPrompt();

  const imageContent = imageDataArray.map((img, idx) => ({
    type: 'image',
    source: {
      type: 'base64',
      media_type: img.mimeType,
      data: img.base64
    }
  }));

  imageContent.push({
    type: 'text',
    text: prompt
  });

  const body = JSON.stringify({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 2000,
    messages: [
      {
        role: 'user',
        content: imageContent
      }
    ]
  });

  const options = {
    hostname: 'api.anthropic.com',
    port: 443,
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': claudeKey,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(body)
    }
  };

  const response = await httpsRequest(options, body);
  if (response.status !== 200) {
    throw new Error(`Haiku API error: ${response.status} - ${JSON.stringify(response.body)}`);
  }

  const textContent = response.body.content?.find(c => c.type === 'text');
  if (!textContent) throw new Error('No text response from Haiku');

  let zones = [];
  try {
    zones = JSON.parse(textContent.text);
  } catch (e) {
    console.error('Haiku JSON parse failed:', e.message);
    console.error('Raw response:', textContent.text);
    throw new Error('Failed to parse Haiku response as JSON');
  }

  if (!Array.isArray(zones)) zones = [zones];

  // Apply tier logic
  const tieredZones = applyTierLogic(zones);

  return {
    zones: tieredZones,
    confidence: 'HIGH'
  };
}

// ════════════════════════════════════════════════════════════════════════════════
// MAIN BACKGROUND HANDLER — Stores results in Blobs for polling
// ════════════════════════════════════════════════════════════════════════════════

exports.handler = async (event, context) => {
  const jobId = event.queryStringParameters?.jobId;
  
  try {
    if (!jobId) {
      console.error('No jobId in handler call');
      return { statusCode: 400, body: JSON.stringify({ error: "Missing jobId" }) };
    }

    const { images, groupType } = JSON.parse(event.rawBody || '{}');
    const claudeKey = process.env.ANTHROPIC_API_KEY;

    if (!claudeKey) {
      throw new Error("ANTHROPIC_API_KEY not configured");
    }

    console.log(`🚀 Background handler: jobId=${jobId}, images=${images?.length || 0}`);

    // Prepare images
    const preparedImages = await Promise.all(
      (images || []).map(img => prepareImage(img.base64, img.mimeType || detectMime(img.base64)))
    );

    // Run Haiku spatial read with tier logic applied
    console.log('📝 Running Haiku spatial read...');
    const spatialData = await runSpatialRead({
      imageDataArray: preparedImages,
      claudeKey
    });

    console.log('✅ Spatial read complete:', spatialData.zones?.length, 'zones');

    // ✅ CRITICAL: Store results in Blobs so check-spatial-read can retrieve them
    const siteID = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
    const token  = process.env.NETLIFY_ACCESS_TOKEN;
    const store  = getStore({ name: "spatial-jobs", siteID, token });

    const result = {
      status: "done",
      spatialData,
      timestamp: new Date().toISOString()
    };

    await store.set(jobId, result, { type: "json" });
    console.log(`💾 Stored results in Blobs: jobId=${jobId}`);

    return { statusCode: 200, body: JSON.stringify({ success: true, jobId }) };

  } catch (err) {
    console.error("group-spatial-read-background error:", err.message);
    
    // Store error in Blobs so polling knows to fail
    try {
      const siteID = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
      const token  = process.env.NETLIFY_ACCESS_TOKEN;
      const store  = getStore({ name: "spatial-jobs", siteID, token });
      await store.set(jobId, { status: "error", error: err.message }, { type: "json" });
    } catch(e) {
      console.error("Error storing failure in Blobs:", e.message);
    }

    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
