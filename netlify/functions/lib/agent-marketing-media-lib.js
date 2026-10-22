// lib/agent-marketing-media-lib.js — pure helpers for the Agent Marketing media picker (Oct 22, 2026).
// Three routes for authentic photos: a Virtually Staged image (clean, unbadged copy only), a gallery photo
// (an original or an external photo the user already has in SSP), or a fresh upload with an ownership attestation.
// Nothing here touches the network; the endpoint passes rows in.
"use strict";

const UPLOAD_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const UPLOAD_SOURCES = ["own_camera", "licensed", "other_permitted"];
const UPLOAD_ATTESTATION_VERSION = "agent-upload-1";
const UPLOAD_ATTESTATION_TEXT = "I own this photo or have permission to use it in my own marketing.";
const SELECTABLE_STATUSES = ["narrative_approved", "images", "ready_to_render"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function libraryKeyPrefix(userId) { return `agent-marketing-library/${userId}/`; }

// Scenes that need a real photo (the planner marks concept scenes GPT_IMAGE_2_CONCEPT).
function photoSceneIndexes(narrative) {
  const scenes = (narrative && Array.isArray(narrative.scenes)) ? narrative.scenes : [];
  return scenes.map((s, i) => (s && s.visualSource !== "GPT_IMAGE_2_CONCEPT" ? i : -1)).filter((i) => i >= 0);
}

function validateSceneIndex(narrative, idx) {
  const n = Number(idx);
  if (!Number.isInteger(n) || n < 0) return { error: "Choose a scene first." };
  if (!photoSceneIndexes(narrative).includes(n)) return { error: "That scene uses a concept image, not a real photo." };
  return { index: n };
}

// Builds the agent_marketing_assets row for a picked photo. Provenance (original, staged, source listing) is kept in the row.
function assetRowFor(kind, ctx) {
  const base = { project_id: ctx.projectId, user_id: ctx.userId, scene_index: ctx.sceneIndex, version: ctx.version, ai_generated: false, status: "approved" };
  if (kind === "staged") {
    const r = ctx.row;
    if (!r.clean_s3_key) return { error: "That staged image was saved with its badge built in, so it cannot be used here. Upload or pick a different photo." };
    return { row: { ...base, source: "staged", staged_image_id: r.id, source_listing_id: r.listing_id || null, original_url: r.cloudinary_original_url || null, staged_url: null, asset_key: r.clean_s3_key, rights: { route: "staged", badgeType: r.badge_type || null } } };
  }
  if (kind === "gallery_original") {
    const r = ctx.row;
    if (r.is_hero_shot || !/^https?:\/\//.test(r.cloudinary_original_url || "")) return { error: "That photo has no original." };
    return { row: { ...base, source: "gallery", staged_image_id: r.id, source_listing_id: r.listing_id || null, original_url: r.cloudinary_original_url, staged_url: null, asset_key: null, rights: { route: "gallery_original" } } };
  }
  if (kind === "gallery_external") {
    const r = ctx.row;
    if (!/^https?:\/\//.test(r.image_url || "")) return { error: "That photo is not available." };
    return { row: { ...base, source: "gallery", external_photo_id: r.id, source_listing_id: r.listing_id || null, original_url: r.image_url, staged_url: null, asset_key: null, rights: { route: "gallery_external", sourceLabel: r.source_label || null } } };
  }
  if (kind === "library") {
    const r = ctx.row;
    return { row: { ...base, source: "upload", library_id: r.id, asset_key: r.asset_key, original_url: null, staged_url: null, ai_generated: r.kind === "generated", rights: { ...(r.rights || {}), route: "library", libraryId: r.id } } };
  }
  return { error: "Unknown photo source." };
}

// Adding to the library: the key must live in this user's library folder, and the attestation is required.
function validateUpload(body, userId) {
  const b = body && typeof body === "object" ? body : {};
  const key = String(b.key || "");
  if (!key.startsWith(libraryKeyPrefix(userId)) || key.includes("..")) return { error: "Please upload the photo again." };
  if (b.ownerConfirmed !== true) return { error: "Please confirm you own this photo or have permission to use it." };
  const source = UPLOAD_SOURCES.includes(b.source) ? b.source : "own_camera";
  const label = String(b.label || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 80);
  const note = String(b.note || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200);
  return { key, label: label || null, rights: { route: "upload", source, note: note || null, attestationVersion: UPLOAD_ATTESTATION_VERSION, attestationText: UPLOAD_ATTESTATION_TEXT, attestedAt: new Date().toISOString() } };
}

module.exports = { UPLOAD_TYPES, UPLOAD_SOURCES, UPLOAD_ATTESTATION_VERSION, UPLOAD_ATTESTATION_TEXT, SELECTABLE_STATUSES, UUID_RE, libraryKeyPrefix, photoSceneIndexes, validateSceneIndex, assetRowFor, validateUpload };
