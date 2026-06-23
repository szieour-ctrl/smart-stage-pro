// haiku-planner-test.js — Netlify Function
// Tests baseline spatial read (LCD + zone extraction) vs. Haiku Planner protocol
// Calls Claude Haiku twice on same image with different prompts
// Returns structured comparison for A/B testing

const https = require("https");
const sharp = require("sharp");

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
    const buf = Buffer.from(base64.slice(0, 16), "base64");
    if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
    if (buf[0] === 0xFF && buf[1] === 0xD8) return "image/jpeg";
    if (buf[0] === 0x52 && buf[1] === 0x49) return "image/webp";
  } catch(e) {}
  return "image/jpeg";
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
  } catch(e) {
    return imageBase64;
  }
}

// BASELINE PROMPT — Your current LCD + zone extraction method
function buildBaselinePrompt() {
  return `You are reading a single room photograph for MLS virtual staging.

TASK: Extract zone anchors and boundaries using the Lighting Classification Dictionary (LCD).

RULES:
1. ZONE IDENTIFICATION: Identify visible zones (kitchen, dining, living, flex) based on stageablе floor area visible in THIS image.

2. LIGHTING CLASSIFICATION DICTIONARY (LCD):
   - Count arms/lights accurately. A 5-arm chandelier is ONE fixture, not "two pendants."
   - If chandeliеr hangs over open floor adjacent to kitchen with no walls between it and main living area → DINING anchor.
   - If chandelier hangs inside a room with walls/partitions forming an enclosed space → FLEX anchor.
   - Ceiling fan (any type) → LIVING anchor.
   - Pendant lights over island countertop → KITCHEN anchor.
   - Recessed lights → not an anchor, preserve only.

3. CEILING FIXTURE DESCRIPTION: For each visible zone, describe the fixture hanging in that zone:
   - Type and finish only (e.g., "5-arm brushed nickel chandelier with clear glass shades")
   - Do NOT describe position or depth.
   - If no visible fixture in a zone, set to null.

4. ZONE ANCHORS (return for each visible zone):
   - Fixture type and description
   - Spatial context (open floor / walled room / island / etc)
   - Staging instruction (where furniture goes relative to fixture)

5. BOUNDARY ANCHORS (return left/right/front/back):
   - Left: describe the landmark stopping the zone on the left
   - Right: describe the landmark stopping the zone on the right
   - Front: where the zone ends toward camera (clearance distance)
   - Back: describe the back wall or partition

6. WALL OPENINGS: For each opening (doorway, pass-through, archway):
   - Type of opening
   - What is visible through it
   - Do NOT assign anchors to zones beyond openings

Return ONLY valid JSON (no markdown, no preamble):
{
  "visibleZones": ["kitchen", "dining", "living"],
  "cameraPosition": "one sentence describing camera angle and height",
  "zoneAnchors": {
    "kitchen": {
      "present": true,
      "ceilingFixture": "2 pendant lights with brushed nickel finish over island",
      "islandDescription": "white quartz island with 3-seat overhang",
      "instruction": "Place 3 bar stools below pendants"
    },
    "dining": {
      "present": true,
      "ceilingFixture": "5-arm brushed nickel chandelier with clear glass shades",
      "fixtureType": "chandelier",
      "spatialContext": "open floor adjacent to kitchen, no walls between",
      "instruction": "Center dining table directly beneath fixture"
    },
    "living": {
      "present": true,
      "ceilingFixture": "brushed nickel ceiling fan with light kit",
      "frontWall": "fireplace wall on right side of frame",
      "backWall": "structural wall opposite fireplace",
      "instruction": "Place sofa against back wall facing fireplace, rug under fan"
    }
  },
  "boundaryAnchors": {
    "leftBoundary": "structural column at kitchen/dining edge",
    "rightBoundary": "patio door frame",
    "frontBoundary": "18 inches in front of hearth",
    "backBoundary": "back wall 12 feet from camera"
  },
  "wallOpenings": [
    {
      "type": "pass-through opening",
      "location": "kitchen to dining",
      "beyond": "hallway with bedroom beyond"
    }
  ]
}`;
}

