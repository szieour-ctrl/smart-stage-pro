// Nov 25, 2026: Local Events with the 55+ focus searches wide (every 55+ community's own site plus city sources), not inside one newsletter.
const test = require("node:test");
const assert = require("node:assert");
const rl = require("../netlify/functions/lib/agent-marketing-research-lib.js");

const base = (focus) => ({ mode: "local_events", audience: "buyers", geography: { type: "city", name: "Roseville", city: "", zip: "", label: "Roseville, CA", state: "CA" }, focus, dataFocus: "none", dataSource: "web" });
const input = (focus) => rl.buildResearchPayload({ request: base(focus), today: "2026-11-25", env: {} }).input;

test("55+ Local Events asks for a wide sweep of every community's own site and the city calendars", () => {
  const t = input({ active_adult_55: true, new_construction: false });
  assert.ok(t.includes(rl.ACTIVE_ADULT_EVENTS_SWEEP));
  assert.match(t, /EVERY 55\+ active adult community/);
  assert.match(t, /not build the list from a single document/);
});
test("without the 55+ focus, or for Market Update, the sweep line is absent", () => {
  assert.ok(!input({ active_adult_55: false, new_construction: false }).includes(rl.ACTIVE_ADULT_EVENTS_SWEEP));
  const m = rl.buildResearchPayload({ request: { ...base({ active_adult_55: true, new_construction: false }), mode: "market_update" }, today: "2026-11-25", env: {} }).input;
  assert.ok(!m.includes(rl.ACTIVE_ADULT_EVENTS_SWEEP));
});
test("the Events retry says what to widen", () => {
  assert.match(rl.EVENTS_RETRY_WIDEN, /Search wider/);
});
