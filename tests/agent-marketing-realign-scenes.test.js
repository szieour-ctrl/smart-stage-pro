const test = require("node:test");
const assert = require("node:assert/strict");
const { realignScenes, captionWords } = require("../netlify/functions/lib/agent-marketing-timing-lib.js");
const scenes = [
  { role: "hook", narrationExcerpt: "Free cars and coffee in Roseville this Sunday morning." },
  { role: "essentials", narrationExcerpt: "Capital City Coffee and Cars rolls into Denio's Market from 8 to 10." },
  { role: "close", narrationExcerpt: "Hope you have a wonderful time out there." },
];
const joined = (r) => r.scenes.map((s) => s.narrationExcerpt).join(" ");
test("unchanged narration changes nothing", () => {
  const r = realignScenes(scenes, "Free cars and coffee in Roseville this Sunday morning. [pause] Capital City Coffee and Cars rolls into Denio's Market from 8 to 10. Hope you have a wonderful time out there.");
  assert.equal(r.changed, false);
});
test("an added word joins the scene of the word before it; the total matches the narration", () => {
  const text = "Cars and coffee in Roseville this Sunday morning. Capital City Coffee and Cars rolls right into Denio's Market from 8 to 10. Hope you have a wonderful time out there.";
  const r = realignScenes(scenes, text);
  assert.equal(joined(r), captionWords(text).join(" "));
  assert.equal(r.scenes[1].narrationExcerpt, "Capital City Coffee and Cars rolls right into Denio's Market from 8 to 10.");
  assert.equal(r.scenes[0].role, "hook");
});
test("a scene whose words were all rewritten still gets words and the order is kept", () => {
  const text = "Something new this Sunday morning. Capital City Coffee and Cars rolls into Denio's Market from 8 to 10. A completely different ending here.";
  const r = realignScenes(scenes, text);
  assert.equal(joined(r), captionWords(text).join(" "));
  assert.ok(r.scenes.every((s) => captionWords(s.narrationExcerpt).length >= 1));
});

test("a replaced word that opens a scene stays with that scene (Denio's case)", () => {
  const sc = [
    { role: "a", narrationExcerpt: "It's the kind of morning that turns into a couple of hours without you even noticing." },
    { role: "b", narrationExcerpt: "Danaio's has been a Roseville gathering spot for decades, and events like this one matter." },
  ];
  const r = realignScenes(sc, "It's the kind of morning that turns into a couple of hours without you even noticing. Denio's has been a Roseville gathering spot for decades, and events like this one matter.");
  assert.equal(r.scenes[0].narrationExcerpt, "It's the kind of morning that turns into a couple of hours without you even noticing.");
  assert.ok(r.scenes[1].narrationExcerpt.startsWith("Denio's has been"));
});

test("a scene boundary left inside a sentence is mended (the saved Denio's project)", () => {
  const { healBoundaries } = require("../netlify/functions/lib/agent-marketing-timing-lib.js");
  const sc = [
    { role: "a", narrationExcerpt: "It's the kind of morning that turns into a couple of hours without you even noticing. Denio's" },
    { role: "b", narrationExcerpt: "has been a Roseville gathering spot for decades, and events like this one matter." },
    { role: "c", narrationExcerpt: "Hope you have a wonderful time out there." },
  ];
  const h = healBoundaries(sc);
  assert.equal(h[0].narrationExcerpt, "It's the kind of morning that turns into a couple of hours without you even noticing.");
  assert.ok(h[1].narrationExcerpt.startsWith("Denio's has been"));
  assert.equal(h[2].narrationExcerpt, sc[2].narrationExcerpt);
  assert.equal(realignScenes(sc, "It's the kind of morning that turns into a couple of hours without you even noticing. Denio's has been a Roseville gathering spot for decades, and events like this one matter. Hope you have a wonderful time out there.").changed, true);
});
