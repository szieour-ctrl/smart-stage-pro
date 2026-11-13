"use strict";
// Nov 13, 2026 (Sam; Test only): focused duration-editing correction. The scene editor and the anchored scene-balance rewrite protect the Realtor's
// argument (not every sentence), work toward the target without a new hard gate, and a rejected scene-balance revision records why.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");
const am = require("../netlify/functions/lib/agent-marketing-lib");

const intake = { angle: "neighborhood", market: "Roseville, CA", audience: "Home sellers", issue: "Supply and buyer demand", action: "Understand the trade-off", observation: "Buyers have more choices." };
async function withDev(on, fn) {
  const prev = process.env.AGENT_MARKETING_B1_EVIDENCE;
  if (on) process.env.AGENT_MARKETING_B1_EVIDENCE = "dev"; else delete process.env.AGENT_MARKETING_B1_EVIDENCE;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.AGENT_MARKETING_B1_EVIDENCE; else process.env.AGENT_MARKETING_B1_EVIDENCE = prev; }
}
const proj = (dur) => ({ template: "local_market_insider", duration_sec: dur, formats: ["9x16", "16x9"], intake });
const run = (project, callFn) => planLib.generatePlan({ project, anthropicKey: "k", callFn }).then((r) => ({ r }), (e) => ({ e }));
const TAGS = ["[conversational]", "[thoughtful]", "[emphasis]", "[confident]", "[warm]", "[calm]"];
const ROLE_OF = ["local_hook", "tension", "insight", "advice", "advice", "advice", "advice", "advice"];
const mkScene = (text, i, last) => { const gpt = last > 4 ? 4 : last > 3 ? 3 : 2;
  return { role: i === last ? "cta" : ROLE_OF[i], narration_excerpt: text, purpose: "purpose " + i,
    visual_source: i < gpt ? "GPT_IMAGE_2_CONCEPT" : (i === last ? "BRAND_CARD" : "CONCEPT_REUSE"), visual_brief: "brief " + i, reuse_of_scene: i < gpt || i === last ? null : 1,
    card_text: i === last ? "Ask me for a local view" : null, ai_generation_prompt: i < gpt ? "Photorealistic editorial tabletop with architectural home models, soft light, no people, no text, wide composition" : null,
    camera_motion: "push_in", framing_9x16: "keep homes visible", framing_16x9: "keep wide street", text_safe_placement: "lower middle", source_role: "data" }; };
const mk = (texts) => JSON.stringify({ editorial_angle: "Buyers have more choices, so preparation matters.", hook: texts[0], narration_with_audio_tags: texts.map((x, i) => `${TAGS[i]} ${x}`).join(" "),
  scenes: texts.map((t, i) => mkScene(t, i, texts.length - 1)), cta_suggestion: "Ask me.", claims_to_verify: [], missing_agent_inputs: [] });
const BASE = "buyers have more choices now and that changes how a prepared home gets priced in this market";
const words = (n) => { const w = BASE.split(" "); const out = []; for (let i = 0; out.length < n; i++) out.push(w[i % w.length]); return out.join(" ") + "."; };
const sized = (sizes) => sizes.map((n, i) => (i === 0 ? "Is that really what is happening in this market? " + words(n - 9) : words(n)));
const total = (t) => t.reduce((a, x) => a + am.countWords(x), 0);
const NUMBERED = (sizes) => sized(sizes).map((t, i) => (i === 1 ? t + " Inventory hit 99.9 months this year." : t));

