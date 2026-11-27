// Agent Appearance Sheet, slice 1: rules, quotes, request shapes, private keys, pool and ledger behavior. Every outside call is a stand-in: this spends nothing.
const test = require("node:test");
const assert = require("node:assert");
const A = require("../netlify/functions/lib/agent-appearance-lib");
const { runCall } = require("../netlify/functions/lib/agent-appearance-run-lib");
const F = require("../netlify/functions/lib/agent-appearance-fal-lib");

const U = "11111111-1111-4111-8111-111111111111", S = "22222222-2222-4222-8222-222222222222", AS = "33333333-3333-4333-8333-333333333333";

test("pool rules: 12 to start, 5 Images buys 12 more", () => {
  assert.equal(A.POOL_SIZE, 12);
  assert.equal(A.REFILL_IMAGES, 5);
  assert.match(A.poolText({ pool_remaining: 7 }), /7 of 12 iterations left/);
  assert.match(A.poolText({ pool_remaining: 0 }), /5 Images to get 12 more/);
  assert.equal(A.poolEmpty({ pool_remaining: 0 }), true);
  assert.equal(A.poolEmpty({ pool_remaining: 1 }), false);
});

test("stages: grids give 3, 6 and 4 crops; no rear view", () => {
  assert.deepEqual(A.STAGE_NAMES, ["enhanced_headshot", "three_quarter", "full_body", "angles", "expressions", "poses"]);
  assert.equal(A.panelCount("angles"), 3);
  assert.equal(A.panelCount("expressions"), 6);
  assert.equal(A.panelCount("poses"), 4);
  assert.equal(A.panelCount("full_body"), 1);
});

test("quotes follow the published rates", () => {
  assert.equal(A.quoteImageEdit(), 0.15);
  assert.equal(A.quoteImageEdit({ resolution: "4K" }), 0.3);
  // 1000x1000 x4 = 16 MP: Wonder 3 bills per started 8 MP (2 steps), Redefine per started 4 MP (4 steps)
  assert.equal(A.quoteUpscale({ width: 1000, height: 1000, factor: 4, model: "Wonder 3" }), 0.16);
  assert.equal(A.quoteUpscale({ width: 1000, height: 1000, factor: 4, model: "Redefine" }), 0.32);
  assert.equal(A.quoteUpscale({ width: 0, height: 10 }), null);
  // one full clean run, with the spec's included redo on each: 1 upscale + 5 image calls, then the 12-call maximum
  assert.equal(Math.round((0.16 + 5 * A.quoteImageEdit()) * 100) / 100, 0.91);
});

test("request bodies", () => {
  const e = A.buildImageEditInput({ prompt: " x ", imageUrls: ["u1", "u2"], aspectRatio: "1:1" });
  assert.deepEqual(e, { prompt: "x", image_urls: ["u1", "u2"], num_images: 1, aspect_ratio: "1:1", output_format: "png", resolution: "1K", limit_generations: true });
  assert.throws(() => A.buildImageEditInput({ prompt: "", imageUrls: ["u"] }));
  assert.throws(() => A.buildImageEditInput({ prompt: "x", imageUrls: [] }));
  assert.throws(() => A.buildImageEditInput({ prompt: "x", imageUrls: new Array(15).fill("u") }));
  const t = A.buildUpscaleInput({ imageUrl: "u" });
  assert.equal(t.upscale_factor, 4); assert.equal(t.model, "Wonder 3"); assert.equal(t.face_enhancement, true);
  assert.throws(() => A.buildUpscaleInput({ imageUrl: "u", model: "nope" }));
  assert.deepEqual(A.firstImage({ images: [{ url: "a", content_type: "image/png" }] }), { url: "a", contentType: "image/png" });
  assert.deepEqual(A.firstImage({ image: { url: "b" } }), { url: "b", contentType: null });
  assert.equal(A.firstImage({ images: [] }), null);
});

test("storage is private, per subscriber, and never the public marketing prefix", () => {
  const k = A.assetKey({ userId: U, sheetId: S, stage: "poses", assetId: AS, ext: "png" });
  assert.equal(k, `smart-stage-appearance/${U}/${S}/poses/${AS}.png`);
  assert.ok(!k.startsWith("smart-stage-marketing/"));
  assert.equal(A.isOwnKey(U, k), true);
  assert.equal(A.isOwnKey("44444444-4444-4444-8444-444444444444", k), false);
  assert.throws(() => A.assetKey({ userId: "../x", sheetId: S, stage: "poses", assetId: AS }));
  assert.throws(() => A.assetKey({ userId: U, sheetId: S, stage: "nope", assetId: AS }));
});

