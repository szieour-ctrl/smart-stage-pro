const test = require("node:test");
const assert = require("node:assert/strict");
const research = require("../netlify/functions/lib/agent-marketing-research-lib");
const plan = require("../netlify/functions/lib/agent-marketing-plan-lib");
const director = require("../netlify/functions/lib/agent-marketing-director-lib");

test("research asks for the page's own dates wording and never a self-built weekday range", () => {
  const sp = research.systemPrompt("local_events");
  assert.match(sp, /dates_as_published/);
  assert.match(sp, /never build a range of your own from a weekday and a date/);
});

test("planner is told to use the page's wording for when, and event brief carries it", () => {
  assert.match(plan.buildSystemPrompt(), /never build your own range such as .{0,2}Thursday through October 31/);
  const project = { template: "local_market_insider", user_id: "u", duration_sec: 30, intake: { market: "Sacramento, CA", action: "Ask for a local perspective" }, selected_topic: { kind: "local_events", question: "q", sources: [{ title: "s", url: "https://downtownsac.org/e" }], event: { name: "Halloween Town", date: "2026-10-29", endDate: "2026-10-31", datesAsPublished: "All of October", time: "All day", location: "Old Sacramento Waterfront", organizer: "Downtown Sacramento Partnership", status: "ongoing" } } };
  const msg = JSON.parse(plan.buildUserMessage(project));
  assert.equal(msg.selected_topic.event.dates_as_published, "All of October");
});

test("opening card shows the page's wording, else the date range", () => {
  assert.equal(director.eventWhen({ date: "2026-10-29", endDate: "2026-10-31", datesAsPublished: "all of October", time: "All day" }), "All of October");
  assert.match(director.eventWhen({ date: "2026-10-29", endDate: "2026-10-31", time: "All day" }), /Oct 29–31/);
});
