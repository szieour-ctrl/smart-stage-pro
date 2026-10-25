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
  assert.ok((t.match(/\[/g) || []).length <= 6);
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
    await assert.rejects(planLib.generatePlan({ project, anthropicKey: "k", callFn: async () => JSON.stringify(plan) }), /can't use/);
  }
});

test("a property-sale concept in an image prompt is rejected too", async () => {
  const plan = goodPlan(); plan.scenes[1].ai_generation_prompt = "A yard sign saying Just Listed with an open house banner";
  await assert.rejects(planLib.generatePlan({ project, anthropicKey: "k", callFn: async () => JSON.stringify(plan) }), /can't use/);
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
