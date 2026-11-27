// lib/agent-appearance-lib.js — rules, quotes and request shapes for the Agent Appearance Sheet (Nov 27, 2026). Pure functions, no network. Unit-tested.
// Vendor names live ONLY in this file's ENDPOINTS and in the fal library; subscribers are never shown them (they see "third-party AI image providers").
//
// Sam's rules (Nov 27): a sheet starts with 12 iterations. When they run out, 5 Images buys 12 MORE (use it or lose it: the pool is SET to 12, unused calls
// never carry over). Approved stages stay; a sheet is completed, never restarted. A failed provider call is refunded to the pool.
"use strict";

const POOL_SIZE = 12;
const REFILL_IMAGES = 5;

const ENDPOINTS = { upscale: "topaz/upscale/image/generative", imageEdit: "fal-ai/nano-banana-pro/edit" };
const PROVIDER_LABEL = { upscale: "upscale", imageEdit: "image_edit" };   // vendor-neutral names stored in the ledger

// Stages in order. `grid` = how a composite splits into independently selectable crops (cols x rows); aspect is the generation's default (confirm in slice 4).
const STAGES = {
  enhanced_headshot: { order: 0, kind: "single", provider: "upscale" },
  three_quarter:     { order: 1, kind: "single", provider: "imageEdit", aspect: "3:4" },
  full_body:         { order: 2, kind: "single", provider: "imageEdit", aspect: "2:3" },
  angles:            { order: 3, kind: "composite", provider: "imageEdit", aspect: "3:2", grid: { cols: 3, rows: 1 } },   // front, 45 left, 45 right; no rear view
  expressions:       { order: 4, kind: "composite", provider: "imageEdit", aspect: "3:2", grid: { cols: 3, rows: 2 } },
  poses:             { order: 5, kind: "composite", provider: "imageEdit", aspect: "1:1", grid: { cols: 2, rows: 2 } },
};
const STAGE_NAMES = Object.keys(STAGES);
const panelCount = (stage) => (STAGES[stage] && STAGES[stage].grid ? STAGES[stage].grid.cols * STAGES[stage].grid.rows : 1);

// ---- Cost quotes (published rates; fal's responses carry no cost, so "actual" in the ledger is this estimate) ----
const IMAGE_EDIT_USD = 0.15;       // per image; 4K is double
const UPSCALE_USD_PER_STEP = 0.08; // per started 8 MP (Wonder 3 / 3.5) or per started 4 MP (the other models) of OUTPUT
const UPSCALE_MODELS = ["Wonder 3.5", "Wonder 3", "Wonder 2", "Wonder", "Recover 3", "Standard MAX", "Redefine", "Recovery V2", "Recovery"];
const quoteImageEdit = ({ resolution = "1K", images = 1 } = {}) => round4(IMAGE_EDIT_USD * (resolution === "4K" ? 2 : 1) * images);
function quoteUpscale({ width, height, factor = 4, model = "Wonder 3" }) {
  const w = Number(width), h = Number(height), f = Number(factor);
  if (!(w > 0) || !(h > 0) || !(f > 0)) return null;
  const mp = (w * f * h * f) / 1e6;
  const step = model === "Wonder 3" || model === "Wonder 3.5" ? 8 : 4;
  return round4(UPSCALE_USD_PER_STEP * Math.ceil(mp / step));
}
function round4(n) { return Math.round(n * 10000) / 10000; }

// ---- Request bodies ----
function buildImageEditInput({ prompt, imageUrls, aspectRatio = "auto", resolution = "1K" }) {
  const p = String(prompt || "").trim();
  if (!p) throw new Error("prompt is required");
  const urls = Array.isArray(imageUrls) ? imageUrls.filter(Boolean) : [];
  if (urls.length < 1 || urls.length > 14) throw new Error("1 to 14 reference images are required");
  if (!["1K", "2K", "4K"].includes(resolution)) throw new Error("resolution must be 1K, 2K or 4K");
  return { prompt: p, image_urls: urls, num_images: 1, aspect_ratio: aspectRatio, output_format: "png", resolution, limit_generations: true };
}
function buildUpscaleInput({ imageUrl, model = "Wonder 3", factor = 4, outputFormat = "png" }) {
  if (!imageUrl) throw new Error("imageUrl is required");
  if (!UPSCALE_MODELS.includes(model)) throw new Error("unknown upscale model");
  return { image_url: imageUrl, model, upscale_factor: factor, output_format: outputFormat, face_enhancement: true };
}
// The one image URL in a provider response: image_edit returns images[], upscale returns image.
function firstImage(data) {
  const d = data && typeof data === "object" ? data : {};
  const f = Array.isArray(d.images) && d.images[0] ? d.images[0] : d.image;
  return f && f.url ? { url: f.url, contentType: f.content_type || null } : null;
}

// ---- Private storage: its own prefix, NOT the public-read smart-stage-marketing/ prefix ----
const PRIVATE_PREFIX = "smart-stage-appearance/";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assetKey({ userId, sheetId, stage, assetId, ext = "png" }) {
  if (![userId, sheetId, assetId].every((v) => UUID.test(String(v || "")))) throw new Error("ids must be UUIDs");
  if (!STAGE_NAMES.includes(stage) && stage !== "original") throw new Error("unknown stage");
  return `${PRIVATE_PREFIX}${userId}/${sheetId}/${stage}/${assetId}.${String(ext).replace(/[^a-z0-9]/gi, "").toLowerCase() || "png"}`;
}
// A small copy of a large result for the page to show (a 3200 px PNG is far too heavy to load in a browser).
const previewKey = (key) => String(key).replace(/\.[a-z0-9]+$/i, "") + "_preview.jpg";
const isOwnKey = (userId, key) => UUID.test(String(userId || "")) && String(key || "").startsWith(`${PRIVATE_PREFIX}${userId}/`);
const extFor = (contentType) => ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" })[String(contentType || "").toLowerCase()] || "png";

// ---- Pool ----
const poolEmpty = (sheet) => !sheet || !(Number(sheet.pool_remaining) > 0);
const poolText = (sheet) => {
  const n = Math.max(0, Number(sheet && sheet.pool_remaining) || 0);
  return n > 0 ? `${n} of ${POOL_SIZE} iterations left` : `No iterations left. Continue for ${REFILL_IMAGES} Images to get ${POOL_SIZE} more.`;
};

module.exports = { POOL_SIZE, REFILL_IMAGES, ENDPOINTS, PROVIDER_LABEL, STAGES, STAGE_NAMES, panelCount, IMAGE_EDIT_USD, UPSCALE_MODELS, quoteImageEdit, quoteUpscale,
  buildImageEditInput, buildUpscaleInput, firstImage, PRIVATE_PREFIX, assetKey, previewKey, isOwnKey, extFor, poolEmpty, poolText };
