"use strict";
const test = require("node:test");
const assert = require("node:assert");
const T = require("../netlify/functions/lib/agent-marketing-treatments");

test("the library is sound", () => assert.deepStrictEqual(T.validateLibrary(), []));

test("exactly the five approved treatments exist", () => {
  assert.deepStrictEqual(T.ids().sort(), ["cinematic_editorial", "expert_perspective", "local_news_brief", "market_intelligence", "side_by_side"]);
  assert.deepStrictEqual(["Cinematic Editorial", "Market Intelligence", "Side-by-Side Comparison", "Local News Brief", "Expert Perspective"].sort(), T.ids().map((i) => T.get(i).label).sort());
});

test("every treatment uses the subscriber font and full branding on opening and closing", () => {
  for (const id of T.ids()) { const t = T.get(id); assert.strictEqual(t.typography.font, "subscriber"); assert.strictEqual(t.branding.opening, "full"); assert.strictEqual(t.branding.closing, "full"); }
});

test("compatible treatments are mutual enough to be useful and never self-referencing", () => {
  for (const id of T.ids()) { const t = T.get(id); assert.ok(!t.compatible.includes(id)); assert.ok(t.compatible.length >= 2); }
});

test("allowedCompositions adds only the compatible secondaries, and can limit to what Railway draws today", () => {
  const base = T.allowedCompositions("cinematic_editorial");
  assert.ok(base.includes("stat_big_number") && !base.includes("compare_two_card"));
  const withSide = T.allowedCompositions("cinematic_editorial", { secondaries: ["side_by_side"] });
  assert.ok(withSide.includes("compare_two_card"));
  assert.deepStrictEqual(T.allowedCompositions("cinematic_editorial", { secondaries: ["local_news_brief"] }).includes("news_location_slate"), false, "local_news_brief is not on cinematic's compatible list");
  assert.ok(T.allowedCompositions("cinematic_editorial", { secondaries: ["side_by_side"], builtOnly: true }).every(T.isBuilt));
  assert.deepStrictEqual(T.allowedCompositions("nope"), []);
});

test("the five cards built today are the five built compositions", () => {
  const built = Object.keys(T.COMPOSITIONS).filter(T.isBuilt).sort();
  assert.deepStrictEqual(built, ["closing_headline_focus", "compare_two_card", "expert_takeaway", "opening_headline_focus", "stat_big_number"]);
});
