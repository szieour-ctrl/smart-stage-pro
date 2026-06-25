// group-spatial-read-background__PHASE5A_INTEGRATED__.js
// PHASE 5A: Integrated Tier 1/2 anchor logic
// Runs Haiku spatial read → applies tier logic → assembles GPT2 prompt

const https = require("https");
const sharp = require("sharp");
const { getStore } = require("@netlify/blobs");

// ── PHASE 5A IMPORTS ───────────────────────────────────────────────────────
const { applyTierLogic, buildVacantPrompt } = require('./buildVacantPrompt__PHASE5A__');
const { assembleGPT2StagingPrompt } = require('./assembleGPT2StagingPrompt');

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

// ── PHASE 5A: HAIKU SPATIAL READ — CLEAN 6-FIELD FACTS ONLY ───────────────
async function runSpatialRead({ images, groupType, claudeKey }) {
  const imageBlocks = images.map((img, i) => ([
    { type: "image", source: { type: "base64", media_type: detectMime(img.base64), data: img.base64 } },
    { type: "text", text: "IMAGE " + (i + 1) + (img.label ? " — " + img.label : " — Angle " + (i + 1)) }
  ])).flat();

  const prompt = `You are Claude Vision: an Architectural Planner reading a real estate listing photo.

YOUR ROLE: Read the image spatially and LIST architectural boundaries and anchors.
- Identify zone boundaries (walls, doors, windows, hallways, vacant space)
- Identify Tier 1 anchors (ceiling-mounted fixtures at 60%+ confidence)
- Report ONLY facts at specified confidence thresholds
- Do NOT infer, directional-ize, or assign furniture layouts

GPT Image 2 will handle staging and rendering.

---

FOR EACH ZONE, RETURN THIS JSON (FACTS ONLY):

{
  "zones": [
    {
      "zoneName": "Zone name (Kitchen | Dining/Nook | Living | Bedroom | Hallway | Other)",
      "boundaries": "ONLY what is present in or attached to this zone (70%+ confidence) OR 'None'",
      "fixtures": "ONLY visible architectural fixtures present in this zone (70%+ confidence) OR 'None'",
      "cabinetry": "ONLY what is present in or attached to this zone (70%+ confidence) OR 'None'",
      "windowsDoors": "ONLY what is present in or attached to this zone (70%+ confidence) OR 'None'",
      "anchorPoint": "ONLY if Tier 1 anchor present at 60%+ confidence: [Fixture name] OR 'None'",
      "focalPoint": "ONLY what is present in this zone (70%+ confidence) OR 'None'",
      "furnishing": "[CONDITIONAL ON ANCHOR]"
    }
  ]
}

---

FURNISHING FIELD LOGIC:

IF anchorPoint = "Fireplace":
  furnishing: "Place an area rug proportional for the seating group 18\\" in front of the Fireplace anchoring the seating group to the Fireplace wall. Place a coffee table centered on the rug and Fireplace."

IF anchorPoint = "Ceiling fan":
  furnishing: "Place an area rug proportional for the seating group centered beneath the ceiling fan. Place a coffee table centered on the rug and ceiling fan."

IF anchorPoint = "Chandelier" OR "Pendant lights":
  furnishing: "Place an area rug proportional to seating group with a round or rectangular dining table and seating not to exceed 6 chairs, in the open space."

IF anchorPoint = "None" (No Tier 1 anchor, Tier 2 open space):
  furnishing: "Style & Main Pieces: [Transitional]. A round or rectangular dining table and seating not to exceed 6 chairs. Place an area rug proportional to seating group. Incorporate gentle tasteful props and decorative art throughout the zone to enhance visual depth and create a curated, market-ready aesthetic. Floor runners are prohibited."

IF zoneName = "Hallway" OR "Circulation" OR "Entry" OR "Foyer" OR "Passage":
  furnishing: "LEAVE VACANT"

---

CONFIDENCE THRESHOLDS:

- Boundaries: 70%+ confidence only
- Fixtures: 70%+ confidence only
- Cabinetry: 70%+ confidence only
- Windows/Doors: 70%+ confidence only
- Anchor Point: 60%+ confidence IF Tier 1 anchor
- Focal Point: 70%+ confidence only

---

TIER 1 ANCHORS (60%+ confidence):

- Fireplace
- Ceiling fan
- Chandelier
- Pendant lights
- Recessed lighting groups

---

CRITICAL RULES:

1. NO INFERENCE: Below threshold = 'None'
2. NO DIRECTIONAL LANGUAGE: No "left of", "adjacent to", relationships
3. NO FURNITURE ASSIGNMENTS: Facts only
4. FLOOR RUNNERS PROHIBITED

RETURN ONLY JSON — no markdown, no preamble.`;

  console.log('Sending Phase 5A spatial read prompt to Claude Haiku...');
  
  const response = await httpsRequest({
    hostname: 'api.anthropic.com',
    port: 443,
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'x-api-key': claudeKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    }
  }, JSON.stringify({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: [...imageBlocks, { type: 'text', text: prompt }]
    }]
  }));

  if (response.status !== 200) {
    throw new Error(`Haiku API error: ${response.status} ${JSON.stringify(response.body)}`);
  }

  const content = response.body.content[0];
  if (content.type !== 'text') {
    throw new Error(`Unexpected response type: ${content.type}`);
  }

  // Parse spatial read JSON
  let spatialData;
  try {
    const jsonMatch = content.text.match(/\{[\s\S]*\}/);
    spatialData = JSON.parse(jsonMatch ? jsonMatch[0] : content.text);
  } catch (e) {
    console.error('Failed to parse spatial read JSON:', content.text);
    throw new Error('Spatial read JSON parse failed: ' + e.message);
  }

  console.log('Spatial read complete. Zones identified: ' + spatialData.zones.length);
  return spatialData;
}

