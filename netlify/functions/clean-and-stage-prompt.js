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
      // Use stage-vacant-prompt logic to build the staging prompt
      
      const stageJobId = "stage-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      
      // Build basic staging prompt (without full Haiku read, assuming we have room anchors)
      const stagePrompt = `PRIMARY ROLE: Stage furniture and decor ONLY.

IMMUTABLE LOCK: Never alter, move, remove, replace, or touch: structural walls | ceilings | kitchen/bathroom cabinets | countertops | lighting fixtures. These must be preserved exactly as photographed.

AB 723 COMPLIANCE: Virtual staging adds furniture only. Any alteration to permanent architecture makes the listing non-compliant.

This is the VACANT version of the room (decluttered in Step 1).
Add furniture and decor using design style: ${designStyle || 'Organic Modern'}
Color palette: ${colorPalette || 'Warm Neutrals'}

Stage furniture anchored to focal points and zone boundaries.
Keep all architectural elements preserved.
Do not alter permanent fixtures, cabinetry, or architectural elements.`;

      // Fire stage job
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
