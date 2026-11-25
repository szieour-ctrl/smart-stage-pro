"use strict";
const test = require("node:test");
const assert = require("node:assert");
const M = require("../netlify/functions/lib/agent-marketing-manifest-lib");

const period = { start: "2026-09-01", end: "2026-09-30" };
const CTX = "Sacramento-area resale homes beside newer Natomas subdivisions and active residential construction, shown as an illustrative street scene.";
function scene(n, composition, role, extra = {}) {
  return { n, composition, narrative_role: role, branding: composition.startsWith("opening") || composition.startsWith("closing") ? "full" : "subtle", narration_excerpt: "x",
    window: { start: (n - 1) * 6, end: n * 6 }, visual: { research_visual_context: CTX, image_keys: { "9x16": `img${n}_9x16.png`, "16x9": `img${n}_16x9.png` } }, claims: [], data: {}, ...extra };
}
function natomas() {
  return {
    version: "am-manifest-2", project_id: "p1", formats: ["9x16", "16x9"], notice_required: true,
    notice: { period, text: M.metroListNotice(period) },
    brand: { font: "Playfair Display", headshot_key: "hs.png", agent: { name: "Sam Zieour", brokerage: "SZ Real Estate Group" } },
    figures: [
      { ref: "r1.f1", label: "Median days on market", display: "41 days", value: 41, n: 14 },
      { ref: "r1.f2", label: "Sold-to-list ratio", display: "99.4%", value: 99.4, n: 22 },
      { ref: "r1.f3", label: "Active listings", display: "14", value: 14, n: 14 },
      { ref: "r1.f4", label: "Active with a price reduction", display: "6", value: 6, n: 14 },
    ],
    derived: [{ id: "d1", op: "ratio_percent", inputs: [{ ref: "r1.f4" }, { ref: "r1.f3" }], decimals: 1, result: 42.9, display: "about 42.9%" }],
    narration_text: "[warm] Natomas homes sold fast. [confident] That tells a story.",
    audio: { narration_key: "n.mp3", duration_sec: 30 },
    captions: [{ text: "Natomas homes sold fast.", start: 0, end: 12 }, { text: "That tells a story.", start: 12, end: 30 }],
    scenes: [
      scene(1, "opening_headline_focus", "hook", { data: { market: "Natomas", headline: "New Construction Is Part of Your Competition" } }),
      scene(2, "stat_big_number", "insight", { data: { lead: "Active Listings Are Sitting a Median of", value: "41", unit: "days" }, claims: [{ field: "value", figure: "r1.f1" }] }),
      scene(3, "compare_two_card", "contrast", { data: { left: { percent: 99.4, lead: "Homes That Closed Sold At" }, right: { highlighted: 6, total: 14, lead: "But in the Active Market," } }, claims: [{ field: "left.percent", figure: "r1.f2" }, { field: "right.highlighted", figure: "r1.f4" }, { field: "right.total", figure: "r1.f3" }] }),
      scene(4, "expert_takeaway", "consequence", { data: { headline: ["Condition +", "Pricing Precision Matter"], statement: "That gap tells a real story." } }),
      scene(5, "closing_headline_focus", "next_step", { data: { headline: ["Want to talk through where", "your home fits in this picture?"] } }),
    ].map((s, i, a) => ({ ...s, window: { start: i * 6, end: (i + 1) * 6 } })),
  };
}
const codes = (r) => r.errors.map((e) => e.code);

test("a sound Natomas manifest passes with no errors", () => {
  const r = M.validateManifest(natomas());
  assert.deepStrictEqual(r.errors, []);
  assert.ok(r.ok);
});

test("a calculated number is allowed when it recomputes, and refused when it does not", () => {
  const m = natomas();
  m.scenes[3].data.statement = "About 42.9% of active listings took a reduction.";
  assert.deepStrictEqual(M.validateManifest(m).errors, []);
  m.derived[0].result = 43.9;
  assert.ok(codes(M.validateManifest(m)).includes("calculation"));
  const m2 = natomas();
  m2.derived[0].inputs[0].ref = "r9.nope";
  assert.ok(M.validateManifest(m2).errors.some((e) => /not a verified numeric figure/.test(e.message)));
});

test("a number that is neither a figure nor a calculation is a factual error", () => {
  const m = natomas();
  m.scenes[3].data.statement = "Homes now take 55 days to sell.";
  assert.ok(M.validateManifest(m).errors.some((e) => e.code === "number" && /55/.test(e.message)));
  const n = natomas();
  n.scenes[1].data.value = "42";
  assert.ok(M.validateManifest(n).errors.some((e) => e.code === "claim" && /source says 41/.test(e.message)));
  const u = natomas();
  u.scenes[1].claims = [];
  assert.ok(M.validateManifest(u).errors.some((e) => /no source figure or calculation/.test(e.message)));
});

