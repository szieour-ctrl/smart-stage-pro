"use strict";
// Nov 14, 2026 (Sam; Test only): the story-first composition contract. STORY -> SELECT ESSENTIAL EVIDENCE -> ALLOCATE WORDS -> WRITE NARRATION.
// Offline only: a stand-in model, and the stored Lincoln Option 2 / Topic 1 session (tests/fixtures/lincoln-option2-t1.json) as the regression fixture.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");
const am = require("../netlify/functions/lib/agent-marketing-lib");
const FX = require("./fixtures/lincoln-option2-t1.json");

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const DEV = { AGENT_MARKETING_B1_EVIDENCE: "dev" };
const PROD_SHA = "25f3118fed1b9726fc4dc78b16dcc92233cef785d3c074ef89a6ee7aaf7b0495";
async function withDev(on, fn) {
  const prev = process.env.AGENT_MARKETING_B1_EVIDENCE;
  if (on) process.env.AGENT_MARKETING_B1_EVIDENCE = "dev"; else delete process.env.AGENT_MARKETING_B1_EVIDENCE;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.AGENT_MARKETING_B1_EVIDENCE; else process.env.AGENT_MARKETING_B1_EVIDENCE = prev; }
}
const intake = { angle: "", market: "Lincoln, CA", audience: "Home sellers", issue: "", action: "Ask for a local perspective", observation: "" };
const lincoln = (dur, b2) => ({ template: "local_market_insider", duration_sec: dur || 60, formats: ["9x16", "16x9"], intake, selected_topic: { ...FX.topic, b2: { ...FX.topic.b2, ...(b2 || {}) } } });
const userOf = (project) => JSON.parse(planLib.buildUserMessage(project));
const rule = (sys, id) => sys.split("\n").filter((l) => l.startsWith(id + ". "));

// ── the duration contract ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("60 seconds in Test drafts to 150 words inside 140-155; 45, 30 and production are unchanged", () => {
  assert.deepStrictEqual(am.DURATION_CONTRACT[60], { range: [110, 130], devRange: [140, 155], aim: [150, 150], editorTarget: 150, scenes: [6, 8], images: [4, 6] });
  assert.deepStrictEqual(am.DURATION_CONTRACT[45].aim, [105, 110]);
  assert.deepStrictEqual(am.WORD_TARGETS, { 30: [55, 70], 45: [105, 125], 60: [110, 130] });
  assert.deepStrictEqual([30, 45, 60].map((d) => am.wordTargets(d, DEV)), [[55, 70], [105, 125], [140, 155]]);
  assert.deepStrictEqual(am.EDITOR_TARGETS, { 45: 110, 60: 150 });
});

test("beat budgets: 20/30/35/50/15 at 150 words (Options 1 and 3; Option 2 at 60 s uses component budgets); scaled whole words that sum to the aim at 45 seconds; none at 30", async () => {
  await withDev(true, async () => {
    const u60 = userOf(lincoln(60, { mode: "article_editorial" })).narrative_contract;
    assert.deepStrictEqual(u60.beats.map((b) => [b.beat, b.words]), [["hook", 20], ["setup", 30], ["evidence", 35], ["interpretation", 50], ["cta", 15]]);
    assert.strictEqual(u60.beats.reduce((a, b) => a + b.words, 0), 150);
    assert.strictEqual(u60.target_words, 150);
    assert.deepStrictEqual(u60.drafting_range, [140, 155]);
    const u45 = userOf(lincoln(45)).narrative_contract;
    assert.ok(u45.beats.every((b) => Number.isInteger(b.words) && b.words > 0));
    assert.strictEqual(u45.beats.reduce((a, b) => a + b.words, 0), u45.target_words);
    assert.ok(u45.target_words >= 105 && u45.target_words <= 110);
    assert.ok(u45.beats[3].words > u45.beats[2].words && u45.beats[2].words > u45.beats[1].words, "the interpretation beat stays the largest");
    assert.ok(!("narrative_contract" in userOf(lincoln(30))), "30 seconds is unchanged");
  });
});

