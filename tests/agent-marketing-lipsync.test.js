// Optional Lip sync step: Off by default, never reaches HeyGen without the key and Sam's approval flag, reuses paid work on a retry,
// and falls back scene by scene. Every outside call is a stand-in here, so this test spends nothing.
const test = require("node:test");
const assert = require("node:assert");
const L = require("../netlify/functions/lib/agent-marketing-lipsync-lib");
const H = require("../netlify/functions/lib/heygen-lib");

const manifest = () => ({ version: "am-manifest-2", scenes: [
  { n: 1, composition: "opening_news_brief", window: { start: 0, end: 7.5 }, visual: { image_keys: {} } },
  { n: 2, composition: "stat_big_number", window: { start: 7.5, end: 40 }, visual: { image_keys: {} } },
  { n: 3, composition: "closing_editorial_portrait", window: { start: 40, end: 52 }, visual: { image_keys: {} } },
] });
const audio = { key: "agent-marketing-assets/u/p/j/narration.mp3" };
const LIVE = { HEYGEN_API_KEY: "k", AGENT_MARKETING_HEYGEN_LIVE: "approved" };

function rig({ createFails = [], finish = "completed", never = false } = {}) {
  const log = { cuts: [], puts: [], creates: [], gets: [], saves: [] };
  let vid = 0;
  const deps = {
    cutExcerpt: async (url, s, e) => { log.cuts.push([s, e]); return Buffer.from("mp3"); },
    put: async (k, b) => { log.puts.push(k); },
    presign: async (k) => `https://s3.example/${k}`,
    heygen: {
      create: async (a) => { log.creates.push(a); if (createFails.includes(a.aspect)) throw new Error("HeyGen returned 402: not enough credit"); return { videoId: `v${++vid}` }; },
      get: async (id) => { log.gets.push(id); return never ? { status: "processing" } : finish === "failed" ? { status: "failed", failure: "face not found" } : { status: "completed", videoUrl: `https://files/${id}.mp4`, duration: 7.5 }; },
      download: async () => Buffer.from("mp4"),
    },
    saveState: async (s) => { log.saves.push(JSON.parse(JSON.stringify(s))); },
    sleep: async () => {},
    now: (() => { let t = 0; return () => (t += never ? 200000 : 1); })(),
  };
  return { deps, log };
}
const job = (lipsync) => ({ id: "amj-1", assets: { audio, ...(lipsync ? { lipsync } : {}) } });

test("Off by default: a job with no lip-sync request (every existing job) is not a lip-sync job", () => {
  assert.strictEqual(L.requested({ assets: { audio } }), false);
  assert.strictEqual(L.requested({ assets: null }), false);
  assert.strictEqual(L.requested({ assets: { lipsync: { requested: true } } }), true);
});

test("targets: the opening and the closing, with each scene's own window and the right picture shape", () => {
  assert.deepStrictEqual(L.targets(manifest()).map((t) => [t.n, t.role, t.start, t.end, t.aspect]), [[1, "opening", 0, 7.5, "1:1"], [3, "closing", 40, 52, "4:5"]]);
});

test("without the key or without the approval flag nothing reaches HeyGen and every scene keeps its still headshot", async () => {
  for (const env of [{}, { HEYGEN_API_KEY: "k" }, { AGENT_MARKETING_HEYGEN_LIVE: "approved" }, { HEYGEN_API_KEY: "k", AGENT_MARKETING_HEYGEN_LIVE: "yes" }]) {
    const { deps, log } = rig();
    const r = await L.prepareLipSync({ job: job({ requested: true }), manifest: manifest(), audio, headshotKey: "hs", env, deps });
    assert.strictEqual(r.calls, 0);
    assert.deepStrictEqual([log.cuts.length, log.creates.length, log.gets.length, log.puts.length], [0, 0, 0, 0]);
    assert.deepStrictEqual(r.report.map((x) => x.status), ["skipped", "skipped"]);
    assert.ok(r.manifest.scenes.every((s) => !s.lipsync));
  }
});

test("both clips: one excerpt and one HeyGen job per scene, clips stored, manifest carries them, state saved", async () => {
  const { deps, log } = rig();
  const r = await L.prepareLipSync({ job: job({ requested: true }), manifest: manifest(), audio, headshotKey: "hs", env: LIVE, deps });
  assert.deepStrictEqual(log.cuts, [[0, 7.5], [40, 52]]);
  assert.strictEqual(log.creates.length, 2);
  assert.deepStrictEqual(log.creates.map((c) => c.idempotencyKey), ["ssp-amj-1-scene1-a1", "ssp-amj-1-scene3-a1"]);
  assert.deepStrictEqual(r.report.map((x) => x.status), ["used", "used"]);
  assert.strictEqual(r.manifest.scenes[0].lipsync.clip_key, "agent-marketing-assets/u/p/j/lipsync_1.mp4");
  assert.strictEqual(r.manifest.scenes[1].lipsync, undefined);
  assert.strictEqual(r.manifest.scenes[2].lipsync.clip_key, "agent-marketing-assets/u/p/j/lipsync_3.mp4");
  assert.strictEqual(log.saves[log.saves.length - 1].scenes[1].status, "done");
});

