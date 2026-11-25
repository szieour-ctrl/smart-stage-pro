"use strict";
// Nov 15, 2026 (Sam; Test only): the recurring "The planner returned 5 scenes; 6–8 are needed" failure.
// Option 2 has five narration components; the 60-second storyboard has 6–8 scenes. They are different things, and the Planner contract and the one structural
// retry now say so. A structural failure also keeps restricted diagnostics (counts, the error and the clipped raw reply) so a generation failure can be told
// from a normalization failure. Offline only: a stand-in model and a fake database. No paid call, no network.
const test = require("node:test");
const assert = require("node:assert");

const U1 = "11111111-1111-4111-8111-111111111111";
const rows = [];
const libPath = require.resolve("../netlify/functions/lib/marketing-profile-lib");
const authPath = require.resolve("../netlify/functions/lib/reel-auth-lib");
function fakeSupabase(method, table, body, qs = "") {
  if (table === "agent_marketing_jobs" && method === "GET") return Promise.resolve({ status: 200, data: [] });
  const q = new URLSearchParams(qs.replace(/^\?/, ""));
  const idEq = (q.get("id") || "").replace("eq.", "");
  const match = rows.filter((r) => !idEq || r.id === idEq);
  if (method === "GET") return Promise.resolve({ status: 200, data: match });
  if (method === "PATCH") { match.forEach((r) => Object.assign(r, body)); return Promise.resolve({ status: 200, data: match }); }
  throw new Error("unexpected " + method);
}
require.cache[libPath] = { id: libPath, filename: libPath, loaded: true, exports: { supabase: fakeSupabase } };
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { requireUser: async () => ({ user: { id: U1 } }) } };
const { handler } = require("../netlify/functions/agent-marketing-project");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");
const runLib = require("../netlify/functions/lib/agent-marketing-plan-run-lib");
const am = require("../netlify/functions/lib/agent-marketing-lib");
const PARK = require("./fixtures/parkwood-option2-t1.json");
const LINC = require("./fixtures/lincoln-option2-t1.json");

async function withDev(on, fn) {
  const prev = process.env.AGENT_MARKETING_B1_EVIDENCE;
  if (on) process.env.AGENT_MARKETING_B1_EVIDENCE = "dev"; else delete process.env.AGENT_MARKETING_B1_EVIDENCE;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.AGENT_MARKETING_B1_EVIDENCE; else process.env.AGENT_MARKETING_B1_EVIDENCE = prev; }
}
const intake = { angle: "", market: "Lincoln, CA", audience: "Home sellers", issue: "", action: "Ask for a local perspective", observation: "" };
const project = (topic, dur, b2) => ({ template: "local_market_insider", duration_sec: dur || 60, formats: ["9x16", "16x9"], intake, selected_topic: { ...topic, b2: { ...topic.b2, ...(b2 || {}) } } });
const FACTS = " Article facts: the Lincoln City Council adopted the Parkwood development agreement on Oct. 27; 122 single-family homes and 4.2 acres of parks; a final map comes next.";
const parkwood = (dur, b2) => project({ ...PARK.topic, whyItMatters: PARK.topic.whyItMatters + FACTS }, dur, b2);
const lincoln = (dur, b2) => project(LINC.topic, dur, b2);

