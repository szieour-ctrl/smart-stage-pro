// Run with: npm test — the shared planner for the series templates: template brief, template rules, pose suggestions, shot caps (Nov 28, 2026)
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");
const poseLib = require("../netlify/functions/lib/agent-marketing-pose-lib");
const series = require("../netlify/functions/lib/agent-marketing-series-lib");

const SENT = [
  "Selling a home is a big decision, and you deserve a guide who has seen what a repair really involves.",
  "Before I ever talk about price, I walk the house with you and sort what truly matters from what does not.",
  "I once replaced rotted fascia on a home before it hit the market, and it changed what we did next.",
  "That is why I look at repairs as decisions, with a cost, a reason, and a clear order to do them in.",
  "You get a plain plan that fits your timeline, so nothing feels rushed or left until the last minute.",
  "If you are weighing a move, let us talk through a preparation plan that fits your home.",
];
const tags = ["[conversational]", "[warm]", "[thoughtful]", "[confident]", "[warm]", "[conversational]"];
const scene = (i, over) => ({ role: ["hook", "approach", "example", "meaning", "benefit", "cta"][i], narration_excerpt: SENT[i], purpose: "p" + i, visual_source: "BRAND_CARD", visual_brief: "b" + i, reuse_of_scene: null, card_text: "Ask me", ai_generation_prompt: null,
  camera_motion: "push_in", framing_9x16: "centered", framing_16x9: "wide", text_safe_placement: "lower", source_role: "data", pose: null, ...(over || {}) });
const reply = (scenes) => JSON.stringify({ editorial_angle: "Repairs are decisions.", hook: SENT[0], narration_with_audio_tags: SENT.map((x, i) => `${tags[i]} ${x}`).join(" "), scenes, cta_suggestion: "Talk through a prep plan.", claims_to_verify: [], missing_agent_inputs: [] });
const proj = (over) => ({ id: "p1", template: "meet_your_agent", duration_sec: 45, formats: ["9x16"], intake: { angle: "shaped", audience: "Sellers", motivation: "Helping big decisions", firsthand: "I replaced rotted fascia on a home before it hit the market.", publicTitle: "What shaped my approach" }, approved_poses: [{ id: "seated_desk", label: "Seated at a desk" }, { id: "standing_folder", label: "Standing with a folder" }], ...(over || {}) });
const gen = (project, scenes, calls) => planLib.generatePlan({ project, anthropicKey: "k", callFn: async (sys, user) => { (calls || []).push({ sys, user }); return reply(scenes); } });
const imgScene = (i, pose) => scene(i, { visual_source: "AGENT_SCENE", ai_generation_prompt: "A consultation desk in soft daylight, eyes on a blank worksheet, one hand on the page, calm mood, no text.", pose, card_text: null });
const conceptScene = (i) => scene(i, { visual_source: "GPT_IMAGE_2_CONCEPT", ai_generation_prompt: "A tidy workbench with a plain folder and blank notepad, soft light, no people, no text.", card_text: null });

test("the planner sees the template brief, the agent's own words, the approved poses and the template rules", async () => {
  const calls = [];
  const { narrative } = await gen(proj(), [scene(0, { visual_source: "AGENT_PROFILE", card_text: null }), conceptScene(1), imgScene(2, "seated_desk"), conceptScene(3), imgScene(4, "standing_folder"), scene(5, { visual_source: "AGENT_PROFILE", card_text: null })], calls);
  const u = JSON.parse(calls[0].user);
  assert.strictEqual(u.template, "Meet Your Agent");
  assert.strictEqual(u.template_brief.editorial_angle, "What shaped my approach");
  assert.match(u.template_brief.story_flow, /experience/);
  assert.strictEqual(u.agents_firsthand_observation, "I replaced rotted fascia on a home before it hit the market.");
  assert.strictEqual(u.audience, "Sellers");
  assert.deepStrictEqual(u.available_poses.map((p) => p.id), ["seated_desk", "standing_folder"]);
  assert.match(calls[0].sys, /TEMPLATE RULES/);
  assert.match(calls[0].sys, /SHOT LENGTH: no scene is longer than 10 seconds/);
  assert.match(calls[0].sys, /Template: Meet Your Agent/);
  assert.deepStrictEqual(narrative.scenes.filter((s) => s.visualSource === "AGENT_SCENE").map((s) => s.pose), ["seated_desk", "standing_folder"]);
  assert.ok(!(narrative.missingAgentInputs || []).some((m) => /firsthand observation/.test(m)), "the agent's firsthand example counts as their own words");
});

