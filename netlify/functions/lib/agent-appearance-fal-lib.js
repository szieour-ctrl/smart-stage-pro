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
  };
}
function realStorage(env = process.env) {
  const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
  const s3 = new S3Client({ region: env.S3_REGION, credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY } });
  return { put: (Key, Body, ContentType) => s3.send(new PutObjectCommand({ Bucket: env.S3_BUCKET_NAME, Key, Body, ContentType })) };
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
const realDeps = (env = process.env) => ({ db: realDb(env), storage: realStorage(env), runner: falRunner(env), download, probe, uuid: () => crypto.randomUUID() });

module.exports = { falRunner, download, probe, supabase, realDb, realStorage, presignOwn, realDeps };
