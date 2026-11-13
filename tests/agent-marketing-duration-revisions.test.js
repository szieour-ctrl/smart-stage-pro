"use strict";
// Phase B (Nov 13, 2026, Sam; Test only): consistent, draft-aware revisions on the shared duration contract. Underlength is advisory only (no padding),
// the 30/45/60-second gate and scene-balance rewrites receive the draft, scene context, problem, duration, range and aim (where there is one), the 45- and
// 60-second editor targets come from the contract, and production is unchanged.
const test = require("node:test");
const assert = require("node:assert");
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

const TAGS = ["[conversational]", "[thoughtful]", "[emphasis]", "[confident]", "[warm]", "[calm]", "[steady]", "[bright]"];
const ROLE_OF = ["local_hook", "tension", "insight", "advice", "advice", "advice", "advice", "advice"];
const mkScene = (text, i, last) => {
  const gpt = last > 4 ? 4 : last > 3 ? 3 : 2;
  return { role: i === last ? "cta" : ROLE_OF[i], narration_excerpt: text, purpose: "purpose " + i,
    visual_source: i < gpt ? "GPT_IMAGE_2_CONCEPT" : (i === last ? "BRAND_CARD" : "CONCEPT_REUSE"), visual_brief: "brief " + i, reuse_of_scene: i < gpt || i === last ? null : 1,
    card_text: i === last ? "Ask me for a local view" : null, ai_generation_prompt: i < gpt ? "Photorealistic editorial tabletop with architectural home models, soft light, no people, no text, wide composition" : null,
    camera_motion: "push_in", framing_9x16: "keep homes visible", framing_16x9: "keep wide street", text_safe_placement: "lower middle", source_role: "data" };
};
const mk = (texts) => JSON.stringify({ editorial_angle: "Buyers have more choices, so preparation matters.", hook: texts[0], narration_with_audio_tags: texts.map((x, i) => `${TAGS[i]} ${x}`).join(" "),
  scenes: texts.map((t, i) => mkScene(t, i, texts.length - 1)), cta_suggestion: "Ask me.", claims_to_verify: [], missing_agent_inputs: [] });
const BASE = "buyers have more choices now and that changes how a prepared home gets priced in this market";
const words = (n, lead) => { const w = BASE.split(" "); const out = []; for (let i = 0; out.length < n; i++) out.push(w[i % w.length]); out[0] = lead || out[0]; return out.join(" ") + "."; };
const sized = (sizes) => sizes.map((n, i) => (i === 0 ? "Is that really what is happening in this market? " + words(n - 9) : words(n)));
const total = (texts) => texts.reduce((a, t) => a + am.countWords(t), 0);

// ── 1. No automatic padding in Test; production unchanged ───────────────────────────────────────────────────────────────────
test("underlength (Test): a complete script under the range is not rewritten or padded; it keeps its words and carries the advisory", async () => {
  for (const [dur, sizes] of [[30, [10, 14, 14, 10]], [45, [12, 20, 20, 16, 10]], [60, [14, 20, 20, 22, 18, 12]]]) {
    await withDev(true, async () => {
      const texts = sized(sizes); const [lo] = am.wordTargets(dur);
      assert.ok(total(texts) < lo, `${dur}s fixture is under ${lo}`);
      let calls = 0;
      const { r, e } = await run(proj(dur), async () => { calls++; return mk(texts); });
      assert.ifError(e);
      assert.strictEqual(calls, 1, `${dur}s: no second model call for being short`);
      assert.strictEqual(r.narrative.wordCount, total(texts), "words untouched");
      assert.ok(r.warnings.some((w) => new RegExp(`a ${dur}-second piece usually runs ${lo}–`).test(w)), "the nonblocking advisory is kept");
      assert.ok(!r.narrative.lengthOver);
    });
  }
});

test("underlength (production): the original padding rewrite still runs and the message is the original", async () => {
  await withDev(false, async () => {
    const texts = sized([12, 20, 20, 16, 10]);
    const users = [];
    await run(proj(45), async (sys, user) => { users.push(user); return mk(texts); });
    assert.strictEqual(users.length, 2);
    assert.match(users[1], /Your draft does not fit the requested length: .*so add about \d+\./);
    assert.ok(!/Your draft does not fit the requested length or scene balance|Your rejected draft|spoken_word_aim/.test(users.join("\n")));
  });
});

