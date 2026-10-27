"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fx = require("./fixtures/natomas-approved.json");
const lib = require("../netlify/functions/lib/agent-marketing-assets-lib");
const timing = require("../netlify/functions/lib/agent-marketing-timing-lib");
const director = require("../netlify/functions/lib/agent-marketing-director-lib");

// words at an even pace, as ElevenLabs would return them
const words = timing.captionWords(fx.narrative.narrationTagged).map((t, i) => ({ text: t, start: 0.3 + i * 0.4, end: 0.3 + i * 0.4 + 0.34 }));
const duration = Math.round((words[words.length - 1].end + 0.5) * 100) / 100;
const brand = { primary: "#B08D3F", secondary: "#1D2023", border: "#B08D3F", font: "Montserrat", headshot_key: "profiles/hs.png", agent: { name: "Sam Zieour", brokerage: "SZ Real Estate Group" } };
const keys = (s) => ({ "9x16": `i${s}_9`, "16x9": `i${s}_16` });
const input = (over) => ({ projectId: "p1", formats: ["9x16", "16x9"], narrative: fx.narrative, intake: fx.intake, reportFigures: fx.reportFigures, notice: { period: lib.parseNoticePeriod(fx.narrative.notice) }, brand, narrationTagged: fx.narrative.narrationTagged, audio: { narration_key: "a.mp3", duration_sec: duration, words }, imageKeys: { 0: keys(0), 1: keys(1), 2: keys(2), 4: keys(4) }, ...over });

test("the approved Natomas script builds a valid manifest", () => {
  const r = lib.buildManifest(input());
  assert.ok(r.manifest, JSON.stringify(r.validation));
  assert.deepStrictEqual(r.validation.errors, [], JSON.stringify(r.validation.errors));
  const comps = r.manifest.scenes.map((s) => s.composition);
  assert.deepStrictEqual(comps, ["opening_headline_focus", "stat_big_number", "compare_two_card", "expert_takeaway", "closing_headline_focus"]);
  assert.strictEqual(r.manifest.scenes[3].visual.image_keys["9x16"], "i2_9", "scene 4 reuses scene 3's image");
  assert.strictEqual(r.manifest.notice.text, "Based on information from MetroList Services, Inc. for the period February 19, 2026 through October 19, 2026.");
});

test("every number on a card traces to a verified figure", () => {
  const { manifest } = lib.buildManifest(input());
  assert.strictEqual(manifest.scenes[1].data.value, "41");
  assert.deepStrictEqual(manifest.scenes[1].claims, [{ field: "value", figure: "r1.f7" }]);
  const cmp = manifest.scenes[2];
  assert.strictEqual(cmp.data.left.percent, 99.4);
  assert.strictEqual(cmp.data.right.highlighted, 6);
  assert.strictEqual(cmp.data.right.total, 14);
  assert.deepStrictEqual(cmp.claims.map((c) => c.figure), ["r1.f16", "r1.f6", "r1.f1"]);
  assert.ok(manifest.figures.every((f) => ["r1.f7", "r1.f16", "r1.f6", "r1.f1"].includes(f.ref)), "only the figures used are carried");
});

test("captions are the approved words and the scenes cover the audio", () => {
  const { manifest } = lib.buildManifest(input());
  assert.strictEqual(manifest.captions.map((c) => c.text).join(" "), timing.captionWords(fx.narrative.narrationTagged).join(" "));
  assert.strictEqual(manifest.scenes[0].window.start, 0);
  assert.ok(Math.abs(manifest.scenes[4].window.end - duration) < 0.01);
});

test("a 9:16-only job only needs 9:16 images", () => {
  const r = lib.buildManifest(input({ formats: ["9x16"], imageKeys: { 0: { "9x16": "a" }, 1: { "9x16": "b" }, 2: { "9x16": "c" }, 4: { "9x16": "e" } } }));
  assert.deepStrictEqual(r.validation.errors, []);
});

test("a missing image stops the build with a plain error", () => {
  const r = lib.buildManifest(input({ imageKeys: { 0: keys(0), 2: keys(2), 4: keys(4) } }));
  assert.ok(!r.validation.ok);
  assert.ok(r.validation.errors.some((e) => /no 9x16 background|no 16x9 background/.test(e.message)));
});

