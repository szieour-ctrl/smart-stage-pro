// lib/agent-appearance-headshot-run-lib.js — the headshot intake steps for the Agent Appearance Sheet, slice 2 (Nov 27, 2026).
// Every outside thing comes in through `deps`, so tests spend nothing:
//   deps.db       getSheet(userId) ensureSheet(userId) patchSheet(id, f) listAssets(sheetId) getAsset(id, userId) insertAsset(row) patchAsset(id, f)
//                 lastCalls(sheetId, stage, n) updateCall(id, f) refund(sheetId) refill(sheetId) getProfile(userId) patchProfile(id, f)
//                 (plus debit / insertCall used by runCall)
//   deps.storage  put(key, buffer, contentType)  get(key) -> Buffer
//   deps.presign  (userId, key, secs) -> url        deps.normalize (buffer) -> { buffer, width, height, contentType }
//   deps.vision   (base64, mediaType) -> text       deps.charge (images, reason, isRefund) -> { status }
//   deps.runner / deps.download / deps.probe / deps.uuid   as in agent-appearance-run-lib
"use strict";
const A = require("./agent-appearance-lib");
const H = require("./agent-appearance-headshot-lib");
const { runCall } = require("./agent-appearance-run-lib");

const STALE_CALL_MS = 10 * 60 * 1000;
const msg = { consent: "Please read and tick the consent line first.", noPhoto: "Upload a photo first.", badPhoto: "That photo can't be used. Choose another one.", busy: "Your headshot is already being enhanced. Please wait a moment." };

// A call that never finished (the worker died) is closed out and its iteration returned, so it can never block the sheet.
async function reapStale(deps, sheet, now) {
  const calls = await deps.db.lastCalls(sheet.id, "enhanced_headshot", 5);
  for (const c of calls) {
    if (c.status === "started" && now - Date.parse(c.started_at) > STALE_CALL_MS) {
      try { await deps.db.refund(sheet.id); } catch (e) { console.error("[appearance] stale refund failed:", e.message); }
      try { await deps.db.updateCall(c.id, { status: "refunded", error: "timed out", finished_at: new Date(now).toISOString() }); } catch { /* best effort */ }
      c.status = "refunded";
    }
  }
  return calls;
}

async function loadState({ deps, userId, now = Date.now() }) {
  const sheet = await deps.db.ensureSheet(userId);
  const calls = await reapStale(deps, sheet, now);
  const fresh = (await deps.db.getSheet(userId)) || sheet;
  const assets = await deps.db.listAssets(fresh.id);
  const view = async (a) => ({ assetId: a.id, status: a.status, width: a.width, height: a.height, url: await deps.presign(userId, a.s3_key, 900) });
  const original = assets.filter((a) => a.stage === "original" && a.status !== "rejected").pop();
  const enhanced = assets.filter((a) => a.stage === "enhanced_headshot" && a.status !== "rejected" && (!original || a.parent_id === original.id || a.status === "approved"));
  const approved = enhanced.filter((a) => a.status === "approved").pop();
  const last = calls[0] || null;
  const vision = fresh.vision_attributes && fresh.vision_attributes.check ? fresh.vision_attributes.check : null;
  const profile = await deps.db.getProfile(userId);
  return {
    sheet: { poolRemaining: fresh.pool_remaining, poolText: A.poolText(fresh), refills: fresh.pool_refills, poolSize: A.POOL_SIZE, refillImages: A.REFILL_IMAGES, consented: !!(fresh.consent_at && fresh.consent_version === H.CONSENT_VERSION) },
    consent: { version: H.CONSENT_VERSION, text: H.CONSENT_TEXT },
    original: original ? { ...(await view(original)), check: vision && vision.assetId === original.id ? { ok: vision.ok, message: vision.message } : null } : null,
    enhanced: await Promise.all(enhanced.filter((a) => a.status === "pending").map(view)),
    approved: approved ? await view(approved) : null,
    working: !!calls.find((c) => c.status === "started"),
    lastCall: last ? { id: last.id, status: last.status } : null,
    lastFailure: last && last.status === "refunded" ? "That image could not be made. Your iteration was not used. Please try again." : null,
    profileReady: !!profile,
  };
}

async function recordConsent({ deps, userId, version, now = Date.now() }) {
  if (version !== H.CONSENT_VERSION) return { ok: false, status: 400, error: msg.consent };
  const sheet = await deps.db.ensureSheet(userId);
  await deps.db.patchSheet(sheet.id, { consent_at: new Date(now).toISOString(), consent_version: H.CONSENT_VERSION });
  return { ok: true };
}

