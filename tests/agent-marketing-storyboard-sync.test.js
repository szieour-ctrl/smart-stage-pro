"use strict";
// Nov 14, 2026 (Sam, Option 2 beta): the subscriber's approved narration is final. The storyboard is rebuilt FROM it (one planning call, scenes cut at
// sentence boundaries by code), unchanged scripts make no call, a failure is explicit and never falls back to the old scenes, and nothing downstream
// edits the approved words. Every model call here is a stub: no cost.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");
const am = require("../netlify/functions/lib/agent-marketing-lib");
const director = require("../netlify/functions/lib/agent-marketing-director-lib");
const timing = require("../netlify/functions/lib/agent-marketing-timing-lib");

const TEST_DB = "https://test-ref.supabase.co";
async function withFlag(on, fn, db) {
  const keep = { b: process.env.AGENT_MARKETING_B1_EVIDENCE, u: process.env.SUPABASE_URL };
  if (on) process.env.AGENT_MARKETING_B1_EVIDENCE = "dev"; else delete process.env.AGENT_MARKETING_B1_EVIDENCE;
  process.env.SUPABASE_URL = db || TEST_DB;
  try { return await fn(); } finally {
    if (keep.b === undefined) delete process.env.AGENT_MARKETING_B1_EVIDENCE; else process.env.AGENT_MARKETING_B1_EVIDENCE = keep.b;
    if (keep.u === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = keep.u;
  }
}

const fig = (key, text) => ({ key, ref: "r1." + key, role: "area_statistic", text, label: key, period: "October 2026", areaLabel: "ROSEVILLE", scopeKind: "exact", partialPeriod: false, partialComparison: false });
const TOPIC = {
  id: "t2", question: "A monthly payment jumped $354 since last year. How does that reshape who can buy my home?", trendSignals: [], scope: "selected", origin: "web", reportFirst: false,
  reportFigures: [
    fig("count_active", "ROSEVILLE, October 2026: Active listings: 443 up 2.8% from September 2026; up 19.7% from October 2025 (Oct 1, 2026 to Oct 31, 2026)"),
    fig("count_closed", "ROSEVILLE, October 2026: Closed sales: 139 down 16.8% from September 2026; down 28.4% from October 2025 (Oct 1, 2026 to Oct 31, 2026)"),
  ],
  reportPrecedence: [], sources: [{ url: "https://www.example.org/roseville-update", kind: "article", role: "primary", title: "Roseville Market Update", domain: "example.org", published: "2026-10-20" }],
  b2: { editorialAngle: "OLD ANGLE: a $354 payment jump shrinks the buyer pool.", mechanism: "m", homeownerImplication: "OLD IMPLICATION", article: { title: "Local update" } },
};
const project = (dur = 45) => ({ id: "p1", template: "local_market_insider", duration_sec: dur, intake: { market: "Roseville, CA", audience: "Home sellers", issue: "x", action: "y", observation: "" }, selected_topic: TOPIC });

// A complete replacement: nothing here is in the AI plan (no $354, no 19.7%).
const REPLACED = "[curious] What if Roseville's market isn't slowing because of supply, but because buyers can no longer afford the homes they want? "
  + "[conversational] October's Market Trend Report shows closed sales fell nearly 17 percent from September. That is a meaningful shift in market conditions. "
  + "[confident] Here's what I see. Higher mortgage rates and elevated prices are squeezing buyer purchasing power. Buyers haven't stopped wanting homes. "
  + "They're reconsidering what they can comfortably afford. For Roseville homeowners, that changes the conversation. "
  + "Yesterday's selling prices don't necessarily reflect what today's buyers can pay. Pricing has to account for affordability, competition, and buyer expectations. "
  + "[warm] Considering selling? Let's evaluate your home against today's market and develop a strategy that makes sense for your next move.";
const caption = (t) => am.stripAudioTags(t).replace(/\s+/g, " ").trim();

// The AI plan the subscriber started from (scenes about the discarded script).
const OLD_SCENES = ["Has your buyer pool quietly shrunk since last year? Here's what I think sellers need to hear.", "A buyer on a median-priced home pays $3,408 a month, $354 more than a year ago, assuming 20% down.", "That's not a paper number, that's who can qualify.", "My report shows active listings up 19.7%.", "I keep a close eye on this, so let's talk."]
  .map((t, i) => ({ index: i, role: ["hook", "article", "interp", "data", "cta"][i], narrationExcerpt: t, purpose: "OLD PURPOSE " + i + " about $354", visualBrief: "OLD BRIEF " + i, aiGenerationPrompt: "OLD PROMPT " + i, sourceRole: i === 1 || i === 2 ? "article" : "data", visualSource: "GPT_IMAGE_2_CONCEPT" }));
const AI_NARRATION = OLD_SCENES.map((s) => s.narrationExcerpt).join(" ");
const approved = (text, extra = {}) => ({
  source: "edited", status: "ready", narrationTagged: text, captionText: caption(text), wordCount: am.countWords(text), editorialAngle: "OLD ANGLE", hook: "OLD HOOK", claimsToVerify: ["OLD CLAIM 2.8 months supply"],
  scenes: OLD_SCENES.map((s) => ({ ...s })), scenesFor: am.narrationKey(AI_NARRATION), approvedAt: "2026-11-14T00:00:00Z", gateVersion: "g1", ...extra,
});

// A planner stub that describes whatever scenes it is given. It tries to misbehave: it returns its own (rewritten) excerpts and an old figure in a brief.
function stub(opts = {}) {
  const sent = [];
  const fn = async (system, user) => {
    sent.push({ system, user });
    const given = JSON.parse(user).scenes;
    const scenes = given.map((g, i) => ({
      index: g.index, role: "scene " + i, purpose: "Shows: " + g.narration_excerpt.slice(0, 30), narration_excerpt: "REWRITTEN BY THE MODEL " + i,
      visual_source: i === 0 || i === 2 || i === 4 ? "GPT_IMAGE_2_CONCEPT" : "CONCEPT_REUSE", reuse_of_scene: i === 0 || i === 2 || i === 4 ? null : 1, card_text: null,
      source_role: opts.roles ? opts.roles[i] : (/October's Market Trend Report/.test(g.narration_excerpt) ? "article" : "data"),
      visual_brief: "A calm Roseville street for scene " + i, ai_generation_prompt: i === 0 || i === 2 || i === 4 ? "Photorealistic editorial street scene " + i : null,
      camera_motion: "push_in", framing_9x16: "center", framing_16x9: "wide", text_safe_placement: "top",
      visual_objective: "o", photographic_direction: "d", contrast_with_previous: "c", overlay_relationship: "r",
    }));
    return JSON.stringify(opts.mutate ? opts.mutate({ scenes }) : { scenes });
  };
  fn.sent = sent;
  return fn;
}

test("segmentation: scenes are cut only at sentence ends, keep every word in order, and stay inside the scene range", () => {
  for (const dur of [45, 60]) {
    const seg = planLib.segmentNarration(caption(REPLACED), dur);
    assert.ok(!seg.error, seg.error);
    const [lo, hi] = planLib.SCENE_RANGE[dur];
    assert.ok(seg.segments.length >= lo && seg.segments.length <= hi);
    assert.strictEqual(seg.segments.join(" "), caption(REPLACED));
    seg.segments.forEach((s) => { assert.match(s, /[.!?]$/, "every scene ends where a sentence ends: " + s); assert.ok(am.countWords(s) >= 8); });
  }
});

test("segmentation: a script too short for a coherent plan is an explicit, actionable error, never a guess", () => {
  const r = planLib.segmentNarration("Rates moved. Buyers changed. Call me.", 45);
  assert.match(r.error, /too short/);
  assert.ok(!r.segments);
});

test("narrationKey: punctuation, case, spacing and audio tags do not count; a changed word does; an unchanged script needs no storyboard", () => {
  assert.strictEqual(am.narrationKey("[warm] Hello,   World!"), am.narrationKey("hello world"));
  assert.notStrictEqual(am.narrationKey("hello world"), am.narrationKey("hello there"));
  assert.strictEqual(am.storyboardNeeded({ source: "edited", narrationTagged: AI_NARRATION, scenesFor: am.narrationKey(AI_NARRATION) }), false);
  assert.strictEqual(am.storyboardNeeded({ source: "edited", narrationTagged: AI_NARRATION + " More.", scenesFor: am.narrationKey(AI_NARRATION) }), true);
  assert.strictEqual(am.storyboardNeeded({ source: "claude", narrationTagged: "x" }), false);
});

test("complete replacement: ONE call, the approved words untouched, scenes at sentence ends, no old plan text anywhere in the rebuilt storyboard", async () => {
  await withFlag(true, async () => {
    const call = stub();
    const n = approved(REPLACED);
    const out = await planLib.rebuildApprovedStoryboard({ project: project(), narrative: n, anthropicKey: "k", callFn: call });
    assert.strictEqual(call.sent.length, 1, "one storyboard-planning call");
    ["narrationTagged", "captionText", "wordCount", "approvedAt", "gateVersion"].forEach((k) => assert.deepStrictEqual(out[k], n[k], k + " is untouched"));
    assert.strictEqual(out.scenes.map((s) => s.narrationExcerpt).join(" "), caption(REPLACED), "the scenes carry the narration's own words, not the model's");
    assert.ok(out.scenes.every((s) => /[.!?]$/.test(s.narrationExcerpt)));
    const dump = JSON.stringify({ scenes: out.scenes, angle: out.editorialAngle, claims: out.claimsToVerify, hook: out.hook });
    assert.ok(!/OLD |\$354|19\.7|REWRITTEN BY THE MODEL/.test(dump), "nothing from the discarded plan or the model's own text survives: " + dump.slice(0, 200));
    assert.strictEqual(out.editorialAngle, "");
    assert.deepStrictEqual(out.claimsToVerify, []);
    assert.strictEqual(out.hook, planLib.sentenceUnits(caption(REPLACED))[0]);
    assert.strictEqual(out.scenesFor, am.narrationKey(REPLACED));
    assert.strictEqual(am.storyboardNeeded(out), false, "a rebuilt script is not rebuilt again (a retry makes no second call)");
  });
});

test("the model is shown the approved scenes and the stored topic, never the first draft's editorial direction, hook, angle or old scenes", async () => {
  await withFlag(true, async () => {
    const call = stub();
    await planLib.rebuildApprovedStoryboard({ project: project(), narrative: approved(REPLACED), anthropicKey: "k", callFn: call });
    const { system, user } = call.sent[0];
    assert.match(system, /approved narration is FINAL/);
    assert.ok(!/\b2i\. EDITORIAL DIRECTION|TAKE A POSITION|ONE GOVERNING EDITORIAL PREMISE/.test(system), "no editorial rule is in the storyboard prompt");
    assert.ok(/ 9\. ai_generation_prompt|^9\. ai_generation_prompt/m.test(system) && /^8\. /m.test(system), "the existing visual rules are kept");
    assert.ok(!/OLD ANGLE|OLD IMPLICATION|editorial_direction|OLD HOOK|OLD PURPOSE|OLD PROMPT|\$3,408/.test(user), "nothing from the discarded plan or B2's direction is sent");
    assert.ok(/figures_you_may_state/.test(user), "the stored report figures are sent so source roles can be set");
    assert.strictEqual(JSON.parse(user).scenes.map((s) => s.narration_excerpt).join(" "), caption(REPLACED));
  });
});

test("source roles follow the figures the approved script actually states, at any position, and the article credit follows them", async () => {
  await withFlag(true, async () => {
    const call = stub({ roles: ["article", "article", "data", "data", "data"] });
    const out = await planLib.rebuildApprovedStoryboard({ project: project(), narrative: approved(REPLACED), anthropicKey: "k", callFn: call });
    assert.deepStrictEqual(out.scenes.map((s) => s.sourceRole), ["article", "article", "data", "data", "data"], "an opening scene may carry the article");
    assert.deepStrictEqual(out.sourceCredit && out.sourceCredit.scenes, [0, 1], "the credit sits on the scenes labeled article now");
  });
});

test("deleted statistics do not reappear: on-screen text is built from the rebuilt scenes and the figures they state", async () => {
  await withFlag(true, async () => {
    const out = await planLib.rebuildApprovedStoryboard({ project: project(), narrative: approved(REPLACED), anthropicKey: "k", callFn: stub() });
    const pl = director.plan({ ...out }, { market: "Roseville" }, director.figuresFrom(TOPIC.reportFigures), {});
    const shown = JSON.stringify(pl.scenes.map((s) => s.data));
    assert.ok(!/354|19\.7|443|139/.test(shown), "no deleted figure on a card");
    pl.scenes.forEach((s, i) => { if (i > 0 && i < pl.scenes.length - 1) assert.notStrictEqual(s.composition, "stat_big_number"); });
    // The opening headline comes from a whole first sentence (the earlier boundary cut it mid-sentence: "...Because There Are"); the closing card is the closing sentences.
    assert.ok(/[?.!]$/.test(out.scenes[0].narrationExcerpt) && !/\bbecause there are$/i.test(String([].concat(pl.scenes[0].data.headline).join(" "))), "the opening headline is built from a whole sentence");
    assert.ok(/[.!?]$/.test(out.scenes[out.scenes.length - 1].narrationExcerpt));
    assert.deepStrictEqual(pl.problems, []);
  });
});

test("partial edit: the same one-call rebuild, scenes and on-screen text follow the edited words (a deleted statistic is gone)", async () => {
  await withFlag(true, async () => {
    const edited = AI_NARRATION.replace(" My report shows active listings up 19.7%.", "").replace("That's not a paper number, that's who can qualify.", "Fewer buyers can qualify at today's payment, and that is the point.") + " Ask me anything about your price.";
    const call = stub();
    const out = await planLib.rebuildApprovedStoryboard({ project: project(), narrative: approved(edited), anthropicKey: "k", callFn: call });
    assert.strictEqual(call.sent.length, 1);
    assert.strictEqual(out.scenes.map((s) => s.narrationExcerpt).join(" "), caption(edited));
    assert.ok(!/19\.7/.test(JSON.stringify(out.scenes)));
  });
});

test("a failed storyboard is explicit and substitutes nothing: model error, missing scenes, no image prompt, a script too short", async () => {
  await withFlag(true, async () => {
    const n = approved(REPLACED);
    const run = (call, narrative = n) => planLib.rebuildApprovedStoryboard({ project: project(), narrative, anthropicKey: "k", callFn: call });
    const bad = (e) => { assert.strictEqual(e.code, "storyboard_failed"); assert.match(e.message, /Your script is unchanged|too short|too few/); return true; };
    await assert.rejects(run(async () => { throw new Error("network down"); }), bad);
    await assert.rejects(run(async () => "not json"), bad);
    await assert.rejects(run(stub({ mutate: (r) => ({ scenes: r.scenes.slice(0, 3) }) })), bad);
    await assert.rejects(run(stub({ mutate: (r) => ({ scenes: r.scenes.map((s, i) => (i === 0 ? { ...s, ai_generation_prompt: null } : s)) }) })), bad);
    await assert.rejects(run(stub(), approved("Rates moved. Buyers changed. Call me.")), bad);
    assert.strictEqual(n.narrationTagged, REPLACED, "the approved narration is unchanged by every failure");
    assert.deepStrictEqual(n.scenes.map((s) => s.narrationExcerpt), OLD_SCENES.map((s) => s.narrationExcerpt), "the caller still holds the old scenes untouched; nothing was merged into them");
  });
});

test("no downstream editorial rewriting: the storyboard path never calls the gate, the length editor or the planner's script writer", () => {
  const lib = fs.readFileSync(path.join(__dirname, "..", "netlify/functions/lib/agent-marketing-plan-lib.js"), "utf8");
  const body = lib.slice(lib.indexOf("async function generateStoryboard"), lib.indexOf("async function rebuildApprovedStoryboard") + 1200);
  assert.ok(!/gateNarrative|editLengthByScene|anchoredRewriteMessage|buildSystemPrompt\(/.test(body), "no gate, editor or script-writing prompt in the storyboard path");
});

test("the prepare job: rebuilds only for an edited script that no longer matches its scenes, with the failure path stopping the job with the explicit message", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "netlify/functions/agent-marketing-prepare-background.js"), "utf8");
  assert.match(src, /enabled\(\) && am\.storyboardNeeded\(narrative\)/);
  assert.match(src, /rebuildApprovedStoryboard/);
  assert.match(src, /e\.code === "storyboard_failed" \? e\.message/);
  assert.ok(src.indexOf("storyboardNeeded") < src.indexOf("await prepareNarration(job"), "the storyboard is settled before the voice and images are made");
});

