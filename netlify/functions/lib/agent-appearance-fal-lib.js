// lib/agent-appearance-fal-lib.js — the outside pieces for the Appearance Sheet: the fal runner, the downloader, the image probe, and the Supabase and S3 helpers (Nov 27, 2026).
// Reads FAL_KEY from the Netlify Functions environment. Subscribers never see vendor names: callers show the generic messages from agent-appearance-run-lib.
"use strict";
const https = require("https");
const crypto = require("crypto");

function falRunner(env = process.env, clientFactory) {
  return {
    async run(endpoint, input) {
      if (!env.FAL_KEY) throw new Error("FAL_KEY is not set");
      const { fal } = clientFactory ? clientFactory() : require("@fal-ai/client");
      fal.config({ credentials: env.FAL_KEY });
      const res = await fal.subscribe(endpoint, { input, logs: false });
      return { requestId: res.requestId, data: res.data };
    },
  };
}

async function download(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download failed (${r.status})`);
  return { buffer: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get("content-type") };
}
async function probe(buffer) {
  const m = await require("sharp")(buffer).metadata();
  return { width: m.width || null, height: m.height || null };
}

function supabase(method, pathAndQuery, body, env = process.env) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${env.SUPABASE_URL}/rest/v1/${pathAndQuery}`);
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({ hostname: url.hostname, path: url.pathname + url.search, method, headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation",
      ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}) } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(d || "null"); } catch { j = d; } resolve({ status: res.statusCode, data: j }); });
    });
    req.setTimeout(8000, () => req.destroy(new Error("Supabase request timed out")));
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Real database helpers in the shape run-lib expects.
function realDb(env = process.env) {
  const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what} failed (${r.status})`); return r.data; };
  const rpc = async (fn, sheetId) => { const r = await supabase("POST", `rpc/${fn}`, { p_sheet: sheetId }, env); ok(r, fn); return Number(r.data); };
  return {
    debit: (id) => rpc("appearance_pool_debit", id),
    refund: (id) => rpc("appearance_pool_refund", id),
    refill: (id) => rpc("appearance_pool_refill", id),
    insertCall: async (row) => { const d = ok(await supabase("POST", "agent_appearance_calls", row, env), "insert call"); return d[0].id; },
    updateCall: async (id, fields) => ok(await supabase("PATCH", `agent_appearance_calls?id=eq.${encodeURIComponent(id)}`, fields, env), "update call"),
    insertAsset: async (row) => { const d = ok(await supabase("POST", "agent_appearance_assets", row, env), "insert asset"); return d[0].id; },
    // slice 2: sheet, asset, call and profile reads and writes
    getSheet: async (userId) => { const d = ok(await supabase("GET", `agent_appearance_sheets?user_id=eq.${encodeURIComponent(userId)}&select=*&limit=1`, null, env), "read sheet"); return d[0] || null; },
    ensureSheet: async function (userId) {
      const have = await this.getSheet(userId); if (have) return have;
      const r = await supabase("POST", "agent_appearance_sheets", { user_id: userId }, env);
      if (r.status < 300 && r.data && r.data[0]) return r.data[0];
      const again = await this.getSheet(userId); if (again) return again;   // two tabs created it at once: the unique index kept one
      throw new Error(`create sheet failed (${r.status})`);
    },
    patchSheet: async (id, f) => ok(await supabase("PATCH", `agent_appearance_sheets?id=eq.${encodeURIComponent(id)}`, f, env), "update sheet"),
    listAssets: async (sheetId) => ok(await supabase("GET", `agent_appearance_assets?sheet_id=eq.${encodeURIComponent(sheetId)}&select=*&order=created_at.asc&limit=500`, null, env), "list assets"),
    getAsset: async (id, userId) => { const d = ok(await supabase("GET", `agent_appearance_assets?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}&select=*&limit=1`, null, env), "read asset"); return d[0] || null; },
    patchAsset: async (id, f) => ok(await supabase("PATCH", `agent_appearance_assets?id=eq.${encodeURIComponent(id)}`, f, env), "update asset"),
    lastCallsAny: async (sheetId, n = 50) => ok(await supabase("GET", `agent_appearance_calls?sheet_id=eq.${encodeURIComponent(sheetId)}&select=id,status,started_at,stage,note,output_asset_id,attempt&order=started_at.desc&limit=${Number(n) || 50}`, null, env), "list calls"),
    lastCalls: async (sheetId, stage, n = 5) => ok(await supabase("GET", `agent_appearance_calls?sheet_id=eq.${encodeURIComponent(sheetId)}&stage=eq.${encodeURIComponent(stage)}&select=id,status,started_at,attempt&order=started_at.desc&limit=${Math.max(1, Math.min(100, n))}`, null, env), "list calls"),
    getProfile: async (userId) => { const d = ok(await supabase("GET", `marketing_profiles?user_id=eq.${encodeURIComponent(userId)}&is_default=eq.true&select=id,headshot_key&limit=1`, null, env), "read profile"); return d[0] || null; },
    patchProfile: async (id, f) => ok(await supabase("PATCH", `marketing_profiles?id=eq.${encodeURIComponent(id)}`, f, env), "update profile"),
  };
}
function realStorage(env = process.env) {
  const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
  const s3 = new S3Client({ region: env.S3_REGION, credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY } });
  const { GetObjectCommand } = require("@aws-sdk/client-s3");
  return {
    put: (Key, Body, ContentType) => s3.send(new PutObjectCommand({ Bucket: env.S3_BUCKET_NAME, Key, Body, ContentType })),
    get: async (Key) => { const r = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET_NAME, Key })); const chunks = []; for await (const c of r.Body) chunks.push(c); return Buffer.concat(chunks); },
  };
}
// A short-lived link for a subscriber's own private image (the browser can show it; it expires).
async function presignOwn(userId, key, secs = 900, env = process.env) {
  const A = require("./agent-appearance-lib");
  if (!A.isOwnKey(userId, key)) return null;
  const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
  const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
  const s3 = new S3Client({ region: env.S3_REGION, credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY } });
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: env.S3_BUCKET_NAME, Key: key }), { expiresIn: secs });
}
// The working copy of an upload: turned upright, shrunk to at most 1600 px on its long side, saved as JPEG.
async function normalize(buffer, maxSide) {
  const H = require("./agent-appearance-headshot-lib");
  const m = maxSide || H.WORK_MAX_SIDE;
  const out = await require("sharp")(buffer).rotate().resize({ width: m, height: m, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer({ resolveWithObject: true });
  return { buffer: out.data, width: out.info.width, height: out.info.height, contentType: "image/jpeg" };
}
const preview = (buffer) => require("sharp")(buffer).rotate().resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
const realDeps = (env = process.env, userId = null) => ({
  preview,
  db: realDb(env), storage: realStorage(env), runner: falRunner(env), download, probe, uuid: () => crypto.randomUUID(), normalize,
  presign: (userId, key, secs) => presignOwn(userId, key, secs, env),
  vision: (b64, mediaType) => require("./agent-appearance-headshot-lib").callVision(b64, mediaType, env.ANTHROPIC_API_KEY),
  charge: (images, reason, isRefund) => require("./reel-quota-lib").callDebitCredit(userId, images, reason, isRefund),
});

module.exports = { falRunner, download, probe, supabase, realDb, realStorage, presignOwn, normalize, realDeps };
