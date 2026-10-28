"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fx = require("./fixtures/natomas-approved.json");
const lib = require("../netlify/functions/lib/agent-marketing-assets-lib");
const timing = require("../netlify/functions/lib/agent-marketing-timing-lib");
const director = require("../netlify/functions/lib/agent-marketing-director-lib");

// words at an even pace, as ElevenLabs would return them
const words = timing.captionWords(fx.narrative.narrationTagged).map((t, i) => ({ text: t, start: 0.3 + i * 0.4, end: 0.3 + i * 0.4 + 0.34 }));
const duration = Math.round((words[words.length - 1].end + 0.5) * 100) / 100;
const brand = { primary: "#B08D3F", secondary: "#1D2023", border: "#B08D3F", font: "Montserrat", headshot_key: "profiles/hs.png", agent: { name: "Sam Zieour", brokerage: "SZ Real Estate Group" } };
const keys = (s) => ({ "9x16": `i${s}_9`, "16x9": `i${s}_16` });
const input = (over) => ({ projectId: "p1", formats: ["9x16", "16x9"], narrative: fx.narrative, intake: fx.intake, reportFigures: fx.reportFigures, notice: { period: lib.parseNoticePeriod(fx.narrative.notice) }, brand, narrationTagged: fx.narrative.narrationTagged, audio: { narration_key: "a.mp3", duration_sec: duration, words }, imageKeys: { 0: keys(0), 1: keys(1), 2: keys(2), 4: keys(4) }, ...over });

test("the approved Natomas script builds a valid manifest", () => {
  const r = lib.buildManifest(input());
  assert.ok(r.manifest, JSON.stringify(r.validation));
  assert.deepStrictEqual(r.validation.errors, [], JSON.stringify(r.validation.errors));
  const comps = r.manifest.scenes.map((s) => s.composition);
  assert.deepStrictEqual(comps, ["opening_headline_focus", "stat_big_number", "compare_two_card", "expert_takeaway", "closing_headline_focus"]);
  assert.strictEqual(r.manifest.scenes[3].visual.image_keys["9x16"], "i2_9", "scene 4 reuses scene 3's image");
  assert.strictEqual(r.manifest.notice.text, "Based on information from MetroList Services, Inc. for the period February 19, 2026 through October 19, 2026.");
});

test("every number on a card traces to a verified figure", () => {
  const { manifest } = lib.buildManifest(input());
  assert.strictEqual(manifest.scenes[1].data.value, "41");
  assert.deepStrictEqual(manifest.scenes[1].claims, [{ field: "value", figure: "r1.f7" }]);
  const cmp = manifest.scenes[2];
  assert.strictEqual(cmp.data.left.percent, 99.4);
  assert.strictEqual(cmp.data.right.highlighted, 6);
  assert.strictEqual(cmp.data.right.total, 14);
  assert.deepStrictEqual(cmp.claims.map((c) => c.figure), ["r1.f16", "r1.f6", "r1.f1"]);
  assert.ok(manifest.figures.every((f) => ["r1.f7", "r1.f16", "r1.f6", "r1.f1"].includes(f.ref)), "only the figures used are carried");
});

test("captions are the approved words and the scenes cover the audio", () => {
  const { manifest } = lib.buildManifest(input());
  assert.strictEqual(manifest.captions.map((c) => c.text).join(" "), timing.captionWords(fx.narrative.narrationTagged).join(" "));
  assert.strictEqual(manifest.scenes[0].window.start, 0);
  assert.ok(Math.abs(manifest.scenes[4].window.end - duration) < 0.01);
});

test("a 9:16-only job only needs 9:16 images", () => {
  const r = lib.buildManifest(input({ formats: ["9x16"], imageKeys: { 0: { "9x16": "a" }, 1: { "9x16": "b" }, 2: { "9x16": "c" }, 4: { "9x16": "e" } } }));
  assert.deepStrictEqual(r.validation.errors, []);
});

test("a missing image stops the build with a plain error", () => {
  const r = lib.buildManifest(input({ imageKeys: { 0: keys(0), 2: keys(2), 4: keys(4) } }));
  assert.ok(!r.validation.ok);
  assert.ok(r.validation.errors.some((e) => /no 9x16 background|no 16x9 background/.test(e.message)));
});

test("words that do not add up to the scenes are refused", () => {
  const r = lib.buildManifest(input({ audio: { narration_key: "a.mp3", duration_sec: duration, words: words.slice(0, -3) } }));
  assert.strictEqual(r.manifest, null);
  assert.ok(!r.validation.ok);
});

