// lib/agent-appearance-stage-run-lib.js — the generated stages of the Agent Appearance Sheet, slice 4: the three-quarter and full-length images (4a) and the three
// multi-panel stages, angles, expressions and poses (4b) (Nov 27, 2026). A multi-panel stage is ONE call; its image is cut into separate pictures with deps.crop.
// Same rules as the headshot: each provider call takes one iteration from the pool, a failed call is refunded, nothing runs twice at once, approved images are never overwritten.
// Every attempt stays on the page, side by side, until the subscriber approves one; then the others are put away. Same `deps` as agent-appearance-headshot-run-lib, plus
//   deps.crop(buffer, cols, rows) -> [{ buffer, width, height, contentType }] (left to right, top to bottom)
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

const approvedOf = (assets, stage) => assets.filter((a) => a.stage === stage && a.kind !== "crop" && a.status === "approved").pop() || null;   // a panel is never "the approved image"

async function loadStageState({ deps, userId, now = Date.now() }) {
  const sheet = await deps.db.ensureSheet(userId);
  const calls = await reapStaleAny(deps, sheet, now);
  const assets = await deps.db.listAssets(sheet.id);
  const noteOf = new Map(calls.filter((c) => c.output_asset_id).map((c) => [c.output_asset_id, c.note || null]));
  const view = async (a) => ({ assetId: a.id, status: a.status, width: a.width, height: a.height, note: noteOf.get(a.id) || null,
    url: await deps.presign(userId, A.previewKey(a.s3_key), 900), fullUrl: await deps.presign(userId, a.s3_key, 900) });
  const running = calls.find((c) => c.status === "started") || null;
  const stages = {};
  const panelsOf = async (composite) => {
    const rows = assets.filter((a) => a.parent_id === composite.id && a.kind === "crop").sort((x, y) => (x.panel_index || 0) - (y.panel_index || 0));
    const labels = (S.COMPOSITE_STAGES[composite.stage] || {}).labels || [];
    return Promise.all(rows.map(async (a) => ({ assetId: a.id, index: a.panel_index, label: labels[a.panel_index] || `Panel ${(a.panel_index || 0) + 1}`, status: a.status,
      url: await deps.presign(userId, A.previewKey(a.s3_key), 900), fullUrl: await deps.presign(userId, a.s3_key, 900) }) ));
  };
  for (const [stage, def] of Object.entries(S.ALL_STAGES)) {
    const composite = !!def.grid;
    const approved = approvedOf(assets, stage);
    const drafts = assets.filter((a) => a.stage === stage && a.kind !== "crop" && a.status === "pending");
    const stageCalls = calls.filter((c) => c.stage === stage);
    const last = stageCalls[0] || null;
    const withPanels = async (a) => (composite ? { ...(await view(a)), panels: await panelsOf(a) } : view(a));
    stages[stage] = {
      title: def.title, composite, intro: def.intro || null, noun: def.noun || null,
      unlocked: !!approvedOf(assets, def.needs) && (def.refs || []).every((r) => !!approvedOf(assets, r)),
      approved: approved ? await withPanels(approved) : null,
      drafts: approved ? [] : await Promise.all(drafts.map(withPanels)),
      attempts: stageCalls.filter((c) => c.status === "ok").length,
      lastFailure: last && last.status === "refunded" && !approved ? FAIL_TEXT : null,
    };
  }
  const fresh = (await deps.db.getSheet(userId)) || sheet;
  return { outfit: { lowerBody: fresh.lower_body || "", shoes: fresh.shoes || "", picks: S.LOWER_PICKS, height: fresh.height_text || "", heightMax: S.HEIGHT_MAX, lowerMax: S.OUTFIT_MAX, shoesMax: S.SHOES_MAX,
      lowerLocked: !!approvedOf(assets, "three_quarter"), shoesLocked: !!approvedOf(assets, "full_body") },
    stages, working: running ? { stage: running.stage } : null, noteMax: S.NOTE_MAX };
}

