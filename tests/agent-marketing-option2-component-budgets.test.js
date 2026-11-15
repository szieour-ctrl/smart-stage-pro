"use strict";
// Nov 15, 2026 (Sam; Test only): the Option 2 narrative composition contract. A 60-second Reel is written as three distinct components between the hook and
// the CTA with ABSOLUTE spoken-word budgets: article narrative at most 33, Market Trend narrative at most 35, Realtor synthesis 47-50 (opening 20, CTA 15).
// Offline only: a stand-in model, and the stored Lincoln and Parkwood Option 2 sessions as regression fixtures. No paid call, no network.
const test = require("node:test");
const assert = require("node:assert");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");
const am = require("../netlify/functions/lib/agent-marketing-lib");
const LINC = require("./fixtures/lincoln-option2-t1.json");
const PARK = require("./fixtures/parkwood-option2-t1.json");

async function withDev(on, fn) {
  const prev = process.env.AGENT_MARKETING_B1_EVIDENCE;
  if (on) process.env.AGENT_MARKETING_B1_EVIDENCE = "dev"; else delete process.env.AGENT_MARKETING_B1_EVIDENCE;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.AGENT_MARKETING_B1_EVIDENCE; else process.env.AGENT_MARKETING_B1_EVIDENCE = prev; }
}
const intake = { angle: "", market: "Lincoln, CA", audience: "Home sellers", issue: "", action: "Ask for a local perspective", observation: "" };
const project = (topic, dur, b2) => ({ template: "local_market_insider", duration_sec: dur || 60, formats: ["9x16", "16x9"], intake, selected_topic: { ...topic, b2: { ...topic.b2, ...(b2 || {}) } } });
// Offline stand-in for the validated article findings B1 supplies at runtime (the stored topic carries only their ids): the article's own facts, stated as the
// article gives them, so the content gate can source the article figures a script states. The research topic is otherwise exactly as stored.
const ARTICLE_FACTS = " Article facts: the Lincoln City Council adopted the Parkwood development agreement on Oct. 27; 122 single-family homes and 4.2 acres of parks; a final map comes next.";
const parkwood = (dur, b2) => project({ ...PARK.topic, whyItMatters: PARK.topic.whyItMatters + ARTICLE_FACTS }, dur, b2);
const lincoln = (dur, b2) => project(LINC.topic, dur, b2);
const wc = (t) => am.countWords(t);

// The hand-composed Parkwood T1 script (written to the contract; see /tmp/eval notes): 20 / 33 / 35 / 48 / 15 = 151 words, counted the way the app counts
// spoken words (am.countWords: a decimal such as 2.7 is two words).
const PW = {
  opening: "Hundreds of new homes are approved for Lincoln's east side. Here's what Parkwood's approval really means for nearby resale sellers.",
  article: "Lincoln's council adopted Parkwood's development agreement October 27: 122 homes, 4.2 acres of parks. It's the last vote before construction paperwork, but the terms aren't public, and a final map comes next.",
  trend: "September's report: 2.7 months of inventory, seller's-market range, down 10.1% from August. Homes sold at 95% of original list price, days on market held near 49, and closed sales are up 4.5%.",
  synthesis: "Lean supply is your leverage today, and Parkwood is the clock on it. It still needs a final map before lots can be sold, so you have a window. If you're planning to sell, use it, price to what homes close for, and expect comparisons with new construction.",
  cta: "Thinking of selling near Parkwood? Ask me what timing and price make sense for you.",
};
const TAGS = ["[conversational]", "[thoughtful]", "[emphasis]", "[confident]", "[warm]", "[calm]"];
const ROLES = ["local_hook", "tension", "insight", "advice", "advice", "cta"];
const scene = (text, i, last, role) => { const gpt = last > 4 ? 4 : last > 3 ? 3 : 2;
  return { role: i === last ? "cta" : ROLES[i], narration_excerpt: text, purpose: "purpose " + i, visual_source: i < gpt ? "GPT_IMAGE_2_CONCEPT" : (i === last ? "BRAND_CARD" : "CONCEPT_REUSE"),
    visual_brief: "brief " + i, reuse_of_scene: i < gpt || i === last ? null : 1, card_text: i === last ? "Ask me for a local view" : null,
    ai_generation_prompt: i < gpt ? "Photorealistic editorial tabletop with architectural home models, soft light, no people, no text, wide composition" : null,
    camera_motion: "push_in", framing_9x16: "keep homes visible", framing_16x9: "keep wide street", text_safe_placement: "lower middle", source_role: role }; };