test("image needs: generate, reuse and brand plate", () => {
  const n = lib.imageNeeds(fx.narrative);
  assert.deepStrictEqual(n.map((x) => x.kind), ["generate", "generate", "generate", "reuse", "plate"]);
  assert.strictEqual(n[3].owner, 2);
});

test("notice period round-trips and bad text is refused", () => {
  assert.deepStrictEqual(lib.parseNoticePeriod(fx.narrative.notice), { start: "2026-02-19", end: "2026-10-19" });
  assert.strictEqual(lib.parseNoticePeriod("nothing here"), null);
});

test("voices: ssp_male defaults to the ssp-prospect narrator, ssp_female needs a setting", () => {
  assert.strictEqual(lib.voiceIdFor("ssp_male", {}), "32k6j8e9sZJuuBXxDcVP");
  assert.strictEqual(lib.voiceIdFor("ssp_female", {}), null);
  assert.strictEqual(lib.voiceIdFor("ssp_female", { AGENT_MARKETING_VOICE_SSP_FEMALE: "x" }), "x");
});

test("director: figures are matched by value and context, not guessed", () => {
  const figs = director.figuresFrom(fx.reportFigures);
  const f = director.figuresInExcerpt("Active listings are sitting a median of 41 days before going under contract.", figs);
  assert.deepStrictEqual(f.map((x) => x.ref), ["r1.f7"]);
  assert.strictEqual(figs.find((x) => x.ref === "r1.f16").n, 46);
  assert.strictEqual(figs.find((x) => x.ref === "r1.f7").n, 14);
});

test("the rewritten Natomas script (pauses, ellipses) still builds a valid manifest", () => {
  const NEW = "[conversational] If you're thinking about selling in Natomas, new construction is part of your competition. Giving buyers more options. [pause] So what does the resale market actually show? Active listings are sitting a median of 41 days before going under contract\u2026 and homes that closed sold at an average of 99.4% of the list price. [thoughtful] But the active market, 6 of 14 listings have already taken a price reduction. That gap between homes that sold and homes that didn't tells a real story. [emphasis] This means condition and pricing precision matter\u2026 New construction sets a baseline so your home has to answer for itself. [warm] Want to talk through where your home fits in that picture? I'm happy to walk you through it.";
  const EX = [
    "If you're thinking about selling in Natomas, new construction is part of your competition. Giving buyers more options.",
    "So what does the resale market actually show? Active listings are sitting a median of 41 days before going under contract\u2026",
    "and homes that closed sold at an average of 99.4% of the list price. But the active market, 6 of 14 listings have already taken a price reduction. That gap between homes that sold and homes that didn't tells a real story.",
    "This means condition and pricing precision matter\u2026 New construction sets a baseline so your home has to answer for itself.",
    "Want to talk through where your home fits in that picture? I'm happy to walk you through it.",
  ];
  const narrative = { ...fx.narrative, narrationTagged: NEW, scenes: fx.narrative.scenes.map((s, i) => ({ ...s, narrationExcerpt: EX[i] })) };
  const w = timing.captionWords(NEW).map((t, i) => ({ text: t, start: 0.3 + i * 0.33, end: 0.3 + i * 0.33 + 0.3 }));
  const r = lib.buildManifest(input({ narrative, narrationTagged: NEW, audio: { narration_key: "a.mp3", duration_sec: w[w.length - 1].end + 0.5, words: w } }));
  assert.deepStrictEqual(r.validation.errors, [], JSON.stringify(r.validation.errors));
  const takeaway = r.manifest.scenes[3].data;
  assert.deepStrictEqual(takeaway.headline, ["This Means Condition and", "Pricing Precision Matter"]);
  assert.strictEqual(takeaway.statement, "", "a 13-word sentence is over the 7-word statement cap, so the card carries no statement");
  assert.ok(r.manifest.captions.some((c) => /\u2026/.test(c.text)), "ellipses stay in the captions");
});

test("a figure card arrives when its number is spoken, and the comparison scene gets a headline from the script", () => {
  const { manifest } = lib.buildManifest(input());
  const stat = manifest.scenes[1], cmp = manifest.scenes[2];
  const spoken41 = words.find((w) => w.text === "41");
  assert.ok(stat.card_start_sec > stat.window.start + 0.7, "not at the start of the leading sentence");
  assert.ok(Math.abs(stat.card_start_sec - (spoken41.start - 0.6)) < 0.02, "about half a second before the number");
  assert.strictEqual(cmp.data.market, "That Gap Tells");
  assert.strictEqual(cmp.data.kind, "A Real Story");
  assert.strictEqual(manifest.scenes[0].card_start_sec, undefined);
});