// Gate for "Make it" / "Try again": consent, the previous step approved, nothing running, an iteration left, and (for approved stages) nothing to redo.
async function readyToGenerate({ deps, userId, stage, note, now = Date.now() }) {
  const def = S.ALL_STAGES[stage];
  if (!def) return { ok: false, status: 400, code: "stage", error: msg.stage };
  const sheet = await deps.db.ensureSheet(userId);
  if (!(sheet.consent_at && sheet.consent_version === H.CONSENT_VERSION)) return { ok: false, status: 400, code: "consent", error: msg.consent };
  const assets = await deps.db.listAssets(sheet.id);
  if (!approvedOf(assets, def.needs) || (def.refs || []).some((r) => !approvedOf(assets, r))) return { ok: false, status: 400, code: "locked", error: msg.locked };
  if (approvedOf(assets, stage)) return { ok: false, status: 400, code: "approved", error: "This step is already approved." };
  const calls = await reapStaleAny(deps, sheet, now);
  if (calls.some((c) => c.status === "started")) return { ok: false, status: 409, code: "busy", error: msg.busy };
  const fresh = (await deps.db.getSheet(userId)) || sheet;
  if (stage === "three_quarter" && !S.cleanOutfit(fresh.lower_body)) return { ok: false, status: 400, code: "outfit", error: "Tell us what you are wearing from the waist down first." };
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
  const def = S.ALL_STAGES[stage];
  const sheet = def ? await deps.db.getSheet(userId) : null;
  if (!def || !sheet) return { ok: false, code: "bad_stage" };
  const assets = await deps.db.listAssets(sheet.id);
  const refs = def.refs.map((s) => approvedOf(assets, s));
  if (refs.some((r) => !r)) return { ok: false, code: "locked" };
  const cleaned = S.cleanNote(note);
  const urls = [];
  for (const r of refs) urls.push(await referenceUrl(deps, userId, r));
  const attrs = sheet.vision_attributes && sheet.vision_attributes.attributes ? sheet.vision_attributes.attributes : null;
  const prompt = S.buildPrompt(stage, { attributes: attrs, note: cleaned, lowerBody: sheet.lower_body, shoes: sheet.shoes, height: sheet.height_text });
  const prior = (await deps.db.lastCallsAny(sheet.id, 100)).filter((c) => c.stage === stage);
  const r = await runCall(deps, { sheet, userId, stage, attempt: prior.length + 1, providerKey: "imageEdit", kind: def.grid ? "composite" : "single", note: cleaned,
    input: A.buildImageEditInput({ prompt, imageUrls: urls, aspectRatio: def.aspect, resolution: "2K" }), quotedUsd: A.quoteImageEdit({ resolution: "2K" }),
    inputAssetIds: refs.map((x) => x.id), parentId: approvedOf(assets, def.needs).id });
  if (!r.ok || !def.grid) return r;
  // The composite is made; cut it into its separate pictures. If the cut fails the try is given back, like any failed call.
  try {
    const pieces = await deps.crop(await deps.storage.get(r.key), def.grid.cols, def.grid.rows);
    if (!Array.isArray(pieces) || pieces.length !== def.grid.cols * def.grid.rows) throw new Error("the image could not be cut into panels");
    for (let i = 0; i < pieces.length; i++) {
      const id = deps.uuid(), ct = pieces[i].contentType || "image/png";
      const key = A.assetKey({ userId, sheetId: sheet.id, stage, assetId: id, ext: A.extFor(ct) });
      await deps.storage.put(key, pieces[i].buffer, ct);
      if (deps.preview) { try { await deps.storage.put(A.previewKey(key), await deps.preview(pieces[i].buffer), "image/jpeg"); } catch { /* the page falls back to the full copy */ } }
      await deps.db.insertAsset({ id, sheet_id: sheet.id, user_id: userId, stage, kind: "crop", parent_id: r.assetId, panel_index: i, s3_key: key, content_type: ct,
        width: pieces[i].width || null, height: pieces[i].height || null, status: "pending", call_id: r.callId });
    }
    return r;
  } catch (e) {
    console.error("[appearance] cutting panels failed:", e.message);
    try { await deps.db.patchAsset(r.assetId, { status: "rejected" }); for (const a of await deps.db.listAssets(sheet.id)) if (a.parent_id === r.assetId) await deps.db.patchAsset(a.id, { status: "rejected" }); } catch { /* best effort */ }
    try { await deps.db.refund(sheet.id); await deps.db.updateCall(r.callId, { status: "refunded", error: "panels could not be cut", finished_at: new Date().toISOString() }); } catch { /* ledger is best effort here */ }
    return { ok: false, code: "crop_failed", callId: r.callId, message: FAIL_TEXT };
  }
}

async function approveStage({ deps, userId, assetId, now = Date.now() }) {
  const sheet = await deps.db.getSheet(userId);
  const a = sheet ? await deps.db.getAsset(assetId, userId) : null;
  if (!a || !S.ALL_STAGES[a.stage] || a.kind === "crop" || a.sheet_id !== sheet.id || a.status !== "pending") return { ok: false, status: 400, error: "That image can't be approved." };
  const all = await deps.db.listAssets(sheet.id);
  if (approvedOf(all, a.stage)) return { ok: false, status: 400, error: "This step is already approved." };
  const at = new Date(now).toISOString();
  for (const o of all) {
    if (o.stage !== a.stage) continue;
    if (o.id === a.id) continue;
    if (o.status === "pending" && (o.kind !== "crop" || o.parent_id !== a.id)) await deps.db.patchAsset(o.id, { status: "rejected" });   // the other tries, and their panels, are put away
  }
  await deps.db.patchAsset(a.id, { status: "approved", approved_at: at });
  for (const o of all) if (o.kind === "crop" && o.parent_id === a.id && o.status === "pending") await deps.db.patchAsset(o.id, { status: "approved", approved_at: at });   // the panels come with it
  await deps.db.patchSheet(sheet.id, { status: "in_progress" });
  return { ok: true };
}

