const test = require("node:test");
const assert = require("node:assert");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");
const am = require("../netlify/functions/lib/agent-marketing-lib");

const intake = {
  angle: "neighborhood", market: "Roseville, CA", audience: "Home sellers", issue: "Supply and buyer demand", action: "Understand the trade-off",
  observation: "If your resale home is near new construction it can bring more interested buyers. It can also create competition for the resale home, and builders often have incentives and rate buy-downs.",
};
const project = { template: "local_market_insider", duration_sec: 45, formats: ["9x16", "16x9"], intake };

const excerpts = [
  "Is new construction helping or hurting your resale home?",
  "Here's what I see near new communities. More interested buyers come into the neighborhood, and that can help.",
  "But it also puts your home next to brand new competition.",
  "Builders often have incentives and rate buydowns, which changes how buyers compare.",
  "So don't judge your value on resale listings alone.",
  "Compare the full picture, and ask me for a local perspective.",
];
const tagged = `[conversational] ${excerpts[0]} [thoughtful] ${excerpts[1]} ${excerpts[2]} [emphasis] ${excerpts[3]} [confident] ${excerpts[4]} [warm] ${excerpts[5]}`;
const scene = (i, kind) => { const gpt = kind === true; const k = gpt ? "GPT_IMAGE_2_CONCEPT" : (kind || "CONCEPT_REUSE"); return {
  role: ["local_hook", "tension", "insight", "comparison", "advice", "cta"][i], narration_excerpt: excerpts[i], purpose: "p" + i,
  visual_source: k, visual_brief: "brief " + i, reuse_of_scene: k === "CONCEPT_REUSE" ? 2 : null, card_text: k === "BRAND_CARD" ? "Ask me for a local view" : null,
  authentic_photo_request: k !== "AUTHENTIC_AGENT_ASSET" ? null : { best_image: "A real Roseville street of established homes", should_contain: "Street context, room to crop", avoid: "Mislabeling a neighborhood", if_unavailable: "Substitute an accurate photo" },
  ai_generation_prompt: gpt ? "Photorealistic editorial tabletop with two architectural home models, soft light, no people, no text, wide composition" : null,
  camera_motion: "push_in", framing_9x16: "keep homes visible", framing_16x9: "keep wide street", text_safe_placement: "lower middle",
}; };
const goodPlan = () => ({
  editorial_angle: "New construction is both an advantage and a challenge.", hook: excerpts[0], narration_with_audio_tags: tagged,
  scenes: [scene(0, true), scene(1, true), scene(2, "CONCEPT_REUSE"), scene(3, true), scene(4, "AUTHENTIC_AGENT_ASSET"), scene(5, "BRAND_CARD")],
  cta_suggestion: "Ask me for a local perspective.", claims_to_verify: ["Which builders currently offer incentives"], missing_agent_inputs: [],
});

test("a good plan is normalized: captions derived, scenes timed to the duration, shopping list kept", async () => {
  const out = await planLib.generatePlan({ project, anthropicKey: "k", callFn: async () => "```json\n" + JSON.stringify(goodPlan()) + "\n```" });
  const n = out.narrative;
  assert.strictEqual(n.source, "claude");
  assert.ok(!/[\[\]]/.test(n.captionText));
  assert.strictEqual(n.scenes.length, 6);
  assert.strictEqual(n.scenes.filter((s) => s.visualSource === "GPT_IMAGE_2_CONCEPT").length, 3); // one wide image per scene: a 45s Reel gets 3-4 different images
  assert.ok(n.scenes.filter((s) => s.visualSource === "GPT_IMAGE_2_CONCEPT").every((s) => s.aiGenerationPrompt));
  assert.strictEqual(n.scenes[2].reuseOfScene, 1); // "scene 2" in the plan = index 1, the first concept image
  assert.strictEqual(n.scenes[5].cardText, "Ask me for a local view");
  assert.strictEqual(n.scenes[4].optional, true);
  assert.ok(Math.abs(n.scenes.reduce((a, s) => a + s.provisionalSeconds, 0) - 45) < 0.6);
  assert.deepStrictEqual(n.cta, { text: "Ask me for a local perspective.", source: "claude" });
  assert.ok(n.missingAgentInputs.some((m) => /Optional: one real photo/.test(m)));
  assert.strictEqual(out.gate.ok, true);
});

