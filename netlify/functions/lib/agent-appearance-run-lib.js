// lib/agent-appearance-run-lib.js — ONE provider call for an Appearance Sheet stage: take an iteration from the pool, record the call, run it,
// store the image privately, and refund the iteration if anything fails (Nov 27, 2026). Every outside thing is passed in (`deps`), so tests spend nothing.
//
//   deps.db       { debit(sheetId) -> remaining | -1, refund(sheetId), insertCall(row) -> id, updateCall(id, fields), insertAsset(row) -> id }
//   deps.storage  { put(key, buffer, contentType) }
//   deps.runner   { run(endpoint, input) -> { requestId, data } }          (the fal runner; may throw)
//   deps.download (url) -> { buffer, contentType }
//   deps.probe    (buffer) -> { width, height }
//   deps.uuid     () -> uuid
"use strict";
const A = require("./agent-appearance-lib");

async function runCall(deps, a) {
  const { sheet, userId, stage, attempt = 1, providerKey, input, quotedUsd = null, inputAssetIds = [], parentId = null, kind } = a;
  const def = A.STAGES[stage];
  if (!def) return { ok: false, code: "bad_stage" };
  const remaining = await deps.db.debit(sheet.id);
  if (remaining < 0) return { ok: false, code: "pool_empty", message: A.poolText({ pool_remaining: 0 }) };

  const callId = await deps.db.insertCall({ sheet_id: sheet.id, user_id: userId, stage, attempt, provider: A.PROVIDER_LABEL[providerKey], endpoint: A.ENDPOINTS[providerKey],
    status: "started", pool_counted: true, quoted_usd: quotedUsd, input_asset_ids: inputAssetIds });
  let requestId = null;
  try {
    const out = await deps.runner.run(A.ENDPOINTS[providerKey], input);
    requestId = out.requestId || null;
    const img = A.firstImage(out.data);
    if (!img) throw new Error("the provider returned no image");
    const dl = await deps.download(img.url);                     // fal links expire: copy the file now
    if (!dl || !dl.buffer || !dl.buffer.length) throw new Error("the image could not be downloaded");
    const contentType = dl.contentType || img.contentType || "image/png";
    const meta = (await deps.probe(dl.buffer)) || {};
    const assetId = deps.uuid();
    const key = A.assetKey({ userId, sheetId: sheet.id, stage, assetId, ext: A.extFor(contentType) });
    await deps.storage.put(key, dl.buffer, contentType);
    await deps.db.insertAsset({ id: assetId, sheet_id: sheet.id, user_id: userId, stage, kind: kind || def.kind, parent_id: parentId, s3_key: key, content_type: contentType,
      width: meta.width || null, height: meta.height || null, status: "pending", call_id: callId });
    await deps.db.updateCall(callId, { status: "ok", request_id: requestId, estimated_usd: quotedUsd, output_asset_id: assetId, finished_at: new Date().toISOString() });
    return { ok: true, assetId, key, callId, remaining, width: meta.width || null, height: meta.height || null };
  } catch (e) {
    try { await deps.db.refund(sheet.id); } catch (re) { console.error("[appearance] pool refund failed:", re.message); }
    try { await deps.db.updateCall(callId, { status: "refunded", request_id: requestId, error: String(e && e.message || e).slice(0, 500), finished_at: new Date().toISOString() }); } catch { /* ledger is best effort here */ }
    return { ok: false, code: "provider_failed", callId, message: "That image could not be made. Your iteration was not used. Please try again." };
  }
}
module.exports = { runCall };
