// Run with: npm test — approved poses reach image generation next to the headshot; the profile photo stays the fallback (Nov 28, 2026)
const test = require("node:test");
const assert = require("node:assert");
const assets = require("../netlify/functions/lib/agent-marketing-assets-lib");
const poseLib = require("../netlify/functions/lib/agent-marketing-pose-lib");

const narrative = { scenes: [
  { visualSource: "AGENT_SCENE", aiGenerationPrompt: "Desk scene", pose: "seated_desk" },
  { visualSource: "GPT_IMAGE_2_CONCEPT", aiGenerationPrompt: "Concept" },
] };

test("the render step's image needs carry the planned pose for agent scenes only", () => {
  const needs = assets.imageNeeds(narrative, new Set());
  assert.strictEqual(needs[0].imageKind, "agent_scene");
  assert.strictEqual(needs[0].pose, "seated_desk");
  assert.ok(!("pose" in needs[1]));
});

test("poses apply to series templates; Local Market Insider keeps the profile photo alone", () => {
  assert.strictEqual(poseLib.isEnabledFor({ template: "meet_your_agent" }), true);
  assert.strictEqual(poseLib.isEnabledFor({ template: "local_market_insider" }), false);
  assert.strictEqual(poseLib.isEnabledFor(null), false);
});

test("an unapproved planned pose falls back to the profile photo", () => {
  const approved = [{ id: "standing_folder", label: "Standing with a folder", key: "k" }];
  assert.strictEqual(poseLib.resolvePose({ suggested: "seated_desk", approved }).pose, null);
  assert.strictEqual(poseLib.promptWithPose("P", null), "P");
});

test("HeyGen budget: planned and actual seconds against the 20-second planning budget", () => {
  const lip = require("../netlify/functions/lib/agent-marketing-lipsync-lib");
  const m = { scenes: [{ n: 0, composition: "x", window: { start: 0, end: 6 } }, { n: 1, window: { start: 6, end: 38 } }, { n: 2, window: { start: 38, end: 45 } }] };
  const b = lip.budget(m, [{ n: 0, status: "used", duration_sec: 6.4 }, { n: 2, status: "used", duration_sec: 7.1 }]);
  assert.deepStrictEqual(b, { budget_sec: 20, shot_cap_sec: 10, planned_sec: 13, actual_sec: 13.5, planned_within_budget: true, actual_within_budget: true });
  const over = lip.budget({ scenes: [{ n: 0, window: { start: 0, end: 16 } }, { n: 1, window: { start: 16, end: 24 } }] }, [{ n: 0, status: "used", duration_sec: 16 }, { n: 1, status: "fallback" }]);
  assert.strictEqual(over.planned_sec, 24); assert.strictEqual(over.planned_within_budget, false); assert.strictEqual(over.actual_sec, 16);
});