// The hand-composed script that meets the component budgets (20 / 33 / 35 / 48 / 15 = 151), counted the way the app counts.
const PW = {
  opening: "Hundreds of new homes are approved for Lincoln's east side. Here's what Parkwood's approval really means for nearby resale sellers.",
  article: "Lincoln's council adopted Parkwood's development agreement October 27: 122 homes, 4.2 acres of parks. It's the last vote before construction paperwork, but the terms aren't public, and a final map comes next.",
  trend: "September's report: 2.7 months of inventory, seller's-market range, down 10.1% from August. Homes sold at 95% of original list price, days on market held near 49, and closed sales are up 4.5%.",
  synthesis: "Lean supply is your leverage today, and Parkwood is the clock on it. It still needs a final map before lots can be sold, so you have a window. If you're planning to sell, use it, price to what homes close for, and expect comparisons with new construction.",
  cta: "Thinking of selling near Parkwood? Ask me what timing and price make sense for you.",
};
const TAGS = ["[conversational]", "[thoughtful]", "[emphasis]", "[confident]", "[warm]", "[calm]", "[calm]", "[warm]"];
const ROLES = ["local_hook", "tension", "insight", "advice", "advice", "advice", "advice", "cta"];
const scene = (text, i, last, role) => { const gpt = last > 4 ? 4 : last > 3 ? 3 : 2;
  return { role: i === last ? "cta" : ROLES[i], narration_excerpt: text, purpose: "purpose " + i, visual_source: i < gpt ? "GPT_IMAGE_2_CONCEPT" : (i === last ? "BRAND_CARD" : "CONCEPT_REUSE"),
    visual_brief: "brief " + i, reuse_of_scene: i < gpt || i === last ? null : 1, card_text: i === last ? "Ask me for a local view" : null,
    ai_generation_prompt: i < gpt ? "Photorealistic editorial tabletop with architectural home models, soft light, no people, no text, wide composition" : null,
    camera_motion: "push_in", framing_9x16: "keep homes visible", framing_16x9: "keep wide street", text_safe_placement: "lower middle", source_role: role }; };
const sentences = (t) => t.split(/(?<=[.!?])\s+/);
/** The script cut into `n` scenes at sentence boundaries: n = 5 reproduces the failure (one scene per component), 6 and 8 are valid. */
function textsFor(c, n) {
  const syn = sentences(c.synthesis);
  const six = [c.opening, c.article, c.trend, syn.slice(0, -1).join(" "), syn[syn.length - 1], c.cta];
  if (n === 5) return [c.opening, c.article, c.trend, c.synthesis, c.cta];
  if (n === 6) return six;
  if (n === 8) return [...sentences(c.opening), c.article, c.trend, ...syn, c.cta].slice(0, 8);
  throw new Error("n");
}
function reply(c, n, opts) {
  const texts = textsFor(c, n), last = texts.length - 1;
  const sc = texts.map((t, i) => scene(t, i, last, i < 2 ? "article" : "data"));
  const narration = sc.map((s, i) => `${TAGS[i]} ${s.narration_excerpt}`).join(" ");
  return JSON.stringify({
    composition_plan: { central_tension: "New homes are coming, supply is lean", realtor_conclusion: "Use the window", essential_findings: ["A1-F5"],
      components: { article: { text: c.article, words: 33 }, trend: { text: c.trend, words: 35 }, synthesis: { text: c.synthesis, words: 48 } } },
    editorial_angle: "Parkwood adds supply later; lean supply favors sellers now.", hook: sentences(c.opening)[0], narration_with_audio_tags: narration, scenes: sc,
    cta_suggestion: "Ask me.", claims_to_verify: [], missing_agent_inputs: [], ...(opts || {}) });
}
const run = (p, callFn) => planLib.generatePlan({ project: p, anthropicKey: "k", callFn }).then((r) => ({ r }), (e) => ({ e }));
const wc = (t) => am.countWords(t);

// ── 1. Option 2 keeps five mandatory narration components, and the Planner is separately told to return 6–8 scenes ──────────────────────────
test("Option 2 still has the five mandatory components with the same budgets: 20 / 33 / 35 / 47-50 / 15", async () => {
  await withDev(true, async () => {
    const c = JSON.parse(planLib.buildUserMessage(parkwood(60))).narrative_contract;
    assert.deepStrictEqual(c.components.map((x) => [x.component, x.min_words || null, x.max_words || x.words]), [["opening", null, 20], ["article", null, 33], ["trend", null, 35], ["synthesis", 47, 50], ["cta", null, 15]]);
    assert.strictEqual(c.target_words, 150);
  });
});

