const test = require("node:test");
const assert = require("node:assert/strict");
const cc = require("../netlify/functions/lib/agent-marketing-cardcopy-lib");
const director = require("../netlify/functions/lib/agent-marketing-director-lib");

const ctx = { narration: "Movies Under the Stars runs Thursday and Friday with Halloween films.", allowed: [], event: true };

test("event cards: market takeaways and advice to the viewer are rejected (the leaked 'Ask how often your target area hosts this' case)", () => {
  for (const bad of [
    { headline: "Downtown activations signal a lively urban core", statement: "Seasonal energy attracts foot traffic year-round", support: "Active districts tend to hold buyer interest" },
    { headline: "Recurring events keep neighborhoods engaged", statement: "Midweek programming is a strong community sign", support: "Ask how often your target area hosts this" },
    { headline: "Showing up in person reveals what data cannot", statement: "", support: "Visit before you decide, not after" },
    { headline: "Halloween films on the waterfront", statement: "Bring your costume", support: "" },
  ]) assert.equal(cc.validateCard(bad, ctx).ok, false, bad.headline);
});

test("event cards: plain event facts pass, and a farmers market is not mistaken for a market claim", () => {
  const v = cc.validateCard({ headline: "Halloween films outdoors Thursday and Friday", statement: "Costume contests and local vendors", support: "At the farmers market plaza" }, ctx);
  assert.equal(v.ok, true);
});

test("event card prompt uses event facts only; market prompt unchanged", () => {
  const ev = cc.buildSystemPrompt("event");
  assert.match(ev, /ONLY facts that are in this scene's narration or in event_details/);
  assert.match(ev, /Never give the viewer an instruction/);
  assert.match(cc.buildSystemPrompt(), /adds the agent's perspective/);
  assert.equal(cc.isEventProject({ selected_topic: { kind: "local_events" } }), true);
  assert.equal(cc.isEventProject({ selected_topic: { kind: "market_update" } }), false);
  const um = JSON.parse(cc.buildUserMessage({ intake: {}, topic: { question: "q", event: { name: "Halloween Town", date: "2026-10-29", location: "Old Sacramento", details: ["Pumpkin"] } }, scenes: [] }));
  assert.equal(um.event_details.name, "Halloween Town");
});

test("opening date line shows only the published time, never a research note", () => {
  const html = director.plan({ hook: "h", scenes: [{ role: "a", narrationExcerpt: "Intro today here." }, { role: "b", narrationExcerpt: "Middle bit." }, { role: "c", narrationExcerpt: "Bye now." }], cta: { text: "x" } }, { market: "Sacramento, CA" }, [], { eventReel: true, event: { name: "Halloween Town", date: "2026-10-29", endDate: "2026-10-31", time: "All day; page also describes a Halloween dance party planned for October 30" } });
  assert.equal(html.scenes[0].data.eyebrow, "Oct 29–31 · All day");
});
