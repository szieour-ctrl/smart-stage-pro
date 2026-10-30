const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
test("project payload flags a script written for another topic, and the page offers Write my script again", () => {
  const api = fs.readFileSync(__dirname + "/../netlify/functions/agent-marketing-project.js", "utf8");
  assert.match(api, /scriptStale: scriptStale\(row\)/);
  const html = fs.readFileSync(__dirname + "/../agent-marketing.html", "utf8");
  assert.match(html, /!state\.project\.scriptStale/);
  assert.match(html, /Choosing a different topic makes the server reset the intake/);
});

test("event Reels offer their own call-to-action choices, accepted by intake validation", () => {
  const intake = require("../netlify/functions/lib/agent-marketing-intake");
  assert.ok(intake.EVENT_ACTIONS.length >= 4);
  assert.ok(intake.EVENT_ACTIONS.includes("Ask for a local perspective"));
  for (const a of intake.EVENT_ACTIONS) {
    const v = intake.validateIntake({ template: "local_market_insider", audience: "Home buyers", market: "Roseville, CA", action: a });
    assert.ok(!(v.errors || []).some((e) => e.field === "action"), a);
  }
});
