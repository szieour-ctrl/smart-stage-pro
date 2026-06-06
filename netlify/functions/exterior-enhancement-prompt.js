// exterior-enhancement-prompt.js — Exterior Enhancements
// Sky replacement (day/dusk/night) + Landscaping generation
// Preserves house structure per AB 723
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

  if (maxDim <= 1536 && sizeKB <= 1500) {
    console.log(`Image OK: ${meta.width}x${meta.height} ${sizeKB}KB`);
    return { base64: imageBase64, mimeType };
  }

  const compressed = await sharp(buffer)
    .resize(1536, 1536, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer();

  const compressedKB = Math.round(compressed.length / 1024);
  console.log(`Image compressed: ${meta.width}x${meta.height} ${sizeKB}KB → 1536px max ${compressedKB}KB`);
  return { base64: compressed.toString("base64"), mimeType: "image/jpeg" };
}

function triggerBackground(payload, siteUrl) {
  const body = Buffer.from(JSON.stringify(payload));
  console.log(`Triggering stage-openai-background: payload ${Math.round(body.length / 1024)}KB`);
  const url = new URL(`${siteUrl}/.netlify/functions/stage-openai-background`);
  
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
        console.log(`stage-openai-background response: status=${res.statusCode}`);
        resolve(res.statusCode);
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ✅ AB 723 COMPLIANCE HEADER — Every prompt starts with this
const AB723_HEADER = `PRIMARY ROLE: Enhance exterior only. Preserve house structure exactly.

IMMUTABLE LOCK: Never alter, move, remove, replace, or touch: house structure | roof | walls | windows | doors | trim | siding | foundation | hardscape. These must be preserved exactly as photographed.

AB 723 COMPLIANCE: Exterior enhancements add/improve landscaping and sky only. Any alteration to house structure makes the result non-compliant and subject to MLS removal.

═══════════════════════════════════════════════════════════════════════════════

`;

// ✅ HAIKU READS EXTERIOR — Identifies house structure to preserve
async function analyzeExterior({ imageBase64, claudeKey }) {
  const prompt = `You are analyzing an exterior photo for MLS enhancement (sky replacement + landscaping).

TASK: Identify what must be PRESERVED (house structure) and what can be ENHANCED (sky, landscaping).

PRESERVE (house structure - IMMUTABLE):
- House exterior walls, siding, color, texture
- Roof shape, color, material
- Windows (frames, glass, shutters)
- Doors (frames, entry doors)
- Trim, eaves, gutters
- Foundation, porch, deck, patio
- Driveway, walkways
- Existing vegetation structure (large trees, shrubs)

ENHANCE (can be modified/added):
- Sky (overcast, dull, or clear - can be replaced with day/dusk/night)
- Landscaping (add plants, flowers, gardens, hardscape improvements)
- Yard maintenance appearance

Return ONLY valid JSON:

{
  "exteriorType": "front|back|side|aerial",
  "preserveList": "Comprehensive list of house structure elements visible and their colors/textures. DO NOT alter any of these.",
  "skyCondition": "current sky description (overcast, clear, dull, etc.)",
  "skyRecommendation": "day|dusk|night",
  "landscapingStatus": "description of current landscaping",
  "landscapingEnhancementOpportunities": [
    "opportunity 1",
    "opportunity 2"
  ],
  "enhancementStrategy": "Brief summary of how to enhance"
}`;

  const payload = JSON.stringify({
    model: "claude-haiku-4-5",
    max_tokens: 1200,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: detectMime(imageBase64), data: imageBase64 } },
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

  if (result.status !== 200) throw new Error("Haiku exterior analysis failed: " + (result.body?.error?.message || result.status));

  const text = result.body?.content?.[0]?.text?.trim() || "{}";
  const clean = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(clean); }
  catch(e) { throw new Error("Exterior analysis JSON parse failed"); }
}

