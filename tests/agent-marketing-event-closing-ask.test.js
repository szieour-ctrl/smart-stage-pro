const test = require("node:test");
const assert = require("node:assert/strict");
const plan = require("../netlify/functions/lib/agent-marketing-plan-lib");
const gate = require("../netlify/functions/lib/agent-marketing-gate");
const intakeLib = require("../netlify/functions/lib/agent-marketing-intake");

const project = (action) => ({ template: "local_market_insider", user_id: "u1", intake: { action, market: "Sacramento, CA" }, selected_topic: { kind: "local_events", event: { name: "Halloween Town" } } });

test("event sign-off asks for one small real estate step, shaped by the chosen viewer action", () => {
  const msg = (a) => JSON.parse(plan.buildUserMessage(project(a))).cta_angle;
  for (const a of intakeLib.EVENT_ACTIONS) {
    const c = msg(a);
    assert.match(c, /warm sign-off/);
    assert.match(c, /ONE small, low-pressure ask/);
    assert.match(c, /message the agent|follow for more|save the date/);
    assert.match(c, /no price, listing or offer to sell/);
  }
  assert.match(msg("Follow for more local happenings"), /buying or selling here/);
  assert.match(msg("Invite a friend or family member to go"), /friend or family member/);
  assert.notEqual(msg("Ask me about the neighborhood"), msg("Follow for more local happenings"));
  assert.match(msg(undefined), /living, buying or selling/);
});

test("planner rule 14 requires the ask, and the content gate accepts a sign-off with a small ask", () => {
  const sys = plan.buildSystemPrompt();
  assert.match(sys, /ends with one small ask/);
  assert.match(sys, /a sign-off with no ask is not enough/);
  const intake = { template: "local_market_insider", angle: "seller", market: "Sacramento, CA", audience: "Home sellers", issue: "Timing their move", observation: "x", action: "Ask for a local perspective" };
  for (const text of ["Message me with questions about buying or selling here.", "Know someone thinking about moving here? Send them my way.", "Follow for more local happenings and message me anytime."]) {
    const r = gate.evaluate({ template: "local_market_insider", intake, generated: { narration: "Hope you have a great time at Halloween Town.", captions: "Hope you have a great time at Halloween Town.", sceneTexts: [], overlays: [] }, cta: { text, source: "claude" } });
    assert.deepEqual(r.blocks, [], text);
  }
});
