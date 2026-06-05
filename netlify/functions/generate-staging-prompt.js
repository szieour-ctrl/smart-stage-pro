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

// ── MIME TYPE DETECTOR — prevents Claude image/jpeg vs image/png mismatch ───────
function detectMime(base64) {
  try {
    const buf = Buffer.from(base64.slice(0, 16), 'base64');
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
    if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
    if (buf[0] === 0x52 && buf[1] === 0x49) return 'image/webp';
  } catch(e) {}
  return 'image/jpeg';
}

// ── STYLE LABEL MAP ──────────────────────────────────────────────────────────
const STYLE_LABELS = {
  'organicmodern':'Organic Modern','transitional':'Transitional','contemporary':'Contemporary',
  'modern':'Modern','scandinavian':'Scandinavian','minimalist':'Minimalist',
  'coastal':'Coastal','farmhouse':'Farmhouse','midcenturymodern':'Mid-Century Modern',
  'industrial':'Industrial','bohemian':'Bohemian','traditional':'Traditional',
  'japandi':'Japandi','warmminimalist':'Warm Minimalist','luxemodern':'Luxe Modern',
  'artdeco':'Art Deco','mediterranean':'Mediterranean','rustic':'Rustic',
  'grandmillennial':'Grand Millennial','wabi_sabi':'Wabi Sabi',
};

// ── PALETTE COLOR TONE MAP ────────────────────────────────────────────────────
// Maps palette label → accent color description for style injection sentence
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

// ── AB 723 COMPLIANCE HEADER ──────────────────────────────────────────────────
// Prepended to every prompt sent to Haiku and GPT
const AB723_HEADER = `You are an MLS virtual staging assistant operating under California AB 723 §10140.6.

PRIMARY ROLE: Stage furniture and decor ONLY.

IMMUTABLE LOCK: Never alter, move, remove, replace, or touch: structural walls | ceilings | kitchen/bathroom cabinets | countertops | lighting fixtures. These must be preserved exactly as photographed.

AB 723 COMPLIANCE: Virtual staging adds furniture only. Any alteration to permanent architecture makes the listing non-compliant and subject to MLS removal.

═══════════════════════════════════════════════════════════════════════════════

`;

