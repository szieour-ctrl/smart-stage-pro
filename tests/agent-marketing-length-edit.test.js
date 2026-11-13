"use strict";
// Development, 60-second Reel over 155 spoken words: ONE scene-by-scene editing pass; scenes and narration stay in step; a draft that is still too
// long is kept (editable) with a clear warning and cannot be approved. Production and other lengths keep the original single rewrite.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");
const am = require("../netlify/functions/lib/agent-marketing-lib");

const intake = { angle: "neighborhood", market: "Roseville, CA", audience: "Home sellers", issue: "Supply and buyer demand", action: "Understand the trade-off",
  observation: "If your resale home is near new construction it can bring more interested buyers, and builders often have incentives and rate buy-downs." };
const project = { template: "local_market_insider", duration_sec: 60, formats: ["9x16", "16x9"], intake };

const CORE = [
  "Is new construction helping or hurting your resale home?",
  "Here's what I see near new communities. More interested buyers come into the neighborhood, and that can help.",
  "But it also puts your home next to brand new competition.",
  "Builders often have incentives and rate buydowns, which changes how buyers compare your home against the ones down the street.",
  "So don't judge your value on resale listings alone.",
  "Compare the full picture, and ask me for a local perspective.",
];
const PAD = [
  "", " And that is only the start of what many owners are noticing across the whole area right now, which is honestly why so many of them keep asking me the very same question about timing and price and what comes next for them.",
  " It really is worth saying again that this is something you should think about carefully, because it is easy to miss and easy to get wrong when you are in the middle of it yourself.",
  " That matters a great deal, and I want to be sure it comes across clearly, because it affects how sellers should think about the whole decision in front of them over the next several weeks.",
  " I say this again because it is the part that people tend to forget, and it is the part that tends to cost them the most when they do not stop to think it through properly first.",
  " It is a simple idea, and yet I keep seeing owners overlook it, which is exactly why I keep bringing it up whenever a neighbor asks me what I think about where the market is going.",
  "",
];
const LONG = CORE.map((c, i) => c + PAD[i]);
const scene = (i, gpt) => ({ role: ["local_hook", "tension", "insight", "comparison", "advice", "cta"][i], narration_excerpt: LONG[i], purpose: "purpose " + i,
  visual_source: gpt ? "GPT_IMAGE_2_CONCEPT" : (i === 5 ? "BRAND_CARD" : "CONCEPT_REUSE"), visual_brief: "brief " + i, reuse_of_scene: gpt || i === 5 ? null : 2,
  card_text: i === 5 ? "Ask me for a local view" : null, ai_generation_prompt: gpt ? "Photorealistic editorial tabletop with architectural home models, soft light, no people, no text, wide composition" : null,
  camera_motion: "push_in", framing_9x16: "keep homes visible", framing_16x9: "keep wide street", text_safe_placement: "lower middle" });
const taggedOf = (t) => `[conversational] ${t[0]} [thoughtful] ${t[1]} ${t[2]} [emphasis] ${t[3]} [confident] ${t[4]} [warm] ${t[5]}`;
const planJson = () => JSON.stringify({ editorial_angle: "New construction is both an advantage and a challenge.", hook: CORE[0], narration_with_audio_tags: taggedOf(LONG),
  scenes: [scene(0, true), scene(1, true), scene(2, true), scene(3, true), scene(4, false), scene(5, false)], cta_suggestion: "Ask me for a local perspective.", claims_to_verify: [], missing_agent_inputs: [] });

async function withDev(on, fn) {
  const prev = process.env.AGENT_MARKETING_B1_EVIDENCE;
  if (on) process.env.AGENT_MARKETING_B1_EVIDENCE = "dev"; else delete process.env.AGENT_MARKETING_B1_EVIDENCE;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.AGENT_MARKETING_B1_EVIDENCE; else process.env.AGENT_MARKETING_B1_EVIDENCE = prev; }
}
const run = (callFn) => planLib.generatePlan({ project: { ...project }, anthropicKey: "k", callFn }).then((r) => ({ r }), (e) => ({ e }));

test("the fixture draft really is over 155 words", () => { assert.ok(am.countWords(taggedOf(LONG)) > 155); });

