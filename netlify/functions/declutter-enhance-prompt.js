// declutter-enhance-prompt.js — Netlify Function
// AI Enhance for Declutter — Iteration Lightbox "AI Enhance" tab
//
// Instead of blindly re-running the same first-pass read that already
// struggled on a messy room, this compares BEFORE (original occupied photo)
// against AFTER (the actual decluttered result) and builds a targeted
// correction prompt for a surgical follow-up edit — same "edit-only, don't
// regenerate the whole thing" pattern iterateRoom()/reStageRoom() already
// use for staging revisions.
//
// Explicitly checks the three known recurring hallucination patterns
// (invented shower doors/enclosures, closet rod removal/duplication,
// vanity cabinet removal) on top of whatever else the comparison catches,
// since those are the confirmed, repeat failure modes for this pipeline.
//
// Input:  { originalBase64, originalMimeType, resultBase64, resultMimeType, userNote }
// Output: { issuesFound, correctionPrompt, analysis }

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

// Same compression contract as declutter-prompt.js's prepareImage — Haiku
// only needs to READ both photos, not reproduce them.
async function prepareImage(imageBase64) {
  const buffer = Buffer.from(imageBase64, 'base64');
  const meta = await sharp(buffer).metadata();
  const sizeKB = Math.round(buffer.length / 1024);
  const maxDim = Math.max(meta.width || 0, meta.height || 0);
  if (maxDim <= 768 && sizeKB <= 80) return imageBase64;
  const compressed = await sharp(buffer)
    .rotate()
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(768, 768, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  return compressed.toString('base64');
}

async function analyzeDeclutterResult({ originalBase64, resultBase64, claudeKey, userNote }) {
  const prompt = `You are reviewing the result of an AI decluttering pass on a real estate photo. You will see two photos of the SAME room: BEFORE (the original occupied room) and AFTER (the result after furniture/decor removal).

TASK: Compare BEFORE and AFTER. Identify anything in AFTER that needs correcting in a follow-up edit pass.

CHECK SPECIFICALLY FOR THESE KNOWN FAILURE PATTERNS, in addition to anything else you notice:
1. SHOWER: If BEFORE shows a shower curtain that is gone in AFTER, AFTER should show a bare curtain rod with an open shower/tub — NOT a glass door, sliding panel, or enclosure. Flag it if one was invented that wasn't in BEFORE.
2. CLOSET RODS: If BEFORE shows a closet, AFTER must have the exact same number of hanging rods in the same position. Flag if a rod was removed, or if a second/lower rod was added that wasn't in BEFORE (no invented double-hang).
3. VANITY CABINETS: If BEFORE shows bathroom vanity cabinetry (upper and/or lower, including medicine cabinets), AFTER must preserve ALL of it exactly. Flag if any upper cabinet, medicine cabinet, or lower cabinet was removed or altered.

ALSO CHECK FOR:
- Leftover furniture/decor from BEFORE that's still visible in AFTER (incomplete removal)
- Any other permanent architecture (walls, windows, doors, other cabinetry, fixtures, flooring) altered, removed, or added in AFTER that wasn't like that in BEFORE
- Any new doorway, opening, or architectural feature invented in AFTER that wasn't in BEFORE

${userNote ? `THE USER ALSO SPECIFICALLY NOTED: "${userNote}" — treat this as a priority item to include in the correction.\n\n` : ''}Return ONLY valid JSON — no markdown:

{
  "issuesFound": true or false,
  "issues": ["short plain description of each specific issue found, one per item — empty array if none"],
  "correctionInstructions": "One clear paragraph of specific edit instructions for a follow-up inpainting pass, describing ONLY what needs to change and where. If issuesFound is false but a user note was given, base this entirely on the user note instead."
}`;

  const payload = JSON.stringify({
    model: "claude-haiku-4-5",
    max_tokens: 1000,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "BEFORE — original occupied room:" },
        { type: "image", source: { type: "base64", media_type: detectMime(originalBase64), data: originalBase64 } },
        { type: "text", text: "AFTER — decluttered result:" },
        { type: "image", source: { type: "base64", media_type: detectMime(resultBase64), data: resultBase64 } },
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

  if (result.status !== 200) throw new Error("Haiku enhance analysis failed: " + (result.body?.error?.message || result.status));

  const text = result.body?.content?.[0]?.text?.trim() || "{}";
  const clean = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(clean); }
  catch(e) { throw new Error("Enhance analysis JSON parse failed"); }
}

function buildCorrectionPrompt({ analysis }) {
  let p = `PRIMARY ROLE: Edit this already-decluttered photo. Make ONLY the correction(s) described below — everything else (the furniture-free state, architecture, lighting, camera angle) must stay exactly as shown.\n\n`;
  p += `CORRECTIONS NEEDED:\n${analysis.correctionInstructions}\n\n`;
  p += `RULES:\n`;
  p += `1. Do not re-declutter or reprocess the whole room — this is a targeted edit only\n`;
  p += `2. Do not alter anything not explicitly mentioned in the corrections above\n`;
  p += `3. Never invent a shower door, glass enclosure, or panel that wasn't in the original photo\n`;
  p += `4. Closet hanging rods must match the original count and position exactly\n`;
  p += `5. Bathroom vanity cabinetry (upper and lower, including medicine cabinets) must be fully preserved\n`;
  p += `6. Maintain the exact same camera angle, field of view, and framing — do not crop, zoom, or reframe\n\n`;
  p += `This image is prepared per California AB 723 §10140.6 for virtual staging — accurate architectural preservation is a compliance requirement, not a style preference.`;
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
    const { originalBase64, resultBase64, userNote } = JSON.parse(event.body || "{}");
    const claudeKey = process.env.ANTHROPIC_API_KEY;

    if (!originalBase64) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing originalBase64" }) };
    if (!resultBase64)   return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing resultBase64" }) };
    if (!claudeKey)      return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }) };

    const [compressedOriginal, compressedResult] = await Promise.all([
      prepareImage(originalBase64),
      prepareImage(resultBase64),
    ]);

    const analysis = await analyzeDeclutterResult({
      originalBase64: compressedOriginal,
      resultBase64: compressedResult,
      claudeKey,
      userNote: (userNote || "").trim(),
    });

    const correctionPrompt = buildCorrectionPrompt({ analysis });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        issuesFound: !!analysis.issuesFound,
        issues: analysis.issues || [],
        correctionPrompt,
        message: analysis.issuesFound
          ? "AI Enhance found issues to correct. Review the prompt, then apply."
          : "AI Enhance found no issues against the original photo.",
      })
    };

  } catch (err) {
    console.error("declutter-enhance-prompt error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