// ── OPEN PLAN PROMPT BUILDER ──────────────────────────────────────────────────
// Architecture: Claude Haiku reads photo → returns PRESERVE list + fixture names only
// JS assembles the final deterministic prompt from Sam's proven formula
// Anchor hierarchy: Walls → Ceiling Fixtures (chandelier/fan) → Fireplace Wall → Island
// islandType: "floating" | "peninsula" → stools eligible. "base" | "none" → no stools.
// islandFixture: "sink" | "cooktop" | "range" | "none" → drives stool anchor language.
function buildOpenPlanPrompt({ preserveList, chandelier, ceilingFan, designStyle, colorPalette, designDNA, openPlanStrategy, openPlanZones, visibleZones, islandType, islandFixture, stoolCount }) {

  // Strategy A — pure native Decor8, no custom prompt
  if (openPlanStrategy === 'native') return null;

  // Zone presence — Haiku visibleZones is the authority, label is the fallback
  const labelLower = (openPlanZones || '').toLowerCase();
  const zones = visibleZones || [];

  // visibleZones from Haiku is the authority — only stage zones confirmed visible in this image
  // Fall back to label ONLY if Haiku returned no zones at all (empty array)
  const hasKitchen = zones.length > 0 ? zones.includes('kitchen') : labelLower.includes('kitchen');
  const hasDining  = zones.length > 0 ? zones.includes('dining')  : true;
  const hasLiving  = zones.length > 0 ? zones.includes('living')  : (labelLower.includes('great room') || labelLower.includes('living'));
  const hasFlexRoom = zones.includes('flex_room') || zones.includes('flex') || labelLower.includes('flex');
  const hasIsland  = zones.includes('kitchen') || labelLower.includes('kitchen');

  // Resolve style and palette
  const rawStyle = designDNA?.overallStyle || designStyle || 'Organic Modern';
  const style = STYLE_LABELS[rawStyle?.toLowerCase().replace(/[^a-z]/g,'')] || rawStyle;
  const palette = colorPalette || 'warm neutrals';
  const paletteTones = PALETTE_TONES[palette] || `${palette} tones`;

  // Ceiling fixture anchors from Haiku
  const diningAnchor  = chandelier || 'the chandelier';
  const livingAnchor2 = ceilingFan || 'the ceiling fan';

  // Island naming — floating shows full perimeter, peninsula is wall-attached on one side
  const islandSeatable = islandType === 'floating' || islandType === 'peninsula';
  const islandNeverMove = islandType === 'floating' ? 'FLOATING kitchen island base cabinet'
    : islandType === 'peninsula' ? 'peninsula base cabinet'
    : islandType === 'base' ? 'kitchen base cabinet'
    : null;

  // Zone description for opening line
  const zoneDesc = [hasLiving && 'living', hasDining && 'dining', hasKitchen && 'kitchen']
    .filter(Boolean).join(', ');
  const islandDesc = islandNeverMove || (hasKitchen ? 'FLOATING kitchen Island Cabinet' : null);
  const circulationDesc = [hasLiving && 'living', hasDining && 'dining', islandDesc]
    .filter(Boolean).join(', and ');

  // Sofa line
  const sofaLine = openPlanStrategy === 'full'
    ? `Place a proportional sofa grouping, accent chairs, coffee table, and layered decor on the rug.`
    : `Place a proportional sofa grouping with accent chairs and a coffee table on the rug.`;

  // Stool anchor — fires only for floating or peninsula
  // Mat (flat floor object) paired with fixture — signals work zone, displaces throws/towels
  // Counter props (bowl + plant) occupy surface — displace soft goods like towels
  // Stool count driven by Haiku island length estimate at 1 per 24", max 5
  const pendantAnchor = (chandelier && chandelier !== 'the chandelier')
    ? `directly below the ${chandelier}`
    : `on the long side of the ${islandNeverMove}`;

  const resolvedStoolCount = (stoolCount && stoolCount > 0) ? stoolCount : 4;

  const matLine = (islandFixture && islandFixture !== 'none')
    ? `Place a 24" x 36" woven kitchen mat laid flat on the floor in front of the ${islandFixture}. `
    : '';

  const stoolAnchor = !islandSeatable ? null
    : `${matLine}Place a bowl of fruit and a small plant on the island countertop. Add ${resolvedStoolCount} ${style} counter stools positioned at the countertop overhang on the long side ${pendantAnchor}. Coordinated upholstery with metallic accent legs. Keep kitchen styling light and minimal. Do not remove, relocate, resize, or alter the ${islandNeverMove}.`;

  // NEVER MOVE list — include island naming only if island present
  const neverMoveIsland = islandNeverMove ? `, ${islandNeverMove}` : '';

  // ✅ LOCATION 2: Prepend AB 723 header
  let prompt = AB723_HEADER;
  
  prompt += `PRESERVE EXACTLY: ${preserveList} NEVER MOVE, DELETE or REPLACE the following: Walls, Windows${neverMoveIsland}, Ceiling Fans, Chandeliers, Pendant Lighting, Fireplaces, Dishwashers, Refrigerators, Ranges or Cooktops. Large multi-pane sliding glass patio door — DO NOT replace with any other door type, DO NOT cover with furniture or art, DO NOT convert to a solid wall or French door. The exterior view through this door must remain visible.

Stage this open-concept ${zoneDesc} space in ${style} design style using a ${palette} palette.

Stage with a high-end, airy look with balanced zone separation, intentional negative space, and open circulation throughout the connected ${circulationDesc}.

${hasDining ? `Dining Zone:
Place a large oval area rug centered directly beneath ${diningAnchor}. Place a modern dining table with 6 chairs centered on the rug defining the dining zone. Keep clear circulation between the dining area and ${islandDesc || 'adjacent spaces'}.` : ''}

${hasLiving ? `Living Zone:
Place a large rectangular area rug centered beneath ${livingAnchor2} with the rug anchored to the fireplace as the primary focal wall. ${sofaLine} Place two sculptural accent chairs flanking the fireplace, angled inward toward the conversation area, approximately 3 feet from the fireplace on each side. Place a coffee table centered on the rug between the sofa and fireplace. If a pass-through or architectural opening is visible on any wall, treat it as a wall segment only — stage the floor area adjacent to the opening at full density with a floor lamp, console table, or accent chair. Do not leave the area beside any architectural opening empty.` : ''}

${hasFlexRoom ? `Flex Room (Multi-purpose Zone):
Place a secondary seating arrangement, game table, home office nook, or accent furniture in this transitional zone. Use this space to accommodate family gathering, casual dining overflow, reading nook, or activity center. Coordinate furniture style and colors with kitchen and living zones. Stage at full floor density proportional to the zone's square footage.` : ''}

${stoolAnchor ? `Kitchen Island:
${stoolAnchor}` : (hasKitchen || hasIsland) ? `Kitchen Island:
Add one minimal prop only on the island countertop — a small plant or single vase. No stools of any kind. Do not remove, relocate, resize, or alter the kitchen island. Preserve the kitchen island, dishwasher, and all appliances exactly as shown.` : ''}

Use ${style} furniture with clean architectural lines, refined materials, soft layered textures, metallic accents, and balanced upscale styling. Incorporate ${paletteTones} throughout pillows, rugs, artwork, and decor accents while maintaining a cohesive neutral foundation. Maintain open circulation, visual openness, and realistic furniture scale throughout the space. Preserve all architectural features, room dimensions, lighting placement, flooring layout, and camera perspective exactly as photographed.`;

  return prompt;
}

// ── CLAUDE HAIKU — PRESERVE LIST + FIXTURE SCAN ONLY ─────────────────────────
// Claude's ONLY job: read the photo and return the PRESERVE list + fixture names.
// Zone anchors, rug shapes, zone order — ALL hardcoded in buildOpenPlanPrompt.
async function extractOpenPlanMetadata({ imageBase64, mimeType, claudeKey }) {
  const prompt = `You are scanning a real estate listing photo to extract preservation data for MLS virtual staging.
Return ONLY valid JSON — no markdown, no explanation, no preamble.

Scan this photo carefully and return:

{
  "preserveList": "Comprehensive comma-separated list of every permanent architectural element visible. Be specific: cabinetry color and door style, countertop material and color, flooring material and color, ALL ceiling fixtures with finish (chandelier, ceiling fan, pendants), windows and door types with frame color, appliances with finish, island base color and countertop, backsplash, all entry doors and trim. If kitchen island is visible end with: DO NOT remove or relocate the kitchen island.",
  "chandelier": "Identify the dining zone chandelier — a decorative ceiling fixture hanging over open floor space where a dining table would go. A linear chandelier has multiple lights on a horizontal bar. Describe finish and style ONLY — no location words. If none visible write 'the chandelier'.",
  "ceilingFan": "Describe the ceiling fan — finish and style ONLY — no location words. If none visible write 'the ceiling fan'.",
  "visibleZones": "Array of zones you can actually identify in this photo based on these identifiers — include ONLY zones you can confirm: kitchen = wall cabinets with appliances OR floating island base cabinet OR range hood OR backsplash; dining = open floor space for a dining table OR hanging chandelier/pendant over open floor; living = sofa-sized open floor space OR fireplace OR ceiling fan in living area OR sliding glass patio door OR French door to exterior OR large window wall with view. Return as array e.g. ['kitchen', 'dining', 'living'] or ['kitchen', 'dining'] or ['dining', 'living'].",
  "islandType": "Classify the kitchen island or counter seating structure. floating = island with all four countertop edges fully visible, not attached to any wall or cabinet run. peninsula = counter seating structure attached to a wall or cabinet run on one side, with three edges visible. base = wall-attached cabinets with no seating overhang. none = no island or peninsula visible. Return exactly one of: 'floating' | 'peninsula' | 'base' | 'none'.",
  "islandFixture": "The work surface where stools sit (if island is floating or peninsula). Return exactly one: 'sink' | 'cooktop' | 'range' | 'none'.",
  "islandCountertopLength": "Estimated length of seating overhang in inches (for stool count, use 1 stool per 24 inches). Return a number e.g. 72, or null if not applicable.",
  "stoolCountEstimate": "Estimate the number of stools that fit (length / 24 inches, max 5). Return a number or null."
}

IMPORTANT: "visibleZones" is the authority for zone identification. Label hints are secondary.`;

  const payload = JSON.stringify({
    model: "claude-haiku-4-5",
    max_tokens: 1000,
    messages: [{
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: mimeType || "image/jpeg", data: imageBase64 }
        },
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
    console.error("Claude extraction error:", JSON.stringify(result.body).slice(0, 300));
    return { preserveList: "", chandelier: "the chandelier", ceilingFan: "the ceiling fan", visibleZones: ["kitchen","dining","living"], islandType: "floating", islandFixture: "none", islandCountertopLength: 96, stoolCountEstimate: 4 };
  }

  const raw = result.body?.content?.[0]?.text?.trim();
  if (!raw) return { preserveList: "", chandelier: "the chandelier", ceilingFan: "the ceiling fan", visibleZones: ["kitchen","dining","living"], islandType: "floating", islandFixture: "none", islandCountertopLength: 96, stoolCountEstimate: 4 };

  const clean = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();

  try {
    return JSON.parse(clean);
  } catch(e) {
    console.error("Metadata parse error:", clean.slice(0, 200));
    return { preserveList: "", chandelier: "the chandelier", ceilingFan: "the ceiling fan", visibleZones: ["kitchen","dining","living"], islandType: "floating", islandFixture: "none", islandCountertopLength: 96, stoolCountEstimate: 4 };
  }
}

// ── DNA-DERIVED PROMPT BUILDER (Single Room from Staged Open Plan) ──────────────
async function buildDNADerivedPrompt({ anchorImageUrl, vacantImageBase64, mimeType, derivedZone, roomName, designStyle, colorPalette, stagingDNA, claudeKey }) {

  const rawStyle = stagingDNA?.overallStyle || designStyle || 'Organic Modern';
  const style = STYLE_LABELS[rawStyle?.toLowerCase().replace(/[^a-z]/g,'')] || rawStyle;
  const palette = colorPalette || 'warm neutrals';
  const paletteTones = PALETTE_TONES[palette] || `${palette} tones`;

  const zoneLabel = derivedZone === 'living' ? 'Living Zone'
    : derivedZone === 'dining' ? 'Dining Zone'
    : 'Kitchen';

  // ✅ LOCATION 3: Prepend AB 723 header to systemPrompt
  const systemPrompt = `${AB723_HEADER}You are an expert MLS virtual staging consultant. You will receive two images:
IMAGE 1: A staged open plan living space — the anchor staging for this home.
IMAGE 2: A vacant single room from the same home.

Your job is to build a Decor8 virtual staging prompt that recreates the ${zoneLabel} inventory from Image 1 into the vacant room in Image 2, using the same anchor logic.

MLS PRESERVE LAW: The prompt must open with PRESERVE EXACTLY listing every permanent element from Image 2. Never alter architecture.`;

  const userPrompt = derivedZone === 'living' ? `
IMAGE 1 — Staged Open Plan (anchor):
Read the LIVING ZONE in this image and inventory every piece Decor8 placed:
- Primary sofa(s): count, fabric, color, profile
- Accent chairs: style, fabric, color, position
- Coffee table: material, shape, size
- Side tables: material, style
- Lamps: style, shade style
- Art above mantel: style, size, description
- Rug: shape, pattern, color, approximate size
- Pillows/throws: colors, textures
- Plants/accessories: type, placement

IMAGE 2 — Vacant Living Room:
Scan and identify:
- PRESERVE list: every permanent element with exact colors/materials
- Ceiling fan: finish and description
- Fireplace: surround color, firebox description
- Window wall: location and description
- Any other architectural anchors

BUILD THE DECOR8 PROMPT using this exact structure:

PRESERVE EXACTLY: [comprehensive list from Image 2 scan]

Stage this living room in ${style} style using a ${palette} palette.

Place a large rectangular [rug color/pattern from Image 1] area rug in front of the fireplace wall centered beneath [ceiling fan from Image 2].

[Primary sofa description from Image 1]: Place [count] [sofa description] centered on the rug.

[If secondary sofa]: Place one matching sofa [position] creating a conversation group.

[Coffee table from Image 1]: Place [description] centered on the rug between sofa and fireplace.

[Side tables + lamps from Image 1]: Place [description] flanking the sofa.

[Art from Image 1]: Mount [description] centered above the fireplace mantel.

[Accessories from Image 1]: [pillows, throws, plants, vase — exact descriptions].

Use ${style} furniture with clean architectural lines, refined materials, soft layered textures, and balanced upscale styling. Incorporate ${paletteTones} throughout pillows, rugs, artwork, and decor accents. Maintain open circulation and realistic furniture scale. Preserve all architectural features, room dimensions, lighting placement, flooring layout, and camera perspective exactly as photographed.

Return ONLY the final prompt text — no explanation, no preamble.`

  : derivedZone === 'dining' ? `
IMAGE 1 — Staged Open Plan (anchor):
Read the DINING ZONE in this image and inventory every piece Decor8 placed:
- Dining table: material, shape, size, finish
- Dining chairs: count, style, fabric, color
- Rug: shape, pattern, color, approximate size
- Centerpiece: description

IMAGE 2 — Vacant Dining Room:
Scan and identify:
- PRESERVE list: every permanent element with exact colors/materials
- Ceiling fixture: chandelier/pendant description
- Wall anchors: color, texture

BUILD THE DECOR8 PROMPT using this exact structure:

PRESERVE EXACTLY: [comprehensive list from Image 2 scan]

Stage this dining room in ${style} style using a ${palette} palette.

Place a large [rug shape from Image 1] area rug centered directly beneath [ceiling fixture from Image 2].

Place a [table material/shape/finish from Image 1] dining table centered on the rug.

Place [chair count] [chair style/color from Image 1] dining chairs around the table.

[Centerpiece from Image 1]: Place [description] on the table.

Use ${style} furniture with clean architectural lines, refined materials, and upscale styling. Incorporate ${paletteTones} throughout. Preserve all architectural features, room dimensions, lighting placement, flooring layout, and camera perspective exactly as photographed.

Return ONLY the final prompt text — no explanation, no preamble.`

  : `
IMAGE 1 — Staged Open Plan (anchor):
Read the KITCHEN ZONE in this image and inventory every piece Decor8 placed:
- Island stools: count, material, color
- Counter props: fruit bowl, plant, vase
- Backsplash/cabinetry appearance
- Any decor/lighting added

IMAGE 2 — Vacant Kitchen:
Scan and identify:
- PRESERVE list: every permanent element with exact colors/materials
- Island/counter anchor
- Ceiling fixtures: pendant lights description
- Appliances and cabinetry: exact condition

BUILD THE DECOR8 PROMPT using this exact structure:

PRESERVE EXACTLY: [comprehensive list from Image 2 scan]

Stage this kitchen in ${style} style using a ${palette} palette.

Place [stool count from Image 1] [stool style/material from Image 1] counter stools positioned at the island countertop overhang.

Place a [fruit bowl/plant description from Image 1] on the island countertop.

Use ${style} materials and styling. Keep surfaces minimal and clean. Incorporate ${paletteTones} in decor accents. Do not remove, relocate, or alter the kitchen island or cabinets. Preserve all architectural features, room dimensions, lighting placement, flooring layout, and camera perspective exactly as photographed.

Return ONLY the final prompt text — no explanation, no preamble.`;

  const payload = JSON.stringify({
    model: "claude-haiku-4-5",
    max_tokens: 1200,
    system: systemPrompt,
    messages: [{
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: anchorImageUrl.includes('data:') ? anchorImageUrl.split(',')[1] : anchorImageUrl }
        },
        { type: "text", text: "IMAGE 1" },
        {
          type: "image",
          source: { type: "base64", media_type: mimeType || "image/jpeg", data: vacantImageBase64 }
        },
        { type: "text", text: "IMAGE 2" },
        { type: "text", text: userPrompt }
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
    console.error("buildDNADerivedPrompt error:", JSON.stringify(result.body).slice(0, 300));
    return "ERROR: Could not build prompt";
  }

  return result.body?.content?.[0]?.text?.trim() || "ERROR: No response from Claude";
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const { mode, imageBase64, mimeType, roomName, designStyle, colorPalette, designDNA, openPlanStrategy, openPlanZones, visibleZones, claudeKey, anchorImageUrl, derivedZone, stagingDNA } = JSON.parse(event.body);

    if (mode === 'extract-open-plan') {
      const metadata = await extractOpenPlanMetadata({ imageBase64, mimeType, claudeKey });
      const stagingPrompt = buildOpenPlanPrompt({
        preserveList: metadata.preserveList,
        chandelier: metadata.chandelier,
        ceilingFan: metadata.ceilingFan,
        designStyle,
        colorPalette,
        designDNA,
        openPlanStrategy,
        openPlanZones,
        visibleZones: metadata.visibleZones,
        islandType: metadata.islandType,
        islandFixture: metadata.islandFixture,
        stoolCount: metadata.stoolCountEstimate
      });
      console.log("Extract mode: metadata acquired, prompt built");
      return { statusCode: 200, headers, body: JSON.stringify({ metadata, stagingPrompt }) };
    }

    if (mode === 'build-dna-derived') {
      const derivedPrompt = await buildDNADerivedPrompt({
        anchorImageUrl, vacantImageBase64, mimeType, derivedZone, roomName, designStyle, colorPalette, stagingDNA, claudeKey
      });
      return { statusCode: 200, headers, body: JSON.stringify({ stagingPrompt: derivedPrompt }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown mode" }) };

  } catch (err) {
    console.error("generate-staging-prompt error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
