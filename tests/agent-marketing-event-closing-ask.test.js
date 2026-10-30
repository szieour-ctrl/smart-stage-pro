const test = require("node:test");
const assert = require("node:assert/strict");
const plan = require("../netlify/functions/lib/agent-marketing-plan-lib");
const gate = require("../netlify/functions/lib/agent-marketing-gate");
const intakeLib = require("../netlify/functions/lib/agent-marketing-intake");

const project = (action) => ({ template: "local_market_insider", user_id: "u1", duration_sec: 30, intake: { action, market: "Sacramento, CA" }, selected_topic: { kind: "local_events", event: { name: "Halloween Town" } } });

test("event sign-off asks for one small connection (comment, like, share or follow), shaped by the chosen viewer action", () => {
  const msg = (a) => JSON.parse(plan.buildUserMessage(project(a))).cta_angle;
  for (const a of intakeLib.EVENT_ACTIONS) {
    const c = msg(a);
    assert.match(c, /warm sign-off/);
    assert.match(c, /ONE small, friendly ask for a connection/);
    assert.match(c, /comment|share|follow|like/);
    assert.match(c, /not a sales ask/);
  }
  assert.match(msg("Follow for more local happenings"), /follow for more local happenings/);
  assert.match(msg("Invite a friend or family member to go"), /friend or family member/);
  assert.notEqual(msg("Ask me about the neighborhood"), msg("Follow for more local happenings"));
  assert.match(msg(undefined), /like, comment or share/);
});

test("planner rule 14 requires the ask, and the content gate accepts a sign-off with a small ask", () => {
  const sys = plan.buildSystemPrompt();
  assert.match(sys, /one small ask for a connection/);
  assert.match(sys, /a sign-off with no ask is not enough/);
  const intake = { template: "local_market_insider", angle: "seller", market: "Sacramento, CA", audience: "Home sellers", issue: "Timing their move", observation: "x", action: "Ask for a local perspective" };
  for (const text of ["Share this with someone who would love to go.", "Comment your favorite local tradition below.", "Follow for more local happenings."]) {
    const r = gate.evaluate({ template: "local_market_insider", intake, generated: { narration: "Hope you have a great time at Halloween Town.", captions: "Hope you have a great time at Halloween Town.", sceneTexts: [], overlays: [] }, cta: { text, source: "claude" } });
    assert.deepEqual(r.blocks, [], text);
  }
});

test("event closing always includes the standard check-the-event-page line; time is optional in the planner rule", () => {
  const c = JSON.parse(plan.buildUserMessage(project("Follow for more local happenings"))).cta_angle;
  assert.match(c, /ALWAYS also includes the standard line telling viewers to check the event page/);
  assert.match(plan.buildSystemPrompt(), /say the time only when selected_topic\.event\.time is present/);
  assert.match(require("../netlify/functions/lib/agent-marketing-research-lib").systemPrompt("local_events"), /The time is optional/);
});

test("when the page states the cause of an event, research lists it first and the script always says it", () => {
  assert.match(plan.buildSystemPrompt(), /the highlights ALWAYS say it, in the page's own wording/);
  assert.match(require("../netlify/functions/lib/agent-marketing-research-lib").systemPrompt("local_events"), /make it the FIRST detail/);
});
