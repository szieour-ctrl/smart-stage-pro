"use strict";
// Nov 13, 2026 (Sam; Test only): E5 controlled experiment. Test B removes exactly two causal restrictions (rule 2h's "explanation finding" sentence and
// rule 2n's final clause); with no marker every prompt is byte-identical; the marker works only in Test; diagnostics capture the first draft.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const PROD = "25f3118fed1b9726fc4dc78b16dcc92233cef785d3c074ef89a6ee7aaf7b0495";
const DEV = "15f2c9382ae3937f76f9fbb800c673e353af9b131c7d903f0eefe5be7e2a8441";
function withDev(on, fn) {
  const prev = process.env.AGENT_MARKETING_B1_EVIDENCE;
  if (on) process.env.AGENT_MARKETING_B1_EVIDENCE = "dev"; else delete process.env.AGENT_MARKETING_B1_EVIDENCE;
  try { return fn(); } finally { if (prev === undefined) delete process.env.AGENT_MARKETING_B1_EVIDENCE; else process.env.AGENT_MARKETING_B1_EVIDENCE = prev; }
}

async function withDevAsync(on, fn) {
  const prev = process.env.AGENT_MARKETING_B1_EVIDENCE;
  if (on) process.env.AGENT_MARKETING_B1_EVIDENCE = "dev"; else delete process.env.AGENT_MARKETING_B1_EVIDENCE;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.AGENT_MARKETING_B1_EVIDENCE; else process.env.AGENT_MARKETING_B1_EVIDENCE = prev; }
}

test("with no variant the Test and production prompts keep their pinned hashes", () => {
  assert.strictEqual(withDev(false, () => sha(planLib.buildSystemPrompt())), PROD);
  assert.strictEqual(withDev(true, () => sha(planLib.buildSystemPrompt(undefined, { scoped: false }))), DEV);
});

