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

  const prompt = `You are reading real estate listing photos to identify furnishing zones.

TASK: Return ONLY factual architectural data for each zone visible. No staging instructions. No furniture recommendations. No inferences.

CONFIDENCE THRESHOLD: Report only facts at 60%+ confidence. If confidence is below 60%, answer "None".

ZONE BOUNDARIES: Zones are bounded by permanent architectural elements (walls, islands, fireplaces, windows, doors).

OUTPUT FORMAT: For each zone, return EXACTLY these 6 fields in JSON:

Zone: [Kitchen | Dining/Nook | Living Room | Bedroom | Hallway | Other]
• Boundaries: [What physically defines this zone]
• Fixtures: [What architectural fixtures are IN this zone]
• Cabinetry: [What cabinetry is IN this zone]
• Windows/Doors: [What windows/doors are IN this zone]
• Anchor Point: [Visible architectural feature that could anchor furniture] OR [Simple location description] OR None
• Focal Point: [Primary architectural feature in this zone] OR None

CRITICAL RULES:

1. DO NOT INFER: If you cannot see it clearly (60%+ confidence), say "None".
2. DO NOT MIX ZONES: Report only what is IN each zone.
3. DO NOT ADD FURNITURE INSTRUCTIONS: This is a spatial read only.
4. HALLWAYS & CIRCULATION: Mark as separate zones. Do not add furnishing instructions.

RETURN ONLY JSON — no markdown, no preamble:

{
  "zones": [
    {
      "zoneName": "Kitchen",
      "boundaries": "...",
      "fixtures": "...",
      "cabinetry": "...",
      "windowsDoors": "...",
      "anchorPoint": "...",
      "focalPoint": "..."
    }
  ]
}`;

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