// ── the user-message contract ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("Lincoln Option 2 (60 s): the contract carries the sequence, the hook rule, the absolute component budgets and the report protection (no 40% ceiling)", async () => {
  await withDev(true, async () => {
    const u = userOf(lincoln(60));
    const c = u.narrative_contract;
    assert.match(c.composition_order, /^STORY, then SELECT ESSENTIAL EVIDENCE, then COMPOSE EACH COMPONENT INSIDE ITS WORD BUDGET, then JOIN THEM IN ORDER/);
    assert.ok(!("beats" in c) && !("beat_rules" in c), "Option 2 at 60 s is written from components, not beats");
    assert.deepStrictEqual(c.components.map((x) => x.component), ["opening", "article", "trend", "synthesis", "cta"]);
    assert.deepStrictEqual(c.components.map((x) => x.words || x.max_words), [20, 33, 35, 50, 15]);
    assert.strictEqual(c.components[3].min_words, 47);
    assert.match(c.components[0].job, /14 words or fewer/);
    assert.match(c.components[0].job, /exact opening sentence of the narration/);
    assert.match(c.components[0].job, /up to 6 more words of immediate setup or tension/);
    assert.match(c.component_rules, /absolute and are met on the first draft/);
    assert.match(c.component_rules, /rely on the length editor/);
    assert.match(c.source_controls, /^Option 2, article plus Market Trend Report/);
    assert.match(c.source_controls, /absolute spoken-word counts, not percentages/);
    assert.match(c.source_controls, /ARTICLE NARRATIVE \(at most 33 spoken words\)/);
    assert.match(c.source_controls, /MARKET TREND NARRATIVE \(at most 35 spoken words\)/);
    assert.match(c.source_controls, /REALTOR EDITORIAL SYNTHESIS \(47 to 50 spoken words\)/);
    assert.match(c.source_controls, /not a repeat of the article summary, not another recap of the statistics and not generic advice/);
    assert.match(c.source_controls, /do not re-label article recommendations as the Realtor's synthesis/);
    assert.match(c.source_controls, /selected topic stays authoritative/);
    assert.match(c.source_controls, /never presented as proof of causation/);
    assert.doesNotMatch(c.source_controls, /40%/);
    assert.match(c.sentence_test, /only repeats a fact, qualifier or explanation without changing the viewer's understanding is removed before drafting/);
    assert.match(c.sentence_test, /Do not force unrelated findings into a causal relationship/);
    assert.deepStrictEqual(u.spoken_word_range, [140, 155]);
    assert.match(u.spoken_word_aim, /^about 150 spoken words\./);
  });
});

test("Option 2 at 45 seconds keeps the beat contract and its 40% article ceiling (the component budgets are defined for 60 seconds)", async () => {
  await withDev(true, async () => {
    const c = userOf(lincoln(45)).narrative_contract;
    assert.ok(c.beats && !c.components);
    assert.match(c.source_controls, /at most 40% of the spoken narration, \d+ words or fewer/);
  });
});

test("the contract states no statistic, subject or sample wording: nothing from the Lincoln fixture appears in it", async () => {
  await withDev(true, async () => {
    for (const mode of ["article_report", "article_editorial"]) {
      const text = JSON.stringify(userOf(lincoln(60, { mode })).narrative_contract);
      assert.doesNotMatch(text.replace(/40%/g, "").replace("[140,155]", ""), /Lincoln|Fannie|builder|buydown|forward|appraisal|Rich|Kat|\$|\d%|\d,\d{3}/i, mode);
      for (const f of FX.topic.reportFigures) assert.ok(!text.includes(f.text), "no report figure text");
      assert.ok(!text.includes(FX.topic.b1CentralArgument.slice(0, 40)));
    }
  });
});