test("a pose the subscriber has not approved, or an unknown id, is dropped; with no approved poses nothing is suggested", async () => {
  const sc = [scene(0, { visual_source: "AGENT_PROFILE", card_text: null }), conceptScene(1), imgScene(2, "standing_presenting"), conceptScene(3), scene(4), scene(5)];
  assert.strictEqual((await gen(proj(), sc)).narrative.scenes[2].pose, null);
  const sc2 = [scene(0), conceptScene(1), imgScene(2, "not_a_pose"), conceptScene(3), scene(4), scene(5)];
  assert.strictEqual((await gen(proj(), sc2)).narrative.scenes[2].pose, null);
  const calls = [];
  const none = await gen(proj({ approved_poses: [] }), [scene(0), conceptScene(1), imgScene(2, "seated_desk"), conceptScene(3), scene(4), scene(5)], calls);
  assert.deepStrictEqual(JSON.parse(calls[0].user).available_poses, []);
  assert.strictEqual(none.narrative.scenes[2].pose, null);
});

test("series templates allow two supporting shots of the agent; Local Market Insider keeps one", () => {
  const raw = (n) => ({ ...JSON.parse(reply([scene(0), conceptScene(1), imgScene(2, "seated_desk"), conceptScene(3), imgScene(4, "standing_folder"), scene(5)])) });
  const twoSeries = planLib.normalizePlan(raw(), proj()).narrative.scenes.filter((s) => s.visualSource === "AGENT_SCENE").length;
  assert.strictEqual(twoSeries, 2);
  const lmi = planLib.normalizePlan(raw(), { ...proj(), template: "local_market_insider", intake: { angle: "seller", market: "Roseville", audience: "Home sellers", issue: "Preparation before listing", action: "Compare options", observation: "x" } }).narrative.scenes.filter((s) => s.visualSource === "AGENT_SCENE").length;
  assert.strictEqual(lmi, 1);
});

test("Local Market Insider's planner input and system prompt are unchanged", async () => {
  const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
  assert.strictEqual(sha(planLib.buildSystemPrompt()), "25f3118fed1b9726fc4dc78b16dcc92233cef785d3c074ef89a6ee7aaf7b0495");
  const u = JSON.parse(planLib.buildUserMessage({ template: "local_market_insider", duration_sec: 45, formats: ["9x16"], intake: { angle: "seller", market: "Roseville", audience: "Home sellers", issue: "Preparation before listing", action: "Compare options", observation: "x" } }));
  assert.ok(!("template_brief" in u) && !("available_poses" in u) && !("series_recap" in u));
  assert.strictEqual(u.agents_firsthand_observation, "x");
  assert.strictEqual(u.market, "Roseville");
});

test("a follow-up's planner input carries the recap so the new episode does not repeat the earlier one", () => {
  const u = JSON.parse(planLib.buildUserMessage(proj({ intake: { angle: "how", audience: "Sellers", firsthand: "I ask what made you start thinking about selling.", series_recap: { title: "Meet Your Agent", angle: "Introduce me", topic: "", takeaway: "A guide should be personal.", episodes: [{ id: "a", title: "Meet Your Agent" }] } } })));
  assert.deepStrictEqual(u.series_recap, { earlier_episode_title: "Meet Your Agent", earlier_angle: "Introduce me", earlier_topic: "", earlier_takeaway: "A guide should be personal.", already_covered: ["Meet Your Agent"] });
});

