// group-spatial-read-background__PHASE5A__.js — REBUILT
// Returns CLEAN SPATIAL READ ONLY (6-field format, factual, no furnishing instructions)
// Tier 1/2 anchor logic applied separately in buildVacantPrompt()

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

// ── PHASE 5A: SPATIAL READ — CLEAN 6-FIELD FACTS ONLY ───────────────────────
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

EXAMPLES:

Zone: Kitchen
• Boundaries: Left wall; island center-left
• Fixtures: Island with cabinetry
• Cabinetry: Left wall full cabinetry; island cabinetry
• Windows/Doors: Window on left wall; door on left wall
• Anchor Point: Island
• Focal Point: Island

Zone: Dining/Nook
• Boundaries: Open floor space; no walls
• Fixtures: None
• Cabinetry: None
• Windows/Doors: None
• Anchor Point: Open space
• Focal Point: None

Zone: Living Room
• Boundaries: Back wall; right wall with glass doors
• Fixtures: Fireplace on back wall; windows on back wall
• Cabinetry: None
• Windows/Doors: Windows on back wall; large glass patio doors on right wall
• Anchor Point: Fireplace
• Focal Point: Fireplace

Zone: Hallway
• Boundaries: Right side passage
• Fixtures: None
• Cabinetry: None
• Windows/Doors: Doorway opening
• Anchor Point: None
• Focal Point: None

CRITICAL RULES:

1. DO NOT INFER: If you cannot see it clearly (60%+ confidence), say "None". Do not hallucinate details.
2. DO NOT MIX ZONES: Report only what is IN each zone. Do not include items from adjacent zones.
3. DO NOT ADD FURNITURE INSTRUCTIONS: This is a spatial read only. Furnishing is handled separately.
4. DO NOT MENTION TIERS: Do not classify as Tier 1, Tier 2, etc. Just report the facts.
5. HALLWAYS & CIRCULATION: Mark as separate zones. Do not add furnishing instructions.
6. ANCHOR POINT: This is ONLY the visible architectural feature that could guide furniture placement. Examples:
   - Island (in Kitchen)
   - Fireplace (in Living Room)
   - Ceiling fixture if clearly visible (chandelier, ceiling fan)
   - "Open space" (if no fixtures)
   - None (if uncertain)

RETURN ONLY JSON — no markdown, no preamble, no explanations:

{
  "zones": [
    {
      "zoneName": "Kitchen",
      "boundaries": "Left wall; island center-left",
      "fixtures": "Island with cabinetry",
      "cabinetry": "Left wall full cabinetry; island cabinetry",
      "windowsDoors": "Window on left wall; door on left wall",
      "anchorPoint": "Island",
      "focalPoint": "Island"
    },
    {
      "zoneName": "Dining/Nook",
      "boundaries": "Open floor space; no walls",
      "fixtures": "None",
      "cabinetry": "None",
      "windowsDoors": "None",
      "anchorPoint": "Open space",
      "focalPoint": "None"
    },
    {
      "zoneName": "Living Room",
      "boundaries": "Back wall; right wall with glass doors",
      "fixtures": "Fireplace on back wall; windows on back wall",
      "cabinetry": "None",
      "windowsDoors": "Windows on back wall; large glass patio doors on right wall",
      "anchorPoint": "Fireplace",
      "focalPoint": "Fireplace"
    },
    {
      "zoneName": "Hallway",
      "boundaries": "Right side passage",
      "fixtures": "None",
      "cabinetry": "None",
      "windowsDoors": "Doorway opening",
      "anchorPoint": "None",
      "focalPoint": "None"
    }
  ]
}`;

  console.log('Sending spatial read prompt to Claude Haiku...');
  
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

// Export for use by other functions
module.exports.runSpatialRead = runSpatialRead;
module.exports.compressForRead = compressForRead;

// ── BACKGROUND HANDLER ────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const siteID    = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
  const token     = process.env.NETLIFY_ACCESS_TOKEN;
  let jobId;

  try {
    const { jobId: jId, images, groupType } = JSON.parse(event.body);
    jobId = jId;
    console.log('Phase 5A spatial read: jobId=' + jobId + ' images=' + images.length);

    const store = getStore({ name: "staging-jobs", siteID, token });
    await store.setJSON(jobId, { status: "processing", startedAt: Date.now() });

    const spatialData = await runSpatialRead({ images, groupType: groupType || 'openplan', claudeKey });

    await store.setJSON(jobId, {
      status: "done",
      spatialData,
      anglesRead: images.length,
      timestamp: Date.now()
    });

    console.log('Job ' + jobId + ': spatial read stored');

  } catch (err) {
    console.error('Job ' + (jobId || 'unknown') + ' error:', err.message);
    try {
      const store = getStore({ name: "staging-jobs", siteID, token });
      await store.setJSON(jobId, { status: "error", error: err.message });
    } catch(e) {}
  }
};
