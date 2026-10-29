const test = require("node:test");
const assert = require("node:assert/strict");
const director = require("../netlify/functions/lib/agent-marketing-director-lib.js");
const timing = require("../netlify/functions/lib/agent-marketing-timing-lib.js");

const scene = (ex) => ({ role: "hook", narrationExcerpt: ex, cameraMotion: "push_in" });
const mk = (hook, source, ex) => ({ hook, source, scenes: [scene(ex), scene("Middle part of the story here."), scene("Hope you have a wonderful time out there.")], narrationTagged: ex });
const open = (n) => director.plan(n, { market: "Roseville, CA" }, [], { eventReel: true }).scenes[0].data.headline;

test("an edited script no longer opens with the planner's old hook", () => {
  const h = open(mk("Free cars and coffee in Roseville — this Sunday morning.", "edited", "Capital City Coffee & Cars rolls into Denio's Market this Sunday morning, November 1st, from 8 to 10."));
  assert.doesNotMatch(h, /free/i);
  assert.match(h, /Capital City/);
});
test("an unedited script keeps its hook, and an edited one keeps it while the hook is still in the text", () => {
  assert.match(open(mk("Free cars and coffee in Roseville", "claude", "Capital City Coffee rolls into town.")), /Free Cars/);
  assert.match(open(mk("Cars and coffee this Sunday", "edited", "Cars and coffee this Sunday morning in Roseville.")), /Cars And Coffee This Sunday/i);
});
test("timings that differ only in punctuation take the caption's spelling; a real difference still stops", () => {
  const w = [{ text: "10", start: 0, end: 1 }, { text: "a.m", start: 1, end: 2 }, { text: "and", start: 2, end: 3 }];
  const r = timing.reconcileWords(w, "10 a.m… and");
  assert.deepEqual(r.map((x) => x.text), ["10", "a.m…", "and"]);
  assert.equal(timing.reconcileWords([{ text: "ten", start: 0, end: 1 }], "10"), null);
});