test("the Planner contract separately states 6-8 scenes and that the five components are not five scenes", async () => {
  await withDev(true, async () => {
    const msg = JSON.parse(planLib.buildUserMessage(parkwood(60)));
    assert.deepStrictEqual(msg.scene_count_range, [6, 8]);
    const rule = msg.narrative_contract.scene_rule;
    assert.match(rule, /govern the narration and its word budgets/);
    assert.match(rule, /NOT five scenes/);
    assert.match(rule, /6-8 scenes/);
    assert.match(rule, /A component may span several scenes/);
    assert.match(rule, /natural narration and visual pacing/);
    // the contract names no subject or statistic
    assert.doesNotMatch(rule, /Lincoln|Parkwood|\d%|\$/);
  });
});

test("the scene rule belongs to Option 2 at 60 seconds only: Options 1 and 3, 45 seconds and production keep their contracts", async () => {
  await withDev(true, async () => {
    for (const mode of ["trend_report", "article_editorial"]) assert.ok(!("scene_rule" in JSON.parse(planLib.buildUserMessage(lincoln(60, { mode }))).narrative_contract), mode);
    assert.ok(!("scene_rule" in JSON.parse(planLib.buildUserMessage(lincoln(45))).narrative_contract));
  });
  await withDev(false, async () => assert.ok(!("narrative_contract" in JSON.parse(planLib.buildUserMessage(lincoln(60))))));
  const prod = planLib.buildSystemPrompt({});
  assert.strictEqual(require("crypto").createHash("sha256").update(prod).digest("hex"), "25f3118fed1b9726fc4dc78b16dcc92233cef785d3c074ef89a6ee7aaf7b0495");
});

// ── 2. the structural retry repeats the scene range and keeps the narration and the budgets ─────────────────────────────────────────────────
test("a 5-scene reply gets ONE retry that states the 6-8 requirement, the component budgets and the narration to keep; the 6-scene retry succeeds", async () => {
  await withDev(true, async () => {
    const calls = [];
    const { r, e } = await run(parkwood(60), async (s, u) => { calls.push(u); return calls.length === 1 ? reply(PW, 5) : reply(PW, 6); });
    assert.ifError(e);
    assert.strictEqual(calls.length, 2, "one retry, no third call, no editor");
    const fix = calls[1];
    assert.match(fix, /The planner returned 5 scenes; 6–8 are needed/);
    assert.match(fix, /MUST contain 6-8 scenes/);
    assert.match(fix, /not five scenes: a component may span several scenes/);
    assert.match(fix, /article at most 33 words, Market Trend at most 35, Realtor synthesis 47-50, opening 20, call to action 15/);
    assert.match(fix, /keep composition_plan\.components, and change only how the narration is divided into scenes/);
    assert.ok(fix.includes(PW.article) && fix.includes(PW.trend) && fix.includes(PW.synthesis), "the previous narration is carried in full");
    // the corrected reply is a valid plan: 6 scenes, the narration and the component budgets intact
    assert.strictEqual(r.narrative.scenes.length, 6);
    assert.strictEqual(r.narrative.wordCount, 151);
    const d = r.narrative.lengthDiagnostics;
    assert.strictEqual(d.structuralRetry, true);
    assert.deepStrictEqual(d.components.final.counts, { opening: 20, article: 33, trend: 35, synthesis: 48, cta: 15 });
    assert.strictEqual(d.components.final.compliant, true);
    assert.strictEqual(d.edit.ran, false, "correcting the scene count did not trigger the length editor");
  });
});

test("a retry that returns 8 scenes is also accepted, and the retry keeps the narration word for word", async () => {
  await withDev(true, async () => {
    let n = 0;
    const { r, e } = await run(parkwood(60), async () => (++n === 1 ? reply(PW, 5) : reply(PW, 8)));
    assert.ifError(e);
    assert.strictEqual(r.narrative.scenes.length, 8);
    assert.strictEqual(r.narrative.captionText, am.stripAudioTags(r.narrative.narrationTagged));
    assert.strictEqual(r.narrative.wordCount, 151);
  });
});

