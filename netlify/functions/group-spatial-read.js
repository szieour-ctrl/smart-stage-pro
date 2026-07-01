// group-spatial-read.js — Dispatcher + Preserve Mode
//
// MODE: spatial — Dispatches to background function, returns jobId immediately.
//   Client polls check-spatial-read.js every 3 seconds.
//   Background handles the slow Haiku multi-image read (~30s).
//
// MODE: preserve — Runs inline (fast, ~2-3s single image).
//   Reads one image for PRESERVE list.
//   Assembles final GPT prompt from zone assignments + PRESERVE + session DNA.
//   Returns promptText ready for GPT Image 2.

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

// ✅ AB 723 COMPLIANCE HEADER — Prepended to every prompt
const AB723_HEADER = `PRIMARY ROLE: Stage furniture and decor ONLY.

IMMUTABLE LOCK: Never alter, move, remove, replace, or touch: structural walls | ceilings | kitchen/bathroom cabinets | countertops | lighting fixtures. These must be preserved exactly as photographed.

AB 723 COMPLIANCE: Virtual staging adds furniture only. Any alteration to permanent architecture makes the listing non-compliant and subject to MLS removal.

═══════════════════════════════════════════════════════════════════════════════

`;

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

// NOTE: runPreserveRead (Haiku-based PRESERVE list generation) was removed here in Phase 6.2.
// The "preserve" mode name is kept for frontend/endpoint compatibility, but it no longer calls
// Haiku — see assembleSpatialZonePrompt below for the new template-substitution approach.

// ══════════════════════════════════════════════════════════════════════════
// SPATIAL ZONE ANALYSIS MODE — proofed prompt template (Phase 6.2)
// Two variable slots only: {{room_assignment_variables}} and the Design DNA block.
// GPT Image 2 does its own spatial/anchor reasoning — no Haiku description layer,
// no per-zone hand-written furniture scripts. The user's own zone selections are
// the only "translation" — everything else is the fixed template text below, verbatim.
// ══════════════════════════════════════════════════════════════════════════
// SPATIAL ZONE ANALYSIS MODE — proofed prompt template (Phase 6.2)
// Now lives in spatial-zone-template.js (shared with stage-vacant-prompt.js) so
// every staging prompt in the app — Multi-Angle Group Stage (if revived), plain
// Vacant Stage, and Clean+Stage step 2 — all use the exact same template/assembler.
// No per-file duplicate copies that can drift.
// ══════════════════════════════════════════════════════════════════════════
const { assembleSpatialZonePrompt, STYLE_LABELS, PALETTE_TONES } = require('./spatial-zone-template');

async function triggerBackground(payload, siteUrl) {
  const body = Buffer.from(JSON.stringify(payload));
  console.log('Triggering group-spatial-read-background: payload ' + Math.round(body.length / 1024) + 'KB');
  const url = new URL(siteUrl + '/.netlify/functions/group-spatial-read-background');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": body.length }
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const resp = Buffer.concat(chunks).toString("utf8");
        console.log('Background response: status=' + res.statusCode + ' body=' + resp.slice(0, 200));
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
  const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Content-Type": "application/json" };

  try {
    const body = JSON.parse(event.body);
    console.log('🔍 DISPATCHER RECEIVED body:', JSON.stringify({ mode: body.mode, imagesCount: body.images?.length, hasImageBase64: !!body.imageBase64 }));

    // MODE: spatial — fire background, return jobId
    if (body.mode === 'spatial' || (!body.mode && body.images && !body.imageBase64)) {
      const claudeKey = process.env.ANTHROPIC_API_KEY;
      if (!claudeKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }) };
      console.log('📡 SPATIAL MODE DETECTED - extracting images');
      const { images, groupType, designStyle, colorPalette, groupSpatialPlan } = body;
      console.log('✅ Extracted images count:', images?.length || 'undefined');
      if (images.length > 5)            return { statusCode: 400, headers, body: JSON.stringify({ error: "Maximum 5 images" }) };

      const siteUrl = process.env.URL || process.env.DEPLOY_URL;
      if (!siteUrl) return { statusCode: 500, headers, body: JSON.stringify({ error: "Site URL not configured" }) };

      const readyImages = await Promise.all(images.map(async (img) => ({
        ...img, base64: await compressForRead(img.base64), mimeType: "image/jpeg"
      })));

      const jobId = "gsr-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      console.log('✅ Generated jobId:', jobId);

      // ✅ FIXED: Pass images (NOT imageDataArray), designStyle, colorPalette, groupSpatialPlan
      console.log('📤 Triggering background with:', { jobId, imagesCount: readyImages.length });
      const triggerStatus = await triggerBackground({ 
        jobId, 
        mode: 'spatial', 
        images: readyImages,
        designStyle: designStyle || 'Transitional',
        colorPalette: colorPalette || 'Warm Neutrals',
        groupSpatialPlan: groupSpatialPlan || null
      }, siteUrl);
      console.log('Job ' + jobId + ': background trigger status = ' + triggerStatus);

      if (triggerStatus !== 202) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Background trigger failed: ' + triggerStatus }) };
      }
      console.log('✅ RETURNING jobId SUCCESS');
      return { statusCode: 200, headers, body: JSON.stringify({ jobId }) };
    }

    // MODE: preserve — kept as the endpoint name for frontend compatibility, but no longer
    // calls Haiku. Phase 6.2: assembles the SPATIAL ZONE ANALYSIS template directly from the
    // user's own Image Assignment selections + Session DNA. No AI translation layer.
    if (body.mode === 'preserve') {
      const { imageLabel, zoneList, flexNote, roomName, isOpenPlan, designStyle, colorPalette, buyerProfile, desiredFeeling, stagingLevel, furnishingsDNA, projectId } = body;

      console.log('Assembling spatial zone prompt: ' + imageLabel + (furnishingsDNA ? ' (with furnishings DNA)' : ''));
      const promptText = assembleSpatialZonePrompt({
        zones: { zoneList: zoneList || [], flexNote: flexNote || '', roomName: roomName || imageLabel, isOpenPlan: !!isOpenPlan },
        dna: {
          style: STYLE_LABELS[designStyle?.toLowerCase()] || designStyle || 'Transitional',
          palette: PALETTE_TONES[colorPalette] || colorPalette || 'Warm Neutrals',
          buyerProfile: buyerProfile || '',
          desiredFeeling: desiredFeeling || '',
          stagingLevel: stagingLevel || '',
          furnishingsDNA: furnishingsDNA || null,
          projectId: projectId || null,
        }
      });

      console.log('Prompt assembly complete: ' + promptText.length + ' chars');
      return { statusCode: 200, headers, body: JSON.stringify({ mode: 'preserve', promptText }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid mode — use spatial or preserve" }) };

  } catch (err) {
    console.error("🔴 DISPATCHER ERROR:", err.message);
    console.error("🔴 ERROR STACK:", err.stack);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