test("unknown or excess audio tags are removed", () => {
  const t = planLib.sanitizeTags("[whispers] Hi [warm] there [emphasis] a [confident] b [thoughtful] c [conversational] d [warm] e [warm] f");
  assert.ok(!/whispers/.test(t));
  assert.ok((t.match(/\[/g) || []).length <= 8);
});

test("[pause] is an allowed tag and stays where the planner put it", () => {
  const t = planLib.sanitizeTags("[conversational] Hello there. [pause] So what does it show? [PAUSE] And [whispers] more.");
  assert.strictEqual(t, "[conversational] Hello there. [pause] So what does it show? [pause] And more.");
});

test("the planner is told to write for the ear, with pauses, ellipses and joined thoughts", () => {
  const sys = planLib.buildSystemPrompt();
  assert.match(sys, /ElevenLabs v4/);
  assert.match(sys, /one person talking to one neighbor/);
  assert.match(sys, /\[pause\]/);
  assert.match(sys, /ellipsis/);
  assert.doesNotMatch(sys, /Write for the ear: short sentences/);
  assert.match(sys, /<N> days/, "the style example uses placeholders, never real figures");
});

test("extra generated images are demoted to concept re-use instead of failing or adding paid generations", () => {
  const p = goodPlan();
  p.scenes = p.scenes.map((s) => ({ ...s, visual_source: "GPT_IMAGE_2_CONCEPT", ai_generation_prompt: "x" }));
  const n = planLib.normalizePlan(p, project).narrative;
  assert.strictEqual(n.scenes.filter((s) => s.visualSource === "GPT_IMAGE_2_CONCEPT").length, 4); // 45s allows at most 4 generated images
  assert.ok(n.scenes.filter((s) => s.visualSource === "CONCEPT_REUSE").every((s) => n.scenes[s.reuseOfScene].aiGenerationPrompt));
  // 3 concept images + 1 agent scene = 4 generated (the limit): the agent scene is kept, not turned into a concept image
  const q = goodPlan();
  q.scenes[2] = { ...q.scenes[2], visual_source: "AGENT_SCENE", reuse_of_scene: null, ai_generation_prompt: "Agent at a desk, bright room" };
  const m = planLib.normalizePlan(q, project).narrative;
  assert.strictEqual(m.scenes.filter((s) => ["GPT_IMAGE_2_CONCEPT", "AGENT_SCENE"].includes(s.visualSource)).length, 4);
  assert.strictEqual(m.scenes[2].visualSource, "AGENT_SCENE");
});

test("wrong scene count or a missing image prompt make the plan unusable", () => {
  const p1 = goodPlan(); p1.scenes = p1.scenes.slice(0, 3);
  assert.throws(() => planLib.normalizePlan(p1, project), /scenes/);
  const p3 = goodPlan(); p3.scenes[1].ai_generation_prompt = "";
  assert.throws(() => planLib.normalizePlan(p3, project), /image prompt/);
});

test("the gate rejects an invented result, an invented number and a property-sale phrase from Claude", async () => {
  for (const bad of ["My clients sold in three days.", "Prices rose 12 percent last year.", "Just listed this week near you."]) {
    const plan = goodPlan();
    plan.narration_with_audio_tags = tagged + " " + bad;
    plan.scenes[5].narration_excerpt = excerpts[5] + " " + bad;
    await assert.rejects(planLib.generatePlan({ project, anthropicKey: "k", callFn: async () => JSON.stringify(plan) }), /blocked by Agent Marketing's check:\n- /);
  }
});

test("a property-sale concept in an image prompt is rejected too", async () => {
  const plan = goodPlan(); plan.scenes[1].ai_generation_prompt = "A yard sign saying Just Listed with an open house banner";
  await assert.rejects(planLib.generatePlan({ project, anthropicKey: "k", callFn: async () => JSON.stringify(plan) }), /blocked by Agent Marketing's check/);
});

test("non-JSON replies fail cleanly", async () => {
  await assert.rejects(planLib.generatePlan({ project, anthropicKey: "k", callFn: async () => "Sorry, I can't." }), /JSON/);
});

test("the prompt carries the rules and never includes the agent's profile or contact details", () => {
  const sys = planLib.buildSystemPrompt();
  assert.match(sys, /NEVER invent numbers/);
  assert.match(sys, /NOT a property advertisement/);
  const user = JSON.parse(planLib.buildUserMessage(project));
  assert.deepStrictEqual(user.spoken_word_range, am.WORD_TARGETS[45]);
  assert.deepStrictEqual(user.scene_count_range, [5, 6]);
  assert.deepStrictEqual(user.gpt_image_2_scene_count, [3, 4]);
  assert.ok(!/dre|license|phone|email/i.test(JSON.stringify(user)));
});

test("intake hash changes only when the answers change", () => {
  assert.strictEqual(planLib.intakeHash(intake), planLib.intakeHash({ ...intake }));
  assert.notStrictEqual(planLib.intakeHash(intake), planLib.intakeHash({ ...intake, observation: intake.observation + " More." }));
});

test("a plan with no real photos at all is fine, and extra optional scenes fall back to re-using a concept image", () => {
  const p = goodPlan(); p.scenes[4] = scene(4, "CONCEPT_REUSE");
  const n = planLib.normalizePlan(p, project).narrative;
  assert.ok(!n.scenes.some((s) => s.visualSource === "AUTHENTIC_AGENT_ASSET"));
  assert.ok(!n.missingAgentInputs.some((m) => /Optional: one real photo/.test(m)));
  const q = goodPlan(); q.scenes[2] = scene(2, "AUTHENTIC_AGENT_ASSET"); // a second optional photo exceeds the limit of 1
  const m = planLib.normalizePlan(q, project).narrative;
  assert.strictEqual(m.scenes.filter((s) => s.visualSource === "AUTHENTIC_AGENT_ASSET").length, 1);
  assert.strictEqual(m.scenes[4].visualSource, "CONCEPT_REUSE"); // the later one is demoted
});

test("an agent-in-scene image counts toward the included images, needs a prompt, and is limited to one", () => {
  const p = goodPlan(); p.scenes[1] = scene(1, "AGENT_SCENE"); p.scenes[1].ai_generation_prompt = "agent on a quiet street, relaxed";
  const n = planLib.normalizePlan(p, project).narrative;
  assert.strictEqual(n.scenes[1].visualSource, "AGENT_SCENE"); assert.ok(n.scenes[1].aiGenerationPrompt);
  const two = goodPlan(); two.scenes[1] = scene(1, "AGENT_SCENE"); two.scenes[3] = scene(3, "AGENT_SCENE");
  two.scenes[1].ai_generation_prompt = two.scenes[3].ai_generation_prompt = "agent scene";
  const m = planLib.normalizePlan(two, project).narrative;
  assert.deepStrictEqual(m.scenes.filter((s) => s.visualSource === "AGENT_SCENE").length, 1);
  assert.strictEqual(m.scenes[3].visualSource, "GPT_IMAGE_2_CONCEPT"); // the second one becomes a plain concept image
  const noPrompt = goodPlan(); noPrompt.scenes[1] = scene(1, "AGENT_SCENE"); noPrompt.scenes[1].ai_generation_prompt = "";
  assert.throws(() => planLib.normalizePlan(noPrompt, project), /image prompt/);
});

test("a re-used scene that names no valid source falls back to the nearest EARLIER generated image, not blindly scene 1; the rules tell the planner to describe only what the source shows", () => {
  const p = goodPlan(); p.scenes[2].reuse_of_scene = null; // reuse scene at index 2, earlier generated images at 0 and 1
  assert.strictEqual(planLib.normalizePlan(p, project).narrative.scenes[2].reuseOfScene, 1);
  const sys = planLib.buildSystemPrompt();
  assert.match(sys, /ONLY what is visibly present in that source image/); assert.match(sys, /do NOT point every reuse at scene 1/);
  assert.match(sys, /central third/); assert.match(sys, /ONCE as a wide 16:9/);
  assert.deepStrictEqual(planLib.GPT_RANGE, { 30: [2, 3], 45: [3, 4], 60: [4, 6] });
});

// ── the chosen research topic reaches the script writer, and only its checked text ──
const topic = { id: "t1", researchId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000001", question: "Are fewer homes closing?", whyItMatters: "There were 31 closed sales.", scope: "selected", scopeNote: "Covers Roseville.", origin: "report", smallSample: false,
  reportFigures: [{ id: "r1.f3", text: "Closed sales: 31" }], reportNotice: "Based on information from MetroList Services, Inc. for the period Oct 11, 2026 through Oct 17, 2026.", trendSignals: [],
  sources: [{ type: "report", url: null, title: "Your MLS report" }], secretField: "never sent" };

test("planner input carries the topic's checked text and nothing else from it", () => {
  const m = JSON.parse(planLib.buildUserMessage({ ...project, intake: { ...intake, angle: "", issue: "" }, selected_topic: topic }));
  assert.strictEqual(m.selected_topic.topic_question, "Are fewer homes closing?");
  assert.deepStrictEqual(m.selected_topic.figures_you_may_state, ["Closed sales: 31"]);
  assert.strictEqual(m.selected_topic.origin, "the agent's own MLS report");
  assert.ok(!JSON.stringify(m).includes("never sent"));
  assert.strictEqual(m.insider_angle, null);
  assert.match(planLib.buildSystemPrompt(), /selected_topic[^"]*only numbers and facts/);
});

test("a topic with no validated source is not given to the planner, and other templates never get one", () => {
  assert.strictEqual(planLib.topicBrief({ ...topic, sources: [] }), null);
  assert.ok(!("selected_topic" in JSON.parse(planLib.buildUserMessage({ ...project, selected_topic: { ...topic, sources: [] } }))));
});

test("choosing a different topic lets the script be planned again", () => {
  assert.strictEqual(planLib.intakeHash(intake, topic), planLib.intakeHash(intake, { ...topic }));
  assert.notStrictEqual(planLib.intakeHash(intake, topic), planLib.intakeHash(intake, { ...topic, id: "t2" }));
  assert.notStrictEqual(planLib.intakeHash(intake, topic), planLib.intakeHash(intake));
});

test("a closing scene with no spoken text is repaired, not thrown away", async () => {
  // The narration the first five scenes did not cover goes to the empty last scene.
  const a = goodPlan();
  a.scenes[4].narration_excerpt = excerpts[4] + " " + excerpts[5];
  a.scenes[5].narration_excerpt = "";
  const outA = await planLib.generatePlan({ project, anthropicKey: "k", callFn: async () => JSON.stringify(a) });
  assert.strictEqual(outA.narrative.scenes.length, 5);                       // nothing left over: the empty closing scene is dropped (45s allows 5 to 6)
  assert.ok(outA.warnings.some((w) => /without spoken text/.test(w)));
  const b = goodPlan();
  b.scenes[5].narration_excerpt = "";                                           // excerpt 5 is not used by any scene: it goes to scene 6
  const outB = await planLib.generatePlan({ project, anthropicKey: "k", callFn: async () => JSON.stringify(b) });
  assert.strictEqual(outB.narrative.scenes.length, 6);
  assert.strictEqual(outB.narrative.scenes[5].narrationExcerpt, excerpts[5]);
  assert.ok(outB.warnings.some((w) => /end of your script was assigned/.test(w)));
});

test("an empty scene in the middle gets one free corrective retry; a second bad answer fails with the same message", async () => {
  const bad = goodPlan(); bad.scenes[2].narration_excerpt = "";
  const answers = [JSON.stringify(bad), JSON.stringify(goodPlan())];
  const seen = [];
  const out = await planLib.generatePlan({ project, anthropicKey: "k", callFn: async (sys, user) => { seen.push(user); return answers.shift(); } });
  assert.strictEqual(out.narrative.scenes.length, 6);
  assert.strictEqual(seen.length, 2);
  assert.match(seen[1], /previous reply could not be used: Scene 3 has no narration excerpt/);
  await assert.rejects(planLib.generatePlan({ project, anthropicKey: "k", callFn: async () => JSON.stringify(bad) }), /Scene 3 has no narration excerpt/);
});

test("a gate block gets one rewrite that names the problems; two blocks show the agent the rule and what is wrong", async () => {
  const plan = goodPlan(); plan.scenes[5].narration_excerpt = excerpts[5] + " Call 916-555-0100 to tour 123 Main Street.";
  let calls = 0, second = "";
  const err = await planLib.generatePlan({ project, anthropicKey: "k", callFn: async (sys, user) => { calls++; if (calls === 2) second = user; return JSON.stringify(plan); } }).then(() => null, (e) => e);
  assert.strictEqual(calls, 2, "exactly one rewrite");
  assert.match(second, /rejected by the compliance check for these specific reasons/);
  assert.match(second, /\([a-z_]+, in /);
  assert.match(err.message, /^The script was blocked by Agent Marketing's check:\n- .+\([a-z_]+, in /);
  assert.ok(err.gate && err.gate.blocks.length > 0);
});

test("a first draft the gate blocks is repaired by the rewrite without the agent seeing an error", async () => {
  const bad = goodPlan(); bad.scenes[5].narration_excerpt = excerpts[5] + " Call 916-555-0100 to tour 123 Main Street.";
  const good = goodPlan();
  let calls = 0;
  const r = await planLib.generatePlan({ project, anthropicKey: "k", callFn: async () => JSON.stringify(++calls === 1 ? bad : good) });
  assert.strictEqual(calls, 2);
  assert.strictEqual(r.gate.ok, true);
});

test("a sourced market statistic ('homes sold for 99% of list price') passes for a report topic, but a first-person result still blocks", () => {
  const gate = require("../netlify/functions/lib/agent-marketing-gate.js");
  const am = require("../netlify/functions/lib/agent-marketing-lib.js");
  const notice = "Based on information from MetroList Services, Inc. for the period 09/01/2026 through 09/30/2026.";
  const project = { template: "local_market_insider", intake: { market: "Roseville, CA" }, selected_topic: {
    question: "Are sellers in Roseville accepting offers close to their asking price?", whyItMatters: "Sold price as a percent of list price shows negotiating room.",
    sources: [{ url: "https://example.org/r" }], reportFigures: [{ text: "Sold price as a percent of list price: 99%" }], reportNotice: notice, trendSignals: [] } };
  const run = (s) => gate.evaluate(am.gateInputFor(project, { captionText: s, narrationTagged: s, scenes: [{ narrationExcerpt: s }], notice, cta: { text: "Ask me what this means for your pricing.", source: "claude" } }, "claude"));
  assert.strictEqual(run("Homes in Roseville sold for 99% of list price in September.").ok, true);
  assert.strictEqual(run("I sold for 99% of list price last month.").ok, false);
  assert.strictEqual(run("Homes sold for 88% of list price.").ok, false);
  assert.strictEqual(run("My clients sold for 99% of list price.").ok, false);
});

test("the planner is told to open with a short, specific hook and to vary its visuals instead of reusing a street and a tabletop", () => {
  const sys = planLib.buildSystemPrompt();
  assert.match(sys, /THE HOOK\. The first spoken sentence must stop a scroll: 14 words or fewer/);
  assert.match(sys, /Never open with a greeting, with "If you're thinking about selling\/buying in"/);
  assert.match(sys, /VISUAL VARIETY AND EDITORIAL QUALITY/);
  assert.match(sys, /do NOT default to a quiet suburban street at golden hour/);
});

test("source roles: the planner is told the rule, and the first and last scene are always data", async () => {
  assert.ok(/SOURCE ROLES/.test(planLib.systemPrompt ? planLib.systemPrompt() : require("fs").readFileSync(require.resolve("../netlify/functions/lib/agent-marketing-plan-lib"), "utf8")));
  const src = require("fs").readFileSync(require.resolve("../netlify/functions/lib/agent-marketing-plan-lib"), "utf8");
  assert.ok(/the data is the source of truth/i.test(src));                                  // Redfin (or the agent's report) wins a conflict
  assert.ok(/state the data's figure only and never the article's/.test(src));
  assert.ok(/building permits, an earlier trend/.test(src));                                // article-only figures stay available, attributed to the article
  assert.ok(!/never put a number from the article and a number from the data in the same scene/.test(src)); // the earlier no-mixing rule is gone
  const p = goodPlan();
  p.scenes.forEach((s, i) => { s.source_role = "article"; });            // the planner tries to make every scene an article scene
  p.scenes[3].source_role = "nonsense";
  const out = await planLib.generatePlan({ project, anthropicKey: "k", callFn: async () => JSON.stringify(p) });
  const roles = out.narrative.scenes.map((s) => s.sourceRole);
  assert.strictEqual(roles[0], "data");
  assert.strictEqual(roles[roles.length - 1], "data");
  assert.strictEqual(roles[1], "article");
  assert.strictEqual(roles[3], "data");                                  // not "article": an unknown value falls back to data
});