test("the three options carry their own source controls", async () => {
  await withDev(true, async () => {
    const o2 = userOf(lincoln(60, { mode: "article_report" })).narrative_contract.source_controls;
    const o3 = userOf(lincoln(60, { mode: "article_editorial" })).narrative_contract.source_controls;
    const o1 = userOf(lincoln(60, { mode: "trend_report" })).narrative_contract.source_controls;
    assert.match(o3, /^Option 3, article only/); assert.match(o3, /without summarizing the whole article/); assert.match(o3, /the interpretation beat is the largest/);
    assert.doesNotMatch(o3, /Market Trend/);
    assert.match(o1, /^Option 1, Market Trend Report only/); assert.match(o1, /geographic scope of every statistic/); assert.match(o1, /never widen the research area/);
    assert.match(o1, /forecasts or professional expectations/); assert.match(o1, /interpretation beat is the largest/);
    assert.doesNotMatch(o1, /40%/);
    assert.strictEqual(new Set([o1, o2, o3]).size, 3);
  });
});

test("not applied where it does not belong: production, an unknown mode, no editorial direction", async () => {
  await withDev(false, async () => assert.ok(!("narrative_contract" in userOf(lincoln(60))), "production user message is unchanged"));
  await withDev(true, async () => {
    assert.ok(!("narrative_contract" in userOf(lincoln(60, { mode: "something_else" }))));
    const bare = { ...lincoln(60), selected_topic: { id: "t9", question: "Plain topic", whyItMatters: "w", scope: "selected", origin: "web", candidate: {}, sources: [] } };
    assert.ok(!("narrative_contract" in userOf(bare)));
  });
});

test("Lincoln handoff preserved (1b1d789): the stored position is still the angle, with the report readings alongside", async () => {
  await withDev(true, async () => {
    const t = userOf(lincoln(60)).selected_topic;
    assert.strictEqual(t.editorial_direction.angle, FX.topic.b1CentralArgument);
    assert.strictEqual(t.editorial_direction.develops_article_position, true);
    assert.strictEqual(t.editorial_direction.homeowner_implication, "");
    assert.ok(!("audience_journey" in t.editorial_direction));
    assert.ok(t.editorial_direction.market_interpretation, "the report readings still reach the writer");
    assert.strictEqual(t.figures_you_may_state.length, FX.topic.reportFigures.length);
  });
});

// ── the Test system prompt ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("Test prompt: the editorial contract (2i C) carries the sequence, the composition_plan key is first in the reply, the article is named once; production untouched", () => {
  const dev = planLib.buildSystemPrompt(DEV, {}), prod = planLib.buildSystemPrompt({});
  assert.strictEqual(sha(prod), PROD_SHA, "production prompt unchanged");
  const r = rule(dev, "2i");
  assert.strictEqual(r.length, 1);
  assert.match(r[0], /PLAN BEFORE YOU WRITE/);
  assert.match(r[0], /never write long and rely on the length editor/);
  assert.match(r[0], /beat budgets and source controls on the first draft/);
  assert.match(r[0], /not scenes and not conclusions/);
  assert.ok(!/^2r\. /m.test(dev) && !/^2r\. /m.test(prod), "the separate sequence rule is gone");
  assert.match(dev, /composition_plan is the FIRST key and is written only when the input has narrative_contract/);
  const schema = dev.split("\n").find((l) => l.startsWith('{ "composition_plan"'));
  assert.ok(schema && schema.indexOf("composition_plan") < schema.indexOf("editorial_angle") && schema.indexOf("editorial_angle") < schema.indexOf("narration_with_audio_tags"));
  assert.match(schema, /central_tension.*realtor_conclusion.*essential_findings.*sentences.*beat_words/);
  assert.doesNotMatch(schema, /market_relationship/);
  assert.doesNotMatch(prod, /composition_plan/);
  assert.match(rule(dev, "2h")[0], /Name the article once, where its first fact is introduced; after that state later facts and the Realtor's interpretation directly/);
  assert.doesNotMatch(rule(prod, "2h").join(""), /Name the article once/);
  assert.match(r[0], /the prices of homes for sale and the prices of homes that sold describe different homes/);
});

