"use strict";
// Nov 12, 2026 (Sam): a 45-second writing aim for the initial writer, an anchored single gate rewrite, and block diagnostics (Test only).
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");
const am = require("../netlify/functions/lib/agent-marketing-lib");

const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
const intake = { angle: "neighborhood", market: "Roseville, CA", audience: "Home sellers", issue: "Supply and buyer demand", action: "Understand the trade-off", observation: "Buyers have more choices." };
async function withDev(on, fn) {
  const prev = process.env.AGENT_MARKETING_B1_EVIDENCE;
  if (on) process.env.AGENT_MARKETING_B1_EVIDENCE = "dev"; else delete process.env.AGENT_MARKETING_B1_EVIDENCE;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.AGENT_MARKETING_B1_EVIDENCE; else process.env.AGENT_MARKETING_B1_EVIDENCE = prev; }
}
const proj = (dur, extra) => ({ template: "local_market_insider", duration_sec: dur, formats: ["9x16", "16x9"], intake, ...(extra || {}) });

// ── 1. The writing aim reaches only the 45-second Test user message ──────────────────────────────────────────────────────
test("aim: a 45-second Test user message carries spoken_word_aim 105-110 beside the unchanged 105-125 range", async () => {
  await withDev(true, async () => {
    const u = JSON.parse(planLib.buildUserMessage(proj(45)));
    assert.deepStrictEqual(u.spoken_word_range, [105, 125]);
    assert.match(u.spoken_word_aim, /^105-110 spoken words\./);
    assert.match(u.spoken_word_aim, /about 151 words a minute \(not a guaranteed rate\)/);
    assert.match(u.spoken_word_aim, /not a per-scene quota/);
    assert.match(u.spoken_word_aim, /never replaces a required attribution/);
    assert.deepStrictEqual(planLib.writingAimFor(45), [105, 110]);
  });
});

test("aim: 30 and 60 seconds in Test, and every duration outside Test, carry no aim (messages are byte-identical to before)", async () => {
  await withDev(true, async () => {
    for (const d of [30, 60]) assert.ok(!("spoken_word_aim" in JSON.parse(planLib.buildUserMessage(proj(d)))), `${d}s`);
    assert.strictEqual(planLib.writingAimFor(30), null);
    assert.strictEqual(planLib.writingAimFor(60), null);
  });
  await withDev(false, async () => {
    for (const d of [30, 45, 60]) assert.ok(!("spoken_word_aim" in JSON.parse(planLib.buildUserMessage(proj(d)))), `prod ${d}s`);
    assert.strictEqual(planLib.writingAimFor(45), null);
  });
});

test("aim: the system prompt is untouched (production hash unchanged; the aim lives in the user message only)", async () => {
  await withDev(false, async () => {
    assert.strictEqual(sha(planLib.buildSystemPrompt()), "25f3118fed1b9726fc4dc78b16dcc92233cef785d3c074ef89a6ee7aaf7b0495");
  });
  await withDev(true, async () => {
    assert.ok(!/spoken_word_aim|writing aim/i.test(planLib.buildSystemPrompt(undefined, { scoped: true })));
  });
});