const sentences = (t) => t.split(/(?<=[.!?])\s+/);
/** Scenes: opening | article | trend | first two synthesis sentences | last synthesis sentence | cta, with the roles rule 2g expects. */
function scenesFor(c) {
  const syn = sentences(c.synthesis), a = syn.slice(0, -1).join(" "), b = syn[syn.length - 1];
  const texts = [c.opening, c.article, c.trend, a, b, c.cta], roles = ["article", "article", "data", "data", "data", "data"];
  return texts.map((t, i) => scene(t, i, texts.length - 1, roles[i]));
}
function writerReply(c, planComponents) {
  const sc = scenesFor(c);
  const narration = sc.map((s, i) => `${TAGS[i]} ${s.narration_excerpt}`).join(" ");
  return JSON.stringify({
    composition_plan: { central_tension: "New homes are coming, supply is lean", realtor_conclusion: "Use the window", essential_findings: ["A1-F5", "r1.f6"],
      ...(planComponents === null ? {} : { components: planComponents || { article: { text: c.article, words: 33 }, trend: { text: c.trend, words: 35 }, synthesis: { text: c.synthesis, words: 48 } } }) },
    editorial_angle: "Parkwood adds supply later; lean supply favors sellers now.", hook: sentences(c.opening)[0], narration_with_audio_tags: narration, scenes: sc,
    cta_suggestion: "Ask me.", claims_to_verify: [], missing_agent_inputs: [] });
}
/** Stand-in editor: returns the scenes, with `edit(sceneTexts, payload)` allowed to change them, and the components it was told to report. */
function editorReply(user, edit, comps) {
  const payload = JSON.parse(user);
  const texts = payload.scenes.map((s) => s.narration);
  const out = edit ? edit(texts, payload) : texts;
  return JSON.stringify({ scenes: out.map((t, index) => ({ index, narration: t })), ...(comps ? { components: comps } : {}) });
}
const run = (p, callFn) => planLib.generatePlan({ project: p, anthropicKey: "k", callFn }).then((r) => ({ r }), (e) => ({ e }));

