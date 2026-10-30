const test = require("node:test");
const assert = require("node:assert/strict");
const cc = require("../netlify/functions/lib/agent-marketing-cardcopy-lib");
const director = require("../netlify/functions/lib/agent-marketing-director-lib");

// Oct 30, 2026: the median sold price and average for-sale price cards showed the figure alone; a line under it now gives the comparison the scene states.
const narrative = { scenes: [
  { role: "Hook", narrationExcerpt: "Antelope home values are drifting down." },
  { role: "Sold", narrationExcerpt: "The median sold price in September came in at $482,000, down from $493,000 in August and down from $503,000 a year ago." },
  { role: "For sale", narrationExcerpt: "The average home listed right now is sitting at $524,000, and that trend is moving in the same direction." },
  { role: "Close", narrationExcerpt: "Reach out and let's take a look together." },
], hook: "Antelope home values are drifting down" };
const rows = [
  { key: "median_price", label: "Median sold price", display: "$482,000", ref: "f1", text: "Median sold price: $482,000 (Sep 2026)" },
  { key: "avg_price", label: "Average for-sale price", display: "$524,000", ref: "f2", text: "Average for-sale price: $524,000 (Sep 2026)" },
];
const base = { project: { template: "local_market_insider" }, narrative, intake: { market: "Antelope" }, reportFigures: rows };

test("big-number scenes with no template trail are found; days-on-market scenes keep their template", () => {
  const figs = director.figuresFrom(rows);
  assert.deepEqual(cc.statTrailScenes(narrative, { market: "Antelope" }, figs), [1, 2]);
});

test("a trail passes into the stat card; the figure itself is never repeated and new numbers are rejected", async () => {
  const callFn = async () => JSON.stringify({ trails: [
    { index: 1, trail: "Lower than both last month and last year" },
    { index: 2, trail: "Same downward direction as sold prices" },
  ] });
  const out = await cc.writeTrails({ ...base, callFn });
  assert.equal(out[1].trail, "Lower than both last month and last year");
  const pl = director.plan(narrative, { market: "Antelope" }, director.figuresFrom(rows), { cardCopy: out });
  assert.equal(pl.scenes[1].data.trail, "Lower than both last month and last year");
  assert.equal(pl.scenes[2].data.trail, "Same downward direction as sold prices");
  const v = (t) => cc.validateTrail(t, { narration: "x $482,000 down from $493,000 in August", allowed: [482000, 493000], figure: 482000 });
  assert.equal(v("It was $482,000 last month").ok, false, "repeats the big figure");
  assert.equal(v("Down from $510,000 in August").ok, false, "510,000 is not in the scene");
  assert.equal(v("One two three four five six seven eight nine").ok, false, "over 8 words");
  assert.equal(v("Ask your agent what this means").ok, false, "advice");
  assert.equal(v("Lower than August's $493,000").ok, true);
});

test("a failed trail is asked again with the reason, an empty one stays bare, and a model error never throws", async () => {
  const seen = [];
  const callFn = async (sys, user) => {
    const u = JSON.parse(user); seen.push(u);
    if (!u.fix_these) return JSON.stringify({ trails: [{ index: 1, trail: "one two three four five six seven eight nine" }, { index: 2, trail: "" }] });
    return JSON.stringify({ trails: [{ index: 1, trail: "Down from August and from last year" }] });
  };
  const out = await cc.writeTrails({ ...base, callFn });
  assert.equal(out[1].trail, "Down from August and from last year");
  assert.equal(out[2], undefined);
  assert.match(seen[1].fix_these[0].problem, /over 8 words/);
  assert.deepEqual(await cc.writeTrails({ ...base, callFn: async () => { throw new Error("down"); } }), {});
  assert.deepEqual(await cc.writeTrails({ ...base, project: { selected_topic: { kind: "local_events" } }, callFn }), {}, "event Reels have no stat cards");
});

test("a big-number card names the area it describes and shows the report period, so it is not read as one home's price", () => {
  const pl = director.plan(narrative, { market: "Antelope" }, director.figuresFrom(rows));
  assert.equal(pl.scenes[1].data.lead, "Antelope's median sold price");
  assert.equal(pl.scenes[1].data.trail, "Sep 2026");
  assert.equal(pl.scenes[2].data.lead, "Antelope's average for-sale price");
  const withTrail = director.plan(narrative, { market: "Antelope" }, director.figuresFrom(rows), { cardCopy: { 1: { trail: "Lower than last month and last year" } } });
  assert.equal(withTrail.scenes[1].data.trail, "Lower than last month and last year", "the written comparison replaces the period line");
});
