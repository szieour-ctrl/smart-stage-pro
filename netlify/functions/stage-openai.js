// stage-openai.js — Job dispatcher
// Fires stage-openai-background and returns jobId immediately
// Image conversion to PNG happens in background function
//
// CHANGE (Oct 1, 2026 — draft monitoring + abuse protection). This endpoint used to
// be fully anonymous: no login check, and it trusted the caller's `quality`.
// Now:
//  • The caller's Supabase login token is read (same pattern as debit-credit.js).
//    STAGE_AUTH_MODE = "log" (DEFAULT) lets unauthenticated calls through but marks
//    them, so you can see in staging_usage whether any legit flow isn't sending a
//    token before you flip to "enforce", which rejects them with 401.
//  • Quality is no longer taken from the client. The server decides it:
//    env STAGE_QUALITY (default "low").
//  • Optional draft limits (OFF unless the env vars are set):
//      STAGE_DRAFT_LIMIT_PER_IMAGE  — max completed drafts per photo per user
//      STAGE_DRAFT_LIMIT_PER_MONTH  — max completed drafts per user, rolling 30 days
//      STAGE_LIMIT_EXEMPT_USER_IDS  — comma-separated user ids that skip both limits
//    Limits fail OPEN: if the usage table can't be read, staging is never blocked.
//  • Context (kind, projectId, imageKey) from the page is passed through so the
//    background function can record who staged what (table: staging_usage).
//  • The trigger to the background function now carries the shared INTERNAL_API_KEY
//    header (same secret debit-credit.js already uses) so the background function
//    can refuse direct calls once STAGE_BG_REQUIRE_KEY=true is set there.

const https = require("https");
const sharp = require("sharp");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

const AUTH_MODE = (process.env.STAGE_AUTH_MODE || "log").toLowerCase(); // "log" | "enforce"
const QUALITY   = ["low", "medium", "high"].includes(process.env.STAGE_QUALITY) ? process.env.STAGE_QUALITY : "low";
const LIMIT_PER_IMAGE = parseInt(process.env.STAGE_DRAFT_LIMIT_PER_IMAGE || "0", 10) || 0;
const LIMIT_PER_MONTH = parseInt(process.env.STAGE_DRAFT_LIMIT_PER_MONTH || "0", 10) || 0;
const EXEMPT_IDS = new Set((process.env.STAGE_LIMIT_EXEMPT_USER_IDS || "").split(",").map(s => s.trim()).filter(Boolean));

// Compress image if needed — keeps payload under Netlify's 6MB limit
// and reduces OpenAI processing time on large inputs
// Target: max 1536px on longest side, max 1.5MB file size
async function prepareImage(imageBase64, mimeType) {
  const buffer = Buffer.from(imageBase64, "base64");
  const meta = await sharp(buffer).metadata();
  const sizeKB = Math.round(buffer.length / 1024);
  const maxDim = Math.max(meta.width || 0, meta.height || 0);

  console.log(`Image input: ${meta.width}x${meta.height} ${sizeKB}KB format=${meta.format} channels=${meta.channels} hasAlpha=${meta.hasAlpha} orientation=${meta.orientation||'none'}`);

  // Netlify function-to-function payload limit is ~300KB
  // Target: max 1024px longest side, max 200KB — ensures payload stays under 280KB
  const TARGET_MAX_DIM = 768;  // Background function payload limit ~100KB — keep well under
  const TARGET_MAX_KB  = 80;

  const needsResize = maxDim > TARGET_MAX_DIM || sizeKB > TARGET_MAX_KB;
  const hasAlpha    = meta.hasAlpha || meta.channels === 4;
  const hasRotation = meta.orientation && meta.orientation !== 1;
  const isPNG       = meta.format === 'png';

  if (needsResize || hasAlpha || hasRotation || isPNG) {
    let pipeline = sharp(buffer)
      .rotate()
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .resize(TARGET_MAX_DIM, TARGET_MAX_DIM, { fit: "inside", withoutEnlargement: true });

    const normalized = await pipeline
      .jpeg({ quality: 85, mozjpeg: false })
      .toBuffer();

    const normMeta = await sharp(normalized).metadata();
    console.log(`Image normalized: ${normMeta.width}x${normMeta.height} ${Math.round(normalized.length/1024)}KB → JPEG`);
    return { base64: normalized.toString("base64"), mimeType: "image/jpeg" };
  }

  console.log(`Image OK: ${meta.width}x${meta.height} ${sizeKB}KB — no normalization needed`);
  return { base64: imageBase64, mimeType };
}