// ── PHASE 5A: ASSEMBLE PROMPT WITH TIER LOGIC ──────────────────────────────
async function assemblePrompt({ images, designStyle, colorPalette, claudeKey, groupType }) {
  /**
   * PHASE 5A PIPELINE:
   * 1. Run Haiku spatial read (returns clean 6-field zones)
   * 2. Apply Tier 1/2 logic (generate furnishing instructions)
   * 3. Assemble GPT2 prompt (boilerplate + zones)
   */

  console.log('Phase 5A: Starting spatial read + tier logic pipeline...');

  // Step 1: Haiku spatial read (clean 6-field zones)
  const spatialData = await runSpatialRead({ 
    images, 
    groupType: groupType || 'openplan', 
    claudeKey 
  });

  // Step 2: Apply Tier 1/2 logic (generate furnishing instructions)
  const tieredData = buildVacantPrompt(
    spatialData,
    designStyle,
    colorPalette
  );

  console.log(`Tier logic applied: ${tieredData.furnishedZones} furnished, ${tieredData.vacantZones} vacant`);

  // Step 3: Assemble complete GPT2 prompt
  const gpt2Prompt = assembleGPT2StagingPrompt(tieredData, images.length);

  console.log('GPT2 prompt assembled and ready for rendering');

  return {
    prompt: gpt2Prompt,
    spatialData: spatialData,
    tieredData: tieredData
  };
}

// Export for use by other functions
module.exports.runSpatialRead = runSpatialRead;
module.exports.assemblePrompt = assemblePrompt;
module.exports.compressForRead = compressForRead;

// ── BACKGROUND HANDLER ────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const siteID    = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
  const token     = process.env.NETLIFY_ACCESS_TOKEN;
  let jobId;

  try {
    const { 
      jobId: jId, 
      images, 
      groupType,
      designStyle,
      colorPalette
    } = JSON.parse(event.body);
    
    jobId = jId;
    console.log(`Phase 5A group read: jobId=${jobId} images=${images.length} type=${groupType}`);

    const store = getStore({ name: "staging-jobs", siteID, token });
    await store.setJSON(jobId, { status: "processing", startedAt: Date.now() });

    // Phase 5A pipeline: spatial read → tier logic → prompt assembly
    const result = await assemblePrompt({
      images,
      groupType: groupType || 'openplan',
      designStyle: designStyle || 'Transitional',
      colorPalette: colorPalette || 'Organic Natural',
      claudeKey
    });

    await store.setJSON(jobId, {
      status: "done",
      prompt: result.prompt,
      spatialData: result.spatialData,
      tieredData: result.tieredData,
      timestamp: Date.now()
    });

    console.log(`Job ${jobId}: Phase 5A pipeline complete`);

  } catch (err) {
    console.error(`Job ${jobId || 'unknown'} error:`, err.message);
    try {
      const store = getStore({ name: "staging-jobs", siteID, token });
      await store.setJSON(jobId, { status: "error", error: err.message });
    } catch(e) {}
  }
};