test("lengthProblems and lengthDistance: under-range is advisory in Test and unchanged in production; over-top and scene balance are unchanged", async () => {
  const mkN = (sizes) => { const t = sized(sizes); return { wordCount: total(t), scenes: t.map((x) => ({ narrationExcerpt: x })) }; };
  const short = mkN([12, 20, 20, 16, 10]);
  await withDev(true, async () => {
    assert.deepStrictEqual(planLib.lengthProblems(short, 45), []);
    assert.strictEqual(planLib.lengthDistance(short, 45), 0);
    assert.match(planLib.lengthProblems(mkN([20, 30, 30, 30, 30]), 45)[0], /cut at least 15/);
    assert.ok(planLib.lengthProblems({ wordCount: 90, scenes: [{ narrationExcerpt: words(40) }, { narrationExcerpt: "Too short." }, { narrationExcerpt: words(48) }] }, 45).some((p) => /Scene 2 has only 2/.test(p)));
  });
  await withDev(false, async () => {
    assert.match(planLib.lengthProblems(short, 45)[0], /add about/);
    assert.ok(planLib.lengthDistance(short, 45) > 0);
  });
});

// ── 2. Scene-balance rewrite is draft-aware (30, 45 and 60 seconds, Test) ───────────────────────────────────────────────────
test("scene balance (Test): the one rewrite receives the draft, scene context, the problem, the duration, the range and the aim; it is accepted when it fixes the scene", async () => {
  for (const [dur, sizes, fixed, range, aim] of [
    [45, [14, 30, 30, 34, 2], [14, 30, 30, 26, 10], "105-125", "writing aim 105-110"],
    [60, [14, 30, 30, 30, 34, 2], [14, 30, 30, 30, 26, 10], "133-151", "writing aim 140-146"],
    [30, [12, 22, 22, 2], [12, 22, 14, 10], "55-70", null],
  ]) {
    await withDev(true, async () => {
      const texts = sized(sizes), better = sized(fixed);
      const [lo, hi] = am.wordTargets(dur);
      assert.ok(total(texts) >= lo && total(texts) <= hi, `${dur}s draft is inside its range, so only the tiny scene is the problem`);
      const users = [];
      const { r, e } = await run(proj(dur), async (sys, user) => { users.push(user); return mk(users.length === 1 ? texts : better); });
      assert.ifError(e);
      assert.strictEqual(users.length, 2, `${dur}s: one planner call and ONE rewrite`);
      const fix = users[1];
      assert.match(fix, /Your draft does not fit the requested length or scene balance:/);
      assert.match(fix, new RegExp(`Scene ${sizes.length} has only 2 spoken words`));
      assert.ok(fix.includes(`is ${am.countWords(texts.map((x, i) => `${TAGS[i]} ${x}`).join(" "))} spoken words`), "the draft's word count");
      assert.match(fix, new RegExp(`for a ${dur}-second Reel \\(recommended range ${range}`));
      if (aim) assert.match(fix, new RegExp(aim)); else assert.ok(!/writing aim/.test(fix), "30 seconds has no aim");
      assert.ok(fix.includes('"purpose":"purpose 1"') && fix.includes('"source_role":"data"'), "scene context");
      assert.ok(fix.includes(texts[1]), "the draft's narration");
      assert.match(fix, /Do not add words to reach the lower end of the range: a complete script shorter than the range is acceptable/);
      assert.match(fix, /never overrides factual accuracy, source attribution/);
      assert.ok(fix.startsWith(users[0]), "the original request is kept in full");
      assert.strictEqual(r.narrative.wordCount, total(better));
      const rev = r.narrative.lengthDiagnostics.revisions;
      assert.deepStrictEqual(rev.map((x) => x.path), ["scene_balance_rewrite"]);
      assert.deepStrictEqual([rev[0].anchored, rev[0].problems, rev[0].accepted], [true, 1, true]);
      assert.deepStrictEqual(Object.keys(rev[0]).sort(), ["accepted", "anchored", "draftWords", "path", "problems"], "numbers only, no script text");
    });
  }
});

test("scene balance (Test): a rewrite that does not fix the problem is not used, and the single-rewrite limit holds", async () => {
  await withDev(true, async () => {
    const texts = sized([14, 30, 30, 34, 2]);
    let calls = 0;
    const { r } = await run(proj(45), async () => { calls++; return mk(texts); });
    assert.strictEqual(calls, 2, "one rewrite, never a third call");
    assert.strictEqual(r.narrative.wordCount, total(texts));
    assert.notStrictEqual(r.narrative.lengthDiagnostics.revisions[0].accepted, true);
  });
});

test("scene balance (production): the original rewrite message is unchanged", async () => {
  await withDev(false, async () => {
    const texts = sized([14, 30, 30, 34, 2]);
    const users = [];
    await run(proj(45), async (sys, user) => { users.push(user); return mk(texts); });
    assert.strictEqual(users.length, 2);
    assert.match(users[1], /Your draft does not fit the requested length: .*Rewrite the complete JSON, keeping the same topic, hook, facts and tone\./);
    assert.ok(!/Your draft does not fit the requested length or scene balance|Your rejected draft/.test(users[1]));
  });
});