// The browser has put the raw upload at `key` (see presignUpload). Make the working copy, run the photo check, and remember the verdict.
async function checkUpload({ deps, userId, key, contentType }) {
  const sheet = await deps.db.ensureSheet(userId);
  if (!A.isOwnKey(userId, key) || !String(key).includes(`/${sheet.id}/original/`)) return { ok: false, status: 400, error: msg.badPhoto };
  const bad = H.validateUpload({ contentType });
  if (bad) return { ok: false, status: 400, error: bad };
  let raw;
  try { raw = await deps.storage.get(key); } catch { return { ok: false, status: 400, error: "We couldn't read that upload. Please try again." }; }
  if (!raw || !raw.length) return { ok: false, status: 400, error: "We couldn't read that upload. Please try again." };
  if (raw.length > H.MAX_UPLOAD_BYTES) return { ok: false, status: 400, error: "That photo is over 5 MB. Please choose a smaller one." };
  let work;
  try { work = await deps.normalize(raw); } catch { return { ok: false, status: 400, error: "That file doesn't look like a photo we can use." }; }
  if (Math.min(work.width, work.height) < H.MIN_SIDE) return { ok: false, status: 400, error: `That photo is too small. Use one at least ${H.MIN_SIDE} pixels on its short side.` };
  const assetId = deps.uuid();
  const workKey = A.assetKey({ userId, sheetId: sheet.id, stage: "original", assetId, ext: A.extFor(work.contentType) });
  await deps.storage.put(workKey, work.buffer, work.contentType);
  for (const a of await deps.db.listAssets(sheet.id)) if (a.stage === "original" && a.status !== "rejected") await deps.db.patchAsset(a.id, { status: "rejected" });
  await deps.db.insertAsset({ id: assetId, sheet_id: sheet.id, user_id: userId, stage: "original", kind: "original", s3_key: workKey, content_type: work.contentType, width: work.width, height: work.height, status: "pending" });
  let verdict;
  let attributes = {};
  try {
    const v = H.parseVision(await deps.vision(work.buffer.toString("base64"), work.contentType));
    verdict = H.decideVision(v);
    attributes = v ? v.attributes : {};
  } catch (e) { console.error("[appearance] photo check failed:", e.message); verdict = H.decideVision(null); }
  await deps.db.patchSheet(sheet.id, { vision_attributes: { check: { assetId, ok: verdict.ok, code: verdict.code, message: verdict.message }, ...(verdict.ok ? { attributes } : {}) } });
  if (!verdict.ok) await deps.db.patchAsset(assetId, { status: "rejected" });
  return { ok: true, check: { ok: verdict.ok, message: verdict.message }, assetId };
}

// Gate for pressing "Enhance": consent given, a checked photo on file, nothing already running, an iteration left. → { ok, sheetId, assetId } or { ok:false, status, code, error }
async function readyToEnhance({ deps, userId, now = Date.now() }) {
  const sheet = await deps.db.ensureSheet(userId);
  if (!(sheet.consent_at && sheet.consent_version === H.CONSENT_VERSION)) return { ok: false, status: 400, code: "consent", error: msg.consent };
  const original = (await deps.db.listAssets(sheet.id)).filter((a) => a.stage === "original" && a.status === "pending").pop();
  const check = sheet.vision_attributes && sheet.vision_attributes.check;
  if (!original || !check || check.assetId !== original.id || !check.ok) return { ok: false, status: 400, code: "photo", error: msg.noPhoto };
  const calls = await reapStale(deps, sheet, now);
  if (calls.some((c) => c.status === "started")) return { ok: false, status: 409, code: "busy", error: msg.busy };
  const fresh = (await deps.db.getSheet(userId)) || sheet;
  if (A.poolEmpty(fresh)) return { ok: false, status: 402, code: "pool_empty", error: A.poolText(fresh) };
  return { ok: true, sheetId: sheet.id, assetId: original.id };
}