// ── 2/3. Anchored rewrite and block diagnostics ───────────────────────────────────────────────────────────────────────────
const fig = (key, text) => ({ key, ref: "r1." + key, role: "area_statistic", text, label: key, period: "October 2026", display: "x", areaLabel: "ROSEVILLE", scopeKind: "exact", partialPeriod: false, partialComparison: false });
const TOPIC = {
  id: "t5", question: "Supply is at 2.8 months, is Roseville still a seller's market?", whyItMatters: "The report shows inventory above the article's threshold.", scope: "selected", origin: "web", reportFirst: false,
  trendSignals: ["The article reported 14 pending sales in the new community and 130 pending sales across the area."],
  reportFigures: [fig("months_supply", "ROSEVILLE, October 2026: Months of inventory: 3.2 months up 23.5% from September 2026; up 67.1% from October 2025 (Oct 1, 2026 to Oct 31, 2026)"),
    fig("count_closed", "ROSEVILLE, October 2026: Closed sales: 139 down 16.8% from September 2026; down 28.4% from October 2025 (Oct 1, 2026 to Oct 31, 2026)")],
  sources: [{ url: "https://example.org/a", kind: "article", role: "primary", title: "t" }],
};
const tags = ["[conversational]", "[thoughtful]", "[emphasis]", "[confident]", "[warm]"];
const mkScene = (text, i, role, last) => ({ role: i === last ? "cta" : ["local_hook", "tension", "insight", "advice", "advice", "advice"][i], narration_excerpt: text, purpose: "purpose " + i,
  visual_source: i < (last > 4 ? 4 : 3) ? "GPT_IMAGE_2_CONCEPT" : (i === last ? "BRAND_CARD" : "CONCEPT_REUSE"), visual_brief: "brief " + i, reuse_of_scene: i < (last > 4 ? 4 : 3) || i === last ? null : 2,
  card_text: i === last ? "Ask me for a local view" : null, ai_generation_prompt: i < (last > 4 ? 4 : 3) ? "Photorealistic editorial tabletop with architectural home models, soft light, no people, no text, wide composition" : null,
  camera_motion: "push_in", framing_9x16: "keep homes visible", framing_16x9: "keep wide street", text_safe_placement: "lower middle", source_role: role });
const mk = (texts, roles) => JSON.stringify({ editorial_angle: "Supply is loosening and sellers should price for it.", hook: texts[0], narration_with_audio_tags: texts.map((x, i) => `${tags[i]} ${x}`).join(" "),
  scenes: texts.map((t, i) => mkScene(t, i, roles[i], texts.length - 1)), cta_suggestion: "Ask me.", claims_to_verify: [], missing_agent_inputs: [] });
const ROLES = ["data", "article", "data", "data", "data"];
const BAD = ["Is Roseville still a seller's market?", "The article says inventory hit 3.2 months, up 67.1% from last year.", "Inventory hit 3.2 months in October.", "So pricing matters more than it did.", "Ask me where your home fits."];
const PAD = "It matters because buyers have more choices now, and that changes how a prepared home gets priced.";
const GOOD = ["Is Roseville still a seller's market, or has that changed?", "The article reported about 130 pending sales across the area. " + PAD + " That is the part many owners miss.", "Inventory hit 3.2 months in October. " + PAD, "So pricing matters more than it did. " + PAD, "Ask me where your home fits and I will walk you through the numbers."];
const run = (project, callFn) => planLib.generatePlan({ project, anthropicKey: "k", callFn }).then((r) => ({ r }), (e) => ({ e }));

test("rewrite (45s Test): receives the rejected narration with scene context, the actual reasons, its word count, the duration, the range and the aim; one rewrite only", async () => {
  await withDev(true, async () => {
    const users = [];
    const { r, e } = await run(proj(45, { selected_topic: TOPIC }), async (sys, user) => { users.push(user); return users.length === 1 ? mk(BAD, ROLES) : mk(GOOD, ROLES); });
    assert.ifError(e);
    assert.strictEqual(users.length, 2, "exactly one planner call and ONE rewrite, no further call");
    const fix = users[1];
    assert.match(fix, /rejected by the compliance check for these specific reasons/);
    assert.match(fix, /source_role_numbers/, "the actual rejection reason");
    assert.match(fix, /labeled source_role \\"article\\" but states|labeled source_role "article" but states/);
    const wc = am.countWords(BAD.map((x, i) => `${tags[i]} ${x}`).join(" "));
    assert.ok(fix.includes(`is ${wc} spoken words`), "the rejected draft's word count");
    assert.match(fix, /for a 45-second Reel \(recommended range 105-125 spoken words; writing aim 105-110\)/);
    assert.ok(fix.includes("The article says inventory hit 3.2 months, up 67.1% from last year."), "the rejected narration");
    assert.match(fix, /"source_role":"article"/, "scene context");
    assert.match(fix, /"purpose":"purpose 1"/);
    assert.match(fix, /keep the existing story, hook, scenes and wording wherever possible/);
    assert.match(fix, /Do not make the narration longer than this draft/);
    assert.match(fix, /never overrides factual accuracy, source attribution, or any other mandatory requirement/);
    assert.ok(fix.startsWith(users[0]), "the original request is kept in full");
    assert.strictEqual(r.gate.ok, true);
  });
});

