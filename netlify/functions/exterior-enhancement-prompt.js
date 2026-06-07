// exterior-enhancement-prompt.js
// Smart Stage PRO™ | Exterior Enhancement Module — Full Rebuild
// June 7, 2026 | SZ Real Estate Group | DRE #01397303
//
// ROLE: Prompt BUILDER only. Haiku reads exterior → assembleExteriorPrompt() → returns { prompt, spatialRead }.
// Frontend compresses image BEFORE calling this function (1024px max via canvas).
// Frontend then calls stage-openai.js with the returned prompt.
// DO NOT modify stage-openai.js or stage-openai-background.js.

const https = require("https");

// Native HTTPS helper — matches the pattern used by all other functions in this project
function callClaudeHaiku(apiKey, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const options = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(data)
      }
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error("Anthropic response parse error: " + body.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ─────────────────────────────────────────────
// AB 723 HEADER — ALWAYS FIRST. NEVER REMOVE.
// California Civil Code §10140.6
// ─────────────────────────────────────────────
const AB723_HEADER = `PRIMARY ROLE: You are a professional real estate exterior photo enhancement AI.
IMMUTABLE LOCK: You must NEVER remove, alter, add, or reposition any permanent architectural structure. This includes the roofline, exterior walls, windows, doors, garage doors, chimneys, hardscape (existing driveway, existing walkway, existing patio or deck surface), permanent fencing, retaining walls, or any other structural or built element.
AB 723 COMPLIANCE (California Civil Code §10140.6): This image will be disclosed as virtually enhanced per CA AB 723 §10140.6. All enhancements must be realistic and achievable for this actual property. Do not create impossible or non-existent features. Do not alter the structure of the home in any way.`;

// ─────────────────────────────────────────────
// LIGHTING OPTIONS
// ─────────────────────────────────────────────
const LIGHTING_PROMPTS = {
  "golden-hour":
    `LIGHTING — Golden Hour: Replace the current sky and lighting with golden hour conditions. Apply warm, raking sunlight from a low angle on the horizon (30–35 degrees above). Cast long, soft shadows from trees and architectural features across the lawn and driveway. The sky transitions from warm amber and peach near the horizon to a clear light blue overhead. Color temperature of the scene: 3200K–4000K (warm and inviting). Any visible windows may show a soft, warm incandescent interior glow. The facade takes on a golden wash that flatters the architecture.`,

  "sunset-glow":
    `LIGHTING — Sunset Glow: Apply a soft, natural sunset ambiance. The sky transitions from warm coral and soft peach near the horizon to a muted dusty blue overhead. Lighting is diffused and soft-directional with minimal harsh shadows — this is a relaxed, cinematic evening feel, not dramatic. The facade receives a gentle warm wash (4000K–4500K). No heavy saturation. Interior windows show a subtle warm glow. The overall mood is peaceful and welcoming.`,

  "twilight":
    `LIGHTING — Twilight (MLS Favorite): Transform the image to professional MLS twilight conditions. The sky is a rich deep cobalt blue at the top, fading to violet and indigo near the horizon — the classic blue-hour look. CRITICAL: ALL visible interior windows must be ON with a warm amber glow (2700K–3000K simulated incandescent/LED interior lights). The exterior is lit by cool blue ambient light balanced against the warm window glow. Where plausible for the architecture, add subtle landscape path lighting or uplighting on trees and the facade. This is the maximum curb appeal look used by professional real estate photographers.`,

  "luxury-twilight":
    `LIGHTING — Luxury Twilight: Apply a dramatic, premium twilight treatment. The sky is deep navy to midnight blue with exceptional gradient depth and richness. CRITICAL: ALL visible interior windows are ON with the warmest possible amber glow. Dramatic uplighting illuminates architectural features and specimen trees from below with warm amber fixtures. Where a driveway or walkway exists, add subtle path lighting pools. The result is a strong contrast between the deep blue sky and the warmly lit home — a magazine cover quality exterior shot. This treatment is reserved for premium and luxury marketing.`
};

// ─────────────────────────────────────────────
// LANDSCAPE ENHANCEMENT OPTIONS
// ─────────────────────────────────────────────
const LANDSCAPE_PROMPTS = {
  "basic-refresh":
    `LANDSCAPE ENHANCEMENT — Basic Refresh: Replace any dry, brown, patchy, or sparse grass with a uniformly healthy, vibrant green lawn. Add fresh dark brown or black mulch to any visible planting beds. Trim all shrubs to a clean, well-maintained appearance with defined edges. Remove any dead plants, weeds, or debris. Do NOT add new plants, change the layout, or introduce new landscape features — only refresh and improve what already exists.`,

  "professional-design":
    `LANDSCAPE ENHANCEMENT — Professional Landscape Design: Upgrade the existing landscape to a professionally installed look. Define all planting beds with clean steel or natural stone edging. Introduce ornamental grasses and low-maintenance rounded shrubs in natural layered groupings. Frame the front walkway with tiered plantings: low ground cover at the front edge, mid-height flowering shrubs behind. Apply fresh dark brown mulch throughout all beds. Ensure the lawn is healthy, neatly edged along all hardscape lines. The overall effect should feel intentional and architecturally planned — as if a landscape designer installed it.`,

  "california-water-wise":
    `LANDSCAPE ENHANCEMENT — California Water-Wise: Replace any lawn with a California-appropriate water-wise landscape in warm, natural earth tones. Use decomposed granite (DG) in tan/buff as the primary ground surface. Add carefully arranged boulders and decorative rock groupings. Plant drought-tolerant California native species: lavender, ornamental sage, agave, blue fescue, manzanita, California poppies, and succulents in clustered groupings with clear negative space between. Create DG pathways with clean steel edging from driveway to entry. The color palette is warm earth tones — no tropical plants, no high-water-use species. This is the premium Sacramento Valley water-wise aesthetic appropriate for the California market.`,

  "luxury-resort":
    `LANDSCAPE ENHANCEMENT — Luxury Resort Landscape: Install a full luxury resort-grade landscape treatment. Plant mature specimen trees (24–36" box size equivalent) as architectural focal points flanking the entry or driveway. Layer mid-height ornamental flowering shrubs, architectural grasses, and tropical accent plants. Carpet the ground layer with lush annual color, creeping ground covers, and perennials. Where uplighting is plausible, add warm amber fixture glow at tree bases and accent plants. Use precision metal edging, custom stone or decomposed granite pathways, and statement container plantings at the entry. The result must read as a luxury estate landscape — layered, immaculate, and impressive.`,

  "seasonal-color":
    `LANDSCAPE ENHANCEMENT — Seasonal Color Enhancement: Add vibrant seasonal blooms appropriate to the current season. Install full flower beds along the front foundation with a curated color palette. Create a strong focal point at the entry with a large container planting arrangement or ornamental flowering tree. Line the front walkway with seasonal annuals or flowering perennials in complementary tones. Ensure the lawn is a healthy, saturated green. The overall effect should be welcoming and emotionally appealing — a home that feels move-in-ready and joyful.`
};

// ─────────────────────────────────────────────
// OUTDOOR LIVING STAGING OPTIONS
// null = do not add any outdoor living staging
// ─────────────────────────────────────────────
const OUTDOOR_LIVING_PROMPTS = {
  "none": null,

  "patio-seating":
    `OUTDOOR LIVING STAGING — Patio Seating: IF a patio, deck, covered patio, or suitable hardscape area is clearly visible in the photo, add a casual seating arrangement: 2–4 weather-resistant chairs (wicker, powder-coated aluminum, or teak finish) with a small round coffee table or side table. Add 1–2 medium potted plants or planters. Keep the arrangement open and airy — do not overcrowd the space. Furniture should complement the home's architectural style. IF no patio or deck is visible, skip this instruction entirely.`,

  "outdoor-dining":
    `OUTDOOR LIVING STAGING — Outdoor Dining: IF a patio, deck, covered patio, or suitable hardscape area is clearly visible in the photo, add an outdoor dining set: a rectangular or round dining table that seats 4–6, with matching side chairs. Add a simple centerpiece appropriate to the setting (a lantern, low succulent arrangement, or grouped candles). Furniture material and style should match the home's architecture (modern metal for contemporary, teak or wicker for traditional or craftsman). IF no patio or deck is visible, skip this instruction entirely.`,

  "conversation-lounge":
    `OUTDOOR LIVING STAGING — Conversation Lounge: IF a patio, deck, covered patio, or suitable hardscape area is clearly visible in the photo, create an outdoor conversation lounge. Include a 3-piece outdoor sectional or L-shaped sofa with 1–2 coordinating lounge chairs facing a linear gas fire table or a low square coffee table as the centerpiece. Add outdoor throw pillows in neutral tones (ivory, taupe, soft gray). This arrangement signals premium outdoor entertaining capability. IF no patio or deck is visible, skip this instruction entirely.`,

  "california-entertainer":
    `OUTDOOR LIVING STAGING — California Entertainer: IF a patio, deck, covered patio, or yard area is clearly visible in the photo, create a full California entertainer setup. Define two zones: (1) a dining zone with a table and 4–6 chairs on one side, and (2) a lounge zone with 2–3 accent chairs and side tables on the other. Add 2–3 large ceramic or concrete statement planters with lush plants. Suggest warm bistro string lights overhead if a covered structure supports them (subtle, not overwhelming). This layout communicates the full California indoor-outdoor lifestyle. IF no suitable outdoor area is visible, skip this instruction entirely.`,

  "luxury-resort-living":
    `OUTDOOR LIVING STAGING — Luxury Resort Outdoor Living: IF a patio, deck, covered patio, or yard area is clearly visible in the photo, stage with luxury resort-grade outdoor furniture. Add a designer-grade sectional or chaise lounge set with premium cushions in a crisp neutral palette (white, cream, or warm linen). Include a fire table or architectural fire bowl as the focal point. Add an outdoor area rug under the seating to define the zone. Place 2–3 architectural planters with sculptural specimen plants (agave, olive tree, or boxwood sphere). The result must read as a 5-star resort terrace — refined, expensive, and aspirational. IF no suitable outdoor area is visible, skip this instruction entirely.`
};

// ─────────────────────────────────────────────
// ENHANCEMENT INTENSITY
// ─────────────────────────────────────────────
const INTENSITY_PROMPTS = {
  "mls-light":
    `ENHANCEMENT INTENSITY — MLS Light (10–15% improvement): Apply conservative enhancements only. The photo should look like perfect natural conditions on a beautiful day — not a transformation. Greener grass, brighter sky, minor cleanup of imperfections. Buyers must immediately recognize this as the actual property with minimal effort to imagine it. Nothing should look artificial or over-processed.`,

  "market-ready":
    `ENHANCEMENT INTENSITY — Market Ready (25–35% improvement): Apply moderate, noticeable enhancements. The home should look well-maintained and genuinely move-in-ready. Healthy landscape, improved lighting, clean and polished surfaces. The improvement is clearly visible compared to the original but remains fully realistic. A buyer should feel this is what the property looks like at its best with normal upkeep.`,

  "premium-marketing":
    `ENHANCEMENT INTENSITY — Premium Marketing (50–60% improvement): Apply significant enhancements for a professional marketing photo result. This is the best version of what this property could realistically look like with quality maintenance and landscaping investment. All elements are polished and photogenic. The result should be suitable for print marketing materials, high-end MLS photos, and featured listing placement.`,

  "luxury-presentation":
    `ENHANCEMENT INTENSITY — Luxury Presentation (70–80% improvement): Apply maximum enhancements for aspirational, aspirationally accurate marketing. Showcase the property at its absolute pinnacle — immaculate in every detail. Exceptional landscaping, perfect lighting, staging that elevates the emotional and financial perception of the property. The image is for luxury listing presentations, print brochures, and premium digital marketing. All enhancements must remain architecturally accurate to this specific home.`
};

// ─────────────────────────────────────────────
// PROPERTY TIER — HIDDEN INTERNAL CALIBRATION VARIABLE
// Guides the AI's calibration of enhancement style to match
// the property's price point. Not labeled in the output.
// ─────────────────────────────────────────────
const PROPERTY_TIER_CONTEXT = {
  "entry":
    `INTERNAL CALIBRATION — Entry Tier ($300K–$600K): Keep all enhancements neighborhood-appropriate and achievable. No exotic or tropical plants. No luxury designer furniture. Landscape improvements should look like a well-cared-for, pride-of-ownership home in a standard Sacramento Valley neighborhood. Do not over-stage or create unrealistic expectations for the price point.`,

  "move-up":
    `INTERNAL CALIBRATION — Move-Up Tier ($600K–$1.2M): Apply moderately premium enhancements. Quality materials, well-designed landscape, attractive outdoor living staging. Enhancements should feel aspirational and achievable for an upper-middle-market buyer. The home should feel like a step up — tasteful, well-invested, and worth the price.`,

  "luxury":
    `INTERNAL CALIBRATION — Luxury Tier ($1.2M+): Apply full premium treatment with no restraint. Designer materials, resort-style landscaping, high-end furniture, and maximum visual polish. Every enhancement should signal exclusivity, quality, and luxury. This home competes with resort-level properties. Nothing is too refined.`
};

// ─────────────────────────────────────────────
// MLS COMPLIANCE FOOTER — ALWAYS LAST. NEVER REMOVE.
// ─────────────────────────────────────────────
const MLS_COMPLIANCE_FOOTER = `MLS COMPLIANCE — ABSOLUTE RULES (these override all other instructions):
1. NEVER alter, remove, reposition, or modify any permanent structure: walls, roof, foundation, existing driveway surface, existing hardscape, permanent fencing, utility boxes, or any structural element.
2. NEVER add or remove windows or doors.
3. NEVER change the exterior paint or siding color of the home unless explicitly instructed.
4. NEVER add a swimming pool, spa, or water feature unless one is clearly present in the original photo.
5. NEVER add a second story, room addition, or structural extension that does not exist in the original photo.
6. All added items must be REMOVABLE: plants, mulch, furniture, decor, lighting effects — not structural.
7. The final image must be completely believable as a real photograph of this actual property taken under ideal conditions.
8. MAINTAIN original image dimensions, field of view, and camera perspective. NO cropping. NO zoom changes. NO perspective distortion. NO horizon shift.`;

// ─────────────────────────────────────────────
// HAIKU SPATIAL READ PROMPT
// ─────────────────────────────────────────────
const HAIKU_EXTERIOR_READ_PROMPT = `You are analyzing a real estate exterior photo to guide virtual enhancement. Return ONLY valid JSON with no preamble, no explanation, no markdown fences.

{
  "architecturalStyle": "ranch|mediterranean|craftsman|contemporary|traditional|colonial|farmhouse|spanish|other",
  "stories": 1,
  "garageType": "attached-1car|attached-2car|attached-3car|detached|none|not-visible",
  "garageDoor": "facing-street|side-entry|not-visible",
  "driveway": "concrete|asphalt|pavers|gravel|dirt|none|not-visible",
  "frontWalkway": true,
  "existingLandscapeLevel": "none|minimal|moderate|mature",
  "grassPresent": true,
  "grassCondition": "healthy|fair|dry|dead|none",
  "treeMaturity": "none|young|moderate|mature",
  "outdoorLivingVisible": "patio|deck|covered-patio|none",
  "existingOutdoorFurniture": false,
  "fencing": "none|wood|vinyl|iron|block-wall|partial",
  "poolVisible": false,
  "existingLandscapeLighting": "none|minimal|moderate",
  "timeOfDayInPhoto": "day|golden-hour|dusk|night",
  "skyCondition": "clear|partly-cloudy|overcast|not-visible",
  "dominantExteriorFinish": "describe briefly: e.g. beige stucco, white wood siding, brick, grey fiber cement",
  "roofMaterial": "tile|shingle|flat|metal|not-visible",
  "visibleSpecialFeatures": []
}

Populate visibleSpecialFeatures with any of: RV access, circular driveway, solar panels, basketball hoop, flagpole, decorative shutters, columns, covered entry, water feature, sport court, ADU, gate.
Return ONLY the JSON object.`;

// ─────────────────────────────────────────────
// PROMPT ASSEMBLER
// Assembly order per spec:
// 1. AB 723 Header
// 2. Spatial Context (from Haiku read)
// 3. Landscape Enhancement Block
// 4. Outdoor Living Block
// 5. Lighting Block
// 6. Intensity Block
// 7. Property Tier (hidden internal calibration)
// 8. MLS Compliance Footer
// ─────────────────────────────────────────────
function assembleExteriorPrompt({ spatialRead, lighting, landscape, outdoorLiving, intensity, propertyTier }) {
  const parts = [];

  // 1. AB 723 Header — ALWAYS FIRST
  parts.push(AB723_HEADER);

  // 2. Spatial Context Block (inform GPT what it's looking at)
  if (spatialRead && Object.keys(spatialRead).length > 0) {
    const contextLines = [];

    if (spatialRead.architecturalStyle)
      contextLines.push(`Architecture: ${spatialRead.architecturalStyle}`);
    if (spatialRead.stories)
      contextLines.push(`Stories: ${spatialRead.stories}`);
    if (spatialRead.dominantExteriorFinish)
      contextLines.push(`Exterior finish: ${spatialRead.dominantExteriorFinish}`);
    if (spatialRead.roofMaterial && spatialRead.roofMaterial !== "not-visible")
      contextLines.push(`Roof: ${spatialRead.roofMaterial}`);
    if (spatialRead.garageType && spatialRead.garageType !== "not-visible")
      contextLines.push(`Garage: ${spatialRead.garageType}${spatialRead.garageDoor && spatialRead.garageDoor !== "not-visible" ? ` (${spatialRead.garageDoor})` : ""}`);
    if (spatialRead.driveway && spatialRead.driveway !== "not-visible")
      contextLines.push(`Driveway: ${spatialRead.driveway}`);
    if (spatialRead.frontWalkway)
      contextLines.push(`Front walkway: present`);
    if (spatialRead.outdoorLivingVisible && spatialRead.outdoorLivingVisible !== "none")
      contextLines.push(`Outdoor living area: ${spatialRead.outdoorLivingVisible}`);
    if (spatialRead.existingOutdoorFurniture)
      contextLines.push(`Existing outdoor furniture: yes — REMOVE before restaging`);
    if (spatialRead.fencing && spatialRead.fencing !== "none")
      contextLines.push(`Fencing: ${spatialRead.fencing}`);
    if (spatialRead.poolVisible)
      contextLines.push(`Pool: VISIBLE — preserve pool, only enhance surrounding landscape`);
    if (spatialRead.grassPresent && spatialRead.grassCondition)
      contextLines.push(`Grass: present, condition = ${spatialRead.grassCondition}`);
    if (spatialRead.treeMaturity && spatialRead.treeMaturity !== "none")
      contextLines.push(`Tree maturity: ${spatialRead.treeMaturity}`);
    if (spatialRead.timeOfDayInPhoto)
      contextLines.push(`Original photo time of day: ${spatialRead.timeOfDayInPhoto}`);
    if (spatialRead.visibleSpecialFeatures && spatialRead.visibleSpecialFeatures.length > 0)
      contextLines.push(`Special features: ${spatialRead.visibleSpecialFeatures.join(", ")}`);

    if (contextLines.length > 0) {
      parts.push(
        `STAGING ZONE SCOPE — PROPERTY ANALYSIS:\n${contextLines.map(l => `  • ${l}`).join("\n")}\nApply all enhancements consistently with the above architectural reality. Do not contradict or ignore any of these observed features.`
      );
    }
  }

  // 3. Landscape Enhancement Block
  const landscapePrompt = LANDSCAPE_PROMPTS[landscape];
  if (landscapePrompt) {
    parts.push(landscapePrompt);
  }

  // 4. Outdoor Living Block
  const outdoorPrompt = OUTDOOR_LIVING_PROMPTS[outdoorLiving];
  if (outdoorPrompt) {
    parts.push(outdoorPrompt);
  }

  // 5. Lighting Block
  const lightingPrompt = LIGHTING_PROMPTS[lighting];
  if (lightingPrompt) {
    parts.push(lightingPrompt);
  }

  // 6. Intensity Block
  const intensityPrompt = INTENSITY_PROMPTS[intensity];
  if (intensityPrompt) {
    parts.push(intensityPrompt);
  }

  // 7. Property Tier — Hidden internal calibration
  const tierContext = PROPERTY_TIER_CONTEXT[propertyTier];
  if (tierContext) {
    parts.push(tierContext);
  }

  // 8. MLS Compliance Footer — ALWAYS LAST
  parts.push(MLS_COMPLIANCE_FOOTER);

  return parts.join("\n\n");
}

// ─────────────────────────────────────────────
// NETLIFY HANDLER
// ─────────────────────────────────────────────
exports.handler = async function (event, context) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method Not Allowed" })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Invalid JSON body" })
    };
  }

  const {
    imageBase64,
    imageMimeType = "image/jpeg",
    lighting = "twilight",
    landscape = "basic-refresh",
    outdoorLiving = "none",
    intensity = "market-ready",
    propertyTier = "move-up"
  } = body;

  if (!imageBase64) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "imageBase64 is required" })
    };
  }

  // Validate options — default to safe fallbacks if unrecognized values arrive
  const validLighting = LIGHTING_PROMPTS[lighting] ? lighting : "twilight";
  const validLandscape = LANDSCAPE_PROMPTS[landscape] ? landscape : "basic-refresh";
  const validOutdoor = OUTDOOR_LIVING_PROMPTS.hasOwnProperty(outdoorLiving) ? outdoorLiving : "none";
  const validIntensity = INTENSITY_PROMPTS[intensity] ? intensity : "market-ready";
  const validTier = PROPERTY_TIER_CONTEXT[propertyTier] ? propertyTier : "move-up";

  // API key — server-side only. NEVER send from frontend.
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  if (!claudeKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server configuration error: ANTHROPIC_API_KEY not set" })
    };
  }

  // ── Step 1: Haiku Spatial Read (native HTTPS — no SDK dependency) ──────────
  let spatialRead = {};
  try {
    const haikusResponse = await callClaudeHaiku(claudeKey, {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: imageMimeType,
                data: imageBase64
              }
            },
            {
              type: "text",
              text: HAIKU_EXTERIOR_READ_PROMPT
            }
          ]
        }
      ]
    });

    const rawText = (haikusResponse.content?.[0]?.text || "").trim();

    // Strip any accidental markdown fences before parsing
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      spatialRead = JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    // Spatial read failure is non-fatal. Log and continue with empty spatial context.
    console.error("Haiku exterior spatial read error:", err.message || err);
    spatialRead = {};
  }

  // ── Step 2: Assemble the full prompt ─────────────────────────
  const prompt = assembleExteriorPrompt({
    spatialRead,
    lighting: validLighting,
    landscape: validLandscape,
    outdoorLiving: validOutdoor,
    intensity: validIntensity,
    propertyTier: validTier
  });

  // ── Return prompt + spatial read to frontend ─────────────────
  // Frontend calls stage-openai.js with { imageBase64, stagingPrompt: prompt }
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      spatialRead
    })
  };
};
