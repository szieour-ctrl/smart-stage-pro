// reel-plan.js — Netlify Function. Dispatches and polls the Reel Vision plan.
//   POST { listingId, userId, event, lengthSec, photos:[{id,url,label}], intake }  → { jobId }
//   GET  ?jobId=...  → { status: "pending" } | { status: "done", plan } | { status: "error", error }
// The Claude call itself runs in reel-plan-background.js (same pattern as autoSelect).
const { getStore } = require("@netlify/blobs");
const { validateRequest } = require("./lib/reel-plan-lib");

const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Cache-Control": "no-store" };
const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" }, body: "" };

  if (event.httpMethod === "GET") {
    const jobId = event.queryStringParameters && event.queryStringParameters.jobId;
    if (!jobId) return reply(400, { error: "Missing jobId" });
    const siteID = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
    const token = process.env.NETLIFY_ACCESS_TOKEN;
    if (!siteID || !token) return reply(500, { error: "Storage not configured" });
    try {
      const r = await getStore({ name: "reelplan-jobs", siteID, token }).get(jobId, { type: "json" });
      if (!r || r.status === "processing") return reply(200, { status: "pending" });
      return reply(200, r);
    } catch (err) {
      if (/404|not found/i.test(err.message || "")) return reply(200, { status: "pending" });
      console.error("reel-plan poll error:", err.message);
      return reply(500, { error: err.message });
    }
  }

  if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return reply(400, { error: "Invalid JSON" }); }
  const { listingId, userId, lengthSec } = body;
  if (!listingId || !userId) return reply(400, { error: "Missing listingId or userId" });
  const err = validateRequest({ event: body.event, lengthSec: Number(lengthSec), photos: body.photos });
  if (err) return reply(400, { error: err });
  if (!process.env.ANTHROPIC_API_KEY) return reply(500, { error: "Reel planning is not configured (missing ANTHROPIC_API_KEY)" });

  const jobId = `rp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const siteUrl = process.env.URL || `https://${event.headers.host}`;
  try {
    await fetch(`${siteUrl}/.netlify/functions/reel-plan-background`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, event: body.event, lengthSec: Number(lengthSec), photos: body.photos, intake: body.intake || {} }),
    });
  } catch (e) {
    console.error("reel-plan dispatch failed:", e.message);
    return reply(500, { error: "Reel planning failed to start", detail: e.message });
  }
  return reply(200, { jobId });
};