test("editor instructions: the argument decides what is essential; secondary evidence may go whole; protected elements named", () => {
  const sys = planLib.lengthEditSystem(60, true);
  assert.ok(!/essential facts and figures exactly as written/.test(sys), "the conflicting preserve-everything instruction is gone");
  assert.match(sys, /The Realtor's argument decides what is essential/);
  assert.match(sys, /Secondary statistics, comparisons and supporting sentences may be removed entirely/);
  assert.match(sys, /correct value, period, measure, qualifier and attribution/);
  assert.match(sys, /remove whole secondary statements, statistics or sentences in preference to trimming a few words from every sentence/);
  assert.match(sys, /question-led hook; the Realtor's interpretation; the decisive evidence and its attribution; the specific homeowner consequence; and a genuine closing invitation/);
  assert.match(sys, /invite the viewer to engage with the Realtor \(cta_angle says how\), not merely end on an observation/);
  assert.match(sys, /words_to_remove and target_words are your objective: work toward target_words and do not stop after a small reduction/);
  assert.match(sys, /a script above it is never blocked/);
  assert.match(sys, /never add words, filler or new content to reach the lower end/);
  assert.ok(!/\b\d+ (statistics|figures|sentences)\b/i.test(sys.replace(/at least 8 spoken words/, "")), "no fixed evidence counts");
  assert.ok(!/per.scene (word )?(quota|limit)|Roseville/i.test(sys), "no per-scene quotas, nothing Roseville-specific");
});

test("editor payload carries cta_angle and the existing targets; the call count is unchanged", async () => {
  await withDev(true, async () => {
    const calls = [];
    const texts = sized([14, 30, 30, 34, 30, 16]); // 154 words, over the 60-second top
    assert.ok(total(texts) > 151);
    const { r, e } = await run(proj(60), async (sys, user) => { calls.push({ sys, user }); return calls.length === 1 ? mk(texts) : JSON.stringify({ scenes: JSON.parse(user).scenes.map((s) => ({ index: s.index, narration: s.narration })) }); });
    assert.ifError(e);
    assert.strictEqual(calls.length, 2, "planner plus ONE editor call, no retry");
    const sent = JSON.parse(calls[1].user);
    assert.ok(typeof sent.cta_angle === "string" && sent.cta_angle.length > 10, "cta_angle passed");
    assert.strictEqual(sent.cta_angle, planLib.ctaAngleFor(proj(60)));
    assert.strictEqual(sent.target_words, 146);
    assert.ok(sent.words_to_remove > 0);
    // not a hard gate: an editor that cuts little is accepted as is, the overage is reported, and the script is kept
    assert.ok(r.narrative.lengthOver && r.narrative.lengthOver.over > 0 === (r.narrative.wordCount > 151));
  });
});

test("editor: a drop of a whole secondary sentence is accepted; a still-over result stays nonblocking with an accurate overage", async () => {
  await withDev(true, async () => {
    const texts = sized([14, 40, 40, 40, 40, 20]); // 194
    const cut = texts.map((t, i) => (i === 3 || i === 4 ? t.split(" ").slice(0, 28).join(" ") + "." : t)); // 'drops' content from two scenes, still over
    let n = 0;
    const { r, e } = await run(proj(60), async () => { n++; return n === 1 ? mk(texts) : JSON.stringify({ scenes: cut.map((t, i) => ({ index: i, narration: t })) }); });
    assert.ifError(e);
    const d = r.narrative.lengthDiagnostics;
    assert.strictEqual(d.edit.outcome, "accepted_still_over");
    assert.strictEqual(r.narrative.wordCount, total(cut));
    assert.deepStrictEqual(r.narrative.lengthOver, { words: total(cut), max: 151, over: total(cut) - 151 });
    assert.match(r.warnings[0], new RegExp(`^${total(cut)} spoken words\\. The recommended range for a 60-second Reel is 133–151 words\\.`));
  });
});

test("scene-balance rewrite message: priorities, protected elements and a genuine invitation; draft, problem and range are still sent", async () => {
  await withDev(true, async () => {
    const users = [];
    await run(proj(30), async (sys, user) => { users.push(user); return mk(sized([12, 22, 22, 2])); });
    const fix = users[1];
    assert.match(fix, /Your draft does not fit the requested length or scene balance:/);
    assert.match(fix, /Scene 4 has only 2 spoken words/);
    assert.match(fix, /for a 30-second Reel \(recommended range 55-70 spoken words\), is \d+ spoken words/);
    assert.match(fix, /secondary statistics, comparisons and supporting sentences may go entirely/);
    assert.match(fix, /removing a whole secondary statement is better than trimming a few words from every sentence/);
    assert.match(fix, /question-led hook, the Realtor's interpretation, the decisive evidence with its attribution, the specific homeowner consequence, and a closing that is a genuine invitation to engage with the Realtor, not merely a concluding observation/);
    assert.match(fix, /correct value, period, measure, qualifier and attribution/);
    assert.match(fix, /Do not add words to reach the lower end of the range/);
  });
});

test("30 seconds keeps its four scenes and no scene editor", async () => {
  await withDev(true, async () => {
    let calls = 0;
    const { r } = await run(proj(30), async () => { calls++; return mk(sized([12, 22, 22, 2])); });
    assert.ok(calls <= 2, "planner plus at most the one rewrite");
    assert.strictEqual(r.narrative.scenes.length, 4);
    assert.strictEqual(r.narrative.lengthDiagnostics.edit.ran, false);
  });
});

test("rejected revision: no score improvement is recorded with counts only", async () => {
  await withDev(true, async () => {
    const texts = sized([14, 30, 30, 34, 2]);
    const { r } = await run(proj(45), async () => mk(texts));
    const rev = r.narrative.lengthDiagnostics.revisions[0];
    assert.strictEqual(rev.accepted, false);
    assert.deepStrictEqual(rev.rejected.reasons, ["no_score_improvement"]);
    assert.strictEqual(rev.rejected.distanceBefore, rev.rejected.distanceAfter);
    assert.deepStrictEqual([rev.rejected.wordsBefore, rev.rejected.wordsAfter], [total(texts), total(texts)]);
    assert.ok(!JSON.stringify(rev).includes(texts[1]), "no script text in the diagnostics");
  });
});

test("rejected revision: additional or unresolved problems are recorded", async () => {
  await withDev(true, async () => {
    const first = sized([14, 30, 30, 34, 2]);                 // one problem: scene 5 too short
    const worse = sized([14, 30, 30, 34, 2]).map((t, i) => (i === 1 ? words(2) : t)); // scenes 2 and 5 too short → more problems
    let n = 0;
    const { r } = await run(proj(45), async () => mk(++n === 1 ? first : worse));
    const rev = r.narrative.lengthDiagnostics.revisions[0];
    assert.strictEqual(rev.accepted, false);
    assert.ok(rev.rejected.reasons.includes("more_problems"));
    assert.ok(rev.rejected.problemsAfter > rev.rejected.problemsBefore);
    assert.ok(Array.isArray(rev.rejected.problemsAfterList) && rev.rejected.problemsAfterList.every((x) => x.length <= 120));
  });
});

test("rejected revision: a content-gate block is recorded with the rule", async () => {
  await withDev(true, async () => {
    const first = sized([14, 30, 30, 34, 2]);
    const gated = NUMBERED([14, 30, 30, 26, 10]);
    let n = 0;
    const { r } = await run(proj(45), async () => mk(++n === 1 ? first : gated));
    const rev = r.narrative.lengthDiagnostics.revisions[0];
    assert.strictEqual(rev.accepted, false);
    assert.ok(rev.rejected.reasons.includes("content_gate"));
    assert.ok(rev.rejected.gateBlocks.length >= 1 && rev.rejected.gateBlocks.every((b) => b.rule && b.message.length <= 120));
  });
});

test("rejected revision: a reply that cannot be parsed or normalized is recorded", async () => {
  await withDev(true, async () => {
    const first = sized([14, 30, 30, 34, 2]);
    let n = 0;
    const { r } = await run(proj(45), async () => (++n === 1 ? mk(first) : "this is not json at all"));
    const rev = r.narrative.lengthDiagnostics.revisions[0];
    assert.strictEqual(rev.accepted, false);
    assert.deepStrictEqual(rev.rejected.reasons, ["normalization_or_parse_failure"]);
    assert.ok(typeof rev.rejected.detail === "string" && rev.rejected.detail.length <= 160);
  });
});

test("an accepted revision keeps its original diagnostic shape; the acceptance condition is unchanged", async () => {
  await withDev(true, async () => {
    const texts = sized([14, 30, 30, 34, 2]), better = sized([14, 30, 30, 26, 10]);
    let n = 0;
    const { r } = await run(proj(45), async () => mk(++n === 1 ? texts : better));
    const rev = r.narrative.lengthDiagnostics.revisions[0];
    assert.deepStrictEqual(Object.keys(rev).sort(), ["accepted", "anchored", "draftWords", "path", "problems"]);
    assert.strictEqual(rev.accepted, true);
    const src = fs.readFileSync(path.join(__dirname, "../netlify/functions/lib/agent-marketing-plan-lib.js"), "utf8");
    assert.match(src, /if \(g2\.ok && fewerOrEqual && closer\)/);
    assert.match(src, /const fewerOrEqual = problems2\.length <= fit\.length, closer = distAfter < distBefore;/);
  });
});

test("production: no diagnostics and the same rewrite path", async () => {
  await withDev(false, async () => {
    const texts = sized([14, 30, 30, 34, 2]);
    const { r } = await run(proj(45), async () => mk(texts));
    assert.strictEqual(r.narrative.lengthDiagnostics, undefined);
  });
});
