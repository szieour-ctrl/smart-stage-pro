"use strict";
// Oct 29, 2026: every scene whose picture is AI-generated carries an automatic disclosure, decided from the image's recorded provenance.
const test = require("node:test");
const assert = require("node:assert");
const fx = require("./fixtures/natomas-approved.json");
const lib = require("../netlify/functions/lib/agent-marketing-assets-lib");
const manifestLib = require("../netlify/functions/lib/agent-marketing-manifest-lib");
const timing = require("../netlify/functions/lib/agent-marketing-timing-lib");

test("provenance: generated and adopted images are AI, own photos are photos unless flagged, the closing plate follows its source", () => {
  const images = {
    "0_9x16": { key: "a", source: "gpt_image_2" },
    "1_9x16": { key: "b", source: "own_photo", ai: false },
    "2_9x16": { key: "c", source: "own_photo", ai: true },
    "3_9x16": { key: "d", source: "existing_project_image" },
    "4_9x16": { key: "e", source: "closing_plate" },
    "0_16x9": { key: "f", source: "own_photo", ai: false },
    "1_16x9": { key: "g", source: "closing_plate" },
    "2_16x9": { key: "h", source: "closing_plate" },
  };
  const p = lib.imageProvenance(images);
  assert.deepStrictEqual(p[0], { "9x16": "ai", "16x9": "photo" });
  assert.strictEqual(p[1]["9x16"], "photo");
  assert.strictEqual(p[2]["9x16"], "ai");
  assert.strictEqual(p[3]["9x16"], "ai");
  assert.strictEqual(p[4]["9x16"], "ai", "the closing plate is a blurred copy of the nearest earlier AI picture");
  assert.strictEqual(p[1]["16x9"], "photo", "a plate made from a real photo is not AI");
  assert.strictEqual(p[2]["16x9"], "photo", "a plate chain stays on the nearest real picture");
  assert.deepStrictEqual(lib.imageProvenance({ "0_9x16": { key: "x", source: "closing_plate" } }), { 0: { "9x16": "photo" } }, "a neutral plate has no picture");
});

test("disclosure wording follows the Reel: event, market or default; fixed text only", () => {
  assert.strictEqual(lib.disclosureKind({ template: "local_market_insider", selected_topic: { kind: "local_events", event: { name: "x" } } }), "event");
  assert.strictEqual(lib.disclosureKind({ template: "local_market_insider", selected_topic: { kind: "market_update" } }), "market");
  assert.strictEqual(lib.disclosureKind({ template: "agent_brand" }), "default");
  assert.strictEqual(manifestLib.AI_DISCLOSURES.event, "AI-generated event illustration. Not actual event photography.");
  assert.strictEqual(manifestLib.AI_DISCLOSURES.market, "AI-generated neighborhood illustration. Not an actual location photograph.");
  assert.strictEqual(manifestLib.AI_DISCLOSURES.default, "AI-generated illustration. Not an actual photograph.");
});

const words = timing.captionWords(fx.narrative.narrationTagged).map((t, i) => ({ text: t, start: 0.3 + i * 0.36, end: 0.3 + i * 0.36 + 0.3 }));
const duration = words[words.length - 1].end + 0.5;
const keys = (s) => ({ "9x16": `i${s}_9`, "16x9": `i${s}_16` });
const topic = { id: "t1", origin: "web", kind: "market_update", question: "What is happening in Natomas 95834?", whyItMatters: "Sellers face new construction.", trendSignals: ["Median days on market is 41, 4 days longer year over year", "Homes that sold went for 99.4% of list price", "6 of 14 active listings took a price reduction"], scope: "broader_context", scopeNote: "Figures cover ZIP 95834, not all of Natomas.", sources: [{ title: "Redfin 95834 Housing Market", url: "https://www.redfin.com/zipcode/95834/housing-market", published: "2026-10-20" }], event: null };
const input = (over) => ({ projectId: "p1", formats: ["9x16"], narrative: fx.narrative, intake: fx.intake, reportFigures: [], webTopic: topic, brand: { agent: { name: "Sam Zieour", brokerage: "SZ" }, headshot_key: "hs" }, narrationTagged: fx.narrative.narrationTagged, audio: { narration_key: "n", duration_sec: duration, words }, imageKeys: { 0: keys(0), 1: keys(1), 2: keys(2), 4: keys(4) }, ...over });

test("the manifest carries per-scene provenance and the disclosure text, and a missing disclosure stops the Reel", () => {
  const prov = { 0: { "9x16": "ai" }, 1: { "9x16": "photo" }, 2: { "9x16": "ai" }, 4: { "9x16": "ai" } };
  const r = lib.buildManifest(input({ imageProvenance: prov, disclosureKind: "market" }));
  assert.deepStrictEqual(r.validation.errors, [], JSON.stringify(r.validation.errors));
  assert.strictEqual(r.manifest.disclosure.text, manifestLib.AI_DISCLOSURES.market);
  assert.strictEqual(r.manifest.scenes[0].visual.image_provenance["9x16"], "ai");
  assert.strictEqual(r.manifest.scenes[1].visual.image_provenance["9x16"], "photo");
  const typed = JSON.parse(JSON.stringify(r.manifest)); typed.disclosure.text = "Made with AI.";
  assert.ok(manifestLib.validateManifest(typed).errors.some((e) => e.code === "disclosure"));
  const gone = JSON.parse(JSON.stringify(r.manifest)); delete gone.disclosure;
  assert.ok(manifestLib.validateManifest(gone).errors.some((e) => e.code === "disclosure"));
});

test("a Reel with no AI picture has no disclosure and nothing to validate", () => {
  const r = lib.buildManifest(input({ imageProvenance: { 0: { "9x16": "photo" }, 1: { "9x16": "photo" }, 2: { "9x16": "photo" }, 4: { "9x16": "photo" } } }));
  assert.strictEqual(r.manifest.disclosure, undefined);
  assert.deepStrictEqual(r.validation.errors, []);
  assert.strictEqual(lib.buildManifest(input()).manifest.disclosure, undefined, "older callers that pass no provenance are unchanged");
});