test("existing successful six-scene outputs remain valid: one call, no retry, no failure record", async () => {
  await withDev(true, async () => {
    let n = 0;
    const { r, e } = await run(parkwood(60), async () => { n++; return reply(PW, 6); });
    assert.ifError(e);
    assert.strictEqual(n, 1);
    assert.strictEqual(r.narrative.scenes.length, 6);
    assert.strictEqual(r.narrative.lengthDiagnostics.structuralRetry, false);
  });
});

test("other structural errors keep the existing retry message; the scene range is added only for a wrong scene count", () => {
  const p = parkwood(60);
  const other = planLib.structuralRetryMessage({ user: "U", err: new Error("Scene 2 has no narration excerpt"), project: p });
  assert.match(other, /Every scene MUST have a non-empty narration_excerpt/);
  assert.doesNotMatch(other, /MUST contain/);
});

test("the retry is shared by every reel pathway: it states the range but no component budgets outside Option 2", async () => {
  await withDev(true, async () => {
    const err = new Error("The planner returned 5 scenes; 6–8 are needed");
    const opt1 = planLib.structuralRetryMessage({ user: "U", err, project: lincoln(60, { mode: "trend_report" }) });
    assert.match(opt1, /MUST contain 6-8 scenes/);
    assert.doesNotMatch(opt1, /component word budgets|at most 33/);
    const s45 = planLib.structuralRetryMessage({ user: "U", err: new Error("The planner returned 4 scenes; 5–6 are needed"), project: lincoln(45) });
    assert.match(s45, /MUST contain 5-6 scenes/);
    assert.doesNotMatch(s45, /at most 33/);
  });
});

// ── 3. structural failures keep diagnostics ─────────────────────────────────────────────────────────────────────────────────────────────────
test("two 5-scene replies fail after exactly two calls, and the error carries counts, the structural error and the clipped raw replies", async () => {
  await withDev(true, async () => {
    let n = 0;
    const { r, e } = await run(parkwood(60), async () => { n++; return reply(PW, 5); });
    assert.ok(!r);
    assert.strictEqual(n, 2, "no third call");
    assert.match(e.message, /The planner returned 5 scenes; 6–8 are needed/);
    const f = e.plannerFailure;
    assert.ok(f && f.at && f.duration_sec === 60);
    assert.strictEqual(f.attempts.length, 2);
    for (const a of f.attempts) {
      assert.match(a.error, /5 scenes/);
      assert.strictEqual(a.sceneCount, 5);
      assert.strictEqual(a.narrationWords, 151);
      assert.strictEqual(a.sceneWords.length, 5);
      assert.deepStrictEqual(a.components.counts, { opening: 20, article: 33, trend: 35, synthesis: 48, cta: 15 });
      assert.strictEqual(a.components.compliant, true, "the narration was fine: this was a generation failure, not a component failure");
    }
    assert.ok(!("rawReply" in f.attempts[0]));
    assert.ok(JSON.parse(f.attempts[1].rawReply).scenes.length === 5, "the final raw reply is kept");
    assert.ok(JSON.parse(f.firstReply).scenes.length === 5, "the first raw reply is kept");
  });
});

test("raw replies are clipped, an unparseable reply is kept, and no key or prompt text is in the diagnostics", async () => {
  await withDev(true, async () => {
    const big = "x".repeat(40000);
    const { e } = await run(parkwood(60), async () => `no json here ${big}`);
    const f = e.plannerFailure;
    assert.ok(f.attempts[1].rawReply.length <= 16000 && f.firstReply.length <= 16000);
    assert.match(f.attempts[1].error, /JSON/);
    assert.strictEqual(f.attempts[1].sceneCount, undefined);
    const text = JSON.stringify(f);
    assert.doesNotMatch(text, /anthropicKey|x-api-key|"k"|narrative_contract|scene_count_range/);
  });
});

