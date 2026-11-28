// Agent Appearance Sheet, slice 2: headshot intake. Every outside call is a stand-in: this spends nothing.
const test = require("node:test");
const assert = require("node:assert");
const A = require("../netlify/functions/lib/agent-appearance-lib");
const H = require("../netlify/functions/lib/agent-appearance-headshot-lib");
const R = require("../netlify/functions/lib/agent-appearance-headshot-run-lib");

const U = "11111111-1111-4111-8111-111111111111", S = "22222222-2222-4222-8222-222222222222";
const BRAND = `smart-stage-marketing/branding/${U}/`;
const GOOD = JSON.stringify({ people: 1, face_clear: true, framing: "head_shoulders", has_badge_logo_or_text: false, attributes: { hair: "short brown", facial_hair: "none", glasses: "no", shirt: "navy blazer" } });

// An in-memory stand-in for the database, storage and providers.
function world(over = {}) {
  let n = 0;
  const w = { sheet: { id: S, user_id: U, status: "setup", pool_remaining: 12, pool_refills: 0, consent_at: null, consent_version: null, vision_attributes: null }, assets: [], calls: [], files: {}, profile: { id: "p1", headshot_key: "old" },
    charges: [], normalizeMax: [], visionText: GOOD, runnerCalls: [], failRunner: false };
  Object.assign(w, over);
  const db = {
    getSheet: async () => w.sheet, ensureSheet: async () => w.sheet,
    patchSheet: async (id, f) => Object.assign(w.sheet, f),
    listAssets: async () => w.assets.slice(), getAsset: async (id) => w.assets.find((a) => a.id === id) || null,
    insertAsset: async (row) => { w.assets.push({ created_at: ++n, ...row }); return row.id; },
    patchAsset: async (id, f) => Object.assign(w.assets.find((a) => a.id === id), f),
    lastCalls: async (sid, stage) => w.calls.filter((c) => c.stage === stage).slice().reverse(),
    insertCall: async (row) => { const id = "c" + (w.calls.length + 1); w.calls.push({ id, ...row, started_at: row.started_at || new Date().toISOString() }); return id; },
    updateCall: async (id, f) => Object.assign(w.calls.find((c) => c.id === id), f),
    debit: async () => (w.sheet.pool_remaining > 0 ? --w.sheet.pool_remaining : -1),
    refund: async () => { w.sheet.pool_remaining = Math.min(12, w.sheet.pool_remaining + 1); },
    refill: async () => { w.sheet.pool_remaining = 12; w.sheet.pool_refills++; return 12; },
    getProfile: async () => w.profile, patchProfile: async (id, f) => Object.assign(w.profile, f),
  };
  let u = 0;
  return Object.assign(w, { deps: {
    db, uuid: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++u).padStart(12, "0")}`,
    storage: { put: async (k, b) => { w.files[k] = b; }, get: async (k) => { if (!w.files[k]) throw new Error("missing"); return w.files[k]; } },
    presign: async (uid, k) => `https://signed.example/${k}`,
    normalize: async (b, max) => { w.normalizeMax.push(max || null); return { buffer: Buffer.from("work"), width: 1000, height: 1000, contentType: "image/jpeg" }; },
    preview: async () => Buffer.from("small"),
    vision: async () => w.visionText,
    charge: async (images, reason, isRefund) => { w.charges.push({ images, reason, isRefund }); return { status: w.chargeStatus || 200 }; },
    runner: { run: async (endpoint, input) => { w.runnerCalls.push({ endpoint, input }); if (w.failRunner) throw new Error("boom"); return { requestId: "r1", data: { image: { url: "https://x/y.png" } } }; } },
    download: async () => ({ buffer: Buffer.from("png"), contentType: "image/png" }), probe: async () => ({ width: 4000, height: 4000 }),
  } });
}
const rawKey = (w) => A.assetKey({ userId: U, sheetId: S, stage: "original", assetId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000001", ext: "png" });
async function upload(w) { const k = rawKey(w); w.files[k] = Buffer.from("raw"); return R.checkUpload({ deps: w.deps, userId: U, key: k, contentType: "image/png" }); }

test("upscale factor keeps the output near 16 MP and only uses 2 or 4", () => {
  assert.equal(H.upscaleFactorFor(1000, 1000), 4);
  assert.equal(H.upscaleFactorFor(800, 800), 4);
  assert.equal(H.upscaleFactorFor(1600, 1600), 2);
  assert.equal(H.upscaleFactorFor(0, 0), 2);
});

test("upload rules: type and size", () => {
  assert.equal(H.validateUpload({ contentType: "image/png", bytes: 1000 }), null);
  assert.match(H.validateUpload({ contentType: "image/gif" }), /PNG, JPG or WebP/);
  assert.match(H.validateUpload({ contentType: "image/png", bytes: 6 * 1024 * 1024 }), /over 5 MB/);
});

test("photo check: one clear face with no badge passes; each failure gives its own plain message", () => {
  assert.equal(H.decideVision(H.parseVision(GOOD)).ok, true);
  const bad = (o) => H.decideVision(H.parseVision(JSON.stringify({ people: 1, face_clear: true, framing: "head_shoulders", has_badge_logo_or_text: false, attributes: {}, ...o })));
  assert.equal(bad({ people: 2 }).code, "people");
  assert.equal(bad({ face_clear: false }).code, "face");
  // the head must fill at least 30% of the photo's height (measured, not a category): Sam's tight headshots read about 0.55, his waist-up image about 0.25
  for (const f of [0.55, 0.45, 0.3, null, undefined, "x", 0, 2]) assert.equal(bad({ head_fraction: f, framing: "waist_up" }).ok, true, "head_fraction " + f);   // the word label alone never rejects
  for (const f of [0.25, 0.12, 0.29]) assert.equal(bad({ head_fraction: f }).code, "framing", "head_fraction " + f);
  assert.match(bad({ head_fraction: 0.2 }).message, /closer photo/);
  assert.match(bad({ has_badge_logo_or_text: true }).message, /badge, logo, name tag or writing/);
  assert.equal(H.decideVision(H.parseVision("not json")).code, "unreadable");
  assert.equal(H.parseVision('text {"people":1,"face_clear":true,"has_badge_logo_or_text":false} text').people, 1);
});

test("the consent line names no vendor and the check message names none either", () => {
  assert.match(H.CONSENT_TEXT, /third-party AI image providers/);
  const src = ["agent-appearance-headshot-lib.js", "agent-appearance-headshot-run-lib.js", "../agent-appearance.js"].map((f) => require("fs").readFileSync(require("path").join(__dirname, "../netlify/functions/lib", f), "utf8")).join("\n");
  assert.doesNotMatch(src, /topaz|nano[- ]banana|fal\.ai|gemini/i);
});

test("consent must match the current version", async () => {
  const w = world();
  assert.equal((await R.recordConsent({ deps: w.deps, userId: U, version: "old" })).ok, false);
  assert.equal(w.sheet.consent_at, null);
  assert.equal((await R.recordConsent({ deps: w.deps, userId: U, version: H.CONSENT_VERSION })).ok, true);
  assert.equal(w.sheet.consent_version, H.CONSENT_VERSION);
});

test("checkUpload saves a private working copy, records the verdict and keeps what Vision saw", async () => {
  const w = world();
  const r = await upload(w);
  assert.equal(r.ok, true); assert.equal(r.check.ok, true);
  const a = w.assets.find((x) => x.stage === "original");
  assert.ok(a.s3_key.startsWith(`smart-stage-appearance/${U}/${S}/original/`)); assert.equal(a.status, "pending");
  assert.equal(w.sheet.vision_attributes.attributes.clothing, "navy blazer");
});

test("checkUpload refuses someone else's key, a bad type, a tiny photo and a badge photo", async () => {
  const w = world();
  assert.equal((await R.checkUpload({ deps: w.deps, userId: U, key: "smart-stage-appearance/other/x/original/y.png", contentType: "image/png" })).ok, false);
  assert.equal((await R.checkUpload({ deps: w.deps, userId: U, key: rawKey(w), contentType: "image/gif" })).ok, false);
  w.deps.normalize = async () => ({ buffer: Buffer.from("w"), width: 300, height: 300, contentType: "image/jpeg" });
  assert.match((await upload(w)).error, /too small/);
  w.deps.normalize = async () => ({ buffer: Buffer.from("w"), width: 1000, height: 1000, contentType: "image/jpeg" });
  w.visionText = JSON.stringify({ people: 1, face_clear: true, framing: "head_shoulders", has_badge_logo_or_text: true, attributes: {} });
  const r = await upload(w);
  assert.equal(r.check.ok, false);
  assert.equal(w.assets.filter((x) => x.stage === "original" && x.status === "pending").length, 0);
  // the page can still say why: the state carries the verdict for a turned-away photo, and none once a good photo replaces it
  const st = await R.loadState({ deps: w.deps, userId: U });
  assert.equal(st.original, null); assert.equal(st.lastCheck.ok, false); assert.match(st.lastCheck.message, /badge, logo, name tag or writing/);
  w.visionText = GOOD; await upload(w);
  assert.equal((await R.loadState({ deps: w.deps, userId: U })).lastCheck, null);
});

test("enhance is blocked until consent and a passing photo, then runs one upscale and shows a draft", async () => {
  const w = world();
  assert.equal((await R.readyToEnhance({ deps: w.deps, userId: U })).code, "consent");
  await R.recordConsent({ deps: w.deps, userId: U, version: H.CONSENT_VERSION });
  assert.equal((await R.readyToEnhance({ deps: w.deps, userId: U })).code, "photo");
  await upload(w);
  const g = await R.readyToEnhance({ deps: w.deps, userId: U });
  assert.equal(g.ok, true);
  const run = await R.runEnhance({ deps: w.deps, userId: U, assetId: g.assetId });
  assert.equal(run.ok, true);
  assert.equal(w.sheet.pool_remaining, 11);
  assert.equal(w.runnerCalls[0].endpoint, A.ENDPOINTS.upscale);
  assert.equal(w.runnerCalls[0].input.upscale_factor, 4);
  assert.equal(w.calls[0].quoted_usd, 0.16);
  const st = await R.loadState({ deps: w.deps, userId: U });
  assert.equal(st.enhanced.length, 1); assert.equal(st.working, false); assert.equal(st.sheet.poolRemaining, 11);
  assert.match(st.enhanced[0].fullUrl, /^https:\/\/signed\.example\/smart-stage-appearance\/.+\.png$/);
  // the page shows the small copy; the full image is the fallback
  assert.match(st.enhanced[0].url, /_preview\.jpg$/);
  assert.ok(Object.keys(w.files).some((k) => /enhanced_headshot\/.+_preview\.jpg$/.test(k)));
});

test("a failed enhancement gives the iteration back and reports it plainly", async () => {
  const w = world({ failRunner: true });
  await R.recordConsent({ deps: w.deps, userId: U, version: H.CONSENT_VERSION }); await upload(w);
  const g = await R.readyToEnhance({ deps: w.deps, userId: U });
  const run = await R.runEnhance({ deps: w.deps, userId: U, assetId: g.assetId });
  assert.equal(run.ok, false); assert.equal(w.sheet.pool_remaining, 12);
  const st = await R.loadState({ deps: w.deps, userId: U });
  assert.match(st.lastFailure, /Your iteration was not used/);
  assert.doesNotMatch(JSON.stringify(st), /boom/);
});

test("only one enhancement at a time, and a stuck one is closed out and returned after 10 minutes", async () => {
  const w = world();
  await R.recordConsent({ deps: w.deps, userId: U, version: H.CONSENT_VERSION }); await upload(w);
  w.sheet.pool_remaining = 11;
  w.calls.push({ id: "c9", stage: "enhanced_headshot", status: "started", started_at: new Date().toISOString() });
  assert.equal((await R.readyToEnhance({ deps: w.deps, userId: U })).code, "busy");
  const later = Date.now() + R.STALE_CALL_MS + 1000;
  assert.equal((await R.readyToEnhance({ deps: w.deps, userId: U, now: later })).ok, true);
  assert.equal(w.sheet.pool_remaining, 12); assert.equal(w.calls[0].status, "refunded");
});

test("an empty pool stops the enhancement and offers the refill", async () => {
  const w = world();
  await R.recordConsent({ deps: w.deps, userId: U, version: H.CONSENT_VERSION }); await upload(w);
  w.sheet.pool_remaining = 0;
  const g = await R.readyToEnhance({ deps: w.deps, userId: U });
  assert.equal(g.code, "pool_empty"); assert.match(g.error, /5 Images to get 12 more/);
});

test("approve copies the headshot to the profile's own folder, supersedes older drafts and sets the Marketing Profile headshot", async () => {
  const w = world();
  await R.recordConsent({ deps: w.deps, userId: U, version: H.CONSENT_VERSION }); await upload(w);
  const g = await R.readyToEnhance({ deps: w.deps, userId: U });
  await R.runEnhance({ deps: w.deps, userId: U, assetId: g.assetId });
  await R.runEnhance({ deps: w.deps, userId: U, assetId: g.assetId });
  const [d1, d2] = w.assets.filter((x) => x.stage === "enhanced_headshot");
  const r = await R.approveEnhanced({ deps: w.deps, userId: U, assetId: d2.id, brandingPrefix: BRAND, now: 1000 });
  assert.equal(r.ok, true); assert.equal(r.profileUpdated, true);
  assert.ok(w.profile.headshot_key.startsWith(BRAND + "headshot_1000_"));
  assert.ok(w.profile.headshot_key.endsWith(".jpg"));
  assert.equal(w.normalizeMax[w.normalizeMax.length - 1], 2048);   // the profile copy is a 2048 px JPEG, not the 3200 px result
  assert.ok(w.files[w.profile.headshot_key]);
  assert.equal(d2.status, "approved"); assert.equal(d1.status, "rejected"); assert.equal(w.sheet.status, "in_progress");
  // approving an approved headshot again is allowed: it only saves the profile copy again
  assert.equal((await R.approveEnhanced({ deps: w.deps, userId: U, assetId: d2.id, brandingPrefix: BRAND, now: 2000 })).ok, true);
  assert.ok(w.profile.headshot_key.startsWith(BRAND + "headshot_2000_"));
  assert.equal((await R.approveEnhanced({ deps: w.deps, userId: U, assetId: d1.id, brandingPrefix: BRAND })).ok, false);   // a rejected one stays rejected
  const st = await R.loadState({ deps: w.deps, userId: U });
  assert.ok(st.approved); assert.equal(st.enhanced.length, 0);
});

test("a heavy PNG profile copy (saved before the lighter copy existed) is flagged, and one re-save replaces it at no cost", async () => {
  const w = world();
  await R.recordConsent({ deps: w.deps, userId: U, version: H.CONSENT_VERSION }); await upload(w);
  await R.runEnhance({ deps: w.deps, userId: U, assetId: (await R.readyToEnhance({ deps: w.deps, userId: U })).assetId });
  const d = w.assets.find((x) => x.stage === "enhanced_headshot");
  await R.approveEnhanced({ deps: w.deps, userId: U, assetId: d.id, brandingPrefix: BRAND, now: 1000 });
  assert.equal((await R.loadState({ deps: w.deps, userId: U })).profileCopyHeavy, false);
  const pool = w.sheet.pool_remaining;
  w.profile.headshot_key = BRAND + "headshot_999_abcdef.png";
  assert.equal((await R.loadState({ deps: w.deps, userId: U })).profileCopyHeavy, true);
  assert.equal((await R.approveEnhanced({ deps: w.deps, userId: U, assetId: d.id, brandingPrefix: BRAND, now: 3000 })).ok, true);
  assert.equal((await R.loadState({ deps: w.deps, userId: U })).profileCopyHeavy, false);
  assert.equal(w.sheet.pool_remaining, pool);   // no iteration used
});

test("approve with no Marketing Profile yet still approves and says the profile was not updated", async () => {
  const w = world({ profile: null });
  await R.recordConsent({ deps: w.deps, userId: U, version: H.CONSENT_VERSION }); await upload(w);
  await R.runEnhance({ deps: w.deps, userId: U, assetId: (await R.readyToEnhance({ deps: w.deps, userId: U })).assetId });
  const d = w.assets.find((x) => x.stage === "enhanced_headshot");
  const r = await R.approveEnhanced({ deps: w.deps, userId: U, assetId: d.id, brandingPrefix: BRAND });
  assert.equal(r.ok, true); assert.equal(r.profileUpdated, false);
});

test("reject marks the draft rejected and costs nothing more", async () => {
  const w = world();
  await R.recordConsent({ deps: w.deps, userId: U, version: H.CONSENT_VERSION }); await upload(w);
  await R.runEnhance({ deps: w.deps, userId: U, assetId: (await R.readyToEnhance({ deps: w.deps, userId: U })).assetId });
  const d = w.assets.find((x) => x.stage === "enhanced_headshot");
  assert.equal((await R.rejectEnhanced({ deps: w.deps, userId: U, assetId: d.id })).ok, true);
  assert.equal(d.status, "rejected"); assert.equal(w.sheet.pool_remaining, 11);
});

test("refill: only when empty, only when confirmed, charges 5 Images, sets the pool to 12 and returns the charge if it fails", async () => {
  const w = world();
  assert.match((await R.refillPool({ deps: w.deps, userId: U, confirmed: true })).error, /still have 12/);
  w.sheet.pool_remaining = 0;
  const ask = await R.refillPool({ deps: w.deps, userId: U });
  assert.equal(ask.code, "confirm_charge"); assert.equal(ask.images, 5); assert.equal(w.charges.length, 0);
  const ok = await R.refillPool({ deps: w.deps, userId: U, confirmed: true });
  assert.equal(ok.ok, true); assert.equal(w.sheet.pool_remaining, 12); assert.equal(w.sheet.pool_refills, 1);
  assert.deepEqual(w.charges[0], { images: 5, reason: "appearance_sheet_refill", isRefund: false });
  const w2 = world({ chargeStatus: 402 }); w2.sheet.pool_remaining = 0;
  assert.equal((await R.refillPool({ deps: w2.deps, userId: U, confirmed: true })).code, "insufficient_credits");
  assert.equal(w2.sheet.pool_remaining, 0);
  const w3 = world(); w3.sheet.pool_remaining = 0; w3.deps.db.refill = async () => { throw new Error("db"); };
  const bad = await R.refillPool({ deps: w3.deps, userId: U, confirmed: true });
  assert.equal(bad.ok, false); assert.equal(w3.charges[1].isRefund, true);
});