// "Not this one": put one attempt away (the others stay to compare). A multi-panel attempt takes its panels with it.
async function rejectStage({ deps, userId, assetId }) {
  const sheet = await deps.db.getSheet(userId);
  const a = sheet ? await deps.db.getAsset(assetId, userId) : null;
  if (!a || !S.ALL_STAGES[a.stage] || a.kind === "crop" || a.sheet_id !== sheet.id || a.status !== "pending") return { ok: false, status: 400, error: "That image can't be changed." };
  await deps.db.patchAsset(a.id, { status: "rejected" });
  for (const o of await deps.db.listAssets(sheet.id)) if (o.kind === "crop" && o.parent_id === a.id) await deps.db.patchAsset(o.id, { status: "rejected" });
  return { ok: true };
}

// "Leave this one out": one panel of a multi-panel image is not used (before or after the image is approved). Reels only see panels that are not left out.
async function rejectPanel({ deps, userId, assetId }) {
  const sheet = await deps.db.getSheet(userId);
  const a = sheet ? await deps.db.getAsset(assetId, userId) : null;
  if (!a || a.kind !== "crop" || a.sheet_id !== sheet.id || a.status === "rejected") return { ok: false, status: 400, error: "That picture can't be changed." };
  await deps.db.patchAsset(a.id, { status: "rejected" });
  return { ok: true };
}

// What the subscriber wears from the waist down (before the three-quarter image is approved) and their shoes (before the full-length image is approved).
async function setOutfit({ deps, userId, lowerBody, shoes, height }) {
  const sheet = await deps.db.ensureSheet(userId);
  const assets = await deps.db.listAssets(sheet.id);
  const patch = {};
  if (lowerBody !== undefined) {
    if (approvedOf(assets, "three_quarter")) return { ok: false, status: 400, error: "Your outfit is locked once your three-quarter image is approved." };
    const v = S.cleanOutfit(lowerBody);
    if (!v) return { ok: false, status: 400, error: "Tell us what you are wearing from the waist down." };
    patch.lower_body = v;
  }
  if (shoes !== undefined) {
    if (approvedOf(assets, "full_body")) return { ok: false, status: 400, error: "Your shoes are locked once your full-length image is approved." };
    patch.shoes = S.cleanShoes(shoes);
  }
  if (height !== undefined) {
    if (approvedOf(assets, "full_body")) return { ok: false, status: 400, error: "Your height is locked once your full-length image is approved." };
    patch.height_text = S.cleanHeight(height);
  }
  if (Object.keys(patch).length) await deps.db.patchSheet(sheet.id, patch);
  return { ok: true };
}

// "Clear and start over": only once the whole sheet is finished (headshot and every step approved). It puts every image on the sheet away and forgets the outfit and what was read from the old photo,
// so the subscriber uploads a new photo and begins again. The iterations they have left are NOT reset (a new pool is only ever bought with the 5-Image refill), and consent stays.
async function startOver({ deps, userId, now = Date.now() }) {
  const sheet = await deps.db.ensureSheet(userId);
  const assets = await deps.db.listAssets(sheet.id);
  const finished = !!approvedOf(assets, "enhanced_headshot") && Object.keys(S.ALL_STAGES).every((st) => !!approvedOf(assets, st));
  if (!finished) return { ok: false, status: 400, code: "not_finished", error: "You can start over once your headshot and every image on the sheet are approved and saved." };
  const calls = await reapStaleAny(deps, sheet, now);
  if (calls.some((c) => c.status === "started")) return { ok: false, status: 409, code: "busy", error: msg.busy };
  for (const a of assets) if (a.status !== "rejected") await deps.db.patchAsset(a.id, { status: "rejected" });
  await deps.db.patchSheet(sheet.id, { vision_attributes: null, lower_body: null, shoes: null, height_text: null, approved_wardrobe: null, status: "in_progress" });
  return { ok: true };
}

module.exports = { startOver, STALE_CALL_MS, loadStageState, readyToGenerate, runStage, approveStage, rejectStage, rejectPanel, setOutfit, reapStaleAny };