test("narration shaping comes from the environment, with a deeper default, and reaches the manifest", () => {
  assert.deepStrictEqual(lib.voiceShapeFrom({}), { semitones: -1.5, bass_db: 3 });
  assert.deepStrictEqual(lib.voiceShapeFrom({ AGENT_MARKETING_VOICE_SEMITONES: "-9", AGENT_MARKETING_VOICE_BASS_DB: "20" }), { semitones: -4, bass_db: 8 });
  assert.strictEqual(lib.voiceShapeFrom({ AGENT_MARKETING_VOICE_SEMITONES: "0", AGENT_MARKETING_VOICE_BASS_DB: "0" }), null);
  const { manifest, validation } = lib.buildManifest(input({ voiceShape: { semitones: -1.5, bass_db: 3 } }));
  assert.deepStrictEqual(manifest.audio.voice_shape, { semitones: -1.5, bass_db: 3 });
  assert.deepStrictEqual(validation.errors, []);
});

test("a takeaway statement that starts with a joining word reads as its own sentence", () => {
  const narrative = { ...fx.narrative, scenes: fx.narrative.scenes.map((s, i) => (i === 3 ? { ...s, narrationExcerpt: "Condition and pricing precision matter… because new construction sets a baseline." } : s)) };
  const pl = director.plan(narrative, fx.intake, director.figuresFrom(fx.reportFigures));
  assert.strictEqual(pl.scenes[3].data.statement, "New construction sets a baseline.");
});

test("imageNeeds: image of you is generated, own photos override, an unadded optional photo becomes a plate", () => {
  const n = { scenes: [
    { visualSource: "GPT_IMAGE_2_CONCEPT", aiGenerationPrompt: "keys" },
    { visualSource: "GPT_IMAGE_2_CONCEPT", aiGenerationPrompt: "kitchen" },
    { visualSource: "CONCEPT_REUSE", reuseOfScene: 1 },
    { visualSource: "AUTHENTIC_AGENT_ASSET" },
    { visualSource: "AGENT_SCENE", aiGenerationPrompt: "agent on a sidewalk" },
    { visualSource: "AGENT_PROFILE" },
  ] };
  const a = lib.imageNeeds(n);
  assert.deepStrictEqual(a.map((x) => x.kind), ["generate", "generate", "reuse", "plate", "generate", "unsupported"]);
  assert.strictEqual(a[4].imageKind, "agent_scene");
  const b = lib.imageNeeds(n, new Set([0, 2, 3, 5]));
  assert.deepStrictEqual(b.map((x) => x.kind), ["own", "generate", "reuse", "own", "generate", "own"]); // reuse is never overridden
});

test("a statement card may repeat any figure the uploaded report states, and a number the report never states still fails", () => {
  const manifestLib = require("../netlify/functions/lib/agent-marketing-manifest-lib");
  const { manifest } = lib.buildManifest(input());
  const stated = fx.reportFigures.find((f) => f.ref && !manifest.figures.some((m) => m.ref === f.ref) && Number.isInteger(director.figuresFrom([f])[0].value) && director.figuresFrom([f])[0].value > 1999 === false);
  assert.ok(stated, "the fixture has an unclaimed report figure");
  const val = director.figuresFrom([stated])[0].value;
  const mk = (text) => { const m = JSON.parse(JSON.stringify(manifest)); m.scenes[3].data = { headline: ["A", "B"], statement: text, support: "" }; return manifestLib.validateManifest(m); };
  assert.deepStrictEqual(mk(`Listings sat a median of ${val} days.`).errors.filter((e) => e.code === "number"), []);
  assert.ok(mk("Listings sat a median of 7777 days.").errors.some((e) => e.code === "number"));
});

test("a report figure with a half value may be read rounded on a statement card", () => {
  const manifestLib = require("../netlify/functions/lib/agent-marketing-manifest-lib");
  const rf = [...fx.reportFigures, { ref: "r1.f99", key: "median_dom", label: "Median days on market of closed sales", display: "19.5 days", text: "x" }];
  const { manifest } = lib.buildManifest(input({ reportFigures: rf }));
  const m = JSON.parse(JSON.stringify(manifest));
  m.scenes[3].data = { headline: ["A", "B"], statement: "Closed sales moved in a median of 20 days.", support: "" };
  assert.deepStrictEqual(manifestLib.validateManifest(m).errors.filter((e) => e.code === "number"), []);
});

