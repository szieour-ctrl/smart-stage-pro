"use strict";
// Nov 13, 2026 (Sam): targeted corrections, Test only. (1) sentence-scoped attribution in sourceRoleBlocks, (2) material numerical context in the length editor and
// planner wording, (3) the nonblocking narration-duration estimate, (4) the revised planner aim. Production is unchanged throughout.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");
const am = require("../netlify/functions/lib/agent-marketing-lib");

const TEST_DB = "https://test-ref.supabase.co";
async function withTest(on, fn) {
  const keep = { b: process.env.AGENT_MARKETING_B1_EVIDENCE, u: process.env.SUPABASE_URL };
  if (on) { process.env.AGENT_MARKETING_B1_EVIDENCE = "dev"; process.env.SUPABASE_URL = TEST_DB; } else { delete process.env.AGENT_MARKETING_B1_EVIDENCE; }
  try { return await fn(); } finally {
    if (keep.b === undefined) delete process.env.AGENT_MARKETING_B1_EVIDENCE; else process.env.AGENT_MARKETING_B1_EVIDENCE = keep.b;
    if (keep.u === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = keep.u;
  }
}

// ── 1. sentence-scoped attribution (Roseville topic as B2 stored it: the question carries the article's $354; the report supplies the market figures) ─────
const fig = (key, text) => ({ key, ref: "r1." + key, role: "area_statistic", text, label: key, period: "October 2026", areaLabel: "ROSEVILLE", scopeKind: "exact", partialPeriod: false, partialComparison: false });
const TOPIC = {
  id: "t2", question: "A monthly payment jumped $354 since last year—how does that reshape who can buy my home?", trendSignals: [], scope: "selected", origin: "web", reportFirst: false,
  reportFigures: [
    fig("count_active", "ROSEVILLE, October 2026: Active listings: 443 up 2.8% from September 2026; up 19.7% from October 2025 (Oct 1, 2026 to Oct 31, 2026)"),
    fig("count_closed", "ROSEVILLE, October 2026: Closed sales: 139 down 16.8% from September 2026; down 28.4% from October 2025 (Oct 1, 2026 to Oct 31, 2026)"),
    fig("sold_to_list", "ROSEVILLE, October 2026: Sold price as a percent of list price: 99.2% up 0.2% from September 2026; down 0.1% from October 2025 (Oct 1, 2026 to Oct 31, 2026)"),
    fig("months_supply", "ROSEVILLE, October 2026: Months of inventory: 3.2 months up 23.5% from September 2026; up 67.1% from October 2025 (Oct 1, 2026 to Oct 31, 2026)"),
  ],
  reportPrecedence: [], sources: [{ url: "https://example.org/a", kind: "article", role: "primary", title: "t" }],
};
const sc = (role, text) => ({ sourceRole: role, narrationExcerpt: text });
const blocked = (role, text) => withTest(true, async () => planLib.sourceRoleBlocks({ selected_topic: TOPIC }, { scenes: [sc(role, text)] }).length > 0);

test("mixed-source scenes: each figure may stand when its own sentence names its true source (either label)", async () => {
  assert.strictEqual(await blocked("article", "The article puts the payment jump at $354 a month, and my report shows active listings at 443."), false);
  assert.strictEqual(await blocked("data", "The article says buyers now pay $354 more a month. My October report shows closed sales fell to 139."), false);
  assert.strictEqual(await blocked("data", "According to the article, buyers now pay $354 more each month."), false);
  assert.strictEqual(await blocked("article", "My market data shows active listings at 443, while the author puts the payment jump at $354."), false);
  assert.strictEqual(await blocked("article", "The trend report puts closed sales at 139, down 28.4%."), false);
});

test("wrong-source detection is retained: no attribution, or attribution to the wrong source, is still flagged", async () => {
  assert.strictEqual(await blocked("data", "Buyers now pay $354 more each month."), true, "article figure, unattributed, data scene");
  assert.strictEqual(await blocked("data", "My market data shows buyers now pay $354 more each month."), true, "article figure presented as the agent's data");
  assert.strictEqual(await blocked("article", "The article says active listings are at 443."), true, "report figure credited to the article");
  assert.strictEqual(await blocked("article", "Active listings are at 443, up 19.7%."), true, "report figure, unattributed, article scene");
  assert.strictEqual(await blocked("article", "The article reports closed sales fell 28.4%. I keep a close eye on this."), true);
});

test("cues survive ordinary punctuation and ElevenLabs delivery tags", async () => {
  // audio tags before a sentence are ignored; the cue and the figure still meet in one sentence
  assert.strictEqual(await blocked("data", "[thoughtful] The article says buyers now pay $354 more. [emphasis] Closed sales fell to 139."), false);
  assert.strictEqual(await blocked("data", "[warm, inviting] Buyers now pay $354 more. [pause] The article says so."), true, "the cue is in the NEXT sentence: not carried over");
  // an ellipsis or em dash inside a sentence does not end it; a full stop does
  assert.strictEqual(await blocked("data", "According to the article, a buyer would pay about $3,408 a month in principal and interest… $354 more than a year ago."), false);
  assert.strictEqual(await blocked("data", "A buyer would pay about $3,408 a month—$354 more than a year ago, the article says."), false);
  assert.strictEqual(await blocked("data", "The article reports a payment of $3,408. $354 more than last year."), true, "attribution does not carry across a sentence boundary");
  // commas, parentheses and quotes around a cue
  assert.strictEqual(await blocked("data", "Buyers (according to the article, in dollar terms) now pay $354 more."), false);
  assert.strictEqual(await blocked("data", "“The article” is clear: $354 more a month."), false);
});

test("documented limitation: one sentence naming both sources and several figures cannot be resolved figure by figure", async () => {
  // Swapped figures in a single sentence that names both sources pass. This check reads wording, not meaning; it is not claim-level attribution verification.
  assert.strictEqual(await blocked("data", "The article says active listings are 443, and my report shows $354."), false);
});

test("the retained Roseville drafts: openings that state $354 stay blocked as data without attribution and pass as article or when attributed", async () => {
  const Z = "Did a $354 monthly jump just shrink your buyer pool? According to Freddie Mac data compiled by the Federal Reserve, the average 30-year fixed rate hit 7.33% in October—up from 6.25% a year ago. That means a buyer financing a median-priced Roseville home now pays about $3,408 a month in principal and interest… $354 more than a year ago.";
  assert.strictEqual(await blocked("data", Z), true);
  assert.strictEqual(await blocked("article", Z), false);
  const withoutHook = Z.slice(Z.indexOf("According to"));
  assert.strictEqual(await blocked("data", withoutHook), true, "the dollar sentence names no source");
  assert.strictEqual(await blocked("data", withoutHook.replace("That means a buyer", "The article says a buyer")), false, "attributed, it stands");
  assert.strictEqual(await blocked("data", Z.replace("Did a $354 monthly jump", "Did the article's $354 monthly jump").replace("That means a buyer", "The article says a buyer")), false, "an attributed hook stands too");
});

test("production never runs the role check", async () => {
  await withTest(false, async () => { assert.deepStrictEqual(planLib.sourceRoleBlocks({ selected_topic: TOPIC }, { scenes: [sc("data", "Buyers now pay $354 more.")] }), []); });
});

// ── 2. material numerical context ────────────────────────────────────────────────────────────────────────────────────────
test("length editor: a retained numerical example keeps what it measures, its assumption, comparison period and attribution", () => {
  for (const withRange of [true, false]) {
    const sys = planLib.lengthEditSystem(45, withRange);
    assert.match(sys, /A retained numerical example keeps what the figure measures \(a monthly payment difference stays a monthly payment difference, never a rate\), the material assumption it depends on \(for example 20% down, or principal and interest, for a monthly payment\), its comparison period and its source attribution: shorten around them, never cut them\./);
    assert.match(sys, /Any figure you keep must keep its correct value, period, measure, qualifier and attribution/, "the existing sentence is still there");
    assert.match(sys, /Do not add any fact, number, claim, caveat, qualification/, "the editor still adds nothing");
  }
});

test("planner rule 2h (Test): the assumption stays with the example and the figure says what it measures; no new gate", async () => {
  await withTest(true, async () => {
    const sys = planLib.buildSystemPrompt();
    assert.match(sys, /When a numerical example depends on a material stated assumption \(for example the down payment behind a monthly payment\), state that assumption with the example, and say what the figure measures \(a monthly payment difference is a payment difference, never a rate\)\./);
  });
  const prod = planLib.buildSystemPrompt();
  assert.ok(!/monthly payment difference/.test(prod), "production prompt untouched");
});

// ── 3. duration advisory ─────────────────────────────────────────────────────────────────────────────────────────────────
test("duration advisory: the observed 2.3-2.8 words-a-second range, the word count and the target", () => {
  assert.deepStrictEqual(am.PACE_WORDS_PER_SECOND, [2.3, 2.8]);
  assert.deepStrictEqual(am.narrationEstimate(134), [48, 58]);
  assert.strictEqual(am.durationAdvisory(134, 45), "134 words · Estimated narration 48–58 seconds · Target 45 seconds.");
  assert.deepStrictEqual(am.narrationEstimate(0), [0, 0]);
});

const TAGS = ["[conversational]", "[thoughtful]", "[emphasis]", "[confident]", "[warm]"];
const ROLE_OF = ["local_hook", "tension", "insight", "advice", "advice"];
const scene = (text, i, last) => ({ role: i === last ? "cta" : ROLE_OF[i], narration_excerpt: text, purpose: "p" + i, visual_source: i < 3 ? "GPT_IMAGE_2_CONCEPT" : (i === last ? "BRAND_CARD" : "CONCEPT_REUSE"),
  visual_brief: "brief " + i, reuse_of_scene: i < 3 || i === last ? null : 0, card_text: i === last ? "Ask me for a local view" : null,
  ai_generation_prompt: i < 3 ? "Photorealistic editorial tabletop with architectural home models, soft light, no people, no text" : null, camera_motion: "push_in",
  framing_9x16: "keep homes visible", framing_16x9: "keep wide street", text_safe_placement: "lower middle", source_role: "data" });
const reply = (texts) => JSON.stringify({ editorial_angle: "Higher payments narrow the buyer pool.", hook: texts[0], narration_with_audio_tags: texts.map((x, i) => `${TAGS[i % TAGS.length]} ${x}`).join(" "),
  scenes: texts.map((t, i) => scene(t, i, texts.length - 1)), cta_suggestion: "Ask me.", claims_to_verify: [], missing_agent_inputs: [] });
// 5 scenes: a short script (under the 105-word range), which stays nonblocking and still carries the estimate
const IN_RANGE = Array.from({ length: 5 }, (_, i) => ["Buyers have more choices now and that changes how a prepared home gets priced here in this market today.", "Payments are higher so fewer buyers can reach the same price and that shapes every offer that comes in now.", "Homes that are priced well still sell quickly because careful buyers move fast on those that look right.", "A home priced just above what today's buyer can reach tends to sit while the better priced homes go first.", "I keep a close eye on these shifts and I am happy to talk through where your own home would land today."][i]);
const proj = { template: "local_market_insider", duration_sec: 45, formats: ["9x16", "16x9"], intake: { angle: "neighborhood", market: "Roseville, CA", audience: "Home sellers", issue: "Supply and buyer demand", action: "Understand the trade-off", observation: "Buyers have more choices." } };

test("a Test plan carries the advisory beside the word count and the selected target (a script under the range included, which stays advisory); production does not", async () => {
  const test_ = await withTest(true, async () => planLib.generatePlan({ project: proj, anthropicKey: "k", callFn: async () => reply(IN_RANGE) }));
  const n = test_.narrative.wordCount;
  assert.ok(n > 0);
  assert.ok(test_.warnings.includes(am.durationAdvisory(n, 45)), "advisory present");
  const prod = await withTest(false, async () => planLib.generatePlan({ project: proj, anthropicKey: "k", callFn: async () => reply(IN_RANGE) }));
  assert.ok(!prod.warnings.some((w) => /Estimated narration/.test(w)), "production has no advisory");
});

test("editing a script in Test returns the advisory; the voice speed and the narration are never changed by it", async () => {
  const text = IN_RANGE.join(" ");
  const t = await withTest(true, async () => am.validateNarrative({ narrationTagged: text, captionText: text, scenes: [] }, 45));
  if (t.error) throw new Error(t.error);
  assert.ok(t.warnings.includes(am.durationAdvisory(am.countWords(text), 45)));
  assert.strictEqual(t.narrative.narrationTagged, text, "the narration is untouched");
  const p = await withTest(false, async () => am.validateNarrative({ narrationTagged: text, captionText: text, scenes: [] }, 45));
  assert.ok(!(p.warnings || []).some((w) => /Estimated narration/.test(w)), "production unchanged");
  const tts = require("fs").readFileSync(require.resolve("../netlify/functions/agent-marketing-prepare-background"), "utf8");
  assert.ok(!/\bspeed\b/.test(tts.replace(/\/\/.*$/gm, "")), "no ElevenLabs speed change");
});

test("the page and schema: the estimate appears only when the server (Test) offers the pace range", () => {
  const project = fs.readFileSync(require.resolve("../netlify/functions/agent-marketing-project"), "utf8");
  assert.match(project, /\.\.\.\(String\(process\.env\.AGENT_MARKETING_B1_EVIDENCE \|\| ""\)\.trim\(\)\.toLowerCase\(\) === "dev" \? \{ paceWordsPerSecond: am\.PACE_WORDS_PER_SECOND \} : \{\}\)/);
  const page = fs.readFileSync(require("path").join(__dirname, "..", "agent-marketing.html"), "utf8");
  assert.match(page, /var pace = state\.schema\.paceWordsPerSecond;/);
  assert.match(page, /if \(pace && pace\.length === 2 && w > 0\)/);
});

// ── 4. planner aim ────────────────────────────────────────────────────────────────────────────────────────────────────────
test("planner aim: the authorized wording, no per-figure word assumption", async () => {
  const u = await withTest(true, async () => JSON.parse(planLib.buildUserMessage(proj)));
  assert.strictEqual(u.spoken_word_aim, "105-110 spoken words. Write to the specified duration from the first draft. Treat the target word count as a production constraint, not a suggestion. Prioritize the hook, central Realtor interpretation, decisive supporting evidence, and homeowner takeaway. Use only the numerical examples necessary to communicate that argument. Preserve material assumptions and source attribution. Do not depend on the length editor to remove an oversized first draft.");
  assert.ok(!/four spoken words|per figure/i.test(u.spoken_word_aim));
});
