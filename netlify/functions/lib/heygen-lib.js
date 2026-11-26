// heygen-lib.js — the only code that talks to HeyGen (Nov 25, 2026). Used only by the optional Agent Marketing lip-sync step.
//   create(): POST /v3/videos  { type: "image", image: { type: "url", url }, audio_url, aspect_ratio, resolution }   -> { videoId }
//   get():    GET  /v3/videos/{id}                                                                                    -> { status, videoUrl, duration, failure }
// A photo plus the exact narration excerpt; the clip's length follows the audio. An Idempotency-Key header makes a repeated create with the same key
// the same job, so a retry cannot be billed twice. The key comes from the environment (HEYGEN_API_KEY) and is never logged or returned.
"use strict";
const https = require("https");

const HOST = "api.heygen.com";

function rawRequest(apiKey, method, pathname, body, extraHeaders, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({ hostname: HOST, path: pathname, method, headers: { "x-api-key": apiKey, Accept: "application/json", ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}), ...(extraHeaders || {}) } }, (res) => {
      let d = ""; res.setEncoding("utf8"); res.on("data", (c) => (d += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(d); } catch { /* not JSON */ } resolve({ status: res.statusCode, json }); });
    });
    req.setTimeout(timeoutMs || 60000, () => req.destroy(new Error("HeyGen request timed out")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function download(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch { return reject(new Error("The clip address is not valid")); }
    if (u.protocol !== "https:") return reject(new Error("The clip address is not secure"));
    https.get(u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) { res.resume(); return resolve(download(new URL(res.headers.location, u).toString(), redirects - 1)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`The clip download returned ${res.statusCode}`)); }
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject).setTimeout(120000, function () { this.destroy(new Error("The clip download timed out")); });
  });
}

function errText(r) {
  const j = r && r.json, e = j && (j.error || j.message || (j.data && j.data.message));
  return `HeyGen returned ${r && r.status}${e ? ": " + String(typeof e === "string" ? e : e.message || JSON.stringify(e)).slice(0, 160) : ""}`;
}

/** client({ apiKey, request? }): request(method, path, body, headers) -> { status, json } is injectable for tests. */
function client({ apiKey, request } = {}) {
  if (!apiKey) throw new Error("HeyGen is not configured.");
  const call = request || ((m, p, b, h) => rawRequest(apiKey, m, p, b, h));
  return {
    async create({ imageUrl, audioUrl, aspect, title, idempotencyKey }) {
      const body = { type: "image", image: { type: "url", url: imageUrl }, audio_url: audioUrl, aspect_ratio: aspect || "1:1", resolution: "720p", ...(title ? { title: String(title).slice(0, 80) } : {}) };
      const r = await call("POST", "/v3/videos", body, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined);
      const id = r && r.json && r.json.data && r.json.data.video_id;
      if (!(r.status >= 200 && r.status < 300) || !id) throw new Error(errText(r));
      return { videoId: String(id) };
    },
    async get(videoId) {
      const r = await call("GET", `/v3/videos/${encodeURIComponent(videoId)}`);
      const d = r && r.json && r.json.data;
      if (!(r.status >= 200 && r.status < 300) || !d) throw new Error(errText(r));
      return { status: String(d.status || ""), videoUrl: d.video_url || null, duration: Number.isFinite(Number(d.duration)) ? Number(d.duration) : null, failure: d.failure_message || d.failure_code || null };
    },
    download,
  };
}

module.exports = { client, download };
