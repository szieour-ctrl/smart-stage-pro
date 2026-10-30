const test = require("node:test");
const assert = require("node:assert/strict");
const director = require("../netlify/functions/lib/agent-marketing-director-lib.js");
test("a big-number card for a change figure says which way it moved", () => {
  const rows = [{ key: "active_change_yoy", ref: "f1", label: "For-sale listings, change from a year earlier", display: "down 5.9%", text: "For-sale listings, change from a year earlier: down 5.9% (September 2026)" }];
  const figs = director.figuresFrom(rows);
  const nar = { hook: "x", scenes: [
    { role: "a", narrationExcerpt: "Intro here today." },
    { role: "b", narrationExcerpt: "Inventory is down 5.9% from a year ago, so there is still limited supply.", cameraMotion: "push_in" },
    { role: "c", narrationExcerpt: "Happy to walk through it with you." },
  ] };
  const pl = director.plan(nar, { market: "Antelope, CA" }, figs, {});
  const card = pl.scenes[1];
  assert.equal(card.composition, "stat_big_number");
  assert.match(card.data.lead, /down from a year earlier/i);
  assert.equal(card.data.direction, "down");
  assert.equal(card.data.value, "5.9");
});