test("the editorial contract keeps the subscriber's direction authoritative and the hook open to a question or a declarative tension", () => {
  const dev = planLib.buildSystemPrompt(DEV, {});
  assert.match(rule(dev, "2i")[0], /that angle is the one point the Reel makes, and editorial_angle restates it/);
  assert.match(rule(dev, "2i")[0], /add no second point/);
  assert.match(rule(dev, "5b")[0], /a question or a declarative statement/);
  assert.match(rule(dev, "5b")[0], /14 words or fewer/);
  assert.match(rule(dev, "2i")[0], /article_evidence\.central_argument|central_argument/);
});

// ── composition_plan: written first, kept as Test diagnostic metadata, never a gate, never another call ─────────────────────────────────────
const TAGS = ["[conversational]", "[thoughtful]", "[emphasis]", "[confident]", "[warm]", "[calm]"];
const ROLE_OF = ["local_hook", "tension", "insight", "advice", "advice", "advice", "advice", "advice"];
const mkScene = (text, i, last) => { const gpt = last > 4 ? 4 : last > 3 ? 3 : 2;
  return { role: i === last ? "cta" : ROLE_OF[i], narration_excerpt: text, purpose: "purpose " + i,
    visual_source: i < gpt ? "GPT_IMAGE_2_CONCEPT" : (i === last ? "BRAND_CARD" : "CONCEPT_REUSE"), visual_brief: "brief " + i, reuse_of_scene: i < gpt || i === last ? null : 1,
    card_text: i === last ? "Ask me for a local view" : null, ai_generation_prompt: i < gpt ? "Photorealistic editorial tabletop with architectural home models, soft light, no people, no text, wide composition" : null,
    camera_motion: "push_in", framing_9x16: "keep homes visible", framing_16x9: "keep wide street", text_safe_placement: "lower middle", source_role: "data" }; };
const BASE = "buyers have more choices now and that changes how a prepared home gets priced in this market";
const words = (n) => { const w = BASE.split(" "); const out = []; for (let i = 0; out.length < n; i++) out.push(w[i % w.length]); return out.join(" ") + "."; };
const sized = (sizes) => sizes.map((n, i) => (i === 0 ? "Is that really what is happening in this market? " + words(n - 9) : words(n)));
const total = (t) => t.reduce((a, x) => a + am.countWords(x), 0);
const PLAN = { central_tension: "Builders can lower a buyer's payment in ways a resale seller cannot match", realtor_conclusion: "Price against what the buyer really pays, not the sign", essential_findings: ["A1-F3", "R10", "R11"],
  sentences: [{ beat: "hook", words: 20, purpose: "question" }, { beat: "setup", words: 30, purpose: "what is changing" }, { beat: "evidence", words: 35, purpose: "two findings" }, { beat: "interpretation", words: 50, purpose: "resolve" }, { beat: "cta", words: 15, purpose: "next step" }, { beat: "nonsense", words: "x", purpose: "p".repeat(500) }],
  beat_words: { hook: 20, setup: 30, evidence: 35, interpretation: 50, cta: 15 } };
const mk = (texts, plan) => JSON.stringify({ ...(plan ? { composition_plan: plan } : {}), editorial_angle: "Buyers have more choices, so preparation matters.", hook: "Is that really what is happening in this market?", narration_with_audio_tags: texts.map((x, i) => `${TAGS[i]} ${x}`).join(" "),
  scenes: texts.map((t, i) => mkScene(t, i, texts.length - 1)), cta_suggestion: "Ask me.", claims_to_verify: [], missing_agent_inputs: [] });
const roseville = (dur) => ({ template: "local_market_insider", duration_sec: dur, formats: ["9x16", "16x9"], intake: { angle: "neighborhood", market: "Roseville, CA", audience: "Home sellers", issue: "Supply", action: "Understand", observation: "Buyers have more choices." } });
const run = (project, callFn) => planLib.generatePlan({ project, anthropicKey: "k", callFn }).then((r) => ({ r }), (e) => ({ e }));