test("small samples: trend wording is qualified automatically, not rejected", () => {
  const q = M.qualifySmallSample("Prices are rising, which is a clear trend.", 8);
  assert.ok(q.changed);
  assert.match(q.text, /^In the 8 listings reviewed, prices are rising, which is a clear pattern\.$/);
  assert.deepStrictEqual(M.qualifySmallSample("Prices are rising.", 14), { text: "Prices are rising.", changed: false });
  assert.deepStrictEqual(M.qualifySmallSample("6 of 8 listings cut their price.", 8), { text: "6 of 8 listings cut their price.", changed: false });
  const m = natomas();
  m.figures[3].n = 8;
  m.scenes[2].data.right.lead = "Prices are rising fast here.";
  const before = M.validateManifest(m);
  assert.ok(codes(before).includes("small_sample"));
  const { manifest, edits } = M.applySmallSampleQualifiers(m);
  assert.strictEqual(edits.length, 1);
  assert.match(manifest.scenes[2].data.right.lead, /^In the 8 listings reviewed, prices are rising fast here\.$/);
  assert.ok(!codes(M.validateManifest(manifest)).includes("small_sample"));
  assert.strictEqual(m.scenes[2].data.right.lead, "Prices are rising fast here.", "the original is not mutated");
});

test("creative notes are warnings and never block", () => {
  const m = natomas();
  m.scenes[2].composition = "stat_big_number"; m.scenes[2].claims = [{ field: "value", figure: "r1.f1" }]; m.scenes[2].data = { value: "41", lead: "x" };
  m.scenes[3].composition = "stat_big_number"; m.scenes[3].claims = [{ field: "value", figure: "r1.f1" }]; m.scenes[3].data = { value: "41", lead: "y" };
  m.scenes[1].visual.research_visual_context = "A beautiful neighborhood photograph";
  const r = M.validateManifest(m);
  assert.deepStrictEqual(r.errors, []);
  const w = r.warnings.map((x) => x.code);
  assert.ok(w.includes("repeat") && w.includes("visual_context") && w.includes("variety"));
});

test("technical errors: notice, headshot, assets, planned compositions, timing, captions", () => {
  let m = natomas(); m.notice.text = "Based on information from MetroList."; assert.ok(codes(M.validateManifest(m)).includes("notice"));
  m = natomas(); m.notice.period = { start: "x", end: "y" }; assert.ok(M.validateManifest(m).errors.some((e) => /report period is required/.test(e.message)));
  m = natomas(); delete m.brand.headshot_key; assert.ok(codes(M.validateManifest(m)).includes("headshot"));
  m = natomas(); delete m.scenes[2].visual.image_keys["16x9"]; assert.ok(M.validateManifest(m).errors.some((e) => /no 16x9 background/.test(e.message)));
  m = natomas(); m.scenes[1].composition = "chart_time_series"; assert.ok(M.validateManifest(m).errors.some((e) => /cannot be drawn yet/.test(e.message)));
  m = natomas(); m.scenes[0].composition = "stat_big_number"; assert.ok(codes(M.validateManifest(m)).includes("composition_role"));
  m = natomas(); m.scenes[2].window.start = 20; assert.ok(codes(M.validateManifest(m)).includes("timing"));
  m = natomas(); m.audio.duration_sec = 40; assert.ok(codes(M.validateManifest(m)).includes("timing"));
  m = natomas(); m.captions[1].text = "That tells a different story."; assert.ok(M.validateManifest(m).errors.some((e) => /word for word/.test(e.message)));
  m = natomas(); m.brand.font = "Comic Sans MS"; assert.ok(codes(M.validateManifest(m)).includes("font"));
  m = natomas(); m.formats = ["9x16"]; delete m.scenes[0].visual.image_keys["16x9"]; assert.deepStrictEqual(M.validateManifest(m).errors, [], "a 9:16-only order needs no 16:9 images");
});

test("the notice is the same sentence Railway draws", () => {
  assert.strictEqual(M.metroListNotice(period), "Based on information from MetroList Services, Inc. for the period September 1, 2026 through September 30, 2026.");
  assert.strictEqual(M.metroListNotice({ start: "", end: "" }), null);
});

test("source role: opening and closing source the data; a middle scene may source the approved article; bad values are refused", () => {
  const m = natomas();
  m.scenes[1].source_role = "article";
  assert.ok(!M.validateManifest(m).errors.some((e) => e.code === "source_role"));
  const bad = natomas(); bad.scenes[0].source_role = "article";
  assert.ok(M.validateManifest(bad).errors.some((e) => e.code === "source_role" && /Opening and closing/.test(e.message)));
  const last = natomas(); last.scenes[last.scenes.length - 1].source_role = "article";
  assert.ok(M.validateManifest(last).errors.some((e) => e.code === "source_role"));
  const odd = natomas(); odd.scenes[1].source_role = "redfin";
  assert.ok(M.validateManifest(odd).errors.some((e) => e.code === "source_role" && /"data" or "article"/.test(e.message)));
});
