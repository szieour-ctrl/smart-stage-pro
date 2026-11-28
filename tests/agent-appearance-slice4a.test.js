// Agent Appearance Sheet, slice 4a: the three-quarter and full-length images. Every outside call is a stand-in: this spends nothing.
const test = require("node:test");
const assert = require("node:assert");
const A = require("../netlify/functions/lib/agent-appearance-lib");
const H = require("../netlify/functions/lib/agent-appearance-headshot-lib");
const S = require("../netlify/functions/lib/agent-appearance-stage-lib");
const SR = require("../netlify/functions/lib/agent-appearance-stage-run-lib");

const U = "11111111-1111-4111-8111-111111111111", SID = "22222222-2222-4222-8222-222222222222";
const ATTRS = { hair: "short gray", facial_hair: "none", glasses: "no", clothing: "navy sport coat over a light blue button-up" };

function world(over = {}) {
  let n = 0, u = 0;
  const w = { sheet: { id: SID, user_id: U, status: "in_progress", pool_remaining: 12, pool_refills: 0, consent_at: "2026-11-27T00:00:00Z", consent_version: H.CONSENT_VERSION, lower_body: "dark gray dress trousers with a black belt", shoes: null, vision_attributes: { attributes: ATTRS } },
    assets: [{ id: "h0000000-0000-4000-8000-000000000001", sheet_id: SID, user_id: U, stage: "enhanced_headshot", kind: "single", s3_key: `smart-stage-appearance/${U}/${SID}/enhanced_headshot/h.png`, status: "approved", created_at: 0 }],
    calls: [], files: {}, runnerCalls: [], failRunner: false, ...over };
  const db = {
    getSheet: async () => w.sheet, ensureSheet: async () => w.sheet, patchSheet: async (id, f) => Object.assign(w.sheet, f),
    listAssets: async () => w.assets.slice(), getAsset: async (id) => w.assets.find((a) => a.id === id) || null,
    insertAsset: async (row) => { w.assets.push({ created_at: ++n, ...row }); return row.id; }, patchAsset: async (id, f) => Object.assign(w.assets.find((a) => a.id === id), f),
    lastCallsAny: async () => w.calls.slice().reverse(),
    insertCall: async (row) => { const id = "c" + (w.calls.length + 1); w.calls.push({ id, ...row, started_at: row.started_at || new Date().toISOString() }); return id; },
    updateCall: async (id, f) => Object.assign(w.calls.find((c) => c.id === id), f),
    debit: async () => (w.sheet.pool_remaining > 0 ? --w.sheet.pool_remaining : -1),
    refund: async () => { w.sheet.pool_remaining = Math.min(12, w.sheet.pool_remaining + 1); },
  };
  w.files[w.assets[0].s3_key] = Buffer.from("big");
  return Object.assign(w, { deps: { db, uuid: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++u).padStart(12, "0")}`,
    storage: { put: async (k, b) => { w.files[k] = b; }, get: async (k) => { if (!w.files[k]) throw new Error("missing " + k); return w.files[k]; } },
    presign: async (uid, k) => `https://signed.example/${k}`, normalize: async () => ({ buffer: Buffer.from("ref"), width: 2048, height: 2048, contentType: "image/jpeg" }), preview: async () => Buffer.from("small"),
    runner: { run: async (endpoint, input) => { w.runnerCalls.push({ endpoint, input }); if (w.failRunner) throw new Error("boom"); return { requestId: "r1", data: { images: [{ url: "https://x/y.png" }] } }; } },
    download: async () => ({ buffer: Buffer.from("png"), contentType: "image/png" }), probe: async () => ({ width: 1536, height: 2048 }),
    crop: async (buf, cols, rows) => { if (w.failCrop) throw new Error("cut"); return Array.from({ length: cols * rows }, (_, i) => ({ buffer: Buffer.from("p" + i), width: 500, height: 700, contentType: "image/png" })); } } });
}
const make = async (w, stage, note) => { const g = await SR.readyToGenerate({ deps: w.deps, userId: U, stage, note }); assert.ok(g.ok, JSON.stringify(g)); return SR.runStage({ deps: w.deps, userId: U, stage, note: g.note }); };