test("retry after a failed render: both clips are reused, so nothing is cut, created or polled again", async () => {
  const first = rig();
  const a = await L.prepareLipSync({ job: job({ requested: true }), manifest: manifest(), audio, headshotKey: "hs", env: LIVE, deps: first.deps });
  const second = rig();
  const b = await L.prepareLipSync({ job: job(a.state), manifest: manifest(), audio, headshotKey: "hs", env: LIVE, deps: second.deps });
  assert.deepStrictEqual([second.log.cuts.length, second.log.creates.length, second.log.gets.length], [0, 0, 0]);
  assert.deepStrictEqual(b.report.map((x) => x.status), ["used", "used"]);
  assert.ok(b.manifest.scenes[0].lipsync && b.manifest.scenes[2].lipsync);
});

test("one clip can't be made: that scene falls back and is named; the other is used; a retry re-asks only for the failed one", async () => {
  const first = rig({ createFails: ["4:5"] });
  const a = await L.prepareLipSync({ job: job({ requested: true }), manifest: manifest(), audio, headshotKey: "hs", env: LIVE, deps: first.deps });
  assert.deepStrictEqual(a.report.map((x) => [x.n, x.status]), [[1, "used"], [3, "fallback"]]);
  assert.match(a.report[1].reason, /402/);
  assert.ok(a.manifest.scenes[0].lipsync && !a.manifest.scenes[2].lipsync);
  const second = rig();
  const b = await L.prepareLipSync({ job: job(a.state), manifest: manifest(), audio, headshotKey: "hs", env: LIVE, deps: second.deps });
  assert.strictEqual(second.log.creates.length, 1, "only the closing is asked again");
  assert.strictEqual(second.log.creates[0].aspect, "4:5");
  assert.strictEqual(second.log.cuts.length, 0, "no excerpt is cut again: both were already stored");
  assert.deepStrictEqual(b.report.map((x) => x.status), ["used", "used"]);
});

test("HeyGen not finished in time: the scene falls back, and the next attempt checks the SAME HeyGen job instead of making a second", async () => {
  const first = rig({ never: true });
  const a = await L.prepareLipSync({ job: job({ requested: true }), manifest: manifest(), audio, headshotKey: "hs", env: LIVE, deps: first.deps });
  assert.deepStrictEqual(a.report.map((x) => x.status), ["fallback", "fallback"]);
  assert.strictEqual(a.state.scenes[1].status, "pending");
  const second = rig();
  const b = await L.prepareLipSync({ job: job(a.state), manifest: manifest(), audio, headshotKey: "hs", env: LIVE, deps: second.deps });
  assert.strictEqual(second.log.creates.length, 0);
  assert.deepStrictEqual(second.log.gets.sort(), ["v1", "v2"]);
  assert.deepStrictEqual(b.report.map((x) => x.status), ["used", "used"]);
});

test("HeyGen reports a failed clip: fallback with its reason; the next attempt makes one new job for that scene", async () => {
  const first = rig({ finish: "failed" });
  const a = await L.prepareLipSync({ job: job({ requested: true }), manifest: manifest(), audio, headshotKey: "hs", env: LIVE, deps: first.deps });
  assert.match(a.report[0].reason, /face not found/);
  const second = rig();
  await L.prepareLipSync({ job: job(a.state), manifest: manifest(), audio, headshotKey: "hs", env: LIVE, deps: second.deps });
  assert.strictEqual(second.log.creates.length, 2);
  assert.deepStrictEqual(second.log.creates.map((c) => c.idempotencyKey), ["ssp-amj-1-scene1-a2", "ssp-amj-1-scene3-a2"]);
});

test("HeyGen client: request shape, idempotency header, and status mapping (no network)", async () => {
  const seen = [];
  const c = H.client({ apiKey: "k", request: async (m, p, b, h) => { seen.push([m, p, b, h]); return m === "POST" ? { status: 200, json: { data: { video_id: "v_9", status: "waiting" } } } : { status: 200, json: { data: { status: "completed", video_url: "https://x/y.mp4", duration: 7.4 } } }; } });
  const made = await c.create({ imageUrl: "https://i", audioUrl: "https://a", aspect: "1:1", title: "t", idempotencyKey: "key-1" });
  assert.strictEqual(made.videoId, "v_9");
  assert.deepStrictEqual(seen[0][2], { type: "image", image: { type: "url", url: "https://i" }, audio_url: "https://a", aspect_ratio: "1:1", resolution: "720p", title: "t" });
  assert.deepStrictEqual(seen[0][3], { "Idempotency-Key": "key-1" });
  assert.deepStrictEqual(await c.get("v_9"), { status: "completed", videoUrl: "https://x/y.mp4", duration: 7.4, failure: null });
  assert.throws(() => H.client({}), /not configured/);
  const bad = H.client({ apiKey: "k", request: async () => ({ status: 402, json: { error: { message: "insufficient credit" } } }) });
  await assert.rejects(bad.create({ imageUrl: "i", audioUrl: "a" }), /402: insufficient credit/);
});