// ── Login check (same approach as debit-credit.js) ────────────────────────────
function verifyJWT(authHeader) {
  return new Promise((resolve) => {
    if (!SUPABASE_URL || !SERVICE_KEY) { resolve(null); return; }
    if (!authHeader || !authHeader.startsWith("Bearer ")) { resolve(null); return; }
    const jwt = authHeader.split(" ")[1];
    const url = new URL(`${SUPABASE_URL}/auth/v1/user`);
    const req = https.request({
      hostname: url.hostname, path: url.pathname, method: "GET",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${jwt}` },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { const p = JSON.parse(data); resolve(res.statusCode === 200 && p.id ? p : null); }
        catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ── Count rows in staging_usage (for the optional limits). Returns null on any
// problem so callers can fail open. ───────────────────────────────────────────
function countUsage(query) {
  return new Promise((resolve) => {
    if (!SUPABASE_URL || !SERVICE_KEY) { resolve(null); return; }
    const url = new URL(`${SUPABASE_URL}/rest/v1/staging_usage?select=id&status=eq.done&${query}`);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search, method: "GET",
      headers: {
        apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
        Prefer: "count=exact", Range: "0-0", "Range-Unit": "items",
      },
    }, (res) => {
      res.on("data", () => {});
      res.on("end", () => {
        const m = /\/(\d+)$/.exec(String(res.headers["content-range"] || ""));
        resolve(res.statusCode < 300 && m ? parseInt(m[1], 10) : null);
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function triggerBackground(payload, siteUrl) {
  const body = Buffer.from(JSON.stringify(payload));
  console.log(`Triggering background: payload ${Math.round(body.length / 1024)}KB`);
  const url = new URL(`${siteUrl}/.netlify/functions/stage-openai-background`);
  const headers = {
    "Content-Type": "application/json",
    "Content-Length": body.length,
  };
  // Shared secret so the background function can tell this call came from here.
  if (process.env.INTERNAL_API_KEY) headers["x-internal-key"] = process.env.INTERNAL_API_KEY;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers,
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const responseBody = Buffer.concat(chunks).toString("utf8").slice(0, 500);
        console.log(`Background response: status=${res.statusCode} body=${responseBody}`);
        resolve(res.statusCode);
      });
    });
    req.on("error", (err) => {
      console.error(`Background trigger network error: ${err.message}`);
      reject(err);
    });
    req.write(body);
    req.end();
  });
}

const clip = (v, n) => (typeof v === "string" ? v.slice(0, n) : null);

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };

  try {
    // NOTE: `quality` in the request body is deliberately ignored — see header comment.
    const { imageBase64, mimeType, stagingPrompt, ctx } = JSON.parse(event.body);
    if (!imageBase64)   return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing imageBase64" }) };
    if (!stagingPrompt) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing stagingPrompt" }) };

    // ── Who is calling? ──────────────────────────────────────────────────────
    const authUser = await verifyJWT(event.headers?.authorization || event.headers?.Authorization);
    if (!authUser) {
      if (AUTH_MODE === "enforce") {
        return { statusCode: 401, headers, body: JSON.stringify({ error: "Please sign in again to continue staging.", code: "UNAUTHORIZED" }) };
      }
      console.warn("stage-openai: unauthenticated request (STAGE_AUTH_MODE=log — allowing, will be recorded as authed=false)");
    }
    const userId    = authUser ? authUser.id : null;
    const kind      = clip(ctx && ctx.kind, 40);
    const projectId = clip(ctx && ctx.projectId, 120);
    const imageKey  = clip(ctx && ctx.imageKey, 200);

    // ── Optional draft limits (off unless env vars are set; fail open) ───────
    if (userId && !EXEMPT_IDS.has(userId)) {
      if (LIMIT_PER_IMAGE > 0 && imageKey) {
        const n = await countUsage(`user_id=eq.${userId}&image_key=eq.${encodeURIComponent(imageKey)}`);
        if (n !== null && n >= LIMIT_PER_IMAGE) {
          console.warn(`stage-openai: per-image draft limit hit user=${userId} key=${imageKey} count=${n}`);
          return { statusCode: 429, headers, body: JSON.stringify({
            error: `Draft limit reached for this photo (${LIMIT_PER_IMAGE} drafts). Generate Final on your best version, or contact support to raise the limit.`,
            code: "DRAFT_LIMIT" }) };
        }
      }
      if (LIMIT_PER_MONTH > 0) {
        const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const n = await countUsage(`user_id=eq.${userId}&created_at=gte.${encodeURIComponent(since)}`);
        if (n !== null && n >= LIMIT_PER_MONTH) {
          console.warn(`stage-openai: monthly draft limit hit user=${userId} count=${n}`);
          return { statusCode: 429, headers, body: JSON.stringify({
            error: `Monthly draft limit reached (${LIMIT_PER_MONTH} drafts in 30 days). Generate Final on your best versions, or contact support to raise the limit.`,
            code: "DRAFT_LIMIT" }) };
        }
      }
    }

    // Always use Netlify subdomain for function-to-function calls —
    // custom domain redirects break background function 202 handshake
    const siteUrl = process.env.NETLIFY_URL || "https://smart-stage-pro.netlify.app";
    console.log(`Using trigger URL base: ${siteUrl}`);

    // Compress if large — protects against subscriber uploading 10MB photos
    const { base64: readyBase64, mimeType: readyMime } = await prepareImage(imageBase64, mimeType);

    const jobId = "oai-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);

    // Retry up to 3 times — Netlify background functions intermittently return 500
    let triggerStatus;
    for (let attempt = 1; attempt <= 3; attempt++) {
      triggerStatus = await triggerBackground({
        jobId, imageBase64: readyBase64, mimeType: readyMime, stagingPrompt,
        quality: QUALITY,
        userId, authed: !!userId, kind, projectId, imageKey,
      }, siteUrl);

      console.log(`Job ${jobId}: attempt ${attempt} background trigger status = ${triggerStatus}`);

      if (triggerStatus === 202) break;
      if (attempt < 3) {
        console.log(`Job ${jobId}: retrying in 2 seconds...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    if (triggerStatus !== 202) {
      console.error(`Job ${jobId}: background trigger FAILED after 3 attempts, last status ${triggerStatus}`);
      return { statusCode: 500, headers, body: JSON.stringify({ error: `Background function trigger failed after 3 attempts: ${triggerStatus}` }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ jobId }) };

  } catch (err) {
    console.error("stage-openai error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