test("the relaxed variant removes exactly the two spans and nothing else", () => {
  withDev(true, () => {
    const a = planLib.buildSystemPrompt(undefined, { scoped: false });
    const b = planLib.buildSystemPrompt(undefined, { scoped: false, causalVariant: "relaxed" });
    assert.notStrictEqual(a, b);
    assert.match(a, /present a cause or explanation only when a validated finding of kind "explanation" states it, as that source's view;/);
    assert.match(a, /do not invent a cause for a single figure\./);
    assert.ok(!/present a cause or explanation only when/.test(b));
    assert.ok(!/A quotation shows what the article says, not why something happened/.test(b));
    assert.ok(!/do not invent a cause for a single figure/.test(b));
    // the attribution sentence is retained, and the rest of both rules is unchanged
    assert.match(b, /If its attribution says no data or source is given, say it is their view and do not present it as established\./);
    assert.match(b, /worded with the confidence the evidence earns \(rule 2o\)\./);
    const restore = b.replace("If its attribution says no data", "A quotation shows what the article says, not why something happened: present a cause or explanation only when a validated finding of kind \"explanation\" states it, as that source's view; if its attribution says no data")
      .replace("explanation, worded with the confidence the evidence earns (rule 2o).", "explanation, worded with the confidence the evidence earns (rule 2o); do not invent a cause for a single figure.");
    assert.strictEqual(restore, a, "the only differences are the two removed spans");
    // factual protections remain in the variant
    assert.match(b, /NEVER invent numbers/);
    assert.match(b, /do not state the finding more strongly than they allow/);
    assert.match(b, /an unsupported factual assertion/i);
  });
});

test("the variant cannot take effect outside Test", () => {
  const p = withDev(false, () => planLib.buildSystemPrompt(undefined, { causalVariant: "relaxed" }));
  assert.strictEqual(sha(p), PROD);
  assert.strictEqual(withDev(false, () => planLib.experimentOf({ intake: { experiment: "causal_relaxed" } })), null);
});

test("experimentOf reads only the two exact markers in Test", () => {
  withDev(true, () => {
    assert.strictEqual(planLib.experimentOf({ intake: { experiment: "causal_current" } }), "current");
    assert.strictEqual(planLib.experimentOf({ intake: { experiment: "causal_relaxed" } }), "relaxed");
    assert.strictEqual(planLib.experimentOf({ intake: { experiment: "other" } }), null);
    assert.strictEqual(planLib.experimentOf({ intake: {} }), null);
    assert.strictEqual(planLib.experimentOf(null), null);
  });
});

test("the marker does not change the intake hash", () => {
  const base = { angle: "a", market: "m", audience: "u", issue: "i", action: "x", observation: "o" };
  assert.strictEqual(planLib.intakeHash(base, { id: "t2", researchId: "r" }), planLib.intakeHash({ ...base, experiment: "causal_relaxed" }, { id: "t2", researchId: "r" }));
});

// ---- instrumentation through generatePlan (fake model) ----
const am = require("../netlify/functions/lib/agent-marketing-lib");
const intake = { angle: "neighborhood", market: "Roseville, CA", audience: "Home sellers", issue: "Supply and buyer demand", action: "Understand the trade-off", observation: "Buyers have more choices." };
const TAGS = ["[conversational]", "[thoughtful]", "[emphasis]", "[confident]", "[warm]", "[calm]"];
const ROLE_OF = ["local_hook", "tension", "insight", "advice", "advice"];
const scene = (text, i, last) => ({ role: i === last ? "cta" : ROLE_OF[i], narration_excerpt: text, purpose: "p" + i, visual_source: i < 3 ? "GPT_IMAGE_2_CONCEPT" : (i === last ? "BRAND_CARD" : "CONCEPT_REUSE"),
  visual_brief: "brief " + i, reuse_of_scene: i < 3 || i === last ? null : 0, card_text: i === last ? "Ask me for a local view" : null,
  ai_generation_prompt: i < 3 ? "Photorealistic editorial tabletop with architectural home models, soft light, no people, no text" : null, camera_motion: "push_in",
  framing_9x16: "keep homes visible", framing_16x9: "keep wide street", text_safe_placement: "lower middle", source_role: "data" });
const reply = (texts) => JSON.stringify({ editorial_angle: "Higher payments narrow the buyer pool.", hook: texts[0], narration_with_audio_tags: texts.map((x, i) => `${TAGS[i % TAGS.length]} ${x}`).join(" "),
  scenes: texts.map((t, i) => scene(t, i, texts.length - 1)), cta_suggestion: "Ask me.", claims_to_verify: ["rate source"], missing_agent_inputs: [] });
const TEXTS = ["Is that really what is happening in this market today?", "Buyers have more choices now and that changes how a prepared home gets priced here.", "Payments are higher so fewer buyers can reach the same price.", "Price it where a qualified buyer can actually say yes.", "Want to talk it through? Message me."];
const proj = (experiment) => ({ template: "local_market_insider", duration_sec: 45, formats: ["9x16", "16x9"], intake: { ...intake, ...(experiment ? { experiment } : {}) } });

test("a marked Test project records variant, prompt hash, first draft and call count; every call uses the same prompt", async () => {
  await withDevAsync(true, async () => {
    for (const [marker, variant] of [["causal_current", "current"], ["causal_relaxed", "relaxed"]]) {
      const systems = [];
      const callFn = async (sys, u, k, sink) => { systems.push(sys); sink.push({ model: "m", input_tokens: 10, output_tokens: 5 }); return reply(TEXTS); };
      const r = await planLib.generatePlan({ project: proj(marker), anthropicKey: "k", callFn });
      const x = r.narrative.lengthDiagnostics.experiment;
      assert.strictEqual(x.variant, variant);
      assert.strictEqual(x.promptSha256, sha(systems[0]));
      assert.ok(systems.every((s) => s === systems[0]));
      assert.strictEqual(/do not invent a cause for a single figure/.test(systems[0]), variant === "current");
      assert.match(x.initialDraft.narration, /Buyers have more choices/);
      assert.strictEqual(x.initialDraft.editorialAngle, "Higher payments narrow the buyer pool.");
      assert.deepStrictEqual(x.initialDraft.claimsToVerify, ["rate source"]);
      assert.strictEqual(x.modelCalls, systems.length);
    }
    const r = await planLib.generatePlan({ project: proj(null), anthropicKey: "k", callFn: async () => reply(TEXTS) });
    assert.ok(!r.narrative.lengthDiagnostics.experiment, "no capture without the marker");
  });
  await withDevAsync(false, async () => {
    const r = await planLib.generatePlan({ project: proj("causal_relaxed"), anthropicKey: "k", callFn: async (sys) => { assert.strictEqual(sha(sys), PROD); return reply(TEXTS); } });
    assert.ok(!r.narrative.lengthDiagnostics);
  });
});

test("a marked project that ends blocked keeps its first draft, rewrite and block reasons in the error record", async () => {
  await withDevAsync(true, async () => {
    const bad = JSON.parse(reply(TEXTS)); bad.scenes[1].narration_excerpt += " Inventory is 3.2 months."; bad.scenes[1].source_role = "article";
    // a report-less topic cannot allow this number in an article scene: use a competing-name block instead via a brokerage name the gate rejects is project-specific; so force the failure through the model reply being structurally blocked twice
    let n = 0;
    const callFn = async (sys, u, k, sink) => { n++; sink.push({ model: "m", input_tokens: 1, output_tokens: 1 }); return JSON.stringify({ ...JSON.parse(reply(TEXTS)), narration_with_audio_tags: "[conversational] Call me at 555-123-4567 for a sure thing guaranteed.", scenes: JSON.parse(reply(TEXTS)).scenes.map((s, i) => (i === 1 ? { ...s, narration_excerpt: "Call me at 555-123-4567 for a sure thing guaranteed." } : s)) }); };
    const { e } = await planLib.generatePlan({ project: proj("causal_current"), anthropicKey: "k", callFn }).then((r) => ({ r }), (e) => ({ e }));
    assert.ok(e && e.gate, "the fake reply is blocked by the gate twice"); { assert.ok(e.experiment, "the experiment record rides on the error"); assert.strictEqual(e.experiment.variant, "current"); assert.ok(e.experiment.initialDraft && e.experiment.afterGateRewrite && e.experiment.blockedAfterRewrite.length); assert.strictEqual(e.experiment.modelCalls, n); }
  });
});
