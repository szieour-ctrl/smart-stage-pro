// lib/agent-appearance-stage-run-lib.js — the generated stages of the Agent Appearance Sheet, slice 4a: the three-quarter image and the full-length image (Nov 27, 2026).
// Same rules as the headshot: each provider call takes one iteration from the pool, a failed call is refunded, nothing runs twice at once, approved images are never overwritten.
// Every attempt stays on the page, side by side, until the subscriber approves one; then the others are put away. Same `deps` as agent-appearance-headshot-run-lib, plus
//   deps.db.lastCallsAny(sheetId, n) -> [{ id, status, started_at, stage, note, output_asset_id, attempt }]
"use strict";
const A = require("./agent-appearance-lib");
const S = require("./agent-appearance-stage-lib");
const H = require("./agent-appearance-headshot-lib");
const { runCall } = require("./agent-appearance-run-lib");

const STALE_CALL_MS = 10 * 60 * 1000;
const REF_MAX_SIDE = 2048;
const FAIL_TEXT = "That image could not be made. Your iteration was not used. Please try again.";
const msg = { consent: "Please read and tick the consent line first.", locked: "Approve the previous step first.", busy: "An image is already being made. Please wait a moment.", stage: "Unknown step." };

async function reapStaleAny(deps, sheet, now) {
  const calls = await deps.db.lastCallsAny(sheet.id, 60);
  for (const c of calls) {
    if (c.status === "started" && now - Date.parse(c.started_at) > STALE_CALL_MS) {
      try { await deps.db.refund(sheet.id); } catch (e) { console.error("[appearance] stale refund failed:", e.message); }
      try { await deps.db.updateCall(c.id, { status: "refunded", error: "timed out", finished_at: new Date(now).toISOString() }); } catch { /* best effort */ }
      c.status = "refunded";
    }
  }
  return calls;
}

const approvedOf = (assets, stage) => assets.filter((a) => a.stage === stage && a.status === "approved").pop() || null;

async function loadStageState({ deps, userId, now = Date.now() }) {
  const sheet = await deps.db.ensureSheet(userId);
  const calls = await reapStaleAny(deps, sheet, now);
  const assets = await deps.db.listAssets(sheet.id);
  const noteOf = new Map(calls.filter((c) => c.output_asset_id).map((c) => [c.output_asset_id, c.note || null]));
  const view = async (a) => ({ assetId: a.id, status: a.status, width: a.width, height: a.height, note: noteOf.get(a.id) || null,
    url: await deps.presign(userId, A.previewKey(a.s3_key), 900), fullUrl: await deps.presign(userId, a.s3_key, 900) });
  const running = calls.find((c) => c.status === "started") || null;
  const stages = {};
  for (const [stage, def] of Object.entries(S.SINGLE_STAGES)) {
    const approved = approvedOf(assets, stage);
    const drafts = assets.filter((a) => a.stage === stage && a.status === "pending");
    const stageCalls = calls.filter((c) => c.stage === stage);
    const last = stageCalls[0] || null;
    stages[stage] = {
      title: def.title,
      unlocked: !!approvedOf(assets, def.needs),
      approved: approved ? await view(approved) : null,
      drafts: approved ? [] : await Promise.all(drafts.map(view)),
      attempts: stageCalls.filter((c) => c.status === "ok").length,
      lastFailure: last && last.status === "refunded" && !approved ? FAIL_TEXT : null,
    };
  }
  const fresh = (await deps.db.getSheet(userId)) || sheet;
  return { style: { key: S.STYLES[fresh.style_dna] ? fresh.style_dna : S.DEFAULT_STYLE, options: Object.entries(S.STYLES).map(([key, v]) => ({ key, label: v.label })) },
    stages, working: running ? { stage: running.stage } : null, noteMax: S.NOTE_MAX };
}

// Gate for "Make it" / "Try again": consent, the previous step approved, nothing running, an iteration left, and (for approved stages) nothing to redo.
async function readyToGenerate({ deps, userId, stage, note, now = Date.now() }) {
  const def = S.SINGLE_STAGES[stage];
  if (!def) return { ok: false, status: 400, code: "stage", error: msg.stage };
  const sheet = await deps.db.ensureSheet(userId);
  if (!(sheet.consent_at && sheet.consent_version === H.CONSENT_VERSION)) return { ok: false, status: 400, code: "consent", error: msg.consent };
  const assets = await deps.db.listAssets(sheet.id);
  if (!approvedOf(assets, def.needs)) return { ok: false, status: 400, code: "locked", error: msg.locked };
  if (approvedOf(assets, stage)) return { ok: false, status: 400, code: "approved", error: "This step is already approved." };
  const calls = await reapStaleAny(deps, sheet, now);
  if (calls.some((c) => c.status === "started")) return { ok: false, status: 409, code: "busy", error: msg.busy };
  const fresh = (await deps.db.getSheet(userId)) || sheet;
  if (A.poolEmpty(fresh)) return { ok: false, status: 402, code: "pool_empty", error: A.poolText(fresh) };
  return { ok: true, sheetId: sheet.id, note: S.cleanNote(note) };
}