// ── Claude-written card text (Oct 27, 2026): word caps 9/7/8, opinion not a repeat of the narration, per-scene fallback ──
const cardCopyLib = require("../netlify/functions/lib/agent-marketing-cardcopy-lib");
const antelope = { scenes: [
  { role: "Local hook", narrationExcerpt: "Half of Antelope's active listings have already cut their price." },
  { role: "Tension", narrationExcerpt: "Right now, 28 of the 56 active listings have taken a price reduction, and 33 out of 56 closed at or above list price." },
  { role: "Insight", narrationExcerpt: "The difference isn't the market\u2014it's the starting point. Canceled listings sat a median of 49 days and never found a buyer. Closed sales moved in a median of 20 days." },
  { role: "Consequence", narrationExcerpt: "This means pricing right the first time is what separates a clean close from a listing that quietly disappears." },
  { role: "Close", narrationExcerpt: "If you'd like a second opinion on pricing, send me a message." },
], hook: "Half of Antelope's active listings have already cut their price" };
const antelopeFigs = []; // no matching report figure, so the middle scenes are statement cards as in the real Antelope Reel

test("fallback card text respects the 9/7/8 caps, starts with a capital and never ends on a dangling word", () => {
  const pl = director.plan(antelope, { market: "Antelope" }, antelopeFigs);
  for (const i of [1, 2, 3]) {
    const d = pl.scenes[i].data;
    assert.ok(pl.scenes[i].composition === "expert_takeaway");
    assert.ok(cardCopyLib.wordsOf(d.headline.join(" ")).length <= 9, d.headline.join(" "));
    assert.ok(cardCopyLib.wordsOf(d.statement).length <= 7 && cardCopyLib.wordsOf(d.support).length <= 8);
    d.headline.forEach((l) => assert.match(l, /^[A-Z0-9]/, "each headline line starts with a capital or a figure"));
  }
  assert.deepStrictEqual(pl.scenes[3].data.headline.join(" "), "Pricing Right the First Time");
});

test("card copy validation: caps, numbers that are not in the scene, and echoing the narration are all rejected", () => {
  const ctx = { narration: antelope.scenes[2].narrationExcerpt, allowed: [49, 20] };
  const v = (c) => cardCopyLib.validateCard(c, ctx);
  assert.ok(v({ headline: "Starting point beats the market", statement: "Price it like a buyer would", support: "That is what moves a home" }).ok);
  assert.strictEqual(v({ headline: "one two three four five six seven eight nine ten" }).ok, false);
  assert.strictEqual(v({ headline: "A fine headline", statement: "one two three four five six seven eight" }).ok, false);
  assert.strictEqual(v({ headline: "A fine headline", support: "one two three four five six seven eight nine" }).ok, false);
  assert.strictEqual(v({ headline: "Homes sat 62 days before canceling" }).ok, false, "62 is not in the scene");
  assert.ok(v({ headline: "Canceled homes waited 49 days" }).ok, "49 is in the scene");
  assert.strictEqual(v({ headline: "Closed sales moved in a median of 20 days" }).ok, false, "repeats the narration");
  assert.strictEqual(v({ headline: "" }).ok, false);
});

test("writeCardCopy asks Claude only for the statement scenes, keeps good cards and falls back for bad ones", async () => {
  const seen = [];
  const callFn = async (sys, user) => {
    seen.push(JSON.parse(user));
    return JSON.stringify({ cards: [
      { index: 2, headline: "Where you start decides how it ends", statement: "Canceled homes waited the longest", support: "Price like a buyer sees it" },
      { index: 3, headline: "This means pricing right the first time is what separates a clean close", statement: "", support: "" },
    ] });
  };
  const out = await cardCopyLib.writeCardCopy({ project: { template: "local_market_insider", intake: { market: "Antelope" } }, narrative: antelope, intake: { market: "Antelope" }, reportFigures: [], callFn });
  assert.deepStrictEqual(seen[0].scenes.map((s) => s.index), [1, 2, 3], "only the middle statement scenes are sent, not the opening or closing");
  assert.ok(out[2] && out[2].headline === "Where you start decides how it ends");
  assert.strictEqual(out[3], undefined, "scene 4 copied the narration, so it falls back");
  const pl = director.plan(antelope, { market: "Antelope" }, [], { cardCopy: out });
  assert.deepStrictEqual(pl.scenes[2].data.headline.join(" "), "Where You Start Decides How It Ends");
  assert.strictEqual(pl.scenes[2].data.statement, "Canceled homes waited the longest");
  assert.match(pl.scenes[2].reason, /agent's perspective/);
  const none = await cardCopyLib.writeCardCopy({ project: {}, narrative: antelope, intake: { market: "Antelope" }, reportFigures: [], callFn: async () => { throw new Error("down"); } });
  assert.deepStrictEqual(none, {}, "a model failure never fails the Reel");
});