// PLANNER PROTOCOL PROMPT — The new structured approach from the PDF
function buildPlannerProtocolPrompt() {
  return `SMART STAGE PRO SPATIAL EXTRACTION PROTOCOL v1

ROLE: Analyze this room photograph as a spatial planning system, not as an interior designer.
Ignore style, furniture, colors, finishes, decor, staging recommendations, and aesthetics.
Extract only geometry, spatial relationships, fixed architectural elements, circulation paths, and furniture placement constraints.

═══════════════════════════════════════════════════════════════════════════════

STEP 1 — ROOM CLASSIFICATION
Identify:
* Room Type (kitchen, dining, living, flex, bedroom, etc.)
* Open Plan or Closed Room
* Primary Viewing Direction (left-to-right, back-to-front, diagonal, etc.)
* Camera Position (standing, seated, elevated)
* Estimated Camera Height (eye level ~5'6", elevated ~6'+, lowered ~4')
* Number of Connected Spaces

═══════════════════════════════════════════════════════════════════════════════

STEP 2 — FIXED ARCHITECTURAL ANCHORS
List every permanent feature visible. For each anchor provide:
ANCHOR NAME | ANCHOR TYPE | LOCATION | VISUAL IMPORTANCE | ALTERATION | OBSTRUCTION

Anchor Types: Fireplace, Kitchen Island, Chandelier, Ceiling Fan, Patio Door, Window, Staircase, Built-In Cabinetry, Bathroom Vanity, Appliance Group, Structural Opening, Column, Beam

═══════════════════════════════════════════════════════════════════════════════

STEP 3 — ROOM ZONES
Divide room into functional zones (Living, Dining, Circulation, Kitchen, etc.)
For each zone identify:
* Purpose
* Approximate boundaries
* Connected zones
* Primary anchor (the fixture that anchors furniture in this zone)

═══════════════════════════════════════════════════════════════════════════════

STEP 4 — CIRCULATION ANALYSIS
Identify:
* Primary Path (entry → living → patio)
* Secondary Path (if any)
* Blocked Areas (where foot traffic cannot go)
* Required Clearances (minimum widths, door swings, view corridors)

═══════════════════════════════════════════════════════════════════════════════

STEP 5 — NO-RENDER AREAS
Identify areas where furniture should NEVER be placed:
* Door swing zones
* Hallway transitions
* Kitchen work triangles
* Patio door clearances
* Window view corridors

═══════════════════════════════════════════════════════════════════════════════

STEP 6 — FURNITURE COMPATIBILITY MAP
For each zone provide:
* Allowed Furniture Types
* Prohibited Furniture Types
* Maximum Furniture Footprint
* Height constraints (low under windows, tall in open ceilings)

═══════════════════════════════════════════════════════════════════════════════

STEP 7 — STRUCTURED OUTPUT

Return ONLY valid JSON (no markdown, no preamble):

{
  "roomClassification": {
    "roomType": "Kitchen+Dining+Living",
    "openPlanOrClosed": "open plan",
    "primaryViewingDirection": "camera left-to-right across dining zone",
    "cameraPosition": "standing in doorway, approximately 5'6\" high, wide-angle view",
    "connectedSpaces": 3
  },
  "architecturalAnchors": [
    {
      "name": "Chandelier",
      "type": "5-arm brushed nickel chandelier with clear glass shades",
      "location": "center of frame, hanging over open floor between kitchen and living",
      "importance": "critical — primary anchor for dining furniture",
      "alteration": "prohibited",
      "obstruction": "prohibited"
    },
    {
      "name": "Fireplace",
      "type": "built-in stone fireplace with mantel",
      "location": "right wall, background of frame",
      "importance": "critical — focal point for living zone",
      "alteration": "prohibited",
      "obstruction": "prohibited"
    },
    {
      "name": "Kitchen Island",
      "type": "white quartz island with 3-seat overhang",
      "location": "left side of frame, kitchen zone",
      "importance": "critical — kitchen zone anchor",
      "alteration": "prohibited",
      "obstruction": "prohibited"
    }
  ],
  "roomZones": [
    {
      "name": "Kitchen",
      "purpose": "food prep and cooking",
      "boundaries": "left wall to structural column, island along left edge",
      "connectedZones": ["dining via pass-through opening"],
      "primaryAnchor": "Kitchen Island with pendant lights"
    },
    {
      "name": "Dining",
      "purpose": "table seating and dining",
      "boundaries": "pass-through opening on left, fireplace wall on right, opens to living on back",
      "connectedZones": ["kitchen", "living"],
      "primaryAnchor": "Chandelier hanging over open floor"
    },
    {
      "name": "Living",
      "purpose": "seating, conversation, gathering",
      "boundaries": "dining zone on front, structural wall at back, patio door on right",
      "connectedZones": ["dining", "patio"],
      "primaryAnchor": "Ceiling fan and fireplace wall"
    }
  ],
  "circulationAnalysis": {
    "primaryPath": "entry doorway → dining zone → living zone → patio door",
    "secondaryPath": "kitchen → island bar → back to dining",
    "blockedAreas": "area under chandelier (centered in dining)",
    "requiredClearances": [
      "Patio door swing zone — 24 inches clearance",
      "Pass-through opening — 30 inches minimum walk-through width"
    ]
  },
  "noRenderAreas": [
    "Patio door swing zone (right side, 24 inches from door frame)",
    "Pass-through opening on kitchen side (2 feet clearance minimum)",
    "Foreground area nearest camera (circulation path between zones)"
  ],
  "furnitureCompatibilityMap": {
    "kitchen": {
      "allowed": ["bar stools", "small accent table", "pendant lighting (preserve existing)"],
      "prohibited": ["dining table", "sofa", "bed", "large cabinet"],
      "maxFootprint": "island overhang seats 3, no additional staging needed"
    },
    "dining": {
      "allowed": ["dining table", "dining chairs", "area rug", "buffet/sideboard"],
      "prohibited": ["sofa", "bed", "tall cabinet"],
      "maxFootprint": "table max 48 inches wide, 36 inches from pass-through opening"
    },
    "living": {
      "allowed": ["sofa", "accent chairs", "coffee table", "media console", "bookcase"],
      "prohibited": ["dining table", "bed"],
      "maxFootprint": "sofa no closer than 18 inches to fireplace hearth"
    }
  },
  "notes": "Open plan with clear fixture anchors. Chandelier position is dining anchor. Fireplace is living focal point. Kitchen island defines kitchen zone. Foreground circulation path must remain clear."
}`;
}