// ── 1. the budgets and the contract ─────────────────────────────────────────────────────────────────────────────────────────────────────────
test("the stored Parkwood Option 2 / T1 topic gets the same component contract: 20 / 33 / 35 / 47-50 / 15, in order, absolute", async () => {
  await withDev(true, async () => {
    const c = JSON.parse(planLib.buildUserMessage(parkwood(60))).narrative_contract;
    assert.deepStrictEqual(c.components.map((x) => [x.component, x.min_words || null, x.max_words || x.words]), [["opening", null, 20], ["article", null, 33], ["trend", null, 35], ["synthesis", 47, 50], ["cta", null, 15]]);
    assert.strictEqual(c.target_words, 150);
    assert.match(c.source_controls, /absolute spoken-word counts, not percentages and not guidelines/);
    assert.match(c.source_controls, /never let a long draft, or a story that needs more room, justify a longer component/);
    assert.match(c.source_controls, /Do not move article explanation or the article's recommendations into another component/);
    assert.match(c.component_rules, /composition_plan\.components exactly as they appear, word for word/);
    // the contract states no subject, statistic or sample wording
    const text = JSON.stringify({ ...c, drafting_range: null });
    assert.doesNotMatch(text, /Lincoln|Parkwood|Stardust|Fannie|buydown|\$|\d%|\d,\d{3}/i);
  });
});

test("the Writer's reply schema asks for composition_plan.components, and production's prompt is untouched", () => {
  const dev = planLib.buildSystemPrompt({ AGENT_MARKETING_B1_EVIDENCE: "dev" }, {}), prod = planLib.buildSystemPrompt({});
  const schema = dev.split("\n").find((l) => l.startsWith('{ "composition_plan"'));
  assert.match(schema, /"components": \{ "article": \{ "text": string, "words": number \}, "trend": .*"synthesis": /);
  assert.ok(schema.indexOf("beat_words") < schema.indexOf('"components"'), "the existing keys keep their order");
  assert.strictEqual(require("crypto").createHash("sha256").update(prod).digest("hex"), "25f3118fed1b9726fc4dc78b16dcc92233cef785d3c074ef89a6ee7aaf7b0495");
  assert.doesNotMatch(prod, /components/);
});

test("Option 1, Option 3, 45 seconds, production and event Reels are unchanged: no component contract, no component check", async () => {
  await withDev(true, async () => {
    for (const mode of ["trend_report", "article_editorial"]) {
      const c = JSON.parse(planLib.buildUserMessage(lincoln(60, { mode }))).narrative_contract;
      assert.ok(c.beats && !c.components, mode);
      assert.strictEqual(planLib.checkComponents(lincoln(60, { mode }), { captionText: "x", compositionPlan: null }), null);
    }
    assert.ok(JSON.parse(planLib.buildUserMessage(lincoln(45))).narrative_contract.beats);
    assert.strictEqual(planLib.checkComponents(lincoln(45), { captionText: "x" }), null);
  });
  await withDev(false, async () => {
    assert.ok(!("narrative_contract" in JSON.parse(planLib.buildUserMessage(lincoln(60)))));
    assert.strictEqual(planLib.checkComponents(lincoln(60), { captionText: "x" }), null);
  });
});

// ── 2. component counts are verified from the narration, not trusted ────────────────────────────────────────────────────────────────────────
test("the hand-composed Parkwood script meets every budget on the first draft: one Planner call, no editor, counts verified from the narration", async () => {
  await withDev(true, async () => {
    assert.deepStrictEqual(["opening", "article", "trend", "synthesis", "cta"].map((k) => wc(PW[k])), [20, 33, 35, 48, 15]);
    const calls = [];
    const { r, e } = await run(parkwood(60), async (s, u) => { calls.push(u); return writerReply(PW); });
    assert.ifError(e);
    assert.strictEqual(calls.length, 1, "no editor and no extra call");
    assert.strictEqual(r.narrative.wordCount, 151);
    const d = r.narrative.lengthDiagnostics.components;
    assert.deepStrictEqual(d.final.counts, { opening: 20, article: 33, trend: 35, synthesis: 48, cta: 15 });
    assert.strictEqual(d.final.compliant, true);
    assert.strictEqual(d.initial.compliant, true);
    assert.deepStrictEqual(r.warnings.filter((w) => /budget|could not be verified/.test(w)), []);
    assert.ok(!r.narrative.componentOver);
    assert.strictEqual(Object.values(d.final.counts).reduce((a, b) => a + b, 0), r.narrative.wordCount, "the components account for every spoken word");
    const cp = r.narrative.compositionPlan.components;
    assert.deepStrictEqual(["article", "trend", "synthesis"].map((k) => cp[k].words), [33, 35, 48]);
  });
});

test("the Writer's own word counts are never trusted: the recorded count is the actual count of the recorded text", async () => {
  await withDev(true, async () => {
    const lie = { article: { text: PW.article, words: 20 }, trend: { text: PW.trend, words: 20 }, synthesis: { text: PW.synthesis, words: 20 } };
    const { r, e } = await run(parkwood(60), async () => writerReply(PW, lie));
    assert.ifError(e);
    const cp = r.narrative.compositionPlan.components;
    assert.deepStrictEqual(["article", "trend", "synthesis"].map((k) => [cp[k].words, cp[k].declaredWords]), [[33, 20], [35, 20], [48, 20]]);
    assert.strictEqual(r.narrative.lengthDiagnostics.components.final.counts.article, 33);
  });
});

test("component texts that are not in the narration, in order, are never reported as compliant", async () => {
  await withDev(true, async () => {
    const swapped = { article: { text: PW.trend, words: 35 }, trend: { text: PW.article, words: 33 }, synthesis: { text: PW.synthesis, words: 48 } }; // out of order
    const { r, e } = await run(parkwood(60), async () => writerReply(PW, swapped));
    assert.ifError(e);
    const f = r.narrative.lengthDiagnostics.components.final;
    assert.strictEqual(f.verified, false); assert.strictEqual(f.compliant, false);
    assert.ok(r.warnings.some((w) => /could not be verified/.test(w)), "the subscriber is told, nonblocking");
    const none = await run(parkwood(60), async () => writerReply(PW, null)); // the Writer recorded no components at all
    assert.strictEqual(none.r.narrative.lengthDiagnostics.components.final.verified, false);
    assert.ok(none.r.gate.ok, "never a gate");
  });
});

// ── 3. the editor does not accept substantial overruns as compliant ─────────────────────────────────────────────────────────────────────────
const LONG_ARTICLE = PW.article + " The lots sit near Stardust and Stardust 12 on McBean Park Drive.";   // over its 33-word budget
test("an article component over its budget triggers the single editor even when the total is inside 140-155; a compliant edit is verified from the edited narration", async () => {
  await withDev(true, async () => {
    const draft = { ...PW, opening: "Hundreds of new homes are approved for Lincoln's east side.", article: LONG_ARTICLE };
    const total = Object.values(draft).reduce((a, t) => a + wc(t), 0);
    assert.ok(total >= 140 && total <= 155 && wc(LONG_ARTICLE) > 33, `the setup: ${total} words, article ${wc(LONG_ARTICLE)}`);
    const calls = [];
    const { r, e } = await run(parkwood(60), async (s, u) => {
      calls.push({ s, u });
      if (calls.length === 1) return writerReply(draft, { article: { text: LONG_ARTICLE }, trend: { text: PW.trend }, synthesis: { text: PW.synthesis } });
      return editorReply(u, (texts) => texts.map((t) => (t === LONG_ARTICLE ? PW.article : t)), { article: PW.article, trend: PW.trend, synthesis: PW.synthesis });
    });
    assert.ifError(e);
    assert.strictEqual(calls.length, 2, "the existing single editor call, nothing else");
    const sent = JSON.parse(calls[1].u);
    assert.deepStrictEqual(sent.composition.over_budget, [{ component: "article", remove_at_least: wc(LONG_ARTICLE) - 33 }]);
    assert.strictEqual(sent.words_to_remove, Math.max(0, total - 150), "never a negative cut");
    assert.ok(sent.scenes[1].components.some((x) => x.component === "article"), "the editor sees which scene holds which component");
    assert.match(calls[1].s, /COMPONENT BUDGETS/);
    assert.match(calls[1].s, /never from the Realtor synthesis while another component can give/);
    assert.match(calls[1].s, /do not re-label article material as the Realtor's synthesis/);
    const d = r.narrative.lengthDiagnostics;
    assert.strictEqual(d.edit.outcome, "accepted");
    assert.strictEqual(d.components.initial.compliant, false);
    assert.strictEqual(d.components.initial.over[0].component, "article");
    assert.strictEqual(d.components.final.counts.article, 33);
    assert.strictEqual(d.components.final.compliant, true);
    assert.deepStrictEqual(r.warnings.filter((w) => /budget/.test(w)), []);
    assert.strictEqual(r.narrative.compositionPlan.components.article.text, PW.article, "the plan now records the edited component");
    assert.strictEqual(r.narrative.compositionPlan.plannedComponents.article.text, LONG_ARTICLE, "and the draft's own text is kept for comparison");
  });
});

test("an editor that leaves the article over its budget is discarded or flagged: never accepted as compliant", async () => {
  await withDev(true, async () => {
    const draft = { ...PW, opening: "Hundreds of new homes are approved for Lincoln's east side.", article: LONG_ARTICLE };
    const plan = { article: { text: LONG_ARTICLE }, trend: { text: PW.trend }, synthesis: { text: PW.synthesis } };
    // (a) the editor changes nothing
    let n = 0;
    const same = await run(parkwood(60), async (s, u) => (++n === 1 ? writerReply(draft, plan) : editorReply(u, null, { article: LONG_ARTICLE, trend: PW.trend, synthesis: PW.synthesis })));
    assert.ifError(same.e);
    let d = same.r.narrative.lengthDiagnostics;
    assert.strictEqual(d.edit.outcome, "discarded");
    assert.strictEqual(d.components.final.compliant, false);
    assert.strictEqual(same.r.narrative.componentOver[0].component, "article");
    assert.ok(same.r.warnings.some((w) => /^Article narrative is \d+ words; its budget is 33\./.test(w)));
    // (b) the editor trims but only partly
    n = 0;
    const PART = LONG_ARTICLE.replace(" The lots sit near Stardust and Stardust 12 on McBean Park Drive.", " Lots sit near Stardust.");
    assert.ok(wc(PART) > 33 && wc(PART) < wc(LONG_ARTICLE));
    const part = await run(parkwood(60), async (s, u) => (++n === 1 ? writerReply(draft, plan) : editorReply(u, (t) => t.map((x) => (x === LONG_ARTICLE ? PART : x)), { article: PART, trend: PW.trend, synthesis: PW.synthesis })));
    assert.ifError(part.e);
    d = part.r.narrative.lengthDiagnostics;
    assert.strictEqual(d.edit.outcome, "accepted_still_over");
    assert.strictEqual(d.components.final.compliant, false);
    assert.ok(d.components.final.counts.article > 33 && d.components.final.counts.article < wc(LONG_ARTICLE));
    assert.ok(part.r.warnings.some((w) => /budget is 33/.test(w)));
  });
});

test("a Market Trend overrun is held to its own 35-word cap, and a synthesis under 47 words is reported, not padded", async () => {
  await withDev(true, async () => {
    const longTrend = PW.trend + " Pending sales are down from last month.";
    const shortSyn = "Lean supply is your leverage today, and Parkwood is the clock on it. Use the window and price to what homes close for.";
    const draft = { ...PW, opening: "Hundreds of new homes are approved for Lincoln's east side.", trend: longTrend, synthesis: shortSyn };
    const { r, e } = await run(parkwood(60), async (s, u) => writerReply(draft, { article: { text: PW.article }, trend: { text: longTrend }, synthesis: { text: shortSyn } }).replace(/x^/, ""));
    assert.ifError(e);
    const f = r.narrative.lengthDiagnostics.components.final;
    assert.ok(f.over.some((x) => x.component === "trend" && x.max === 35));
    assert.ok(f.under.some((x) => x.component === "synthesis" && x.min === 47));
    assert.ok(r.warnings.some((w) => /^Market Trend narrative is \d+ words; its budget is 35\./.test(w)));
    assert.ok(r.warnings.some((w) => /^Realtor synthesis is \d+ words; its budget is at least 47\./.test(w)));
    assert.ok(r.gate.ok, "never a gate");
  });
});

test("the old whole-script rule still applies: a draft over 155 is edited once, and the Option 2 check is recomputed on the result", async () => {
  await withDev(true, async () => {
    const draft = { ...PW, article: LONG_ARTICLE, trend: PW.trend + " Pending sales are down from last month." };
    assert.ok(Object.values(draft).reduce((a, t) => a + wc(t), 0) > 155);
    let n = 0;
    const { r, e } = await run(parkwood(60), async (s, u) => (++n === 1 ? writerReply(draft, { article: { text: draft.article }, trend: { text: draft.trend }, synthesis: { text: PW.synthesis } })
      : editorReply(u, (t) => t.map((x) => (x === draft.article ? PW.article : x === draft.trend ? PW.trend : x)), { article: PW.article, trend: PW.trend, synthesis: PW.synthesis })));
    assert.ifError(e);
    assert.strictEqual(n, 2);
    assert.strictEqual(r.narrative.wordCount, 151);
    assert.strictEqual(r.narrative.lengthDiagnostics.components.final.compliant, true);
  });
});

// ── 4. regression: the stored failed scripts are rejected by the new check, and the Lincoln case gets the same contract ────────────────────────
test("regression: the recorded Parkwood evaluation script (197 words) is over the whole-script range and its article section far over the 33-word budget", async () => {
  const f = PARK.failedScript;
  assert.strictEqual(wc(f.narration), 197);
  const firstPara = f.narration.split(/(?<=[.!?…])\s+/);
  // Its article-led sentences (the council vote, the 508-home total and the agreement explanation) alone run well past 33 words.
  const articleSection = firstPara.slice(1, 4).join(" ");
  assert.ok(wc(articleSection) > 50, `article section ${wc(articleSection)} words`);
  await withDev(true, async () => {
    const check = planLib.checkComponents(parkwood(60), { captionText: f.narration, compositionPlan: null });
    assert.strictEqual(check.verified, false, "a script that records no components cannot be reported as compliant");
    assert.strictEqual(check.compliant, false);
  });
});

test("regression: the recorded Lincoln script (169 words) cannot be reported as compliant either; the Lincoln contract matches Parkwood's", async () => {
  await withDev(true, async () => {
    assert.strictEqual(wc(LINC.failedScript.narration), 169);
    assert.strictEqual(planLib.checkComponents(lincoln(60), { captionText: LINC.failedScript.narration }).compliant, false);
    const a = JSON.parse(planLib.buildUserMessage(lincoln(60))).narrative_contract, b = JSON.parse(planLib.buildUserMessage(parkwood(60))).narrative_contract;
    assert.deepStrictEqual(a, b, "the contract is the same for both cases: it carries no case wording");
  });
});

test("Lincoln through the full Planner path: a Lincoln-shaped script that meets the budgets is verified, one that does not is flagged", async () => {
  await withDev(true, async () => {
    const LN = {
      opening: "Builders can lower a buyer's payment in ways a resale seller cannot. Here's what that means for pricing in Lincoln.",
      article: "The article says a builder's rate buydown sits in the payment, not the price, and a resale seller's concessions are capped, so the two prices are not comparable.",
      trend: "September's Lincoln report: 2.7 months of inventory, seller's-market range. Homes sold at 95% of original list price, average days on market held steady near 49.",
      synthesis: "So the builder's sticker is not your competition. Buyers compare monthly payments, and a seller who can use part of a price cut toward financing help may reach them. Price to what buyers actually pay, and ask your agent what concessions your buyer's lender will allow.",
      cta: "Curious how this applies to your home? Ask me for a local view.",
    };
    const counts = Object.fromEntries(Object.entries(LN).map(([k, v]) => [k, wc(v)]));
    const { r, e } = await run(lincoln(60), async () => writerReply(LN, { article: { text: LN.article }, trend: { text: LN.trend }, synthesis: { text: LN.synthesis } }));
    assert.ifError(e);
    const f = r.narrative.lengthDiagnostics.components.final;
    assert.deepStrictEqual(f.counts, counts);
    assert.strictEqual(f.compliant, counts.opening <= 20 && counts.article <= 33 && counts.trend <= 35 && counts.synthesis >= 47 && counts.synthesis <= 50 && counts.cta <= 15);
    // every component over its cap is named in the diagnostics and in a nonblocking warning
    for (const x of f.over) assert.ok(r.warnings.some((w) => w.includes(`its budget is ${x.max}`)));
  });
});

test("Use My Script is untouched: the component check is a Planner-side diagnostic and warning only", () => {
  const src = require("fs").readFileSync(__dirname + "/../netlify/functions/lib/agent-marketing-plan-lib.js", "utf8");
  const i = src.indexOf("function componentWarnings"), j = src.indexOf("const componentLabel");
  assert.ok(i > 0);
  assert.doesNotMatch(src.slice(i, i + 900), /gateNarrative|blocks\.push|throw new Error/);
  assert.ok(j > 0);
});
