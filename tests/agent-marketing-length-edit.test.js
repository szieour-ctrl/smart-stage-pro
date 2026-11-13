"use strict";
// Development, 60-second Reel over 151 spoken words: ONE scene-by-scene editing pass; scenes and narration stay in step; a draft that is still too
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

test("the fixture draft really is over 151 words", () => { assert.ok(am.countWords(taggedOf(LONG)) > 151); });

test("over 151: one editing call sees every scene, edits scene by scene, and narration and scenes stay exactly in step", async () => {
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
    assert.ok(sent.words_to_remove > 0 && sent.max_words === 151);
    sent.scenes.forEach((s, i) => { assert.strictEqual(s.index, i); assert.ok(s.role && s.purpose && "intended_message" in s && typeof s.words === "number" && s.narration); });
    assert.ok(!("equal_limit" in sent) && !/per scene/i.test(calls[1].sys), "no equal per-scene limit");
    const n = r.narrative;
    assert.ok(n.wordCount <= 151 && !n.lengthOver);
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

test("edit still over 151: the draft is kept with a nonblocking advisory, and no further model call is made", async () => {
  await withDev(true, async () => {
    let calls = 0;
    const { r, e } = await run(async (sys, user) => { calls++; return calls === 1 ? planJson() : JSON.stringify({ scenes: JSON.parse(user).scenes.map((s) => ({ index: s.index, narration: s.narration })) }); });
    assert.ifError(e);
    assert.strictEqual(calls, 2);
    assert.ok(r.narrative.lengthOver && r.narrative.lengthOver.max === 151 && r.narrative.lengthOver.words > 151);
    assert.match(r.warnings[0], /^\d+ spoken words\. The recommended range for a 60-second Reel is 133–151 words\. Actual narration duration depends on delivery\. You may edit the script or approve it as written\.$/);
    assert.ok(!/before approving|Cut about/.test(r.warnings.join(" ")), "an advisory, not a demand");
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

test("approval is no longer refused for word count (source check): no script_too_long anywhere", () => {
  const dir = path.join(__dirname, "../netlify/functions");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => path.join(dir, f)).concat(fs.readdirSync(path.join(dir, "lib")).filter((f) => f.endsWith(".js")).map((f) => path.join(dir, "lib", f)));
  files.forEach((f) => assert.ok(!/script_too_long/.test(fs.readFileSync(f, "utf8")), f + " has no word-count refusal"));
  assert.ok(!/script_too_long/.test(fs.readFileSync(path.join(__dirname, "../agent-marketing.html"), "utf8")));
});

// ── Diagnostics (Nov 12, Sam): counts and one short reason in the project record; nothing else ───────────────────────────────────────
test("diagnostics: an accepted edit records initial, returned and final counts per scene, with the outcome", async () => {
  await withDev(true, async () => {
    let calls = 0;
    const { r } = await run(async (sys, user) => { calls++; return calls === 1 ? planJson() : JSON.stringify({ scenes: JSON.parse(user).scenes.map((s) => ({ index: s.index, narration: CORE[s.index] })) }); });
    const d = r.narrative.lengthDiagnostics;
    assert.deepStrictEqual(d.target, [133, 151]);
    assert.strictEqual(d.initial.words, am.countWords(taggedOf(LONG)));
    assert.deepStrictEqual(d.initial.scenes, LONG.map(am.countWords));
    assert.strictEqual(d.initial.sceneSum, d.initial.scenes.reduce((a, b) => a + b, 0));
    assert.strictEqual(d.structuralRetry, false);
    assert.strictEqual(d.gateRewrite, false);
    assert.strictEqual(d.edit.ran, true);
    assert.strictEqual(d.edit.outcome, "accepted");
    assert.strictEqual(d.edit.reason, null);
    assert.strictEqual(d.edit.returned.words, am.countWords(taggedOf(CORE)));
    assert.deepStrictEqual(d.edit.returned.scenes, CORE.map(am.countWords));
    assert.strictEqual(d.final.words, r.narrative.wordCount);
    assert.deepStrictEqual(d.final.scenes, CORE.map(am.countWords));
    assert.strictEqual(d.final.overLimit, false);
    const text = JSON.stringify(d);
    CORE.concat(LONG).forEach((line) => assert.ok(!text.includes(line.slice(0, 30)), "no script text in the diagnostics"));
    assert.ok(text.length < 1500, "concise");
  });
});

test("diagnostics: discarded edits say why; an edit that is shorter but still over is 'accepted_still_over'", async () => {
  await withDev(true, async () => {
    const first = { n: 0 };
    const fail = await run(async () => { if (!first.n++) return planJson(); throw new Error("Planner call timed out"); });
    let d = fail.r.narrative.lengthDiagnostics;
    assert.deepStrictEqual([d.edit.ran, d.edit.outcome, d.edit.returned], [true, "discarded", null]);
    assert.match(d.edit.reason, /^edit call failed: Planner call timed out/);
    assert.strictEqual(d.final.words, d.initial.words); assert.strictEqual(d.final.overLimit, true);

    const same = { n: 0 };
    const unchanged = await run(async (sys, user) => (++same.n === 1 ? planJson() : JSON.stringify({ scenes: JSON.parse(user).scenes.map((s) => ({ index: s.index, narration: s.narration })) })));
    d = unchanged.r.narrative.lengthDiagnostics;
    assert.strictEqual(d.edit.outcome, "discarded");
    assert.match(d.edit.reason, /^edited script not shorter \(\d+ vs \d+\)/);
    assert.strictEqual(d.edit.returned.words, d.initial.words);

    const gate = { n: 0 };
    const invented = await run(async (sys, user) => (++gate.n === 1 ? planJson() : JSON.stringify({ scenes: JSON.parse(user).scenes.map((s) => ({ index: s.index, narration: s.index === 1 ? CORE[1] + " Prices rose 14% last year." : CORE[s.index] })) })));
    d = invented.r.narrative.lengthDiagnostics;
    assert.strictEqual(d.edit.outcome, "discarded");
    assert.match(d.edit.reason, /^edited script failed the content check/);
    assert.ok(d.edit.returned.words > 0 && d.edit.returned.scenes.length === 6);

    const missing = { n: 0 };
    const dropped = await run(async (sys, user) => (++missing.n === 1 ? planJson() : JSON.stringify({ scenes: JSON.parse(user).scenes.slice(1).map((s) => ({ index: s.index, narration: CORE[s.index] })) })));
    d = dropped.r.narrative.lengthDiagnostics;
    assert.strictEqual(d.edit.reason, "edit returned the wrong number of scenes");
    assert.deepStrictEqual(d.edit.returned, { sceneCount: 5 });

    const half = { n: 0 };
    const some = await run(async (sys, user) => (++half.n === 1 ? planJson() : JSON.stringify({ scenes: JSON.parse(user).scenes.map((s) => ({ index: s.index, narration: s.index === 1 ? LONG[1].split(" ").slice(0, 20).join(" ") + "." : s.narration })) })));
    d = some.r.narrative.lengthDiagnostics;
    assert.strictEqual(d.edit.outcome, "accepted_still_over");
    assert.ok(d.final.words < d.initial.words && d.final.words > 151 && d.final.overLimit);
  });
});

test("diagnostics: a draft inside the range records no edit, and nothing is recorded outside development", async () => {
  await withDev(true, async () => {
    const inRange = CORE.map((c, i) => (i === 2 || i === 3 ? c + PAD[i] : c));
    assert.ok(am.countWords(taggedOf(inRange)) >= 133 && am.countWords(taggedOf(inRange)) <= 151, "fixture is inside the range");
    const okPlan = JSON.parse(planJson()); okPlan.scenes.forEach((sc, i) => { sc.narration_excerpt = inRange[i]; }); okPlan.narration_with_audio_tags = taggedOf(inRange);
    const { r } = await run(async () => JSON.stringify(okPlan));
    const d = r.narrative.lengthDiagnostics;
    assert.deepStrictEqual([d.edit.ran, d.edit.outcome], [false, "not_needed"]);
    assert.strictEqual(d.initial.words, d.final.words);
    assert.strictEqual(d.final.overLimit, false);
  });
  await withDev(false, async () => {
    const { r } = await run(async () => planJson());
    assert.strictEqual(r.narrative.lengthDiagnostics, undefined);
  });
});

test("diagnostics survive the agent's own script edits (carried over, not rewritten)", () => {
  const src = fs.readFileSync(path.join(__dirname, "../netlify/functions/agent-marketing-project.js"), "utf8");
  assert.match(src, /intakeHash: prev\.intakeHash, lengthDiagnostics: prev\.lengthDiagnostics,/);
});

// ── Opening hook, and cross-scene compression (Nov 12, 2026, Sam) ────────────────────────────────────────────────────────────────────
const MISMATCH_HOOK = "New homes next door change what your resale home is worth.";
const planWithHook = (hook) => JSON.stringify({ ...JSON.parse(planJson()), hook });
const norm = (t) => String(t).replace(/\s+/g, " ").trim();

test("hook: a hook the narration does not open with is spoken first, in the narration and in scene 1, and the field matches", async () => {
  await withDev(true, async () => {
    let calls = 0;
    const { r, e } = await run(async (sys, user) => { calls++; return calls === 1 ? planWithHook(MISMATCH_HOOK) : JSON.stringify({ scenes: JSON.parse(user).scenes.map((s) => ({ index: s.index, narration: s.narration })) }); });
    assert.ifError(e);
    const n = r.narrative;
    assert.strictEqual(am.stripAudioTags(n.narrationTagged).split(/(?<=[.!?])\s+/)[0], MISMATCH_HOOK, "first spoken sentence is the hook");
    assert.strictEqual(n.hook, MISMATCH_HOOK, "the hook field is that sentence");
    assert.ok(n.scenes[0].narrationExcerpt.startsWith(MISMATCH_HOOK), "scene 1 uses the corresponding narration");
    assert.strictEqual(norm(n.scenes.map((s) => s.narrationExcerpt).join(" ")), norm(n.captionText), "scene excerpts and continuous narration stay in step");
    assert.strictEqual(n.hookSync, "inserted");
    assert.strictEqual(calls, 2, "no model call was spent on the hook (planner + the length editor only)");
  });
});

test("hook: when the narration already opens with it, nothing is inserted and the field takes the spoken sentence", () => {
  const raw = JSON.parse(planJson());
  const a = planLib.alignHook({ ...raw, hook: CORE[0].replace(/\?$/, "") });
  assert.strictEqual(a.how, "matched");
  assert.strictEqual(a.raw.hook, CORE[0]);
  assert.strictEqual(a.raw.narration_with_audio_tags, raw.narration_with_audio_tags, "narration untouched");
  assert.strictEqual(planLib.alignHook({ ...raw, hook: "" }).raw.hook, CORE[0], "an empty hook is filled from the narration");
  const ins = planLib.alignHook({ ...raw, hook: "New homes next door change what your resale home is worth" });
  assert.match(ins.raw.narration_with_audio_tags, /^\[conversational\] New homes next door change what your resale home is worth\. Is new construction/, "leading tag stays first; a missing full stop is added");
});

test("hook: the editor keeps the opening, and the field still equals the first spoken sentence after editing", async () => {
  await withDev(true, async () => {
    let calls = 0;
    const { r } = await run(async (sys, user) => { calls++; return calls === 1 ? planWithHook(MISMATCH_HOOK) : JSON.stringify({ scenes: JSON.parse(user).scenes.map((s) => ({ index: s.index, narration: s.index === 0 ? s.narration : CORE[s.index] })) }); });
    const n = r.narrative;
    assert.strictEqual(n.hook, am.stripAudioTags(n.narrationTagged).split(/(?<=[.!?])\s+/)[0]);
    assert.strictEqual(n.hook, MISMATCH_HOOK);
    assert.strictEqual(norm(n.scenes.map((s) => s.narrationExcerpt).join(" ")), norm(n.captionText));
  });
});

test("hook: production and non-dev paths are not changed", async () => {
  await withDev(false, async () => {
    const { r } = await run(async () => planWithHook(MISMATCH_HOOK));
    assert.strictEqual(r.narrative.hook, MISMATCH_HOOK);
    assert.ok(!r.narrative.hookSync);
    assert.ok(!r.narrative.captionText.startsWith(MISMATCH_HOOK), "narration was not rewritten");
  });
});

test("editor: sees the whole script and is told to cut a conclusion that later scenes only restate", async () => {
  await withDev(true, async () => {
    const seen = [];
    let calls = 0;
    await run(async (sys, user) => { calls++; if (calls === 1) return planJson(); seen.push({ sys, user: JSON.parse(user) }); return JSON.stringify({ scenes: JSON.parse(user).scenes.map((s) => ({ index: s.index, narration: CORE[s.index] })) }); });
    const { sys, user } = seen[0];
    assert.match(sys, /Read the WHOLE script first, as one argument/);
    assert.match(sys, /once an earlier scene has established a conclusion[^.]*not say the conclusion again/);
    assert.match(sys, /Where two scenes say the same thing, keep it where it does the most work/);
    assert.match(sys, /Cut first: an interpretation already stated/);
    assert.match(sys, /Do not cut equally/);
    assert.strictEqual(user.scenes.length, 6, "every scene, with its message and text, in one call");
    user.scenes.forEach((s) => assert.ok(s.narration && s.purpose && "intended_message" in s && s.words > 0));
    assert.ok(user.editorial_angle && user.hook);
  });
});

test("editor: a repeated conclusion is cut from a later scene, each scene keeps its job, scenes stay aligned and the script is accepted", async () => {
  await withDev(true, async () => {
    const REPEAT = " The point is that new construction cuts both ways, and that is exactly the conclusion I stated at the start.";
    const withRepeat = LONG.map((t, i) => (i === 3 ? t + REPEAT : t));
    const plan = JSON.stringify({ ...JSON.parse(planJson()), narration_with_audio_tags: taggedOf(withRepeat), scenes: JSON.parse(planJson()).scenes.map((s, i) => ({ ...s, narration_excerpt: withRepeat[i] })) });
    let calls = 0;
    const { r, e } = await run(async (sys, user) => { calls++; return calls === 1 ? plan : JSON.stringify({ scenes: JSON.parse(user).scenes.map((s) => ({ index: s.index, narration: CORE[s.index] })) }); });
    assert.ifError(e);
    const n = r.narrative;
    assert.ok(!/exactly the conclusion I stated/.test(n.narrationTagged), "the repeat is gone");
    assert.strictEqual(n.scenes.length, 6);
    n.scenes.forEach((s, i) => { assert.strictEqual(s.narrationExcerpt, CORE[i]); assert.strictEqual(s.role, ["local_hook", "tension", "insight", "comparison", "advice", "cta"][i], "role kept"); assert.strictEqual(s.purpose, "purpose " + i, "purpose kept"); });
    assert.strictEqual(norm(n.scenes.map((s) => s.narrationExcerpt).join(" ")), norm(n.captionText));
    assert.strictEqual(r.narrative.lengthDiagnostics.edit.outcome, "accepted");
  });
});
