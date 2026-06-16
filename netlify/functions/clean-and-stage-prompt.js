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
      // Run zone-aware Haiku read — same logic as stage-vacant-prompt.js
      const isOpenPlan = roomType.includes('+');
      const zoneList = isOpenPlan ? roomType.split('+').map(z => z.trim()).filter(Boolean) : null;

      const readPrompt = isOpenPlan ? `You are reading a single open-plan space for MLS virtual staging.

Room Type: ${roomType}
Zones visible: ${zoneList.join(', ')}

STEP 1 — SPATIAL INVENTORY (do this first):
Before assigning anything to zones, identify every ceiling fixture and architectural anchor by its PHYSICAL POSITION in the image frame:
- Where is it? (left side of frame / center of frame / right side of frame)
- How far from camera? (foreground / midground / background)
- What is it? (chandelier, ceiling fan, pendant cluster, recessed lights, etc.)

STEP 2 — ZONE MAPPING:
Map each fixture to a zone based on SPATIAL POSITION ONLY — never by fixture type or zone name assumption. A chandelier over the dining area is a DINING anchor even if it is near the kitchen. A ceiling fan over the living area is a LIVING anchor even if it is near the fireplace.

STEP 3 — STAGING INSTRUCTION:
For each zone, write a staging instruction that uses the ceiling fixture as the PRIMARY anchor. Furniture must be placed centered beneath or oriented toward that zone's ceiling fixture.

FLEX/SECONDARY ZONE RULE: Look for the ONE enclosed or partially enclosed space in the frame — it will have its own walls, an angled or defined entry opening, and may have a pass-through window or partial partition wall. This is the flex zone. It is the only space in the image with defined walls. Describe it by its entry opening and boundary walls so GPT can locate it instantly. Place furniture INSIDE that walled space only.

CRITICAL RULES:
- A fireplace is a LIVING ZONE focal point ONLY — sofas and seating face it. A dining table NEVER goes near a fireplace unless a chandelier is directly above that location.
- A chandelier/pendant cluster hanging from the ceiling over open floor space = DINING anchor → dining table + chairs MUST be centered directly beneath it — regardless of what else is nearby
- Island pendant lights = KITCHEN anchor → counter stools beneath them
- Ceiling fan = LIVING anchor → sofa/seating group oriented beneath it facing the fireplace
- Never place a dining table near a fireplace if a chandelier exists elsewhere in the space
- The chandelier position IS the dining table position — always

Return ONLY valid JSON — no markdown, no preamble:

{
  "roomType": "${roomType}",
  "preserveList": "Comprehensive list of every permanent architectural element visible: walls (including partial walls, half-walls, partition walls, and pass-through openings with their wall sections), ceiling, flooring material/color, windows with frame color, doors, appliances, fixtures, finishes. If a pass-through or opening exists in a wall, describe the full wall including the solid sections — these wall sections are permanent architecture. End with: DO NOT alter any permanent architectural element.",
  "fixtureInventory": [
    {
      "fixture": "description",
      "framePosition": "left/center/right of frame",
      "depth": "foreground/midground/background",
      "assignedZone": "which zone"
    }
  ],
  "zones": [
    ${zoneList.map(zone => '{\n      "name": "' + zone + '",\n      "ceilingFixture": "Ceiling fixture directly above this zone — specify type, finish, style, and its position RELATIVE TO THE CAMERA (foreground = close to camera, midground = middle of frame, background = far from camera). This camera-relative position is what GPT uses to place furniture beneath it. If none, say NONE.",\n      "focalPoint": "Primary anchor for furniture placement in this zone",\n      "stagingInstruction": "Specific furniture to place in this zone based on its ceiling fixture and focal point",\n      "stagingInstruction": "Specific furniture to place in this zone. Every user-labeled zone MUST be staged."\n    }').join(',\n    ')}
  ],
  "zoneBoundary": {
    "front": "Front boundary description",
    "back": "Back boundary description",
    "left": "Left boundary description",
    "right": "Right boundary description",
    "shape": "rectangular or other"
  },
  "adjacentVisibleZones": [
    {
      "zone": "zone name",
      "visible": "HOW visible",
      "staging": "KEEP VACANT - do not stage this zone"
    }
  ]
}` : `You are reading a single vacant room for MLS virtual staging.

Room Type: ${roomType}

Return ONLY valid JSON — no markdown, no preamble:

{
  "roomType": "${roomType}",
  "preserveList": "Comprehensive list of every permanent architectural element visible: walls (including partial walls, half-walls, partition walls, and pass-through openings with their wall sections), ceiling, flooring material/color, windows with frame color, doors, appliances, fixtures, finishes. If a pass-through or opening exists in a wall, describe the full wall including the solid sections — these wall sections are permanent architecture. End with: DO NOT alter any permanent architectural element.",
  "anchors": {
    "focal": "Primary focal point — sofa/seating faces this",
    "ceiling": "Ceiling fixture description if present with finish and style",
    "backWall": "Wall where furniture back goes against",
    "leftBoundary": "Left wall or element that stops furniture extension",
    "rightBoundary": "Right wall or element that stops furniture extension",
    "frontBoundary": "Distance in front of focal wall before furniture starts"
  },
  "zoneBoundary": {
    "front": "Front boundary",
    "back": "Back boundary",
    "left": "Left boundary",
    "right": "Right boundary",
    "shape": "rectangular or other"
  },
  "adjacentVisibleZones": []
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
