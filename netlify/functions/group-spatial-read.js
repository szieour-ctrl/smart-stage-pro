const https = require("https");

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

// ── MIME TYPE DETECTOR ───────────────────────────────────────────────────────
function detectMime(base64) {
  try {
    const buf = Buffer.from(base64.slice(0, 16), 'base64');
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
    if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
    if (buf[0] === 0x52 && buf[1] === 0x49) return 'image/webp';
  } catch(e) {}
  return 'image/jpeg';
}

// ── PHASE 1: HAIKU MULTI-IMAGE SPATIAL READ ──────────────────────────────────
// Sends all images in one call. Haiku builds unified spatial inventory:
// PRESERVE union, conflict detection, furnitureBoundaryAnchors per image,
// fixture details confirmed across angles.
async function runSpatialPreRead({ images, groupType, claudeKey }) {
  const imageBlocks = images.map((img, i) => ([
    {
      type: "image",
      source: { type: "base64", media_type: detectMime(img.base64), data: img.base64 }
    },
    {
      type: "text",
      text: `IMAGE ${i + 1} — ${img.label || img.fileName || ('Angle ' + (i+1))}`
    }
  ])).flat();

  const prompt = `You are analyzing ${images.length} photos of the same ${groupType === 'bedroom' ? 'bedroom' : 'open plan living space'} from different camera angles.
All images show the same physical space. Your job is to build a unified spatial inventory for MLS virtual staging.

CRITICAL RULE: Every instruction you write must reference something GPT Image 2 can SEE in each specific image — visible landmarks only. No abstract spatial concepts.

Return ONLY valid JSON — no markdown, no preamble.

{
  "groupType": "${groupType}",
  "anglesRead": ${images.length},

  "masterPreserve": "Comprehensive comma-separated PRESERVE list combining ALL visible permanent elements across all angles. Include: all cabinetry color+style, countertops, flooring, ALL ceiling fixtures with finish (chandeliers, fans, pendants), ALL window types with exact description, ALL door types, fireplace surround description, island base color+countertop, backsplash, appliances. Where the same element is seen from multiple angles use the most detailed description. End with: DO NOT alter any permanent architectural element.",

  "conflictsDetected": [
    {
      "element": "name of conflicted element",
      "conflict": "what was ambiguous or contradictory across angles",
      "resolution": "the correct interpretation after seeing all angles"
    }
  ],

  "masterFurniturePlan": {
    "style": "One phrase design style",
    "livingZone": {
      "sofa": "fabric, color, profile — or null",
      "accentChairs": "style, fabric, count — or null",
      "coffeeTable": "material, shape — or null",
      "rug": "shape, material, approximate size",
      "console": "placement and description — or null",
      "plant": "one plant description and placement — or null",
      "art": "one art piece description for above fireplace — or null",
      "floorLamp": "description — or null"
    },
    "diningZone": {
      "table": "material, shape, size",
      "chairs": "count, style, fabric",
      "rug": "shape, material"
    },
    "kitchenZone": {
      "stools": "count, style, frame",
      "props": "one bowl/plant description only"
    }
  },

  "perImageAnchors": [
    ${images.map((img, i) => `{
      "imageIndex": ${i},
      "imageLabel": "${img.label || img.fileName || ('Angle ' + (i+1))}",
      "cameraPosition": "brief description of camera angle/position",
      "primaryAnchor": "the single most prominent visible architectural element that orients this image — e.g. 'fireplace centered on back wall', 'island centered foreground', 'chandelier centered overhead'",
      "furnitureBoundaryAnchors": {
        "rugCenter": "Center rug under [specific visible ceiling fixture]",
        "rugDepth": "Rug front edge at [specific visible landmark] — do not extend beyond [specific visible boundary landmark]",
        "leftBoundary": "Left furniture boundary: [specific visible wall or element]",
        "rightBoundary": "Right furniture boundary: [specific visible wall or element]",
        "sofaPlacement": "Sofa [back toward camera / facing camera / left wall] facing [fireplace / focal wall]",
        "additionalNote": "Any critical placement note specific to this angle using only visible landmarks — or null"
      },
      "imageSpecificProhibitions": [
        "DO NOT [specific prohibition based on what IS visible in this image and was confirmed by cross-angle read]"
      ],
      "visibleZones": ["list of zones clearly visible in this specific image: kitchen, dining, living"]
    }`).join(',\n    ')}
  ],

  "globalProhibitions": [
    "Prohibition applying to ALL images in this group based on cross-angle findings"
  ]
}`;

  const payload = JSON.stringify({
    model: "claude-haiku-4-5",
    max_tokens: 4000,
    messages: [{
      role: "user",
      content: [
        ...imageBlocks,
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

  if (result.status !== 200) {
    console.error("Haiku spatial pre-read error:", JSON.stringify(result.body).slice(0, 300));
    throw new Error("Haiku spatial pre-read failed: " + (result.body?.error?.message || result.status));
  }

  const text = result.body?.content?.[0]?.text?.trim() || "{}";
  const clean = text.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch(e) {
    // Attempt to repair truncated JSON — close any open arrays/objects
    console.warn("Spatial pre-read JSON truncated — attempting repair. Length:", clean.length);
    try {
      let repaired = clean;
      // Remove trailing partial key-value or comma
      repaired = repaired.replace(/,\s*$/, '').replace(/"[^"]*$/, '').replace(/:\s*$/, '');
      // Count unclosed braces and brackets
      let braces = 0, brackets = 0;
      for (const ch of repaired) {
        if (ch === '{') braces++;
        else if (ch === '}') braces--;
        else if (ch === '[') brackets++;
        else if (ch === ']') brackets--;
      }
      // Close in reverse order
      while (brackets > 0) { repaired += ']'; brackets--; }
      while (braces > 0) { repaired += '}'; braces--; }
      const parsed = JSON.parse(repaired);
      console.warn("Spatial pre-read JSON repaired successfully");
      return parsed;
    } catch(e2) {
      console.error("Spatial pre-read JSON parse failed after repair attempt:", clean.slice(0, 400));
      throw new Error("Spatial pre-read returned invalid JSON — try reducing image count or check max_tokens");
    }
  }
}

// ── PHASE 2: ASSEMBLE PLAIN TEXT PROMPT PER IMAGE ────────────────────────────
// Takes master plan + per-image anchors → builds the GPT Image 2 prompt string
// This is exactly what the user reads, edits, and approves in the Review modal.
function assemblePlainTextPrompt({ spatialPlan, imageIndex, designStyle, colorPalette }) {
  const rawStyle = designStyle || 'Organic Modern';
  const style = STYLE_LABELS[rawStyle?.toLowerCase().replace(/[^a-z]/g,'')] || rawStyle;
  const palette = colorPalette || 'Warm Neutrals';
  const paletteTones = PALETTE_TONES[palette] || `${palette} tones`;

  const plan = spatialPlan.masterFurniturePlan || {};
  const living = plan.livingZone || {};
  const dining = plan.diningZone || {};
  const kitchen = plan.kitchenZone || {};

  const imgAnchor = spatialPlan.perImageAnchors?.[imageIndex] || {};
  const bounds = imgAnchor.furnitureBoundaryAnchors || {};
  const visibleZones = imgAnchor.visibleZones || ['living', 'dining', 'kitchen'];
  const prohibitions = [
    ...(imgAnchor.imageSpecificProhibitions || []),
    ...(spatialPlan.globalProhibitions || [])
  ];

  const hasLiving = visibleZones.includes('living');
  const hasDining = visibleZones.includes('dining');
  const hasKitchen = visibleZones.includes('kitchen');

  let prompt = `PRESERVE EXACTLY: ${spatialPlan.masterPreserve}\n\n`;

  prompt += `Stage with furniture and decor only. Do not alter any permanent architectural element. `;
  prompt += `Stage this space in ${style} design style using a ${palette} palette with ${paletteTones} throughout.\n\n`;

  if (hasLiving) {
    prompt += `Living Zone:\n`;
    if (bounds.rugCenter) prompt += `${bounds.rugCenter}. `;
    if (bounds.rugDepth) prompt += `${bounds.rugDepth}. `;
    prompt += `\n`;
    if (bounds.sofaPlacement) prompt += `${bounds.sofaPlacement}. `;
    if (living.sofa) prompt += `Place a ${living.sofa} sofa. `;
    if (living.accentChairs) prompt += `Place ${living.accentChairs} accent chairs flanking the coffee table. `;
    if (living.coffeeTable) prompt += `Place a ${living.coffeeTable} coffee table centered on the rug between sofa and fireplace. `;
    if (living.console) prompt += `${living.console}. `;
    if (living.floorLamp) prompt += `${living.floorLamp}. `;
    if (living.art) prompt += `${living.art} centered above the fireplace mantel. `;
    if (living.plant) prompt += `${living.plant}. `;
    if (bounds.leftBoundary) prompt += `\n${bounds.leftBoundary}. `;
    if (bounds.rightBoundary) prompt += `${bounds.rightBoundary}. `;
    if (bounds.additionalNote) prompt += `${bounds.additionalNote}. `;
    prompt += `\n\n`;
  }

  if (hasDining) {
    prompt += `Dining Zone:\n`;
    prompt += `Place a large ${dining.rug || 'round jute'} area rug centered beneath the chandelier. `;
    if (dining.table) prompt += `Place a ${dining.table} dining table centered on the rug. `;
    if (dining.chairs) prompt += `Place ${dining.chairs} dining chairs around the table. `;
    prompt += `\n\n`;
  }

  if (hasKitchen) {
    prompt += `Kitchen Island:\n`;
    prompt += `DO NOT remove, relocate, resize, or alter the FLOATING kitchen island base cabinet. `;
    if (kitchen.stools) prompt += `Place ${kitchen.stools} counter stools on the dining-zone-facing side of the island only — NOT the camera-facing side. `;
    if (kitchen.props) prompt += `${kitchen.props} on the island countertop. Keep all other surfaces minimal and clean. `;
    prompt += `\n\n`;
  }

  if (prohibitions.length) {
    prompt += prohibitions.join(' ') + `\n\n`;
  }

  prompt += `Use ${style} furniture with clean architectural lines, refined materials, soft layered textures, and metallic accents. `;
  prompt += `Maintain open circulation, realistic furniture scale, and MLS-photorealistic quality throughout. `;
  prompt += `Preserve all architectural features, room dimensions, lighting placement, flooring, and camera perspective exactly as photographed.`;

  return prompt.trim();
}

// ── HANDLER ───────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const { images, groupType, designStyle, colorPalette } = JSON.parse(event.body);
    // images: [{ base64, mimeType, label, fileName }]
    // groupType: 'openplan' | 'bedroom'

    if (!images || !Array.isArray(images) || images.length < 2) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "At least 2 images required for group spatial read" }) };
    }
    if (images.length > 5) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Maximum 5 images per group" }) };
    }

    const claudeKey = process.env.ANTHROPIC_API_KEY;
    if (!claudeKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }) };

    console.log(`Group spatial read: ${images.length} images, type=${groupType}`);

    // Phase 1: Haiku reads all images simultaneously
    const spatialPlan = await runSpatialPreRead({ images, groupType: groupType || 'openplan', claudeKey });

    console.log(`Spatial plan built: ${spatialPlan.conflictsDetected?.length || 0} conflicts detected, ${spatialPlan.perImageAnchors?.length || 0} per-image anchor sets`);

    // Phase 2: Assemble one plain text prompt per image
    const perImagePrompts = images.map((img, i) => ({
      imageIndex: i,
      imageLabel: img.label || img.fileName || `Angle ${i + 1}`,
      promptText: assemblePlainTextPrompt({ spatialPlan, imageIndex: i, designStyle, colorPalette }),
      anchors: spatialPlan.perImageAnchors?.[i] || {},
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        spatialPlan,        // full master plan — stored in SESSION for reference
        perImagePrompts,    // array of { imageIndex, imageLabel, promptText } — shown in Review modal
        conflictsResolved: spatialPlan.conflictsDetected?.length || 0,
        anglesRead: images.length,
      })
    };

  } catch (err) {
    console.error("group-spatial-read error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
