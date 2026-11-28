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