test("words that do not add up to the scenes are refused", () => {
  const r = lib.buildManifest(input({ audio: { narration_key: "a.mp3", duration_sec: duration, words: words.slice(0, -3) } }));
  assert.strictEqual(r.manifest, null);
  assert.ok(!r.validation.ok);
});

test("image needs: generate, reuse and brand plate", () => {
  const n = lib.imageNeeds(fx.narrative);
  assert.deepStrictEqual(n.map((x) => x.kind), ["generate", "generate", "generate", "reuse", "plate"]);
  assert.strictEqual(n[3].owner, 2);
});

test("notice period round-trips and bad text is refused", () => {
  assert.deepStrictEqual(lib.parseNoticePeriod(fx.narrative.notice), { start: "2026-02-19", end: "2026-10-19" });
  assert.strictEqual(lib.parseNoticePeriod("nothing here"), null);
});

test("voices: ssp_male defaults to the ssp-prospect narrator, ssp_female needs a setting", () => {
  assert.strictEqual(lib.voiceIdFor("ssp_male", {}), "J7X6yWhJQlWW5OoUeuP1");
  assert.strictEqual(lib.voiceIdFor("ssp_female", {}), null);
  assert.strictEqual(lib.voiceIdFor("ssp_female", { AGENT_MARKETING_VOICE_SSP_FEMALE: "x" }), "x");
});

test("director: figures are matched by value and context, not guessed", () => {
  const figs = director.figuresFrom(fx.reportFigures);
  const f = director.figuresInExcerpt("Active listings are sitting a median of 41 days before going under contract.", figs);
  assert.deepStrictEqual(f.map((x) => x.ref), ["r1.f7"]);
  assert.strictEqual(figs.find((x) => x.ref === "r1.f16").n, 46);
  assert.strictEqual(figs.find((x) => x.ref === "r1.f7").n, 14);
});

test("the rewritten Natomas script (pauses, ellipses) still builds a valid manifest", () => {
  const NEW = "[conversational] If you're thinking about selling in Natomas, new construction is part of your competition. Giving buyers more options. [pause] So what does the resale market actually show? Active listings are sitting a median of 41 days before going under contract\u2026 and homes that closed sold at an average of 99.4% of the list price. [thoughtful] But the active market, 6 of 14 listings have already taken a price reduction. That gap between homes that sold and homes that didn't tells a real story. [emphasis] This means condition and pricing precision matter\u2026 New construction sets a baseline so your home has to answer for itself. [warm] Want to talk through where your home fits in that picture? I'm happy to walk you through it.";
  const EX = [
    "If you're thinking about selling in Natomas, new construction is part of your competition. Giving buyers more options.",
    "So what does the resale market actually show? Active listings are sitting a median of 41 days before going under contract\u2026",
    "and homes that closed sold at an average of 99.4% of the list price. But the active market, 6 of 14 listings have already taken a price reduction. That gap between homes that sold and homes that didn't tells a real story.",
    "This means condition and pricing precision matter\u2026 New construction sets a baseline so your home has to answer for itself.",
    "Want to talk through where your home fits in that picture? I'm happy to walk you through it.",
  ];
  const narrative = { ...fx.narrative, narrationTagged: NEW, scenes: fx.narrative.scenes.map((s, i) => ({ ...s, narrationExcerpt: EX[i] })) };
  const w = timing.captionWords(NEW).map((t, i) => ({ text: t, start: 0.3 + i * 0.33, end: 0.3 + i * 0.33 + 0.3 }));
  const r = lib.buildManifest(input({ narrative, narrationTagged: NEW, audio: { narration_key: "a.mp3", duration_sec: w[w.length - 1].end + 0.5, words: w } }));
  assert.deepStrictEqual(r.validation.errors, [], JSON.stringify(r.validation.errors));
  const takeaway = r.manifest.scenes[3].data;
  assert.deepStrictEqual(takeaway.headline, ["This Means Condition and", "Pricing Precision Matter"]);
  assert.strictEqual(takeaway.statement, "New construction sets a baseline so your home has to answer for itself.");
  assert.ok(r.manifest.captions.some((c) => /\u2026/.test(c.text)), "ellipses stay in the captions");
});