// ✅ BUILD SKY REPLACEMENT PROMPT
function buildSkyReplacementPrompt({ exteriorData, skyType }) {
  let p = AB723_HEADER;

  p += `TASK: Replace sky in exterior photo\n\n`;

  p += `PRESERVE EXACTLY (do not alter):\n${exteriorData.preserveList}\n\n`;

  p += `SKY REPLACEMENT:\n`;
  p += `Current sky: ${exteriorData.skyCondition}\n`;
  p += `Replace with: ${skyType} sky\n\n`;

  if (skyType === 'day') {
    p += `DAY SKY: Clear blue sky, bright sunny conditions, soft shadows on house\n`;
    p += `Adjust house shadows and lighting to match bright daylight\n`;
    p += `Keep colors warm and inviting\n`;
  } else if (skyType === 'dusk') {
    p += `DUSK SKY: Golden hour lighting, warm orange/pink tones, soft shadows\n`;
    p += `Adjust house lighting and shadows to warm golden tones\n`;
    p += `Create romantic, appealing curb appeal\n`;
  } else if (skyType === 'night') {
    p += `NIGHT SKY: Dark evening sky with stars or moon, house exterior lit with landscape lighting\n`;
    p += `Add subtle exterior lighting to highlight house features\n`;
    p += `Maintain inviting appearance while showcasing nighttime curb appeal\n`;
  }

  p += `\nIMPORTANT:\n`;
  p += `— Preserve house structure exactly (walls, roof, windows, doors, trim)\n`;
  p += `— Preserve house color and siding texture\n`;
  p += `— Adjust shadows and lighting to match new sky condition\n`;
  p += `— Do NOT alter or move house elements\n`;
  p += `— Do NOT alter trees, large shrubs, or existing landscaping\n`;
  p += `— Result must show beautiful curb appeal with new sky\n\n`;

  p += `COMPLIANCE:\n`;
  p += `This enhancement per California AB 723 §10140.6.\n`;
  p += `House structure and architectural elements preserved exactly.\n`;
  p += `Sky replacement only — no structural alterations.`;

  return p.trim();
}