function rig({ remaining = 12, runFails = false, noImage = false } = {}) {
  const log = { debits: 0, refunds: 0, calls: [], updates: [], assets: [], puts: [], runs: [] };
  let left = remaining;
  const deps = {
    db: { debit: async () => { if (left <= 0) return -1; log.debits++; return --left; }, refund: async () => { log.refunds++; left++; return left; },
      insertCall: async (r) => { log.calls.push(r); return "call-1"; }, updateCall: async (id, f) => { log.updates.push([id, f]); }, insertAsset: async (r) => { log.assets.push(r); return r.id; } },
    storage: { put: async (k, b, t) => { log.puts.push([k, t]); } },
    runner: { run: async (ep, input) => { log.runs.push([ep, input]); if (runFails) throw new Error("fal 500: boom"); return { requestId: "req-9", data: noImage ? { images: [] } : { images: [{ url: "https://f/x.png", content_type: "image/png" }] } }; } },
    download: async () => ({ buffer: Buffer.from("png"), contentType: "image/png" }),
    probe: async () => ({ width: 1024, height: 1024 }),
    uuid: () => AS,
  };
  return { deps, log, left: () => left };
}
const args = () => ({ sheet: { id: S }, userId: U, stage: "poses", providerKey: "imageEdit", input: { prompt: "p" }, quotedUsd: 0.15, inputAssetIds: [] });

test("a good call costs one iteration, is stored privately and is in the ledger", async () => {
  const r = rig();
  const out = await runCall(r.deps, args());
  assert.equal(out.ok, true); assert.equal(out.remaining, 11); assert.equal(r.left(), 11);
  assert.equal(r.log.calls[0].provider, "image_edit"); assert.equal(r.log.calls[0].endpoint, "fal-ai/nano-banana-pro/edit"); assert.equal(r.log.calls[0].pool_counted, true);
  assert.match(r.log.puts[0][0], /^smart-stage-appearance\//);
  assert.equal(r.log.assets[0].status, "pending"); assert.equal(r.log.assets[0].kind, "composite"); assert.equal(r.log.assets[0].width, 1024);
  const upd = r.log.updates[0][1];
  assert.equal(upd.status, "ok"); assert.equal(upd.request_id, "req-9"); assert.equal(upd.estimated_usd, 0.15); assert.equal(upd.output_asset_id, AS);
});

test("an empty pool makes no provider call and offers the refill", async () => {
  const r = rig({ remaining: 0 });
  const out = await runCall(r.deps, args());
  assert.equal(out.ok, false); assert.equal(out.code, "pool_empty"); assert.match(out.message, /5 Images/);
  assert.equal(r.log.runs.length, 0); assert.equal(r.log.calls.length, 0);
});

test("a failed or empty provider call is refunded and never shows vendor details", async () => {
  for (const opts of [{ runFails: true }, { noImage: true }]) {
    const r = rig(opts);
    const out = await runCall(r.deps, args());
    assert.equal(out.ok, false); assert.equal(out.code, "provider_failed");
    assert.equal(r.left(), 12); assert.equal(r.log.refunds, 1);
    assert.equal(r.log.updates[0][1].status, "refunded");
    assert.doesNotMatch(out.message, /fal|topaz|banana|500/i);
    assert.equal(r.log.assets.length, 0); assert.equal(r.log.puts.length, 0);
  }
});

test("the fal runner needs the key and passes the request through", async () => {
  await assert.rejects(() => F.falRunner({}).run("e", {}), /FAL_KEY/);
  const seen = {};
  const client = { fal: { config: (c) => { seen.cfg = c; }, subscribe: async (ep, o) => { seen.ep = ep; seen.o = o; return { requestId: "r1", data: { ok: 1 } }; } } };
  const out = await F.falRunner({ FAL_KEY: "k" }, () => client).run("e", { a: 1 });
  assert.deepEqual(out, { requestId: "r1", data: { ok: 1 } });
  assert.equal(seen.cfg.credentials, "k"); assert.equal(seen.ep, "e"); assert.deepEqual(seen.o.input, { a: 1 });
});