test("production without the article-led switch is unchanged: no storyboard rebuild is asked for, and the first and last scene stay data", async () => {
  await withFlag(false, async () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "netlify/functions/agent-marketing-prepare-background.js"), "utf8");
    assert.match(src, /b1-evidence-lib"\)\.enabled\(\) && am\.storyboardNeeded/);
    const raw = { editorial_angle: "a", hook: "h", narration_with_audio_tags: AI_NARRATION, scenes: OLD_SCENES.map((s) => ({ role: s.role, narration_excerpt: s.narrationExcerpt, purpose: "p", visual_source: "GPT_IMAGE_2_CONCEPT", source_role: "article", visual_brief: "b", ai_generation_prompt: "p" })) };
    const n = planLib.normalizePlan(raw, project()).narrative;
    assert.strictEqual(n.scenes[0].sourceRole, "data");
    assert.strictEqual(n.scenes[n.scenes.length - 1].sourceRole, "data");
  });
});

test("save_narrative keeps the plan only for the words it was planned for (source check of the handler)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "netlify/functions/agent-marketing-project.js"), "utf8");
  assert.match(src, /scenesFor/);
  assert.match(src, /scenesStale: changed/);
  assert.match(src, /editorialAngle: changed \? ""/);
  assert.match(src, /claimsToVerify: changed \? \[\]/);
});

test("realignment is still the interim board for an edited script (partial edit keeps sentence-sized scenes), and the rebuild replaces it at render", () => {
  const edited = AI_NARRATION.replace(" My report shows active listings up 19.7%.", "");
  const r = timing.realignScenes(OLD_SCENES, edited);
  assert.strictEqual(r.scenes.map((s) => s.narrationExcerpt).join(" ").replace(/\s+/g, " "), edited);
});