test("composition_plan is kept as sanitized Test diagnostic metadata beside the narration, with no extra call", async () => {
  await withDev(true, async () => {
    const texts = sized([20, 30, 35, 20, 30, 15]); // 150 words, inside the range: no editor
    assert.strictEqual(total(texts), 150);
    const calls = [];
    const { r, e } = await run(roseville(60), async (sys, user) => { calls.push({ sys, user }); return mk(texts, PLAN); });
    assert.ifError(e);
    assert.strictEqual(calls.length, 1, "one Planner call and nothing else");
    const cp = r.narrative.compositionPlan;
    assert.ok(cp, "the plan is preserved");
    assert.strictEqual(cp.centralTension, PLAN.central_tension);
    assert.strictEqual(cp.realtorConclusion, PLAN.realtor_conclusion);
    assert.strictEqual(cp.marketRelationship, undefined, "market_relationship is no longer a composition_plan field");
    assert.deepStrictEqual(cp.essentialFindings, PLAN.essential_findings);
    assert.deepStrictEqual(cp.beatWords, PLAN.beat_words);
    assert.strictEqual(cp.sentences.length, 6);
    assert.strictEqual(cp.sentences[5].beat, null, "an unknown beat is dropped");
    assert.strictEqual(cp.sentences[5].words, null, "a non-number is dropped");
    assert.ok(cp.sentences[5].purpose.length <= 160, "text is clipped");
    assert.strictEqual(cp.declaredWords, 150);
    assert.strictEqual(r.narrative.wordCount, 150);
    assert.deepStrictEqual(r.warnings.filter((w) => /usually runs/.test(w)), [], "140-155 is inside the range");
    assert.ok(r.gate.ok, "the plan is never a gate");
  });
});

test("no plan, a malformed plan, and production: nothing is stored, nothing fails", async () => {
  await withDev(true, async () => {
    const texts = sized([20, 30, 35, 20, 30, 15]);
    for (const plan of [undefined, "text", [], 5, {}]) {
      const { r, e } = await run(roseville(60), async () => mk(texts, plan));
      assert.ifError(e);
      assert.ok(!("compositionPlan" in r.narrative), JSON.stringify(plan));
    }
  });
  await withDev(false, async () => {
    const { r, e } = await run(roseville(30), async () => mk(sized([14, 14, 14, 14]).slice(0, 4), PLAN).replace(/"scenes"/, '"scenes"'));
    // production ignores the key entirely (a 4-scene 30-second plan may fail for other reasons; only the absence of the plan matters)
    if (r) assert.ok(!("compositionPlan" in r.narrative));
  });
});

test("the plan reaches no gate input and is not fed to any later call (the editor payload carries budgets, not the plan)", async () => {
  await withDev(true, async () => {
    const texts = sized([20, 32, 40, 24, 36, 20]); // 172 words, over 155: the editor runs
    assert.ok(total(texts) > 155);
    const calls = [];
    const { r, e } = await run(roseville(60), async (sys, user) => { calls.push({ sys, user }); return calls.length === 1 ? mk(texts, PLAN) : JSON.stringify({ scenes: JSON.parse(user).scenes.map((s) => ({ index: s.index, narration: s.narration })) }); });
    assert.ifError(e);
    assert.strictEqual(calls.length, 2, "the existing single editor call");
    assert.doesNotMatch(calls[1].user, /central_tension|realtor_conclusion|essential_findings/);
    assert.ok(r.narrative.compositionPlan, "the plan survives the edit pass");
  });
});

