// group-spatial-read-background.js — Phase 5A Multi-Angle Open-Plan Spatial Read
// Reads 3+ angles of open-plan rooms, detects Tier 1/2 anchors, stores result in Netlify Blobs
// Client polls check-spatial-read.js every 3 seconds for result

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
  return `YOU ARE A PROFESSIONAL SPATIAL ARCHITECT & ARCHITECTURAL ANALYZER.

YOUR TASK: Read the uploaded property photo and identify functional furnishing zones based ONLY on visible architecture, fixtures, and spatial boundaries.

CRITICAL RULES:
1. Analyze ONLY what is visible in the photograph
2. NO INFERENCE below confidence thresholds (see below)
3. Preserve ALL architectural elements exactly as shown
4. NO directional language ("left of", "adjacent to", etc.)
5. NO furniture placement — facts only
6. Hallway/circulation zones must output "LEAVE VACANT"

ZONE IDENTIFICATION:
Identify zones using: walls, partial walls, openings, doorways, windows, sliding glass doors, fireplaces, kitchen islands, cabinetry, ceiling changes, chandeliers, pendant lighting, ceiling fans, built-ins, columns.

CONFIDENCE THRESHOLDS (Below = "None"):
- Boundaries: 70%+
- Fixtures: 70%+
- Cabinetry: 70%+
- Windows/Doors: 70%+
- Anchor Point: 60%+ (IF Tier 1 anchor exists)
- Focal Point: 70%+

TIER 1 ANCHORS (Explicit furnishing instructions at 60%+ confidence):
- Fireplace (gas or wood-burning insert)
- Ceiling fan
- Chandelier or pendant light groups
- Recessed light groups positioned to anchor seating

TIER 2 ZONES (No Tier 1 anchor):
- Open floor space, no fixture
- Generic furnishing instructions
- GPT2 infers placement

FURNISHING FIELD LOGIC:

IF Zone = Kitchen:
"Style & Main Pieces: Kitchen island (1), bar stools (quantity per clearance), cabinetry (built-in, fixed).
Incorporate tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic."

IF Zone = Dining & Anchor = Chandelier/Pendant Lights (Tier 1):
"Place an area rug proportional to seating group with a round or rectangular dining table and seating not to exceed 6 chairs, in the open space. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic. Floor runners are prohibited."

IF Zone = Dining & No Anchor (Tier 2):
"Style & Main Pieces: [Transitional]. A round or rectangular dining table and seating not to exceed 6 chairs. Place an area rug proportional to seating group. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic. Floor runners are prohibited."

IF Zone = Living & Anchor = Fireplace (Tier 1):
"Place an area rug proportional for the seating group 18\" in front of the Fireplace anchoring the seating group to the Fireplace wall. Place a coffee table centered on the rug and Fireplace. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic."

IF Zone = Living & Anchor = Ceiling Fan (Tier 1):
"Place an area rug proportional for the seating group centered beneath the ceiling fan. Place a coffee table centered on the rug and ceiling fan. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic."

IF Zone = Living & No Anchor (Tier 2):
"Style & Main Pieces: [Transitional]. Seating arrangement with sofa and accent chairs. Place an area rug proportional to seating group. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic. Floor runners are prohibited."

IF Zone = Hallway or Circulation or Entry or Foyer or Passage:
"LEAVE VACANT"

OUTPUT FORMAT (STRICT JSON):

Return ONLY valid JSON array. One object per zone. NO additional text, NO markdown, NO explanations.

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

STRICT RULES FOR EACH FIELD:

zoneName: Exact zone type (Kitchen, Dining Zone, Living/Great Room, Hallway/Circulation, Bedroom, etc.)

boundaries: Describe zone perimeter using architecture only. Example: "Left: island edge. Right: fireplace wall. Front: hallway. Back: window wall."

fixtures: List ALL ceiling and wall-mounted fixtures visible. If none at 70%+ confidence: "None".

cabinetry: List all built-in cabinetry types (upper, lower, island, etc.). If none visible: "None".

windowsDoors: List all windows, glass doors, openings. Example: "Sliding glass doors (4-panel, black frame, center-back). Single window (upper left)". If none: "None".

anchorPoint: Tier 1 anchor ONLY if 60%+ confidence AND zone is Kitchen/Dining/Living. Otherwise "None".
Examples: "Fireplace (center-right wall)", "Ceiling fan (center-room)", "Chandelier (center-dining)", "None".

focalPoint: Describe focal reference. Can be architectural (fireplace wall, window wall) or fixture-based. NOT furniture placement.

furnishing: EXACT instruction from logic rules above. DO NOT MODIFY. Use zone name and anchor presence to select correct instruction.

---

Now analyze the uploaded photo and return ONLY the JSON array. No other output.`;
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
// MAIN HANDLER — BLOB STORAGE PATTERN (following stage-openai-background)
// ════════════════════════════════════════════════════════════════════════════════

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  const siteID = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_ACCESS_TOKEN;
  let jobId;

  try {
    const { jobId: jId, imageDataArray, designStyle, colorPalette } = JSON.parse(event.body);
    jobId = jId;
    const claudeKey = process.env.ANTHROPIC_API_KEY;

    console.log(`Job ${jobId} starting... siteID=${siteID ? "SET" : "MISSING"} token=${token ? "SET" : "MISSING"}`);

    if (!siteID) throw new Error("NETLIFY_SITE_ID not configured");
    if (!token)  throw new Error("NETLIFY_ACCESS_TOKEN not configured");
    if (!claudeKey) throw new Error("ANTHROPIC_API_KEY not configured");
    if (!imageDataArray || imageDataArray.length === 0) throw new Error("Missing imageDataArray");

    const store = getStore({ name: "spatial-jobs", siteID, token });

    // Write heartbeat immediately — confirms background function is running
    await store.setJSON(jobId, { status: "processing", startedAt: Date.now() });
    console.log(`Job ${jobId}: heartbeat written`);

    // Prepare images
    const preparedImages = await Promise.all(
      imageDataArray.map(img => prepareImage(img.base64, img.mimeType || detectMime(img.base64)))
    );

    // Run Haiku spatial read with tier logic applied
    const spatialData = await runSpatialRead({
      imageDataArray: preparedImages,
      claudeKey
    });

    console.log(`Job ${jobId}: spatial read complete, ${spatialData.zones?.length || 0} zones`);

    // Store result via SDK — no presigned URL expiry issues
    await store.setJSON(jobId, { status: "done", spatialData });
    console.log(`Job ${jobId}: stored in Blobs`);

  } catch (err) {
    console.error(`Job ${jobId} error:`, err.message);
    console.error("Stack trace:", err.stack);
    try {
      const store = getStore({ name: "spatial-jobs", siteID, token });
      await store.setJSON(jobId, { status: "error", error: err.message });
    } catch(e) {}
  }
};