// ── 3. Gate rewrite is draft-aware for 30 seconds too ───────────────────────────────────────────────────────────────────────
const NUMBERED = (n) => { const t = sized(n); t[1] = "Inventory hit 99.9 months this year. " + t[1]; return t; };
test("gate rewrite (30 seconds, Test): anchored to the rejected draft with the 55-70 range and no writing aim; diagnostics record the revision", async () => {
  await withDev(true, async () => {
    const bad = NUMBERED([8, 20, 22, 10]), good = sized([8, 20, 22, 10]);
    const users = [];
    const { r, e } = await run(proj(30), async (sys, user) => { users.push(user); return mk(users.length === 1 ? bad : good); });
    assert.ifError(e);
    assert.strictEqual(users.length, 2, "one rewrite only");
    const fix = users[1];
    assert.match(fix, /rejected by the compliance check for these specific reasons/);
    assert.match(fix, /Your rejected draft, for a 30-second Reel \(recommended range 55-70 spoken words\), is \d+ spoken words:/);
    assert.ok(!/writing aim/.test(fix));
    assert.ok(fix.includes("Inventory hit 99.9 months this year."), "the rejected narration");
    assert.match(fix, /Do not make the narration longer than this draft/);
    assert.ok(!/bring the script toward the writing aim/.test(fix));
    const d = r.narrative.lengthDiagnostics;
    assert.strictEqual(d.rewriteAnchored, true);
    assert.deepStrictEqual(d.revisions.map((x) => [x.path, x.anchored]), [["gate_rewrite", true]]);
  });
});

test("gate rewrite (production): the original message, no anchoring and no diagnostics", async () => {
  await withDev(false, async () => {
    const bad = NUMBERED([8, 20, 22, 10]), good = sized([8, 20, 22, 10]);
    const users = [];
    await run(proj(30), async (sys, user) => { users.push(user); return mk(users.length === 1 ? bad : good); });
    assert.match(users[1], /Rewrite the complete JSON so none of these happen\. Keep the same topic, hook and facts; change only what is listed/);
    assert.ok(!/Your rejected draft, for a/.test(users[1]));
  });
});

// ── 4. Editor targets and trigger come from the contract ────────────────────────────────────────────────────────────────────
test("editor (Test): 45 seconds triggers above 125 and cuts toward 110; 60 seconds triggers above 151 and cuts toward 146; 30 seconds has no editor", async () => {
  await withDev(true, async () => {
    const edit = (sizes, dur) => {
      const texts = sized(sizes); const sent = []; let n = 0;
      return run(proj(dur), async (sys, user) => { n++; if (n === 1) return mk(texts); const s = JSON.parse(user); sent.push(s); return JSON.stringify({ scenes: s.scenes.map((x) => ({ index: x.index, narration: x.narration })) }); }).then((o) => ({ ...o, n, sent, texts }));
    };
    let o = await edit([14, 30, 30, 26, 26], 45); assert.strictEqual(total(o.texts), 126);
    assert.strictEqual(o.n, 2); assert.deepStrictEqual([o.sent[0].max_words, o.sent[0].target_words, o.sent[0].recommended_words], [125, 110, [105, 125]]);
    o = await edit([14, 30, 30, 26, 25], 45); assert.strictEqual(total(o.texts), 125); assert.strictEqual(o.n, 1, "125 is inside the range: no editor");
    o = await edit([14, 26, 26, 30, 30, 26], 60); assert.strictEqual(total(o.texts), 152);
    assert.strictEqual(o.n, 2); assert.deepStrictEqual([o.sent[0].max_words, o.sent[0].target_words, o.sent[0].recommended_words], [151, 146, [133, 151]]);
    o = await edit([14, 26, 26, 30, 30, 25], 60); assert.strictEqual(total(o.texts), 151); assert.strictEqual(o.n, 1, "151 is inside the range: no editor");
    o = await edit([20, 30, 30, 20], 30); assert.ok(total(o.texts) > 70); assert.strictEqual(o.sent.length, 0, "30 seconds never gets the scene editor");
  });
});

test("editor: production never calls the scene editor and keeps the 110-130 range at 60 seconds", async () => {
  await withDev(false, async () => {
    assert.deepStrictEqual(am.wordTargets(60), [110, 130]);
    assert.strictEqual(planLib.writingAimFor(60), null);
    const texts = sized([14, 26, 26, 30, 30, 26]); let n = 0; const users = [];
    await run(proj(60), async (sys, user) => { n++; users.push(user); return mk(texts); });
    assert.ok(users.every((u) => !/words_to_remove|target_words/.test(u)), "no editor payload in production");
  });
});
