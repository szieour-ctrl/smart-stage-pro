"use strict";
// The shared duration contract (Phase A, Nov 12, 2026: reproduced the values then in force; Phase B, Nov 13, 2026: 60-second Test aim 140-146, advisory 133-151,
// editor targets 110 (45 s) and 146 (60 s)). Production values and the unknown-duration fallback are unchanged.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

const am = require("../netlify/functions/lib/agent-marketing-lib");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");

const PROD_HASH = "25f3118fed1b9726fc4dc78b16dcc92233cef785d3c074ef89a6ee7aaf7b0495";
const withEnv = (v, fn) => { const was = process.env.AGENT_MARKETING_B1_EVIDENCE; if (v === undefined) delete process.env.AGENT_MARKETING_B1_EVIDENCE; else process.env.AGENT_MARKETING_B1_EVIDENCE = v; try { return fn(); } finally { if (was === undefined) delete process.env.AGENT_MARKETING_B1_EVIDENCE; else process.env.AGENT_MARKETING_B1_EVIDENCE = was; } };

test("the contract holds the existing 30-, 45- and 60-second values", () => {
  assert.deepStrictEqual(Object.keys(am.DURATION_CONTRACT), ["30", "45", "60"]);
  assert.deepStrictEqual(am.DURATION_CONTRACT[30], { range: [55, 70], scenes: [4, 4], images: [2, 3] });
  assert.deepStrictEqual(am.DURATION_CONTRACT[45], { range: [105, 125], aim: [105, 110], editorTarget: 110, scenes: [5, 6], images: [3, 4] });
  assert.deepStrictEqual(am.DURATION_CONTRACT[60], { range: [110, 130], devRange: [133, 151], aim: [140, 146], editorTarget: 146, scenes: [6, 8], images: [4, 6] });
});

test("the word tables derived from the contract equal the previous tables", () => {
  assert.deepStrictEqual(am.WORD_TARGETS, { 30: [55, 70], 45: [105, 125], 60: [110, 130] });
  assert.deepStrictEqual(am.DEV_WORD_TARGETS, { 30: [55, 70], 45: [105, 125], 60: [133, 151] });
});

test("wordTargets keeps production and Test values and the unknown-duration fallback to the 45-second range", () => {
  withEnv(undefined, () => {
    assert.deepStrictEqual([30, 45, 60].map((d) => am.wordTargets(d)), [[55, 70], [105, 125], [110, 130]]);
    [0, 15, 90, undefined].forEach((d) => assert.deepStrictEqual(am.wordTargets(d), [105, 125]));
  });
  withEnv("dev", () => {
    assert.deepStrictEqual([30, 45, 60].map((d) => am.wordTargets(d)), [[55, 70], [105, 125], [133, 151]]);
    [0, 15, 90, undefined].forEach((d) => assert.deepStrictEqual(am.wordTargets(d), [105, 125]));
  });
});

test("scene and image ranges come from the contract and are unchanged, with no entry for any other duration", () => {
  assert.deepStrictEqual(planLib.SCENE_RANGE, { 30: [4, 4], 45: [5, 6], 60: [6, 8] });
  assert.deepStrictEqual(planLib.GPT_RANGE, { 30: [2, 3], 45: [3, 4], 60: [4, 6] });
  assert.strictEqual(planLib.SCENE_RANGE[90], undefined);
  assert.strictEqual(planLib.GPT_RANGE[90], undefined);
  assert.deepStrictEqual(am.SCENE_RANGES, planLib.SCENE_RANGE);
  assert.deepStrictEqual(am.IMAGE_RANGES, planLib.GPT_RANGE);
});

test("the writing aims (45 s: 105-110, 60 s: 140-146) are Test only and absent at 30 seconds", () => {
  withEnv(undefined, () => [30, 45, 60].forEach((d) => assert.strictEqual(planLib.writingAimFor(d), null)));
  withEnv("dev", () => {
    assert.strictEqual(planLib.writingAimFor(30), null);
    assert.deepStrictEqual(planLib.writingAimFor(45), [105, 110]);
    assert.deepStrictEqual(planLib.writingAimFor(60), [140, 146]);
  });
  assert.deepStrictEqual(am.WRITING_AIMS, { 45: [105, 110], 60: [140, 146] });
  assert.deepStrictEqual(am.EDITOR_TARGETS, { 45: 110, 60: 146 });
});

test("the user message carries the same ranges, scene counts and image budget as before", () => {
  withEnv("dev", () => {
    const base = { template: "local_market_insider", intake: { market: "Roseville", observation: "x" }, selected_topic: null };
    [[30, [55, 70], [4, 4], [2, 3]], [45, [105, 125], [5, 6], [3, 4]], [60, [133, 151], [6, 8], [4, 6]]].forEach(([dur, words, scenes, gpt]) => {
      const u = JSON.parse(planLib.buildUserMessage({ ...base, duration_sec: dur, formats: ["9x16"], voice: "ssp_male", user_id: "u" }));
      assert.deepStrictEqual(u.spoken_word_range, words);
      assert.deepStrictEqual(u.scene_count_range, scenes);
      assert.deepStrictEqual(u.gpt_image_2_scene_count, gpt);
      assert.strictEqual(u.generated_images_allowed_total, gpt[1]);
    });
  });
});

test("the production system prompt is unchanged", () => {
  withEnv(undefined, () => assert.strictEqual(crypto.createHash("sha256").update(planLib.buildSystemPrompt()).digest("hex"), PROD_HASH));
});

test("the duration list, editor durations and timing rate are untouched", () => {
  assert.deepStrictEqual(am.DURATIONS, [30, 45, 60]);
  assert.match(require("fs").readFileSync(require("path").join(__dirname, "../netlify/functions/lib/agent-marketing-plan-lib.js"), "utf8"), /const EDITOR_DURATIONS = \[45, 60\];[\s\S]*const WPM = 130;|const WPM = 130;[\s\S]*const EDITOR_DURATIONS = \[45, 60\];/);
});
