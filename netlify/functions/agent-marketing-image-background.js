// agent-marketing-image-background.js — Netlify Background Function. Generates ONE concept image with GPT Image 2.
// Dispatched only by agent-marketing-images.js (shared internal key). The asset row (already created, state "generating")
// holds everything needed; this function re-checks ownership and the feature switch, calls OpenAI, stores the PNG in a
// private per-user folder and writes the result into the row. On failure it marks the row "error" and refunds any charge.
const https = require("https");
const crypto = require("crypto");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { supabase } = require("./lib/marketing-profile-lib");
const am = require("./lib/agent-marketing-lib");
const img = require("./lib/agent-marketing-images-lib");
const quota = require("./lib/reel-quota-lib");

const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
const s3 = new S3Client({ region: process.env.S3_REGION, credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } });

async function s3Bytes(key) {
  const r = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: key }));
  const chunks = []; for await (const c of r.Body) chunks.push(c);
  return Buffer.concat(chunks);
}

function openaiJson(path, bodyObj, apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const req = https.request({ hostname: "api.openai.com", path, method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, json: null, raw: d.slice(0, 300) }); } });
    });
    req.setTimeout(240000, () => req.destroy(new Error("Image request timed out")));
    req.on("error", reject); req.write(body); req.end();
  });
}
function openaiEdit(prompt, refBuffer, refMime, size, quality, apiKey) {
  return new Promise((resolve, reject) => {
    const boundary = "----AMBoundary" + crypto.randomBytes(6).toString("hex");
    const field = (n, v) => `--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}`;
    const text = Buffer.from([field("model", IMAGE_MODEL), field("prompt", prompt), field("n", "1"), field("size", size), field("quality", quality), field("output_format", "png")].join("\r\n") + "\r\n", "utf8");
    const fileHdr = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="reference.png"\r\nContent-Type: ${refMime}\r\n\r\n`, "utf8");
    const body = Buffer.concat([text, fileHdr, refBuffer, Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")]);
    const req = https.request({ hostname: "api.openai.com", path: "/v1/images/edits", method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, json: null, raw: d.slice(0, 300) }); } });
    });
    req.setTimeout(240000, () => req.destroy(new Error("Image request timed out")));
    req.on("error", reject); req.write(body); req.end();
  });
}

async function markError(asset, message, userId) {
  const gen = { ...(asset.generation || {}), state: "error", error: String(message || "Image generation failed").slice(0, 300), finishedAt: new Date().toISOString() };
  await supabase("PATCH", "agent_marketing_assets", { generation: gen, status: "rejected" }, `?id=eq.${asset.id}&user_id=eq.${userId}`);
  const credits = gen.charged && gen.charged.credits;
  if (credits && !gen.refunded) {
    try {
      const r = await quota.callDebitCredit(userId, credits, "agent_marketing_image_refund_dispatch_failed", true);
      if (r.status === 200) await supabase("PATCH", "agent_marketing_assets", { generation: { ...gen, refunded: true } }, `?id=eq.${asset.id}&user_id=eq.${userId}`);
    } catch (e) { console.error("agent-marketing image refund failed:", e.message); }
  }
}

exports.handler = async (event) => {
  const h = event.headers || {};
  const key = process.env.INTERNAL_API_KEY || "";
  if (!key || h["x-internal-key"] !== key) return { statusCode: 401, body: "" };
  let asset = null, userId = null;
  try {
    const body = JSON.parse(event.body || "{}");
    userId = body.owner;
    if (!am.UUID_RE.test(String(body.assetId || "")) || !am.UUID_RE.test(String(userId || ""))) return { statusCode: 400, body: "" };
    if (!am.isEnabledFor(userId)) return { statusCode: 404, body: "" };
    const r = await supabase("GET", "agent_marketing_assets", null, `?id=eq.${body.assetId}&user_id=eq.${userId}&select=*&limit=1`);
    asset = Array.isArray(r.data) ? r.data[0] : null;
    if (!asset || !asset.generation || asset.generation.state !== "generating") return { statusCode: 200, body: "" }; // late or duplicate call
    if (!process.env.OPENAI_API_KEY) { await markError(asset, "Image generation is not configured.", userId); return { statusCode: 200, body: "" }; }
    const gen = asset.generation;
    const size = img.SIZES[gen.format]; const quality = gen.quality || "medium";
    let res;
    if (gen.referenceKey) {
      const ref = await s3Bytes(gen.referenceKey);
      res = await openaiEdit(gen.prompt, ref, /\.jpe?g$/i.test(gen.referenceKey) ? "image/jpeg" : /\.webp$/i.test(gen.referenceKey) ? "image/webp" : "image/png", size, quality, process.env.OPENAI_API_KEY);
    } else {
      res = await openaiJson("/v1/images/generations", { model: IMAGE_MODEL, prompt: gen.prompt, n: 1, size, quality, output_format: "png" }, process.env.OPENAI_API_KEY);
    }
    const b64 = res.json && res.json.data && res.json.data[0] && res.json.data[0].b64_json;
    if (res.status >= 300 || !b64) {
      const msg = res.json && res.json.error && res.json.error.message ? res.json.error.message : `Image service returned ${res.status}`;
      console.error("[agent-marketing-image] OpenAI error:", String(msg).slice(0, 300));
      await markError(asset, /safety|policy|moderation/i.test(msg) ? "That image could not be created. Try a different scene description." : "The image could not be created. Please try again.", userId);
      return { statusCode: 200, body: "" };
    }
    const outKey = `agent-marketing-generated/${userId}/${asset.project_id}/${asset.scene_index}_${gen.format}_v${asset.version}_${crypto.randomBytes(3).toString("hex")}.png`;
    await s3.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: outKey, Body: Buffer.from(b64, "base64"), ContentType: "image/png" }));
    await supabase("PATCH", "agent_marketing_assets", { asset_key: outKey, generation: { ...gen, state: "done", finishedAt: new Date().toISOString(), model: IMAGE_MODEL, usage: res.json.usage || null } }, `?id=eq.${asset.id}&user_id=eq.${userId}`);
  } catch (err) {
    console.error("[agent-marketing-image-background] failed:", err.message);
    if (asset && userId) { try { await markError(asset, "The image could not be created. Please try again.", userId); } catch (e) { console.error("could not write error state:", e.message); } }
  }
  return { statusCode: 200, body: "" };
};