async function callClaudeWithPrompt(imageBase64, mimeType, prompt, claudeKey) {
  const body = JSON.stringify({
    model: "claude-3-5-haiku-20241022",
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mimeType,
              data: imageBase64
            }
          },
          {
            type: "text",
            text: prompt
          }
        ]
      }
    ]
  });

  const options = {
    hostname: "api.anthropic.com",
    port: 443,
    path: "/v1/messages",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": claudeKey,
      "anthropic-version": "2023-06-01"
    }
  };

  const response = await httpsRequest(options, body);
  if (response.status !== 200) {
    throw new Error(`Anthropic API error: ${response.status} ${JSON.stringify(response.body)}`);
  }

  const firstContent = response.body.content?.[0];
  if (!firstContent || firstContent.type !== "text") {
    throw new Error("Unexpected response format from Anthropic API");
  }

  return firstContent.text;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  try {
    const { imageBase64: rawBase64, mimeType: rawMimeType } = JSON.parse(event.body);

    if (!rawBase64) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing imageBase64" })
      };
    }

    const claudeKey = process.env.ANTHROPIC_API_KEY;
    if (!claudeKey) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" })
      };
    }

    // Compress image
    const imageBase64 = await compressForRead(rawBase64);
    const mimeType = rawMimeType || detectMime(rawBase64);

    // Run both prompts in parallel
    const [baselineResult, plannerResult] = await Promise.all([
      callClaudeWithPrompt(imageBase64, mimeType, buildBaselinePrompt(), claudeKey),
      callClaudeWithPrompt(imageBase64, mimeType, buildPlannerProtocolPrompt(), claudeKey)
    ]);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        timestamp: new Date().toISOString(),
        baseline: {
          prompt: "LCD + Zone Extraction (Current Method)",
          result: baselineResult
        },
        planner: {
          prompt: "Haiku Planner Protocol v1",
          result: plannerResult
        }
      })
    };

  } catch (err) {
    console.error("haiku-planner-test error:", err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