test("the intake hash covers a series template's own answers (a changed angle makes the script stale); Local Market Insider hashes are unchanged", () => {
  const a = planLib.intakeHash({ angle: "shaped", audience: "Sellers", firsthand: "x" }, null, "meet_your_agent");
  assert.notStrictEqual(a, planLib.intakeHash({ angle: "shaped", audience: "Sellers", firsthand: "y" }, null, "meet_your_agent"));
  assert.notStrictEqual(a, planLib.intakeHash({ angle: "shaped", audience: "Sellers", firsthand: "x", motivation: "Serving my community" }, null, "meet_your_agent"));
  const lmi = { angle: "seller", market: "Roseville", audience: "Home sellers", issue: "i", action: "a", observation: "o" };
  assert.strictEqual(planLib.intakeHash(lmi, { id: "t1", researchId: "r" }), planLib.intakeHash(lmi, { id: "t1", researchId: "r" }, "local_market_insider"));
});

test("a scene planned for more than 10 seconds gets a planning warning (the final cut is fitted to the audio)", () => {
  const long = JSON.parse(reply([scene(0), conceptScene(1), conceptScene(2), conceptScene(3), scene(4), scene(5)]));
  const r = planLib.normalizePlan(long, proj());
  r.narrative.scenes.forEach((s) => assert.ok(s.provisionalSeconds > 0));
  const over = r.narrative.scenes.filter((s) => s.provisionalSeconds > 10.5).length;
  assert.strictEqual(r.warnings.some((w) => /longer than 10 seconds/.test(w)), over > 0);
});

test("pose resolver: planner suggestion, subscriber override, 'none', and the profile-photo fallback", () => {
  const approved = [{ id: "seated_desk", label: "Seated at a desk", key: "k1" }, { id: "standing_folder", label: "Standing with a folder", key: "k2" }];
  assert.deepStrictEqual(poseLib.resolvePose({ suggested: "seated_desk", approved }), { pose: approved[0], source: "planner" });
  assert.deepStrictEqual(poseLib.resolvePose({ suggested: "seated_desk", override: "standing_folder", approved }), { pose: approved[1], source: "subscriber" });
  assert.deepStrictEqual(poseLib.resolvePose({ suggested: "seated_desk", override: "none", approved }), { pose: null, source: "subscriber_none" });
  assert.deepStrictEqual(poseLib.resolvePose({ suggested: "seated_listening", approved }), { pose: null, source: "fallback" });
  assert.deepStrictEqual(poseLib.resolvePose({ override: "seated_listening", approved }), { pose: null, source: "fallback" });
  assert.deepStrictEqual(poseLib.resolvePose({ approved: [] }), { pose: null, source: "none" });
  assert.strictEqual(poseLib.promptWithPose("PROMPT", null), "PROMPT");
  assert.match(poseLib.promptWithPose("PROMPT", approved[0]), /Image 1 is the approved headshot[\s\S]*Image 2 is the approved pose reference \(Seated at a desk\)[\s\S]*PROMPT$/);
});

test("approvedPoses lists only approved, not-left-out pose panels in sheet order, once each; a read failure returns none", async () => {
  const rows = [{ id: "a2", panel_index: 1, s3_key: "k-desk" }, { id: "a0", panel_index: 0, s3_key: "k-stand" }, { id: "dupe", panel_index: 1, s3_key: "k-old" }, { id: "bad", panel_index: 9, s3_key: "k-x" }, { id: "nokey", panel_index: 2, s3_key: null }];
  let qs = "";
  const list = await poseLib.approvedPoses("u1", async (m, t, b, q) => { qs = q; return { data: rows }; });
  assert.match(qs, /stage=eq\.poses.*kind=eq\.crop.*status=eq\.approved/);
  assert.deepStrictEqual(list.map((p) => [p.id, p.key]), [["seated_desk", "k-desk"], ["standing_presenting", "k-stand"]].sort((a, b) => 0));
  assert.deepStrictEqual(await poseLib.approvedPoses("u1", async () => { throw new Error("down"); }), []);
});