test("when the retry succeeds nothing is stored as a failure; production and Test-off record nothing", async () => {
  await withDev(false, async () => {
    const { e } = await run(parkwood(60), async () => reply(PW, 5));
    assert.ok(e && !e.plannerFailure, "production: no restricted diagnostics");
  });
  await withDev(true, async () => {
    let n = 0;
    const { r } = await run(parkwood(60), async () => (++n === 1 ? reply(PW, 5) : reply(PW, 6)));
    assert.ok(!("plannerFailure" in r.narrative));
  });
});

test("a cut-off reply, a gate block and other non-structural errors are not retried and keep their own errors", async () => {
  await withDev(true, async () => {
    let n = 0;
    const { e } = await run(parkwood(60), async () => { n++; throw new Error("Planner response was cut off"); });
    assert.strictEqual(n, 1);
    assert.match(e.message, /cut off/);
    assert.ok(!e.plannerFailure);
  });
});

// ── 4. storage and access: kept in the database, never sent to the subscriber ───────────────────────────────────────────────────────────────
test("runPlan writes plannerFailure into the error narrative, and the project endpoint never returns it", async () => {
  process.env.AGENT_MARKETING_ENABLED = "true";
  await withDev(true, async () => {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
    rows.length = 0;
    rows.push({ id, user_id: U1, template: "local_market_insider", duration_sec: 60, formats: ["9x16", "16x9"], intake, selected_topic: (({ b1, ...t }) => t)(parkwood(60).selected_topic), status: "draft", created_at: "t", updated_at: "t",   // no b1 record: the legacy Planner path (the complete-source Writer needs one)
      narrative: { status: "planning", startedAt: Date.now(), attempts: 1, intakeHash: "h" } });
    const out = await runLib.runPlan({ id, userId: U1, deps: { supabase: fakeSupabase, env: process.env, anthropicKey: "k", callFn: async () => reply(PW, 5), withEvidence: async (p) => p } });
    assert.strictEqual(out.state, "error");
    const stored = rows[0].narrative;
    assert.strictEqual(stored.status, "error");
    assert.strictEqual(stored.attempts, 1);
    assert.match(stored.error, /5 scenes/);
    assert.strictEqual(stored.plannerFailure.attempts.length, 2);
    assert.ok(stored.plannerFailure.attempts[1].rawReply, "stored for restricted Test diagnosis");

    const res = await handler({ httpMethod: "GET", headers: {}, body: null, queryStringParameters: { id } });
    const body = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(body.project.narrative.status, "error");
    assert.match(body.project.narrative.error, /5 scenes/);
    assert.ok(!("plannerFailure" in body.project.narrative), "not sent to the page");
    assert.doesNotMatch(res.body, /rawReply|plannerFailure/);
    const list = await handler({ httpMethod: "GET", headers: {}, body: null, queryStringParameters: null });
    assert.doesNotMatch(list.body, /rawReply|plannerFailure/);
  });
});

// ── 5. the cause found while writing these tests ────────────────────────────────────────────────────────────────────────────────────────────
test("a wrong scene count is retried: the retry pattern matches the exact error text for every duration", async () => {
  await withDev(true, async () => {
    for (const [dur, wrong] of [[60, 5], [60, 9], [45, 4], [45, 7], [30, 3], [30, 5]]) {
      let n = 0;
      const p = lincoln(dur, dur === 60 ? { mode: "trend_report" } : undefined);
      const texts = ["One. ", "Two. ", "Three. ", "Four. ", "Five. ", "Six. ", "Seven. ", "Eight. ", "Nine. "];
      const rep = (k) => JSON.stringify({ narration_with_audio_tags: texts.slice(0, k).map((t) => `[calm] ${t.trim()}`).join(" "),
        scenes: texts.slice(0, k).map((t, i) => scene(t.trim(), i, k - 1, "data")) });
      const { e } = await run(p, async () => { n++; return rep(wrong); });
      assert.strictEqual(n, 2, `${dur}s with ${wrong} scenes was retried once`);
      assert.match(e.message, /scenes?; [\d–-]+ (is|are) needed/);
    }
  });
});