test("over 155: one editing call sees every scene, edits scene by scene, and narration and scenes stay exactly in step", async () => {
  await withDev(true, async () => {
    const calls = [];
    const callFn = async (sys, user) => {
      calls.push({ sys, user });
      if (calls.length === 1) return planJson();
      const seen = JSON.parse(user);
      return JSON.stringify({ scenes: seen.scenes.map((s) => ({ index: s.index, narration: CORE[s.index] })) });
    };
    const { r, e } = await run(callFn);
    assert.ifError(e);
    assert.strictEqual(calls.length, 2, "the planner call and ONE editing call");
    const sent = JSON.parse(calls[1].user);
    assert.strictEqual(sent.scenes.length, 6);
    assert.ok(sent.words_to_remove > 0 && sent.max_words === 155);
    sent.scenes.forEach((s, i) => { assert.strictEqual(s.index, i); assert.ok(s.role && s.purpose && "intended_message" in s && typeof s.words === "number" && s.narration); });
    assert.ok(!("equal_limit" in sent) && !/per scene/i.test(calls[1].sys), "no equal per-scene limit");
    const n = r.narrative;
    assert.ok(n.wordCount <= 155 && !n.lengthOver);
    assert.strictEqual(n.wordCount, am.countWords(n.narrationTagged));
    assert.strictEqual(n.scenes.length, 6);
    assert.deepStrictEqual(n.scenes.map((s) => s.role), ["local_hook", "tension", "insight", "comparison", "advice", "cta"]);
    assert.strictEqual(n.scenes.map((s) => s.narrationExcerpt).join(" "), n.captionText, "continuous narration is rebuilt from the scenes");
    assert.deepStrictEqual(n.scenes.map((s) => s.narrationExcerpt), CORE);
    assert.deepStrictEqual(n.narrationTagged.match(/\[[a-z]+\]/g), ["[conversational]", "[thoughtful]", "[emphasis]", "[confident]", "[warm]"], "audio tags kept, in place");
    assert.ok(n.narrationTagged.indexOf("[thoughtful] Here's what I see") > 0);
    assert.ok(Math.abs(n.scenes.reduce((a, s) => a + s.provisionalSeconds, 0) - 60) < 0.8);
    assert.strictEqual(n.scenes[5].cardText, "Ask me for a local view");
    assert.ok(!r.warnings.some((w) => /spoken words/.test(w)), "no stale length warning");
    assert.strictEqual(r.gate.ok, true);
  });
});

test("edit still over 155: the draft is kept with a clear warning, flagged too long, and no further model call is made", async () => {
  await withDev(true, async () => {
    let calls = 0;
    const { r, e } = await run(async (sys, user) => { calls++; return calls === 1 ? planJson() : JSON.stringify({ scenes: JSON.parse(user).scenes.map((s) => ({ index: s.index, narration: s.narration })) }); });
    assert.ifError(e);
    assert.strictEqual(calls, 2);
    assert.ok(r.narrative.lengthOver && r.narrative.lengthOver.max === 155 && r.narrative.lengthOver.words > 155);
    assert.match(r.warnings[0], /^Too long for a 60-second Reel: \d+ spoken words, maximum 155\. Cut about \d+ words .*draft is kept/);
    assert.strictEqual(r.narrative.scenes.length, 6);
  });
});

test("an edit that fails, drops a scene, or empties one is not used: the original draft is kept and flagged", async () => {
  await withDev(true, async () => {
    for (const bad of [
      async () => { throw new Error("Planner call timed out"); },
      async (u) => JSON.stringify({ scenes: JSON.parse(u).scenes.slice(1).map((s) => ({ index: s.index, narration: CORE[s.index] })) }),
      async (u) => JSON.stringify({ scenes: JSON.parse(u).scenes.map((s) => ({ index: s.index, narration: s.index === 2 ? "" : CORE[s.index] })) }),
    ]) {
      let calls = 0;
      const { r, e } = await run(async (sys, user) => { calls++; return calls === 1 ? planJson() : bad(user); });
      assert.ifError(e);
      assert.strictEqual(calls, 2);
      assert.ok(r.narrative.lengthOver, "kept as a flagged draft");
      assert.strictEqual(r.narrative.scenes[1].narrationExcerpt, LONG[1], "original scene text untouched");
    }
  });
});

test("a number the edit invents fails the content check: the original draft is kept", async () => {
  await withDev(true, async () => {
    let calls = 0;
    const { r } = await run(async (sys, user) => { calls++; return calls === 1 ? planJson() : JSON.stringify({ scenes: JSON.parse(user).scenes.map((s) => ({ index: s.index, narration: s.index === 1 ? CORE[1] + " Prices rose 14% last year." : CORE[s.index] })) }); });
    assert.ok(r && r.narrative.lengthOver);
    assert.ok(!/14%/.test(r.narrative.narrationTagged));
  });
});

test("outside development (and for other lengths) the original single rewrite runs, not the scene edit", async () => {
  await withDev(false, async () => {
    const seen = [];
    await run(async (sys, user) => { seen.push(user); return planJson(); });
    assert.ok(seen.length >= 1 && seen.length <= 2);
    if (seen.length === 2) assert.match(seen[1], /does not fit the requested length/);
    assert.ok(!seen.some((u) => /words_to_remove/.test(u)));
  });
});

test("retagScenes puts mid-scene tags before the same sentence", () => {
  const scenes = [{ narrationExcerpt: "One two three. Four five six." }];
  const tagged = "[conversational] One two three. [pause] Four five six.";
  assert.strictEqual(planLib.retagScenes(tagged, scenes, ["One two. Four five."])[0], "[conversational] One two. [pause] Four five.");
});

test("approval of a 60-second script over 155 words is refused in development only", () => {
  const src = fs.readFileSync(path.join(__dirname, "../netlify/functions/agent-marketing-project.js"), "utf8");
  const i = src.indexOf('code: "script_too_long"');
  assert.ok(i > 0 && i < src.indexOf("narrative_approved: {"), "checked before approval is written");
  assert.match(src.slice(i - 400, i), /agent-marketing-b1-evidence-lib"\)\.enabled\(\) && project\.duration_sec === 60/);
});
