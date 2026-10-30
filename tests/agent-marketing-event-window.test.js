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

test("events: up to eight candidates are accepted and the first five that pass are kept; the output cap has room for them", () => {
  const sp = r.systemPrompt("local_events");
  assert.match(sp, /up to EIGHT candidate events/);
  const ev = r.buildResearchPayload({ request: req("local_events"), today: "2026-10-29", env: {} });
  assert.match(ev.input, /up to 8 candidate events/);
  assert.ok(ev.max_output_tokens >= 5000);
  const mu = r.buildResearchPayload({ request: req("market_update"), today: "2026-10-29", env: {} });
  assert.equal(mu.max_output_tokens, 2200);
  const Q = ["Is the jazz brunch back on Sutter Street?", "Where can neighbors taste award-winning chili Saturday?", "Will lantern boats float along the river tonight?", "Which pumpkin patch opens its corn maze early?", "How do sculptors transform the old rail depot?", "Do kite flyers gather at the lake bluff?", "Can wine lovers tour three tasting rooms downtown?", "What vintage tractors roll through Main Street?"];
  const mk = (i, time) => ({ question: Q[i - 1], why_it_matters: "Neighbors gather.", trend_signals: [], scope: "selected", sources: [{ title: `Source ${i}`, url: `https://site${i}.example.org/e${i}`, published: "2026-10-20" }], event: { name: `Event ${i}`, date: "2026-11-07", time, location: "Zittel Amphitheater, Folsom", organizer: `Org ${i}`, status: "upcoming", details: ["Live music"] } });
  const raw = [mk(1, "unknown"), mk(2, "6 p.m."), mk(3, "7 p.m."), mk(4, "unknown"), mk(5, "5 p.m."), mk(6, "8 p.m."), mk(7, "4 p.m."), mk(8, "3 p.m.")];
  const v = r.validateTopics(raw, { mode: "local_events", today: "2026-10-29" });
  assert.equal(v.topics.length, 5);
  assert.deepEqual(v.topics.map((t) => t.event.name), ["Event 2", "Event 3", "Event 5", "Event 6", "Event 7"]);
  assert.ok(!v.problems.some((p) => /expected 5 topics/.test(p)));
});