// A 2048 px JPEG of an approved image, stored beside it, for the provider to read: the full 3200 px PNG is far larger than it needs.
async function referenceUrl(deps, userId, asset) {
  const small = await deps.normalize(await deps.storage.get(asset.s3_key), REF_MAX_SIDE);
  const key = String(asset.s3_key).replace(/\.[a-z0-9]+$/i, "") + "_ref.jpg";
  await deps.storage.put(key, small.buffer, small.contentType || "image/jpeg");
  return deps.presign(userId, key, 1800);
}

// The background step: one image for the stage, made from the approved images before it.
async function runStage({ deps, userId, stage, note }) {
  const def = S.SINGLE_STAGES[stage];
  const sheet = def ? await deps.db.getSheet(userId) : null;
  if (!def || !sheet) return { ok: false, code: "bad_stage" };
  const assets = await deps.db.listAssets(sheet.id);
  const refs = def.refs.map((s) => approvedOf(assets, s));
  if (refs.some((r) => !r)) return { ok: false, code: "locked" };
  const cleaned = S.cleanNote(note);
  const urls = [];
  for (const r of refs) urls.push(await referenceUrl(deps, userId, r));
  const attrs = sheet.vision_attributes && sheet.vision_attributes.attributes ? sheet.vision_attributes.attributes : null;
  const prompt = S.buildPrompt(stage, { styleKey: sheet.style_dna, attributes: attrs, note: cleaned });
  const prior = (await deps.db.lastCallsAny(sheet.id, 100)).filter((c) => c.stage === stage);
  return runCall(deps, { sheet, userId, stage, attempt: prior.length + 1, providerKey: "imageEdit", kind: "single", note: cleaned,
    input: A.buildImageEditInput({ prompt, imageUrls: urls, aspectRatio: def.aspect, resolution: "2K" }), quotedUsd: A.quoteImageEdit({ resolution: "2K" }),
    inputAssetIds: refs.map((r) => r.id), parentId: refs[0].id });
}

async function approveStage({ deps, userId, assetId, now = Date.now() }) {
  const sheet = await deps.db.getSheet(userId);
  const a = sheet ? await deps.db.getAsset(assetId, userId) : null;
  if (!a || !S.SINGLE_STAGES[a.stage] || a.sheet_id !== sheet.id || a.status !== "pending") return { ok: false, status: 400, error: "That image can't be approved." };
  if (approvedOf(await deps.db.listAssets(sheet.id), a.stage)) return { ok: false, status: 400, error: "This step is already approved." };
  for (const o of await deps.db.listAssets(sheet.id)) if (o.stage === a.stage && o.id !== a.id && o.status === "pending") await deps.db.patchAsset(o.id, { status: "rejected" });
  await deps.db.patchAsset(a.id, { status: "approved", approved_at: new Date(now).toISOString() });
  await deps.db.patchSheet(sheet.id, { status: "in_progress" });
  return { ok: true };
}

// "Not this one": put one attempt away (the others stay to compare). Allowed only while nothing is approved for the stage.
async function rejectStage({ deps, userId, assetId }) {
  const sheet = await deps.db.getSheet(userId);
  const a = sheet ? await deps.db.getAsset(assetId, userId) : null;
  if (!a || !S.SINGLE_STAGES[a.stage] || a.sheet_id !== sheet.id || a.status !== "pending") return { ok: false, status: 400, error: "That image can't be changed." };
  await deps.db.patchAsset(a.id, { status: "rejected" });
  return { ok: true };
}

async function setStyle({ deps, userId, style }) {
  if (!S.STYLES[style]) return { ok: false, status: 400, error: "Choose one of the styles." };
  const sheet = await deps.db.ensureSheet(userId);
  const assets = await deps.db.listAssets(sheet.id);
  if (approvedOf(assets, "three_quarter")) return { ok: false, status: 400, error: "The style is locked once your three-quarter image is approved." };
  await deps.db.patchSheet(sheet.id, { style_dna: style });
  return { ok: true };
}

module.exports = { STALE_CALL_MS, loadStageState, readyToGenerate, runStage, approveStage, rejectStage, setStyle, reapStaleAny };
