// stage-openai-background.js — Netlify Background Function
// Calls GPT Image 2, stores result in Netlify Blobs via SDK
// Client polls check-openai.js every 3 seconds for result
//
// CHANGE (Oct 1, 2026 — draft monitoring + abuse protection):
//  • Every finished call (done or error) is recorded in the Supabase table
//    staging_usage: who, which project/photo, what kind of call (stage, iterate,
//    preset...), the REAL token usage OpenAI reports, and an estimated cost. Logging
//    never affects the job — any failure to log is swallowed.
//  • Optional shared-secret check: set STAGE_BG_REQUIRE_KEY=true and this function
//    ignores any call that doesn't carry the INTERNAL_API_KEY header that
//    stage-openai.js now sends. Leave unset until stage-openai.js with the new
//    code has been live for a bit.
//  • Model name can be switched from the Netlify dashboard with OPENAI_IMAGE_MODEL
//    (default "gpt-image-2", so nothing changes unless you set it).

const https = require("https");
const crypto = require("crypto");
const sharp = require("sharp");
const { getStore } = require("@netlify/blobs");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const IMAGE_MODEL  = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";

// USD per 1M tokens — gpt-image-2 list prices (text in $5, image in $8, image out $30).
// If prices or the model change, the token columns in staging_usage stay correct and
// cost can be recomputed in SQL; only est_cost_usd would be off.
const PRICE_PER_M = { text: 5, image: 8, out: 30 };

function estimateCost(usage) {
  if (!usage) return null;
  const d = usage.input_tokens_details || {};
  if (d.text_tokens == null || d.image_tokens == null || usage.output_tokens == null) return null;
  return (d.text_tokens * PRICE_PER_M.text + d.image_tokens * PRICE_PER_M.image + usage.output_tokens * PRICE_PER_M.out) / 1e6;
}

// Best-effort insert into staging_usage. Never throws.
function logUsage(row) {
  return new Promise((resolve) => {
    try {
      if (!SUPABASE_URL || !SERVICE_KEY) { resolve(); return; }
      const payload = JSON.stringify(row);
      const url = new URL(`${SUPABASE_URL}/rest/v1/staging_usage`);
      const req = https.request({
        hostname: url.hostname, path: url.pathname, method: "POST",
        headers: {
          apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json", Prefer: "return=minimal",
          "Content-Length": Buffer.byteLength(payload),
        },
      }, (res) => {
        res.on("data", () => {});
        res.on("end", () => {
          if (res.statusCode >= 300) console.warn(`staging_usage insert returned ${res.statusCode}`);
          resolve();
        });
      });
      req.on("error", (e) => { console.warn("staging_usage insert failed:", e.message); resolve(); });
      req.setTimeout(5000, () => { req.destroy(); resolve(); });
      req.write(payload);
      req.end();
    } catch (e) { console.warn("staging_usage log error:", e.message); resolve(); }
  });
}