// ── the length editor ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("editor: minor overruns and pacing only; article explanation goes first; the article is named once; the payload carries the component budgets for Option 2 at 60 s", async () => {
  const sys = planLib.lengthEditSystem(60, true);
  assert.match(sys, /You handle minor overruns and pacing; you do not re-select the story/);
  assert.match(sys, /take words first from article explanation that exceeds its ceiling or its beat, then from secondary evidence, and never from the Realtor's interpretation/);
  assert.match(sys, /the article is named once, where its first fact is introduced/);
  assert.doesNotMatch(sys, /named whenever its facts are used/);
  assert.match(sys, /so the article is still named once/);
  await withDev(true, async () => {
    const texts = sized([20, 32, 40, 24, 36, 20]);
    const calls = [];
    const lp = { ...lincoln(60), duration_sec: 60 };
    // the Lincoln project through the whole Planner path with a stand-in model
    const { e } = await run({ ...lp }, async (sys2, user) => { calls.push({ sys: sys2, user }); return calls.length === 1 ? mk(texts) : JSON.stringify({ scenes: JSON.parse(user).scenes.map((s) => ({ index: s.index, narration: s.narration })) }); });
    assert.ifError(e);
    assert.strictEqual(calls.length, 2, "the stored Lincoln topic reaches the existing single editor call");
    const sent = JSON.parse(calls[1].user);
    assert.deepStrictEqual(sent.composition.components.map((x) => [x.component, x.min_words || null, x.max_words]), [["opening", null, 20], ["article", null, 33], ["trend", null, 35], ["synthesis", 47, 50], ["cta", null, 15]]);
    assert.ok(!("beat_words" in sent.composition) && !("article_explanation_ceiling_words" in sent.composition));
    assert.strictEqual(sent.target_words, 150);
    assert.strictEqual(sent.max_words, 155);
  });
});

test("editor trigger: at most 155 words is never edited; above 155 the existing single editor call runs", async () => {
  await withDev(true, async () => {
    for (const [sizes, expect] of [[[20, 30, 35, 20, 30, 15], 1], [[20, 30, 35, 20, 30, 20], 1], [[20, 30, 36, 20, 30, 20], 2]]) {
      const texts = sized(sizes), calls = [];
      const { e } = await run(roseville(60), async (s, u) => { calls.push(u); return calls.length === 1 ? mk(texts) : JSON.stringify({ scenes: JSON.parse(u).scenes.map((x) => ({ index: x.index, narration: x.narration })) }); });
      assert.ifError(e);
      assert.strictEqual(calls.length, expect, `${total(texts)} words`);
    }
  });
});

// ── regression fixture: the failed Lincoln script ───────────────────────────────────────────────────────────────────────────────────────────
test("regression: the failed Lincoln draft was 187 words, which the new contract treats as an overrun, and its report framing is what rule 2i E names", async () => {
  const f = FX.failedScript;
  assert.strictEqual(am.countWords(f.narration), f.finalWords);
  assert.ok(f.initialWords > 155 && f.finalWords > 155, "both counts were over the new top");
  assert.ok(f.sceneWords.every((w) => w >= 8));
  // The framing the contract rejects: an average asking (for-sale) price set against an average sold price as a difference.
  assert.match(f.narration, /average sold price of \$737,000 sits meaningfully below the average for-sale price of \$866,000/);
  await withDev(true, async () => {
    const u = userOf(lincoln(60));
    // the same stored readings still reach the writer; rule 2i E tells it to read a for-sale price and a sold price as different homes
    assert.match(JSON.stringify(u.selected_topic.editorial_direction.market_interpretation), /asking prices|what recently sold/);
    const dev = planLib.buildSystemPrompt(DEV, {});
    assert.match(rule(dev, "2i")[0], /leave out any that compare different groups of homes or different measures as if they were the same/);
    assert.match(u.narrative_contract.source_controls, /never presented as proof of causation/);
    assert.ok(u.selected_topic.figures_you_may_state.some((x) => /Sold price as a percent of original list price: 95%/.test(x)), "the ratio the contract reads by its own label is available");
  });
});

test("Use My Script is untouched: the contract is a Planner input only, with no gate, approval or length block anywhere in it", () => {
  const src = require("fs").readFileSync(__dirname + "/../netlify/functions/lib/agent-marketing-plan-lib.js", "utf8");
  const block = src.slice(src.indexOf("Story-first composition contract"), src.indexOf("function buildUserMessage")).split("\n").filter((l) => !/^\s*(\/\/|\/\*)/.test(l)).join("\n");
  assert.ok(block.length > 500);
  assert.doesNotMatch(block, /gate\.|gateNarrative|blocks\.push|throw new Error|approv/i);
  const am2 = require("../netlify/functions/lib/agent-marketing-lib");
  assert.strictEqual(typeof am2.countWords, "function");
});