test("diagnostics (45s Test): the rule, field and a short reason of each rejection are recorded with the rewrite flags", async () => {
  await withDev(true, async () => {
    let n = 0;
    const { r, e } = await run(proj(45, { selected_topic: TOPIC }), async () => (++n === 1 ? mk(BAD, ROLES) : mk(GOOD, ROLES)));
    assert.ifError(e);
    const d = r.narrative.lengthDiagnostics;
    assert.strictEqual(d.gateRewrite, true);
    assert.strictEqual(d.rewriteAnchored, true);
    assert.ok(Array.isArray(d.gateBlocks) && d.gateBlocks.length >= 1 && d.gateBlocks.length <= 6);
    const b = d.gateBlocks[0];
    assert.strictEqual(b.rule, "source_role_numbers");
    assert.match(b.field, /^sceneText\[1\]$/);
    assert.ok(b.message.length > 0 && b.message.length <= 160);
    assert.deepStrictEqual(Object.keys(b).sort(), ["field", "message", "rule"], "no payloads, only rule, field, message");
    assert.ok(d.initial && typeof d.initial.words === "number" && d.afterGateRewrite);
  });
});

test("diagnostics: a draft that passes the first time records no blocks and no rewrite", async () => {
  await withDev(true, async () => {
    const { r, e } = await run(proj(45, { selected_topic: TOPIC }), async () => mk(GOOD, ROLES));
    assert.ifError(e);
    const d = r.narrative.lengthDiagnostics;
    assert.strictEqual(d.gateRewrite, false);
    assert.ok(!("gateBlocks" in d));
    assert.ok(!("rewriteAnchored" in d));
  });
});

test("rewrite: 60 seconds in Test keeps the original rewrite message (not anchored) and records blocks only where a rewrite happens", async () => {
  await withDev(true, async () => {
    const users = [];
    const B6 = BAD.concat(["And one more thing."]), G6 = GOOD.concat(["And one more thing."]), R6 = ROLES.concat(["data"]);
    const { e } = await run(proj(60, { selected_topic: TOPIC }), async (sys, user) => { users.push(user); return users.length === 1 ? mk(B6, R6) : mk(G6, R6); });
    assert.ok(users.length >= 2);
    assert.match(users[1], /Rewrite the complete JSON so none of these happen\. Keep the same topic, hook and facts; change only what is listed/);
    assert.ok(!/Your rejected draft, for a/.test(users[1]), "60 seconds is not anchored");
    assert.ok(!/spoken_word_aim/.test(users[0]));
  });
});

test("rewrite: outside Test the rewrite message is the original, byte for byte", async () => {
  await withDev(false, async () => {
    const users = [];
    await run(proj(45, { selected_topic: TOPIC }), async (sys, user) => { users.push(user); return mk(GOOD, ROLES); });
    assert.ok(!/spoken_word_aim|Your rejected draft, for a/.test(users.join("\n")));
  });
});

test("rewrite (45s Test): a second block still stops the plan; the single-rewrite limit is unchanged", async () => {
  await withDev(true, async () => {
    let n = 0;
    const { e } = await run(proj(45, { selected_topic: TOPIC }), async () => { n++; return mk(BAD, ROLES); });
    assert.strictEqual(n, 2, "planner call plus one rewrite, never a third");
    assert.ok(e && /blocked/i.test(e.message));
  });
});
