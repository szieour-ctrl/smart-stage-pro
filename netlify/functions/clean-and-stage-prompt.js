// clean-and-stage-prompt.js — Clean & Stage Workflow
// Step 1: Calls declutter-prompt.js to remove furniture/decor
// Step 2: Calls stage-vacant-prompt.js to stage the now-vacant room
// Step 3: Returns final staged image
// AB 723 compliant throughout

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
    const buf = Buffer.from(base64.slice(0, 16), 'base64');
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
    if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
    if (buf[0] === 0x52 && buf[1] === 0x49) return 'image/webp';
  } catch(e) {}
  return 'image/jpeg';
}

async function prepareImage(imageBase64, mimeType) {
  const buffer = Buffer.from(imageBase64, "base64");
  const meta = await sharp(buffer).metadata();
  const sizeKB = Math.round(buffer.length / 1024);
  const maxDim = Math.max(meta.width || 0, meta.height || 0);

  if (maxDim <= 768 && sizeKB <= 80) {
    console.log(`Image OK: ${meta.width}x${meta.height} ${sizeKB}KB`);
    return { base64: imageBase64, mimeType };
  }

  const compressed = await sharp(buffer)
    .resize(768, 768, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();

  const compressedKB = Math.round(compressed.length / 1024);
  console.log(`Image compressed: ${meta.width}x${meta.height} ${sizeKB}KB → 1536px max ${compressedKB}KB`);
  return { base64: compressed.toString("base64"), mimeType: "image/jpeg" };
}

function triggerBackground(payload, siteUrl, functionName) {
  const body = Buffer.from(JSON.stringify(payload));
  console.log(`Triggering ${functionName}: payload ${Math.round(body.length / 1024)}KB`);
  const url = new URL(`${siteUrl}/.netlify/functions/${functionName}`);
  
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length,
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const responseBody = Buffer.concat(chunks).toString("utf8").slice(0, 500);
        console.log(`${functionName} response: status=${res.statusCode}`);
        resolve(res.statusCode);
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const { 
      imageBase64, 
      mimeType, 
      roomType, 
      designStyle, 
      colorPalette, 
      openAIKey,
      mode  // "build-prompt" or "execute"
    } = JSON.parse(event.body);
    const claudeKey = process.env.ANTHROPIC_API_KEY;

    if (!imageBase64) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing imageBase64" }) };
    if (!roomType) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing roomType" }) };
    if (!claudeKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }) };

    const siteUrl = process.env.NETLIFY_URL || process.env.DEPLOY_URL || "https://smart-stage-pro.netlify.app";
    if (!siteUrl) return { statusCode: 500, headers, body: JSON.stringify({ error: "Site URL not configured" }) };

    // Compress image if needed
    const { base64: readyBase64, mimeType: readyMime } = await prepareImage(imageBase64, mimeType);

    // ═══════════════════════════════════════════════════════════════════════════════
    // MODE 1: BUILD PROMPT FOR USER REVIEW
    // ═══════════════════════════════════════════════════════════════════════════════
    if (mode === "build-prompt") {
      // Get declutter prompt
      const declutterPrompt = `PRIMARY ROLE: Remove furniture and decor ONLY. Preserve architecture exactly.

IMMUTABLE LOCK: Never alter, move, remove, replace, or touch: structural walls | ceilings | kitchen/bathroom cabinets | countertops | lighting fixtures | doors | windows | built-in appliances.

AB 723 COMPLIANCE: Decluttering removes movable objects only.

Step 1: DECLUTTER
Remove all furniture and decor. Keep architectural elements exactly as photographed.
This creates a vacant room ready for staging.

Step 2: STAGE VACANT
Add furniture and decor to the decluttered room using anchors and zone boundaries.
Stage ONLY within zone boundaries. Keep adjacent zones vacant.
Preserve all permanent architecture.

This two-step process ensures AB 723 compliance throughout.`;

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          mode: "clean-and-stage",
          step1: "DECLUTTER",
          step2: "STAGE VACANT",
          prompt: declutterPrompt,
          message: "Clean & Stage workflow: (1) Declutter image, (2) Stage vacant room. Review prompt and click CLEAN & STAGE to execute both steps."
        })
      };
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // MODE 2: EXECUTE (Declutter → Stage)
    // ═══════════════════════════════════════════════════════════════════════════════
    if (mode === "execute") {
      if (!openAIKey) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing openAIKey for execution" }) };

      // STEP 1: TRIGGER DECLUTTER via stage-openai-background
      const declutterJobId = "declutter-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      
      const declutterPrompt = `PRIMARY ROLE: Remove furniture and decor ONLY.

IMMUTABLE LOCK: Never alter, move, remove, replace, or touch: structural walls | ceilings | kitchen/bathroom cabinets | countertops | lighting fixtures | doors | windows | built-in appliances. These must be preserved exactly as photographed.

AB 723 COMPLIANCE: Decluttering removes movable objects only.

Remove all furniture and decor from this room using inpainting.
Keep all architectural elements (walls, ceiling, flooring, fixtures, appliances, windows, doors) exactly as photographed.
Fill empty areas with matching surfaces (floor, wall, ceiling).
Result must be a completely vacant, clean room ready for staging.`;

      // Fire declutter job
      await triggerBackground({
        jobId: declutterJobId,
        imageBase64: readyBase64,
        mimeType: readyMime,
        stagingPrompt: declutterPrompt,
        quality: "low"
      }, siteUrl, "stage-openai-background");

      // STEP 2: RETURN JOB INFO FOR CLIENT POLLING
      // Client will poll check-openai.js with declutterJobId
      // Once decluttered image is ready, client calls clean-and-stage again with declutteredImageBase64
      
      return {
        statusCode: 202,
        headers,
        body: JSON.stringify({
          success: true,
          step: 1,
          jobId: declutterJobId,
          message: "Step 1/2: Decluttering image... Please wait (polling for result)",
          nextAction: "Poll for decluttered image, then call stage-vacant with decluttered base64"
        })
      };
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // MODE 3: STAGE THE DECLUTTERED IMAGE
    // ═══════════════════════════════════════════════════════════════════════════════
    if (mode === "stage-decluttered") {
      if (!openAIKey) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing openAIKey" }) };

      // At this point, imageBase64 is the DECLUTTERED image (vacant room)
      // Run zone-aware Haiku read — same logic as stage-vacant-prompt.js (4-field zones)
      const isOpenPlan = roomType.includes('+');

      const readPrompt = `You are reading a real estate listing photo to identify furnishing zones.

Room Type: ${roomType}
Zone type: ${isOpenPlan ? 'OPEN PLAN (multiple interconnected zones)' : 'SINGLE ROOM (one zone)'}

TASK: For each zone visible, return ONLY factual architectural data — no staging instructions, no furniture recommendations, no prose.

RULES:
1. ZONE IDENTIFICATION: Zones are bounded by permanent architectural elements (walls, partitions, openings, fireplaces, islands, windows).
2. ONE ZONE PER BOUNDED AREA: Kitchen = one zone. Dining = one zone. Living = one zone.
3. FLOATING ZONES (no enclosing walls): Use TIER 3 anchoring (position in frame + neighbor relationships).
4. FIXTURE FACTS ONLY: Report what is ACTUALLY VISIBLE. Do not infer. If no fixture visible, set to null.
5. BOUNDARY NAMING: Name neighbors on EVERY edge. Example: "Left: kitchen island. Right: fireplace wall. Front: circulation. Back: great room."
6. PRESERVED ARCHITECTURE: Name all permanent elements per zone — distribute across zones, no laundry list.

ANCHOR TIER CLASSIFICATION:
TIER 1 (HIGHEST PRECISION) — Zone has a dominant fixture:
  Examples: Chandelier, fireplace, ceiling fan, island with sink, appliances.

TIER 2 (MEDIUM PRECISION) — Zone has clear wall position but no fixture:
  Examples: Seating wall with windows, headboard wall, kitchen perimeter wall.

TIER 3 (LOWER PRECISION) — Zone is floating (no walls, no fixtures):
  Examples: Dining nook in open plan, flex room with no boundaries.
  Use: FOREGROUND / MIDGROUND / BACKGROUND + LEFT / CENTER / RIGHT + neighbor relationships.

EDGE CASES:
• Flex Room: Flag flexRoomType as null or inferred (home_office / sitting_room / formal_dining / etc).
• Multiple recessed lights: Name SPECIFIC location. "Recessed lights centered above dining zone".
• Sliding doors: Flag doorType: sliding. Clearance is ONE-SIDED.
• Swinging doors: Flag doorType: swinging. Clearance is ARC-BASED.
• Ceiling cut off: Flag ceilingVisibility: partial and low confidence.
• Hallway: Mark isHallway: true, keep empty.

RETURN ONLY THIS JSON — no markdown, no preamble:

{
  "zones": [
    {
      "name": "Zone name (Kitchen / Dining / Living / Bedroom / Flex Room / Hallway / etc)",
      "boundaries": "Reciprocal description of boundaries and neighbors on each edge.",
      "fixtures": "Comma-separated list of ceiling/structural fixtures visible in THIS ZONE ONLY, or null.",
      "cabinetry": "Kitchen/bathroom built-ins in THIS ZONE ONLY, or null.",
      "windows_doors": "All openings (windows, doors, pass-throughs) in THIS ZONE's boundaries, or null.",
      "anchor_point": {
        "tier": "TIER 1 or TIER 2 or TIER 3",
        "location": "Specific physical location.",
        "instruction": "How to use this anchor.",
        "confidence": "high / medium / low"
      },
      "negative_constraints": ["Do not extend past [boundary].", "Do not block [feature]."],
      "furnishing_specification": {
        "pieces": "Furniture types with FIXED COUNTS (not ranges).",
        "decor": "Decorative elements by count, or null.",
        "notes": "Additional context, or null."
      },
      "flags": {
        "flexRoomType": "null or inferred type",
        "doorType": "swinging / sliding / null",
        "ceilingVisibility": "full / partial",
        "isHallway": "true / false"
      }
    }
  ],
  "metadata": {
    "roomType": "${roomType}",
    "groupType": "${isOpenPlan ? 'open_plan' : 'single_room'}",
    "totalZones": "[count]",
    "conflictsDetected": [],
    "notes": "Any overall observations."
  }
}`;

      // Haiku reads the decluttered room
      const readPayload = JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: detectMime(readyBase64), data: readyBase64 } },
            { type: "text", text: readPrompt }
          ]
        }]
      });

      const readResult = await httpsRequest({
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "x-api-key": claudeKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(readPayload)
        }
      }, readPayload);

      if (readResult.status !== 200) throw new Error("Haiku C&S stage read failed: " + (readResult.body?.error?.message || readResult.status));

      const rawText = readResult.body?.content?.[0]?.text?.trim() || "{}";
      const cleanText = rawText.replace(/```json|```/g, "").trim();
      let roomData;
      try { roomData = JSON.parse(cleanText); }
      catch(e) { throw new Error("C&S stage room JSON parse failed"); }

      // Build zone-aware staging prompt
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
        'Warm Neutrals':'warm cream, taupe, and honey tones',
        'Bright Airy':'soft white, pale sage, and warm wood tones',
        'Soft Luxury':'blue, gray, and champagne tones',
        'Cool Gray':'cool gray, slate, and white tones',
        'Earth Tones':'terracotta, rust, and warm brown tones',
        'Bold Contrast':'black, white, and bold accent tones',
        'Coastal Blue':'ocean blue, sandy neutral, and white tones',
        'Sage Green':'sage green, warm white, and natural wood tones',
        'Jewel Tones':'emerald, sapphire, and warm gold tones',
        'Desert Modern':'sand, clay, and muted terracotta tones',
      };

      const rawStyle = designStyle || 'Organic Modern';
      const style = STYLE_LABELS[rawStyle?.toLowerCase().replace(/[^a-z]/g, '')] || rawStyle;
      const palette = colorPalette || 'Warm Neutrals';
      const paletteTones = PALETTE_TONES[palette] || (palette + ' tones');

      let stagePrompt = `PRIMARY ROLE: Stage furniture and decor ONLY.\n\nIMMUTABLE LOCK: Never alter, move, remove, replace, or touch: structural walls | partial walls | half-walls | pass-through openings and their surrounding wall sections | ceilings | kitchen/bathroom cabinets | countertops | lighting fixtures. These must be preserved exactly as photographed. If a wall has a pass-through opening, both the opening AND the solid wall sections above and below it must remain exactly as photographed — do not enlarge, remove, or modify any wall section.\n\nABSOLUTE PROHIBITION: Never ADD architectural elements that do not exist in the original photo. Do NOT add: built-in shelving | niches | alcoves | recessed shelves | bookcases built into walls | fireplace surrounds | wall openings | cabinetry | any structural element. If it is not visible in the original photograph, it cannot appear in the staged image.\n\nAB 723 COMPLIANCE: Virtual staging adds furniture only. Any alteration to permanent architecture — including ADDING elements not present — makes the listing non-compliant and subject to MLS removal.\n\n═══════════════════════════════════════════════════════════════════════════════\n\n`;

      stagePrompt += `PRESERVE EXACTLY: ${roomData.preserveList}\n\n`;
      stagePrompt += `STAGING: ${roomData.roomType} — Stage ONLY within this room boundary\n\n`;
      stagePrompt += `ZONE BOUNDARY (do not stage beyond):\nFront: ${roomData.zoneBoundary.front}\nBack: ${roomData.zoneBoundary.back}\nLeft: ${roomData.zoneBoundary.left}\nRight: ${roomData.zoneBoundary.right}\nShape: ${roomData.zoneBoundary.shape}\n\n`;

      if (isOpenPlan && Array.isArray(roomData.zones)) {
        stagePrompt += `ZONE-BY-ZONE STAGING INSTRUCTIONS:\n`;
        roomData.zones.forEach(zone => {
stagePrompt += `\n${zone.name.toUpperCase()} ZONE:\n`;
          if (zone.ceilingFixture && zone.ceilingFixture !== 'NONE') {
            stagePrompt += `Ceiling fixture: ${zone.ceilingFixture} — use this as the anchor for furniture placement in this zone\n`;
          }
          stagePrompt += `Focal point: ${zone.focalPoint}\n`;
          stagePrompt += `Staging: ${zone.stagingInstruction}\n`;
        });
        stagePrompt += `\n`;
      } else if (roomData.anchors) {
        stagePrompt += `ANCHORS (use these to place furniture):\n`;
        stagePrompt += `Focal Wall: ${roomData.anchors.focal}\n`;
        if (roomData.anchors.ceiling) stagePrompt += `Ceiling: ${roomData.anchors.ceiling}\n`;
        stagePrompt += `Back Wall: ${roomData.anchors.backWall}\n`;
        stagePrompt += `Left Boundary: ${roomData.anchors.leftBoundary}\n`;
        stagePrompt += `Right Boundary: ${roomData.anchors.rightBoundary}\n`;
        stagePrompt += `Front Boundary: ${roomData.anchors.frontBoundary}\n\n`;
      }

      stagePrompt += `Stage in ${style} design style using a ${palette} palette with ${paletteTones} throughout.\n\n`;

      if (roomData.adjacentVisibleZones?.length > 0) {
        stagePrompt += `ADJACENT ZONES (KEEP VACANT):\n`;
        roomData.adjacentVisibleZones.forEach(z => {
          stagePrompt += `${z.zone}: Visible ${z.visible} — Keep completely empty\n`;
        });
        stagePrompt += `\n`;
      }

      const leftBound = isOpenPlan ? roomData.zoneBoundary.left : roomData.anchors?.leftBoundary;
      const rightBound = isOpenPlan ? roomData.zoneBoundary.right : roomData.anchors?.rightBoundary;
      stagePrompt += `DO NOT stage beyond zone boundary:\n— Do not extend furniture past left boundary (${leftBound})\n— Do not extend furniture past right boundary (${rightBound})\n— Do not stage adjacent zones (keep vacant)\n— Do not alter architectural elements\n— Maintain open circulation within the zone\n\n`;
      stagePrompt += `Use ${style} furniture with clean architectural lines.\nMaintain realistic furniture scale proportional to the room.\nPreserve all architectural features, room dimensions, and camera perspective exactly as photographed.\nThis image is for MLS listing per California AB 723 §10140.6.\nVirtual staging adds furniture and decor only — any alteration to architecture or spatial geometry is prohibited.`;

      const stageJobId = "stage-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);

      await triggerBackground({
        jobId: stageJobId,
        imageBase64: readyBase64,
        mimeType: readyMime,
        stagingPrompt: stagePrompt,
        quality: "low"
      }, siteUrl, "stage-openai-background");

      return {
        statusCode: 202,
        headers,
        body: JSON.stringify({
          success: true,
          step: 2,
          jobId: stageJobId,
          message: "Step 2/2: Staging decluttered room... Please wait (polling for result)",
          finalAction: "Poll check-openai with this jobId for final staged image"
        })
      };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid mode. Use: build-prompt, execute, or stage-decluttered" }) };

  } catch (err) {
    console.error("clean-and-stage error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