test("prompts: only what the headshot showed; every visible garment kept; the subscriber's own words name the lower body and the shoes", () => {
  const lower = "dark gray dress trousers with a black belt";
  const p = S.buildPrompt("three_quarter", { attributes: ATTRS, lowerBody: lower });
  assert.match(p, /three-quarter-length studio portrait of the person in Image 1/);
  assert.match(p, /hair: short gray; no facial hair; no glasses; clothing: navy sport coat over a light blue button-up/);
  assert.match(p, /Keep ALL visible clothing unchanged, including any jacket, blazer, sweater/);
  assert.match(p, /Do not add any clothing layer that is not visible in Image 1/);
  assert.match(p, /Lower body, exactly as the subscriber described: dark gray dress trousers with a black belt\. Show it clearly, including the belt/);
  assert.throws(() => S.buildPrompt("three_quarter", { attributes: ATTRS }), /required/, "the garment is never left to chance");
  assert.throws(() => S.buildPrompt("three_quarter", { lowerBody: "   " }), /required/);
  const f = S.buildPrompt("full_body", { shoes: "brown leather dress shoes" });
  assert.match(f, /Add only the shoes: brown leather dress shoes\./);
  assert.match(f, /do not add, remove or change a garment/);
  assert.match(S.buildPrompt("full_body", {}), /plain shoes that go with the outfit/);
  assert.match(S.buildPrompt("full_body", {}), /arms end near mid-thigh and the legs are about half of the total height/);
  assert.match(S.buildPrompt("full_body", { height: "5'9\"" }), /The person's height is 5'9"\./);
  assert.doesNotMatch(S.buildPrompt("full_body", {}), /height is/, "no height is invented");
  assert.doesNotMatch(S.buildPrompt("full_body", { height: "5'9\"" }), /\bman\b|\bwoman\b|\bhis\b|\bher\b/i, "no gender is assumed");
  assert.doesNotMatch(S.buildPrompt("full_body", { note: "shorter legs" }), /Preserve[^.]*body proportions/, "a proportions note is not undercut");
  assert.equal(S.cleanHeight("  5'9\"  "), "5'9\"");
  assert.doesNotMatch(p + f, /consultant|executive|undefined|topaz|nano|fal\.ai|gemini/i);
  assert.equal(S.describeAttributes(null), "");
  assert.match(S.describeAttributes({ hair: "gray", shirt: "blue shirt" }), /clothing: blue shirt/, "sheets saved before Nov 27 only recorded a shirt");
  assert.equal(S.cleanOutfit("  a\n skirt "), "a skirt"); assert.equal(S.cleanOutfit("x".repeat(300)).length, S.OUTFIT_MAX); assert.equal(S.cleanShoes(""), null);
  assert.ok(S.LOWER_PICKS.every((x) => x.length < S.OUTFIT_MAX));
});

test("the retry note is cleaned, capped, and added as ONE adjustment with the likeness held fixed", () => {
  assert.equal(S.cleanNote("   "), null); assert.equal(S.cleanNote(null), null);
  assert.equal(S.cleanNote("a\n\tlighter   shirt\u0000"), "a lighter shirt");
  assert.equal(S.cleanNote("x".repeat(500)).length, S.NOTE_MAX);
  const p = S.buildPrompt("three_quarter", { note: "a lighter shirt", lowerBody: "chinos with a belt" });
  assert.match(p, /Adjustment requested by the subscriber: "a lighter shirt"\. Apply only this adjustment\. Preserve the approved facial likeness/);
  assert.doesNotMatch(S.buildPrompt("three_quarter", { lowerBody: "chinos" }), /Adjustment requested/);
});

test("three-quarter: one iteration, reference is the approved headshot, 3:4 at 2K, the note is kept on the call", async () => {
  const w = world();
  const r = await make(w, "three_quarter", "make the shirt lighter");
  assert.ok(r.ok); assert.equal(w.sheet.pool_remaining, 11);
  const call = w.runnerCalls[0];
  assert.equal(call.endpoint, "fal-ai/nano-banana-pro/edit");
  assert.equal(call.input.aspect_ratio, "3:4"); assert.equal(call.input.resolution, "2K"); assert.equal(call.input.num_images, 1);
  assert.equal(call.input.image_urls.length, 1); assert.match(call.input.image_urls[0], /_ref\.jpg$/);   // a 2048 px copy, not the 3200 px original
  assert.match(call.input.prompt, /make the shirt lighter/);
  assert.equal(w.calls[0].note, "make the shirt lighter"); assert.equal(w.calls[0].quoted_usd, 0.15);
  const a = w.assets.find((x) => x.id === r.assetId);
  assert.equal(a.stage, "three_quarter"); assert.equal(a.status, "pending"); assert.equal(a.parent_id, w.assets[0].id);
});

test("order is enforced: full-length needs an approved three-quarter; nothing runs twice at once; no iterations → no run", async () => {
  const w = world();
  assert.equal((await SR.readyToGenerate({ deps: w.deps, userId: U, stage: "full_body" })).code, "locked");
  assert.equal((await SR.readyToGenerate({ deps: w.deps, userId: U, stage: "bogus" })).code, "stage");
  w.calls.push({ id: "c0", stage: "three_quarter", status: "started", started_at: new Date().toISOString() });
  assert.equal((await SR.readyToGenerate({ deps: w.deps, userId: U, stage: "three_quarter" })).code, "busy");
  w.calls[0].started_at = new Date(Date.now() - 11 * 60 * 1000).toISOString();   // a worker that died: closed out, iteration returned
  w.sheet.pool_remaining = 5;
  assert.ok((await SR.readyToGenerate({ deps: w.deps, userId: U, stage: "three_quarter" })).ok); assert.equal(w.sheet.pool_remaining, 6);
  w.sheet.pool_remaining = 0; w.calls = [];
  assert.equal((await SR.readyToGenerate({ deps: w.deps, userId: U, stage: "three_quarter" })).code, "pool_empty");
  w.sheet.pool_remaining = 3; w.sheet.consent_at = null;
  assert.equal((await SR.readyToGenerate({ deps: w.deps, userId: U, stage: "three_quarter" })).code, "consent");
});

test("a failed call gives the iteration back and keeps no image", async () => {
  const w = world({ failRunner: true });
  const r = await make(w, "three_quarter");
  assert.equal(r.ok, false); assert.equal(w.sheet.pool_remaining, 12); assert.equal(w.assets.filter((a) => a.stage === "three_quarter").length, 0);
  const st = await SR.loadStageState({ deps: w.deps, userId: U });
  assert.match(st.stages.three_quarter.lastFailure, /Your iteration was not used/); assert.equal(st.stages.three_quarter.attempts, 0);
});

test("every attempt stays visible; approving one puts the others away and locks the stage; the next stage opens", async () => {
  const w = world();
  const r1 = await make(w, "three_quarter"); const r2 = await make(w, "three_quarter", "warmer smile");
  let st = await SR.loadStageState({ deps: w.deps, userId: U });
  assert.equal(st.stages.three_quarter.drafts.length, 2, "the first try is still there to compare");
  assert.equal(st.stages.three_quarter.drafts[1].note, "warmer smile");
  assert.equal(st.stages.full_body.unlocked, false);
  assert.ok((await SR.approveStage({ deps: w.deps, userId: U, assetId: r1.assetId })).ok);
  assert.equal(w.assets.find((a) => a.id === r2.assetId).status, "rejected");
  st = await SR.loadStageState({ deps: w.deps, userId: U });
  assert.ok(st.stages.three_quarter.approved); assert.equal(st.stages.three_quarter.drafts.length, 0); assert.equal(st.stages.full_body.unlocked, true);
  assert.equal((await SR.readyToGenerate({ deps: w.deps, userId: U, stage: "three_quarter" })).code, "approved", "an approved image is never redone over");
  assert.equal((await SR.approveStage({ deps: w.deps, userId: U, assetId: r2.assetId })).ok, false);
  assert.equal(w.sheet.pool_remaining, 10);
});

test("full-length: made from the approved three-quarter AND the headshot (2:3), and the three-quarter is untouched", async () => {
  const w = world();
  const r1 = await make(w, "three_quarter"); await SR.approveStage({ deps: w.deps, userId: U, assetId: r1.assetId });
  const before = JSON.stringify(w.assets.find((a) => a.id === r1.assetId));
  const r2 = await make(w, "full_body");
  const call = w.runnerCalls[1];
  assert.equal(call.input.aspect_ratio, "2:3"); assert.equal(call.input.image_urls.length, 2);
  assert.ok(call.input.image_urls[0].includes("three_quarter") && call.input.image_urls[1].includes("enhanced_headshot"));
  assert.deepEqual(w.calls[1].input_asset_ids, [r1.assetId, w.assets[0].id]);
  assert.equal(JSON.stringify(w.assets.find((a) => a.id === r1.assetId)), before);
  assert.equal(w.assets.find((a) => a.id === r2.assetId).parent_id, r1.assetId);
});

test("reject puts one attempt away and leaves the others", async () => {
  const w = world();
  const r1 = await make(w, "three_quarter"); await make(w, "three_quarter");
  assert.ok((await SR.rejectStage({ deps: w.deps, userId: U, assetId: r1.assetId })).ok);
  assert.equal((await SR.loadStageState({ deps: w.deps, userId: U })).stages.three_quarter.drafts.length, 1);
});

test("the outfit: required before the first three-quarter try; saved with the button; locked once each image is approved; shoes are optional", async () => {
  const w = world({}); w.sheet.lower_body = null;
  assert.equal((await SR.readyToGenerate({ deps: w.deps, userId: U, stage: "three_quarter" })).code, "outfit");
  assert.equal((await SR.setOutfit({ deps: w.deps, userId: U, lowerBody: "   " })).ok, false);
  assert.ok((await SR.setOutfit({ deps: w.deps, userId: U, lowerBody: "chinos with a belt" })).ok);
  const r1 = await make(w, "three_quarter");
  assert.match(w.runnerCalls[0].input.prompt, /Lower body, exactly as the subscriber described: chinos with a belt/);
  assert.ok((await SR.setOutfit({ deps: w.deps, userId: U, lowerBody: "dark jeans with a belt" })).ok, "can change it while nothing is approved");
  await SR.approveStage({ deps: w.deps, userId: U, assetId: r1.assetId });
  assert.equal((await SR.setOutfit({ deps: w.deps, userId: U, lowerBody: "a skirt" })).ok, false);
  assert.ok((await SR.setOutfit({ deps: w.deps, userId: U, shoes: "brown loafers", height: "5'9\"" })).ok);
  await make(w, "full_body");
  assert.match(w.runnerCalls[1].input.prompt, /Add only the shoes: brown loafers/);
  assert.match(w.runnerCalls[1].input.prompt, /The person's height is 5'9"/);
  let st = await SR.loadStageState({ deps: w.deps, userId: U });
  assert.equal(st.outfit.lowerLocked, true); assert.equal(st.outfit.shoesLocked, false); assert.equal(st.outfit.lowerBody, "dark jeans with a belt");
  const fb = w.assets.filter((a) => a.stage === "full_body").pop();
  await SR.approveStage({ deps: w.deps, userId: U, assetId: fb.id });
  assert.equal((await SR.setOutfit({ deps: w.deps, userId: U, shoes: "boots" })).ok, false);
  assert.equal((await SR.setOutfit({ deps: w.deps, userId: U, height: "6'0\"" })).ok, false);
});

// ---- slice 4b: angles, expressions, poses ----
const bodyReady = () => { const w = world(); const hs = w.assets[0]; w.assets.push({ id: "f0000000-0000-4000-8000-000000000002", sheet_id: SID, user_id: U, stage: "full_body", kind: "single", s3_key: `smart-stage-appearance/${U}/${SID}/full_body/f.png`, status: "approved", created_at: 1 }); w.files[w.assets[1].s3_key] = Buffer.from("fb"); return w; };

test("prompts for the three multi-panel stages follow the spec: references named, no rear view, hands below frame, no branding", () => {
  const a = S.buildPrompt("angles", { attributes: ATTRS }), e = S.buildPrompt("expressions", { attributes: ATTRS }), p = S.buildPrompt("poses", { attributes: ATTRS });
  assert.match(a, /three-panel full-body studio contact sheet[\s\S]*toward the LEFT edge of the image[\s\S]*OPPOSITE way[\s\S]*toward the RIGHT edge of the image[\s\S]*opposite directions/); assert.doesNotMatch(a, /rear|back view/i);
  assert.match(e, /3-column x 2-row[\s\S]*CURIOUS[\s\S]*Hands and arms BELOW frame/);
  assert.match(p, /2 x 2 professional pose[\s\S]*TOP LEFT[\s\S]*BOTTOM RIGHT/);
  for (const t of [a, e, p]) { assert.match(t, /Image 1 is the approved headshot[\s\S]*Image 2 is the approved full-length image/); assert.match(t, /hair: short gray/); assert.doesNotMatch(t, /undefined|topaz|nano|fal\.ai|gemini/i); }
  assert.deepEqual(Object.values(S.COMPOSITE_STAGES).map((d) => d.labels.length), [3, 6, 4]);
  for (const d of Object.values(S.COMPOSITE_STAGES)) assert.equal(d.labels.length, d.grid.cols * d.grid.rows);
});

test("the three stages open only after the full-length image is approved, in any order", async () => {
  const w = world();
  for (const st of ["angles", "expressions", "poses"]) assert.equal((await SR.readyToGenerate({ deps: w.deps, userId: U, stage: st })).code, "locked");
  const b = bodyReady();
  for (const st of ["angles", "expressions", "poses"]) assert.ok((await SR.readyToGenerate({ deps: b.deps, userId: U, stage: st })).ok);
  const state = await SR.loadStageState({ deps: b.deps, userId: U });
  assert.deepEqual(["angles", "expressions", "poses"].map((k) => state.stages[k].unlocked), [true, true, true]);
  assert.equal(state.stages.angles.composite, true); assert.equal(state.stages.full_body.composite, false);
});

test("one call makes the composite and cuts it into its panels: one iteration, both references, the right grid and aspect", async () => {
  const w = bodyReady();
  const r = await make(w, "expressions");
  assert.ok(r.ok); assert.equal(w.sheet.pool_remaining, 11); assert.equal(w.runnerCalls.length, 1);
  const call = w.runnerCalls[0];
  assert.equal(call.input.aspect_ratio, "3:2"); assert.equal(call.input.image_urls.length, 2);
  assert.ok(call.input.image_urls[0].includes("enhanced_headshot") && call.input.image_urls[1].includes("full_body"));
  const comp = w.assets.find((a) => a.id === r.assetId), crops = w.assets.filter((a) => a.kind === "crop");
  assert.equal(comp.kind, "composite"); assert.equal(comp.parent_id, w.assets[1].id);
  assert.equal(crops.length, 6); assert.deepEqual(crops.map((c) => c.panel_index), [0, 1, 2, 3, 4, 5]);
  assert.ok(crops.every((c) => c.parent_id === r.assetId && c.status === "pending" && c.stage === "expressions"));
  assert.ok(Object.keys(w.files).some((k) => k.endsWith("_preview.jpg")));
  assert.equal(w.runnerCalls.length, 1, "cutting costs no model call");
});

test("a cut that fails gives the iteration back and leaves nothing to approve", async () => {
  const w = bodyReady(); w.failCrop = true;
  const r = await make(w, "angles");
  assert.equal(r.ok, false); assert.equal(w.sheet.pool_remaining, 12); assert.equal(w.calls[0].status, "refunded");
  assert.equal(w.assets.filter((a) => a.stage === "angles" && a.status !== "rejected").length, 0);
  assert.match((await SR.loadStageState({ deps: w.deps, userId: U })).stages.angles.lastFailure, /iteration was not used/);
});

test("attempts are compared as whole images with their panels; approving one takes its panels and puts the other away; panels can be left out", async () => {
  const w = bodyReady();
  const r1 = await make(w, "poses"); const r2 = await make(w, "poses", "make the first pose more relaxed");
  let st = (await SR.loadStageState({ deps: w.deps, userId: U })).stages.poses;
  assert.equal(st.drafts.length, 2); assert.equal(st.drafts[0].panels.length, 4); assert.equal(st.drafts[0].panels[1].label, "Seated at a desk");
  assert.equal(st.drafts[1].note, "make the first pose more relaxed");
  const left = st.drafts[0].panels[3].assetId;
  assert.ok((await SR.rejectPanel({ deps: w.deps, userId: U, assetId: left })).ok);
  assert.ok((await SR.approveStage({ deps: w.deps, userId: U, assetId: r1.assetId })).ok);
  const by = (id) => w.assets.find((a) => a.id === id);
  assert.equal(by(r1.assetId).status, "approved"); assert.equal(by(left).status, "rejected", "a panel left out stays out");
  assert.equal(w.assets.filter((a) => a.parent_id === r1.assetId && a.status === "approved").length, 3);
  assert.equal(by(r2.assetId).status, "rejected"); assert.ok(w.assets.filter((a) => a.parent_id === r2.assetId).every((a) => a.status === "rejected"));
  st = (await SR.loadStageState({ deps: w.deps, userId: U })).stages.poses;
  assert.ok(st.approved); assert.equal(st.drafts.length, 0); assert.equal(st.approved.panels.filter((p) => p.status === "approved").length, 3);
  assert.equal((await SR.readyToGenerate({ deps: w.deps, userId: U, stage: "poses" })).code, "approved");
  assert.ok((await SR.rejectPanel({ deps: w.deps, userId: U, assetId: st.approved.panels[0].assetId })).ok, "a panel can still be dropped later");
  assert.equal((await SR.rejectPanel({ deps: w.deps, userId: U, assetId: st.approved.assetId })).ok, false, "only panels");
  assert.equal((await SR.approveStage({ deps: w.deps, userId: U, assetId: by(w.assets.find((a) => a.parent_id === r1.assetId).id).id })).ok, false, "a panel is not approved by itself");
});

test("rejecting a whole multi-panel try takes its panels away; the earlier approved images are never touched", async () => {
  const w = bodyReady();
  const before = JSON.stringify(w.assets.filter((a) => a.stage !== "angles"));
  const r1 = await make(w, "angles"); await make(w, "angles");
  assert.ok((await SR.rejectStage({ deps: w.deps, userId: U, assetId: r1.assetId })).ok);
  assert.ok(w.assets.filter((a) => a.parent_id === r1.assetId).every((a) => a.status === "rejected"));
  assert.equal((await SR.loadStageState({ deps: w.deps, userId: U })).stages.angles.drafts.length, 1);
  assert.equal(JSON.stringify(w.assets.filter((a) => a.stage !== "angles")), before);
});