// ✅ BUILD LANDSCAPING ENHANCEMENT PROMPT
function buildLandscapingPrompt({ exteriorData, landscapeStyle, yardType }) {
  let p = AB723_HEADER;

  p += `TASK: Enhance landscaping in ${yardType} photo\n\n`;

  p += `PRESERVE EXACTLY (do not alter):\n${exteriorData.preserveList}\n\n`;

  p += `LANDSCAPING ENHANCEMENT:\n`;
  p += `Current landscaping: ${exteriorData.landscapingStatus}\n`;
  p += `Style: ${landscapeStyle}\n`;
  p += `Yard type: ${yardType}\n\n`;

  p += `Enhancement opportunities:\n`;
  exteriorData.landscapingEnhancementOpportunities.forEach(opp => {
    p += `— ${opp}\n`;
  });

  p += `\nENHANCEMENT APPROACH:\n`;
  p += `Add plants, flowers, shrubs, trees, and hardscape improvements in ${landscapeStyle} style\n`;
  p += `Focus on curb appeal and property value enhancement\n`;
  p += `Keep improvements proportional to yard and house\n\n`;

  p += `IMPORTANT:\n`;
  p += `— Preserve house structure exactly (walls, roof, windows, doors, trim, foundation)\n`;
  p += `— Preserve house color and siding texture\n`;
  p += `— Preserve large existing trees and major landscaping features\n`;
  p += `— Do NOT alter or move house elements\n`;
  p += `— Do NOT alter roof, siding, windows, or doors\n`;
  p += `— Add landscaping enhancements while maintaining realistic proportions\n`;
  p += `— Result must show attractive, well-maintained yard\n\n`;

  p += `COMPLIANCE:\n`;
  p += `This enhancement per California AB 723 §10140.6.\n`;
  p += `House structure and architectural elements preserved exactly.\n`;
  p += `Landscaping enhancement only — no structural alterations.`;

  return p.trim();
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
      openAIKey,
      mode,  // "build-prompt" or "execute"
      skyType,  // "day", "dusk", "night"
      yardType,  // "front|back|side"
      landscapeStyle  // "Mediterranean", "Modern", "Cottage", etc.
    } = JSON.parse(event.body);
    const claudeKey = process.env.ANTHROPIC_API_KEY;

    if (!imageBase64) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing imageBase64" }) };
    if (!claudeKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }) };

    const siteUrl = process.env.URL || process.env.DEPLOY_URL;
    if (!siteUrl) return { statusCode: 500, headers, body: JSON.stringify({ error: "Site URL not configured" }) };

    // Compress image if needed
    const { base64: readyBase64, mimeType: readyMime } = await prepareImage(imageBase64, mimeType);

    // ═══════════════════════════════════════════════════════════════════════════════
    // MODE 1: BUILD PROMPT FOR USER REVIEW
    // ═══════════════════════════════════════════════════════════════════════════════
    if (mode === "build-prompt") {
      // Analyze exterior
      const exteriorData = await analyzeExterior({ imageBase64: readyBase64, claudeKey });

      // Build prompts for both enhancements
      const skyPrompt = buildSkyReplacementPrompt({ exteriorData, skyType: skyType || exteriorData.skyRecommendation });
      const landscapePrompt = buildLandscapingPrompt({ exteriorData, landscapeStyle: landscapeStyle || "Modern", yardType: yardType || "Front Yard" });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          mode: "exterior-enhancements",
          exteriorData,
          options: {
            skyTypes: ["day", "dusk", "night"],
            yardTypes: ["Front Yard", "Backyard", "Side Yard"],
            landscapeStyles: ["Mediterranean", "Modern", "Cottage", "Japanese Zen", "Tropical", "Minimalist", "English Cottage", "Xeriscape"]
          },
          prompts: {
            skyReplacement: skyPrompt,
            landscaping: landscapePrompt
          },
          message: "Exterior enhancement options ready. Review prompts and choose: Sky Replacement, Landscaping, or Both."
        })
      };
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // MODE 2: EXECUTE SKY REPLACEMENT
    // ═══════════════════════════════════════════════════════════════════════════════
    if (mode === "sky-replacement") {
      if (!openAIKey) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing openAIKey" }) };

      const exteriorData = await analyzeExterior({ imageBase64: readyBase64, claudeKey });
      const skyPrompt = buildSkyReplacementPrompt({ exteriorData, skyType: skyType || "day" });
      const jobId = "sky-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);

      await triggerBackground({
        jobId,
        imageBase64: readyBase64,
        mimeType: readyMime,
        stagingPrompt: skyPrompt,
        quality: "low"
      }, siteUrl);

      return {
        statusCode: 202,
        headers,
        body: JSON.stringify({
          success: true,
          jobId,
          message: `Sky replacement (${skyType || 'day'})... Please wait`
        })
      };
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // MODE 3: EXECUTE LANDSCAPING
    // ═══════════════════════════════════════════════════════════════════════════════
    if (mode === "landscaping") {
      if (!openAIKey) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing openAIKey" }) };

      const exteriorData = await analyzeExterior({ imageBase64: readyBase64, claudeKey });
      const landscapePrompt = buildLandscapingPrompt({ exteriorData, landscapeStyle: landscapeStyle || "Modern", yardType: yardType || "Front Yard" });
      const jobId = "landscape-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);

      await triggerBackground({
        jobId,
        imageBase64: readyBase64,
        mimeType: readyMime,
        stagingPrompt: landscapePrompt,
        quality: "low"
      }, siteUrl);

      return {
        statusCode: 202,
        headers,
        body: JSON.stringify({
          success: true,
          jobId,
          message: `Landscaping enhancement (${landscapeStyle || 'Modern'})... Please wait`
        })
      };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid mode. Use: build-prompt, sky-replacement, or landscaping" }) };

  } catch (err) {
    console.error("exterior-enhancement error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
