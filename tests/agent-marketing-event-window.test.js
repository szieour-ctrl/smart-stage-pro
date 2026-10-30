const test = require("node:test");
const assert = require("node:assert/strict");
const r = require("../netlify/functions/lib/agent-marketing-research-lib");

const req = (mode) => r.validateResearchRequest({ mode, audience: "buyers", geography: { zip: "95630", type: "city", name: "Folsom" } }).request;

test("events search: a 30-day window in the prompt and no publication-date filter; market updates keep the 60-day filter", () => {
  const ev = r.buildResearchPayload({ request: req("local_events"), today: "2026-10-29", env: {} });
  assert.match(ev.input, /Event window: include events that start from today \(2026-10-29\) through 2026-11-28/);
  assert.match(ev.input, /still running/);
  assert.equal(ev.tools[0].filters, undefined);
  const mu = r.buildResearchPayload({ request: req("market_update"), today: "2026-10-29", env: {} });
  assert.ok(mu.tools[0].filters && mu.tools[0].filters.search_after_date_filter);
  assert.ok(!/Event window/.test(mu.input));
});