function internalKeyOk(event) {
  const expected = process.env.INTERNAL_API_KEY;
  const got = event.headers?.["x-internal-key"] || event.headers?.["X-Internal-Key"];
  if (!expected || !got) return false;
  const a = Buffer.from(String(got));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ✅ AB 723 COMPLIANCE HEADER — Prepended to every prompt sent to GPT
const AB723_HEADER = `You are an MLS virtual staging assistant operating under California AB 723 §10140.6.

PRIMARY ROLE: Stage furniture and decor ONLY.

IMMUTABLE LOCK: Never alter, move, remove, replace, or touch: structural walls | ceilings | kitchen/bathroom cabinets | countertops | lighting fixtures. These must be preserved exactly as photographed.

FRAMING LOCK: Preserve the EXACT original camera framing, angle, field of view, and crop of the input photo. Do not recompose, reframe, zoom in/out, pan, or shift what is visible at the edges of the shot. The output must show precisely the same extent of the room — same walls, same edges, same amount of visible space on every side — as the input image. This applies on every edit pass, including revisions to an already-staged photo: never narrow or shift the field of view from what was already visible.

AB 723 COMPLIANCE: Virtual staging adds furniture only. Any alteration to permanent architecture makes the listing non-compliant and subject to MLS removal.

═══════════════════════════════════════════════════════════════════════════════

`;

function buildOpenAIMultipart(imageBuffer, imageMime, prompt, quality, size) {
  const boundary = "----OAIBoundary" + Math.random().toString(36).slice(2);
  const outputSize = size || "1536x1024";
  const parts = [];
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${IMAGE_MODEL}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${prompt}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="n"\r\n\r\n1`);
  // Size auto-detected from input: landscape photos → 1536x1024, square inputs → 1024x1024
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\n${outputSize}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="quality"\r\n\r\n${quality || "low"}`);
  const textBuf = Buffer.from(parts.join("\r\n") + "\r\n", "utf8");
  const fileHdr = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="room.png"\r\nContent-Type: ${imageMime}\r\n\r\n`,
    "utf8"
  );
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return { body: Buffer.concat([textBuf, fileHdr, imageBuffer, closing]), boundary };
}

async function callOpenAI(imageBase64, mimeType, prompt, apiKey, quality) {
  // OpenAI edits endpoint requires PNG — convert regardless of input format
  const rawBuffer = Buffer.from(imageBase64, "base64");
  const imageBuffer = await sharp(rawBuffer).png().toBuffer();
  // Detect aspect ratio to set correct output size
  // Square input (remove-objects) → 1024x1024
  // Landscape input (listing photos) → 1536x1024
  // Portrait input → 1024x1536
  const meta = await sharp(rawBuffer).metadata();
  const w = meta.width || 1024;
  const h = meta.height || 1024;
  let outputSize;
  if (Math.abs(w - h) < 100) outputSize = "1024x1024";
  else if (w > h) outputSize = "1536x1024";
  else outputSize = "1024x1536";
  console.log(`OpenAI: prompt ${prompt.length} chars, image ${Math.round(rawBuffer.length/1024)}KB → PNG ${Math.round(imageBuffer.length/1024)}KB quality=${quality||"low"} size=${outputSize} input=${w}x${h}`);
  
  // ✅ LOCATION 4: Wrap prompt with AB 723 header
  const wrappedPrompt = AB723_HEADER + prompt;
  
  const { body, boundary } = buildOpenAIMultipart(imageBuffer, "image/png", wrappedPrompt, quality, outputSize);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.openai.com",
      path: "/v1/images/edits",
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      }
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (res.statusCode !== 200) reject(new Error(`OpenAI error ${res.statusCode}: ${JSON.stringify(parsed).slice(0,300)}`));
          else resolve(parsed);
        } catch(e) { reject(new Error("OpenAI parse error")); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  // Optional: ignore calls that didn't come from stage-openai.js (see header comment).
  if (process.env.STAGE_BG_REQUIRE_KEY === "true" && !internalKeyOk(event)) {
    console.warn("stage-openai-background: rejected call without a valid internal key");
    return;
  }

  const openAIKey = process.env.OPENAI_API_KEY;
  const siteID    = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
  const token     = process.env.NETLIFY_ACCESS_TOKEN;
  let jobId;
  const startedAtMs = Date.now();
  let meta = { userId: null, authed: false, kind: null, projectId: null, imageKey: null, quality: null };
  let usage = null;
  try {
    const { jobId: jId, imageBase64, mimeType, stagingPrompt, quality, userId, authed, kind, projectId, imageKey } = JSON.parse(event.body);
    jobId = jId;
    meta = { userId: userId || null, authed: !!authed, kind: kind || null, projectId: projectId || null, imageKey: imageKey || null, quality: quality || "low" };
    console.log(`Job ${jobId} starting... siteID=${siteID ? "SET" : "MISSING"} token=${token ? "SET" : "MISSING"}`);

    if (!siteID) throw new Error("NETLIFY_SITE_ID not configured");
    if (!token)  throw new Error("NETLIFY_ACCESS_TOKEN not configured");
    if (!openAIKey) throw new Error("OPENAI_API_KEY not configured");

    const store = getStore({ name: "staging-jobs", siteID, token });

    // Write heartbeat immediately — confirms background function is running
    await store.setJSON(jobId, { status: "processing", startedAt: Date.now() });
    console.log(`Job ${jobId}: heartbeat written`);

    // Call GPT Image 2 with wrapped prompt
    const result = await callOpenAI(imageBase64, mimeType, stagingPrompt, openAIKey, quality);
    usage = result?.usage || null;
    const stagedBase64 = result?.data?.[0]?.b64_json;
    if (!stagedBase64) throw new Error("No image data in OpenAI response");
    // Diagnostic (this session): confirms whether OpenAI's actual returned
    // image matches the requested size, or whether it silently returns
    // something else — the size logged before the call was only ever the
    // REQUEST, never verified against what actually came back. If the
    // framing-lock prompt instruction above doesn't fully resolve the
    // crop issue, this line is the next piece of real evidence needed.
    try {
      const returnedMeta = await sharp(Buffer.from(stagedBase64, "base64")).metadata();
      console.log(`Job ${jobId}: OpenAI returned ${returnedMeta.width}x${returnedMeta.height} (${Math.round(stagedBase64.length/1024)}KB)`);
    } catch (metaErr) {
      console.warn(`Job ${jobId}: could not read returned image dimensions —`, metaErr.message);
    }

    // Store result via SDK — no presigned URL expiry issues
    await store.setJSON(jobId, { status: "done", stagedBase64 });
    console.log(`Job ${jobId}: stored in Blobs`);

    // Record the call (best effort — never affects the job).
    const d = (usage && usage.input_tokens_details) || {};
    await logUsage({
      job_id: jobId, user_id: meta.userId, authed: meta.authed, kind: meta.kind,
      project_id: meta.projectId, image_key: meta.imageKey,
      model: IMAGE_MODEL, quality: meta.quality, status: "done",
      input_text_tokens: d.text_tokens ?? null, input_image_tokens: d.image_tokens ?? null,
      output_tokens: usage ? (usage.output_tokens ?? null) : null,
      est_cost_usd: estimateCost(usage), duration_ms: Date.now() - startedAtMs,
    });

  } catch (err) {
    console.error(`Job ${jobId} error:`, err.message);
    try {
      const store = getStore({ name: "staging-jobs", siteID, token });
      await store.setJSON(jobId, { status: "error", error: err.message });
    } catch(e) {}
    if (jobId) {
      await logUsage({
        job_id: jobId, user_id: meta.userId, authed: meta.authed, kind: meta.kind,
        project_id: meta.projectId, image_key: meta.imageKey,
        model: IMAGE_MODEL, quality: meta.quality, status: "error",
        error: String(err.message || "").slice(0, 300), duration_ms: Date.now() - startedAtMs,
      });
    }
  }
};