// The background step: one upscale of the checked photo.
async function runEnhance({ deps, userId, assetId }) {
  const sheet = await deps.db.getSheet(userId);
  const original = sheet ? await deps.db.getAsset(assetId, userId) : null;
  if (!sheet || !original || original.stage !== "original" || original.sheet_id !== sheet.id) return { ok: false, code: "bad_asset" };
  const factor = H.upscaleFactorFor(original.width, original.height);
  const url = await deps.presign(userId, original.s3_key, 1800);
  const quotedUsd = A.quoteUpscale({ width: original.width, height: original.height, factor });
  const prior = await deps.db.lastCalls(sheet.id, "enhanced_headshot", 50);
  return runCall(deps, { sheet, userId, stage: "enhanced_headshot", attempt: prior.length + 1, providerKey: "upscale", kind: "single",
    input: A.buildUpscaleInput({ imageUrl: url, factor }), quotedUsd, inputAssetIds: [assetId], parentId: assetId });
}

// "Use this headshot": it becomes the Marketing Profile headshot (and so the lip sync source). The copy goes where the profile already keeps headshots.
async function approveEnhanced({ deps, userId, assetId, brandingPrefix, now = Date.now() }) {
  const sheet = await deps.db.getSheet(userId);
  const a = sheet ? await deps.db.getAsset(assetId, userId) : null;
  if (!a || a.stage !== "enhanced_headshot" || a.sheet_id !== sheet.id || a.status !== "pending") return { ok: false, status: 400, error: "That image can't be approved." };
  const profile = await deps.db.getProfile(userId);
  let profileUpdated = false;
  if (profile) {
    const ext = A.extFor(a.content_type);
    const key = `${brandingPrefix}headshot_${now}_${deps.uuid().slice(0, 6)}.${ext}`;
    await deps.storage.put(key, await deps.storage.get(a.s3_key), a.content_type || "image/png");
    await deps.db.patchProfile(profile.id, { headshot_key: key });
    profileUpdated = true;
  }
  for (const o of await deps.db.listAssets(sheet.id)) if (o.stage === "enhanced_headshot" && o.id !== a.id && o.status !== "rejected") await deps.db.patchAsset(o.id, { status: "rejected" });
  await deps.db.patchAsset(a.id, { status: "approved", approved_at: new Date(now).toISOString() });
  await deps.db.patchSheet(sheet.id, { status: "in_progress" });
  return { ok: true, profileUpdated };
}

async function rejectEnhanced({ deps, userId, assetId }) {
  const sheet = await deps.db.getSheet(userId);
  const a = sheet ? await deps.db.getAsset(assetId, userId) : null;
  if (!a || a.stage !== "enhanced_headshot" || a.sheet_id !== sheet.id || a.status !== "pending") return { ok: false, status: 400, error: "That image can't be changed." };
  await deps.db.patchAsset(a.id, { status: "rejected" });
  return { ok: true };
}

// Out of iterations: 5 Images buys 12 more (the pool is SET to 12; unused calls are lost). The charge is taken first and returned if the refill fails.
async function refillPool({ deps, userId, confirmed }) {
  const sheet = await deps.db.ensureSheet(userId);
  if (!A.poolEmpty(sheet)) return { ok: false, status: 400, error: `You still have ${sheet.pool_remaining} iterations left.` };
  if (confirmed !== true) return { ok: false, status: 402, code: "confirm_charge", images: A.REFILL_IMAGES, error: A.poolText(sheet) };
  let d;
  try { d = await deps.charge(A.REFILL_IMAGES, "appearance_sheet_refill", false); } catch { d = { status: 500 }; }
  if (d.status === 402) return { ok: false, status: 402, code: "insufficient_credits", images: A.REFILL_IMAGES, error: "You don't have enough Images for this." };
  if (d.status !== 200) return { ok: false, status: 502, error: "Could not process the charge. Please try again." };
  try { const n = await deps.db.refill(sheet.id); if (!(n >= 0)) throw new Error("refill returned " + n); return { ok: true, remaining: n }; }
  catch (e) {
    console.error("[appearance] refill failed, returning the charge:", e.message);
    try { await deps.charge(A.REFILL_IMAGES, "appearance_sheet_refill_failed", true); } catch (e2) { console.error("[appearance] charge return failed:", e2.message); }
    return { ok: false, status: 502, error: "Could not add the iterations. You were not charged." };
  }
}

// Where the browser puts its raw upload: the private prefix, stage "original".
function rawUploadKey({ deps, sheet, userId, contentType }) {
  return A.assetKey({ userId, sheetId: sheet.id, stage: "original", assetId: deps.uuid(), ext: H.ALLOWED_TYPES[contentType] });
}

module.exports = { STALE_CALL_MS, loadState, recordConsent, checkUpload, readyToEnhance, runEnhance, approveEnhanced, rejectEnhanced, refillPool, rawUploadKey, reapStale };
