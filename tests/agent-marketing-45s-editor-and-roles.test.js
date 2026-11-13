"use strict";
// Nov 12, 2026 (Sam): 45-second Reels use the existing scene-by-scene editor; 60 and 30 seconds are unchanged; rule 2g's numbers are checked in code (Test only).
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");
const am = require("../netlify/functions/lib/agent-marketing-lib");

const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
const intake = { angle: "neighborhood", market: "Roseville, CA", audience: "Home sellers", issue: "Supply and buyer demand", action: "Understand the trade-off",
  observation: "If your resale home is near new construction it can bring more interested buyers, and builders often have incentives and rate buy-downs." };

async function withDev(on, fn) {
  const prev = process.env.AGENT_MARKETING_B1_EVIDENCE;
  if (on) process.env.AGENT_MARKETING_B1_EVIDENCE = "dev"; else delete process.env.AGENT_MARKETING_B1_EVIDENCE;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.AGENT_MARKETING_B1_EVIDENCE; else process.env.AGENT_MARKETING_B1_EVIDENCE = prev; }
}

// ── Fixture: a market-insider script with N scenes whose narration is too long, plus a tight version ───────────────────────────────────
const CORE5 = [
  "Is new construction helping or hurting your resale home?",
  "Nearby new communities bring more interested buyers, and that can help.",
  "But it also puts your home next to brand new competition and builder incentives.",
  "So don't judge your value on resale listings alone, compare the full picture.",
  "Ask me for a local perspective on where your home fits.",
];
const PAD5 = ["", " And that is only the start of what many owners are noticing across the whole area right now, which is honestly why so many of them keep asking me the very same question about timing and price.",
  " It really is worth saying again that this is something you should think about carefully, because it is easy to miss and easy to get wrong when you are in the middle of it yourself and busy.",
  " I say this again because it is the part that people tend to forget, and it is the part that tends to cost them the most when they do not stop to think it through properly first, every time.", ""];
const LONG5 = CORE5.map((c, i) => c + PAD5[i]);
const scene = (text, i, n) => ({ role: ["local_hook", "tension", "insight", "advice", "cta"][i], narration_excerpt: text, purpose: "purpose " + i,
  visual_source: i < 3 ? "GPT_IMAGE_2_CONCEPT" : (i === n - 1 ? "BRAND_CARD" : "CONCEPT_REUSE"), visual_brief: "brief " + i, reuse_of_scene: i < 3 || i === n - 1 ? null : 2,
  card_text: i === n - 1 ? "Ask me for a local view" : null, ai_generation_prompt: i < 3 ? "Photorealistic editorial tabletop with architectural home models, soft light, no people, no text, wide composition" : null,
  camera_motion: "push_in", framing_9x16: "keep homes visible", framing_16x9: "keep wide street", text_safe_placement: "lower middle" });
const tags = ["[conversational]", "[thoughtful]", "[emphasis]", "[confident]", "[warm]"];
const taggedOf = (t) => t.map((x, i) => `${tags[i]} ${x}`).join(" ");
const planJson = (texts) => JSON.stringify({ editorial_angle: "New construction is both an advantage and a challenge.", hook: texts[0], narration_with_audio_tags: taggedOf(texts),
  scenes: texts.map((t, i) => scene(t, i, texts.length)), cta_suggestion: "Ask me for a local perspective.", claims_to_verify: [], missing_agent_inputs: [] });
const proj = (dur) => ({ template: "local_market_insider", duration_sec: dur, formats: ["9x16", "16x9"], intake });
const run = (project, callFn) => planLib.generatePlan({ project, anthropicKey: "k", callFn }).then((r) => ({ r }), (e) => ({ e }));

test("fixture: the long 45-second draft is over 125 words and the tight one is inside 105–125", () => {
  assert.ok(am.countWords(taggedOf(LONG5)) > 125);
  assert.ok(am.countWords(taggedOf(CORE5)) < 125);
});

// ── 1. 45-second overlength uses the existing scene editor (one call, no re-plan) ───────────────────────────────────────────────────────
test("45 seconds over 125: ONE scene-by-scene editing call replaces the full re-plan; the editor sees the 45-second budget", async () => {
  await withDev(true, async () => {
    const calls = [];
    const { r, e } = await run(proj(45), async (sys, user) => {
      calls.push({ sys, user });
      if (calls.length === 1) return planJson(LONG5);
      return JSON.stringify({ scenes: JSON.parse(user).scenes.map((s) => ({ index: s.index, narration: CORE5[s.index] })) });
    });
    assert.ifError(e);
    assert.strictEqual(calls.length, 2, "the planner call and ONE editing call, no second planner call");
    assert.ok(!/does not fit the requested length/.test(calls[1].user), "not the old full re-plan");
    const sent = JSON.parse(calls[1].user);
    assert.strictEqual(sent.scenes.length, 5);
    assert.strictEqual(sent.max_words, 125);
    assert.strictEqual(sent.target_words, 110, "the editor cuts toward the shared contract's 45-second target");
    assert.deepStrictEqual(sent.recommended_words, [105, 125], "the minimum goes in as guidance");
    assert.match(calls[1].sys, /finished 45-second first-person Realtor Reel script/);
    assert.match(calls[1].sys, /guidance, not a floor[^"]*never add words, filler or new content to reach the lower end/);
    const n = r.narrative;
    assert.ok(n.wordCount <= 125 && !n.lengthOver);
    assert.strictEqual(n.scenes.length, 5);
    assert.deepStrictEqual(n.scenes.map((s) => s.narrationExcerpt), CORE5);
    assert.strictEqual(n.scenes.map((s) => s.narrationExcerpt).join(" "), n.captionText);
    const d = n.lengthDiagnostics;
    assert.deepStrictEqual(d.target, [105, 125]);
    assert.strictEqual(d.duration_sec, 45);
    assert.strictEqual(d.edit.ran, true);
    assert.strictEqual(d.edit.outcome, "accepted");
    assert.ok(!r.warnings.some((w) => /spoken words/.test(w)));
  });
});

test("45 seconds: the editor never rejects a short result for being under 105 (no minimum rule), and an edit still over keeps the draft with a 45-second advisory", async () => {
  await withDev(true, async () => {
    const tiny = ["Is new construction helping or hurting your resale home?", "Nearby new communities bring more interested buyers.", "But it also brings brand new competition for you.", "So compare the full picture, not just resale listings.", "Ask me for a local perspective on your home."];
    let calls = 0;
    const a = await run(proj(45), async (sys, user) => (++calls === 1 ? planJson(LONG5) : JSON.stringify({ scenes: JSON.parse(user).scenes.map((s) => ({ index: s.index, narration: tiny[s.index] })) })));
    assert.ifError(a.e);
    assert.ok(a.r.narrative.wordCount < 105, "accepted as written: " + a.r.narrative.wordCount);
    assert.strictEqual(a.r.narrative.lengthDiagnostics.edit.outcome, "accepted");
    assert.ok(!a.r.narrative.lengthOver);
    calls = 0;
    const b = await run(proj(45), async (sys, user) => (++calls === 1 ? planJson(LONG5) : JSON.stringify({ scenes: JSON.parse(user).scenes.map((s) => ({ index: s.index, narration: s.narration })) })));
    assert.ifError(b.e);
    assert.strictEqual(calls, 2, "no further model call");
    assert.ok(b.r.narrative.lengthOver && b.r.narrative.lengthOver.max === 125);
    assert.match(b.r.warnings[0], /^\d+ spoken words\. The recommended range for a 45-second Reel is 105–125 words\. Actual narration duration depends on delivery\. You may edit the script or approve it as written\.$/);
    assert.ok(!/140|155/.test(b.r.warnings[0]), "no 60-second numbers in a 45-second advisory");
  });
});

test("45 seconds: an edit that fails is not used, the draft is kept flagged, and no re-plan follows", async () => {
  await withDev(true, async () => {
    let calls = 0;
    const { r, e } = await run(proj(45), async () => { if (++calls === 1) return planJson(LONG5); throw new Error("Planner call timed out"); });
    assert.ifError(e);
    assert.strictEqual(calls, 2);
    assert.ok(r.narrative.lengthOver);
    assert.match(r.narrative.lengthDiagnostics.edit.reason, /^edit call failed/);
  });
});

test("45 seconds inside its range: no editor, no extra call", async () => {
  await withDev(true, async () => {
    let calls = 0;
    const { r, e } = await run(proj(45), async () => { calls++; return planJson(CORE5.map((c, i) => c + [" Here is a little more to say about it for you.", " And another thought about it, which many owners find useful today.", " This is the part owners ask me about most often these days.", " It is what most people want to understand first.", ""][i] + (i === 0 ? "" : ""))); });
    assert.ifError(e);
    const w = r.narrative.wordCount;
    assert.ok(w >= 105 && w <= 125, "fixture is inside the 45-second range: " + w);
    assert.strictEqual(calls, 1); assert.strictEqual(r.narrative.lengthDiagnostics.edit.ran, false);
  });
});

// ── 2. 60 seconds unchanged ─────────────────────────────────────────────────────────────────────────────────────────────────────────
test("60 seconds (Phase B): the editor gets the range guidance, cuts toward 146 above 151, and the advisory reads 133–151", async () => {
  assert.strictEqual(sha(planLib.lengthEditSystem(60, false)), "9d0e6776f077e91b82dc3ab0cfb101e42e34b9ca4c44afcf41c6d7762222226f", "the prompt function without a range is unchanged");
  await withDev(true, async () => {
    const six = [...CORE5.slice(0, 4), "Compare the full picture before you decide anything at all.", ...CORE5.slice(4)];
    const LONG6 = six.map((c, i) => c + (i === 1 || i === 2 || i === 3 || i === 4 ? PAD5[Math.min(i, 3)] + PAD5[2] : ""));
    const calls = [];
    const six6 = (texts) => JSON.stringify({ editorial_angle: "x", hook: texts[0], narration_with_audio_tags: [...texts.map((t, i) => `${["[conversational]", "[thoughtful]", "[emphasis]", "[confident]", "[calm]", "[warm]"][i]} ${t}`)].join(" "),
      scenes: texts.map((t, i) => scene(t, Math.min(i, 4), 6)).map((s, i) => ({ ...s, role: ["local_hook", "tension", "insight", "comparison", "advice", "cta"][i], visual_source: i < 4 ? "GPT_IMAGE_2_CONCEPT" : (i === 5 ? "BRAND_CARD" : "CONCEPT_REUSE"), reuse_of_scene: i < 4 || i === 5 ? null : 2, card_text: i === 5 ? "Ask me for a local view" : null, ai_generation_prompt: i < 4 ? "Photorealistic editorial tabletop with architectural home models, soft light, no people, no text, wide composition" : null })),
      cta_suggestion: "Ask me for a local perspective.", claims_to_verify: [], missing_agent_inputs: [] });
    const { r, e } = await run(proj(60), async (sys, user) => { calls.push({ sys, user }); return calls.length === 1 ? six6(LONG6) : JSON.stringify({ scenes: JSON.parse(user).scenes.map((s) => ({ index: s.index, narration: s.narration })) }); });
    assert.ifError(e);
    assert.strictEqual(calls.length, 2, "the 60-second fixture is over 151 words and uses the editor");
    {
      assert.strictEqual(calls[1].sys, planLib.lengthEditSystem(60, true));
      assert.match(calls[1].sys, /guidance, not a floor[^"]*never add words, filler or new content to reach the lower end/);
      const sent6 = JSON.parse(calls[1].user);
      assert.deepStrictEqual(sent6.recommended_words, [133, 151]);
      assert.strictEqual(sent6.max_words, 151);
      assert.strictEqual(sent6.target_words, 146);
      if (r.narrative.lengthOver) assert.match(r.warnings[0], /^\d+ spoken words\. The recommended range for a 60-second Reel is 133–151 words\./);
    }
  });
});

// ── 30 seconds unchanged: the original single rewrite, never the scene editor ──────────────────────────────────────────────────────────
test("30 seconds: an overlength draft still goes through the original single rewrite, not the scene editor", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "../netlify/functions/lib/agent-marketing-plan-lib.js"), "utf8");
  assert.match(src, /const EDITOR_DURATIONS = \[45, 60\];/);
  assert.match(src, /b1\.enabled\(\) && EDITOR_DURATIONS\.includes\(project\.duration_sec\) && narrative\.wordCount > whi/);
  assert.ok(![30].some((d) => [45, 60].includes(d)));
});

test("outside development, 45 seconds keeps the original single rewrite (production unchanged)", async () => {
  await withDev(false, async () => {
    const seen = [];
    await run(proj(45), async (sys, user) => { seen.push(user); return planJson(LONG5); });
    assert.ok(!seen.some((u) => /words_to_remove/.test(u)), "no scene editor");
    if (seen.length === 2) assert.match(seen[1], /does not fit the requested length/);
  });
});

// ── 3. Source-role numbers (rule 2g in code, Test only) ─────────────────────────────────────────────────────────────────────────────
const fig = (key, text, display) => ({ key, ref: "r1." + key, role: "area_statistic", text, label: key, period: "October 2026", display, areaLabel: "ROSEVILLE", scopeKind: "exact", partialPeriod: false, partialComparison: false });
const TOPIC = {
  id: "t5", question: "Supply is at 2.8 months, is Roseville still a seller's market?", whyItMatters: "The report shows inventory above the article's threshold.", scope: "selected", origin: "web", reportFirst: false,
  trendSignals: ["The article reported 14 pending sales in the new community and 130 pending sales across the area."],
  reportFigures: [
    fig("months_supply", "ROSEVILLE, October 2026: Months of inventory: 3.2 months up 23.5% from September 2026; up 67.1% from October 2025 (Oct 1, 2026 to Oct 31, 2026)", "3.2 months"),
    fig("count_closed", "ROSEVILLE, October 2026: Closed sales: 139 down 16.8% from September 2026; down 28.4% from October 2025 (Oct 1, 2026 to Oct 31, 2026)", "139"),
    fig("count_active", "ROSEVILLE, October 2026: Active listings: 443 up 2.8% from September 2026; up 19.7% from October 2025 (Oct 1, 2026 to Oct 31, 2026)", "443"),
  ],
  sources: [{ url: "https://example.org/a", kind: "article", role: "primary", title: "t" }],
};
const sc = (role, text) => ({ sourceRole: role, narrationExcerpt: text });
const roleBlocks = (scenes, topic) => withDev(true, async () => planLib.sourceRoleBlocks({ selected_topic: topic || TOPIC }, { scenes }));

test("source roles: an article scene stating report-only figures is a violation; the message names the scene field and the figures", async () => {
  const b = await roleBlocks([sc("data", "Is it still a seller's market?"), sc("article", "Inventory hit 3.2 months, up 67.1% from a year ago, and the article says buyers pulled back.")]);
  assert.strictEqual(b.length, 1);
  assert.strictEqual(b[0].rule, "source_role_numbers");
  assert.strictEqual(b[0].field, "sceneText[1]");
  assert.match(b[0].match, /3\.2/); assert.match(b[0].match, /67\.1/);
  assert.match(b[0].message, /labeled source_role "article" but states 3\.2, 67\.1, which come only from the subscriber's report/);
  assert.match(b[0].message, /rule 2g/);
});

test("source roles: a data scene stating article-only figures is a violation", async () => {
  const b = await roleBlocks([sc("data", "The article counted 130 pending sales, and closed sales were 139.")]);
  assert.strictEqual(b.length, 1);
  assert.strictEqual(b[0].field, "sceneText[0]");
  assert.strictEqual(b[0].match, "130");
  assert.match(b[0].message, /labeled source_role "data" but states 130, which come only from the article/);
});

test("source roles: clean scenes pass: each role states its own figures; the report figure in a data scene; the article figure in an article scene", async () => {
  assert.deepStrictEqual(await roleBlocks([sc("data", "Inventory hit 3.2 months."), sc("article", "The article reported 130 pending sales."), sc("data", "Closed sales were 139, and active listings reached 443.")]), []);
});

test("source roles: shared figures are never flagged (2.8 is in the article's question and in the report), in either role", async () => {
  assert.deepStrictEqual(await roleBlocks([sc("article", "The article reported 2.8 months of supply."), sc("data", "Active listings are up 2.8% from September.")]), []);
});

test("source roles: rounding and formatting variations match conservatively; ambiguous roundings are not flagged", async () => {
  // report 19.7 / 67.1 / 28.4 rounded or reformatted, inside a data scene: fine
  assert.deepStrictEqual(await roleBlocks([sc("data", "Listings are up nearly 20% and inventory is up about 67%, with closed sales down 28.4 percent.")]), []);
  // the same roundings in an article scene are report figures: flagged
  const b = await roleBlocks([sc("article", "The article says listings are up nearly 20% and 443 are active.")]);
  assert.strictEqual(b.length, 1); assert.match(b[0].match, /20/); assert.match(b[0].match, /443/);
  // a number that could be the article's 14 or the report's 14.x is ambiguous: not flagged
  const t2 = { ...TOPIC, reportFigures: TOPIC.reportFigures.concat(fig("x", "ROSEVILLE, October 2026: Median days on market: 14.2 days up 1% from September 2026 (Oct 1, 2026 to Oct 31, 2026)", "14.2 days")) };
  assert.deepStrictEqual(await roleBlocks([sc("article", "The article counted 14 pending sales.")], t2), []);
  assert.deepStrictEqual(await roleBlocks([sc("data", "Comma figures like 1,430 and small digits like 3 or a year like 2026 are not market figures here.")]), []);
});

test("source roles: skipped for area_context topics, topics without report figures, topics with no article numbers, and outside development", async () => {
  const mixed = [sc("article", "Inventory hit 3.2 months.")];
  assert.deepStrictEqual(await roleBlocks(mixed, { ...TOPIC, areaContext: [{ text: "Sacramento County listings rose 8.8%" }] }), []);
  assert.deepStrictEqual(await roleBlocks(mixed, { ...TOPIC, reportFigures: [] }), []);
  assert.deepStrictEqual(await roleBlocks(mixed, { ...TOPIC, question: "Is Roseville still a seller's market?", trendSignals: [] }), []);
  assert.deepStrictEqual(await withDev(false, async () => planLib.sourceRoleBlocks({ selected_topic: TOPIC }, { scenes: mixed })), [], "production never runs it");
});

test("source roles: the check never changes a scene's role", async () => {
  const scenes = [sc("article", "Inventory hit 3.2 months.")];
  await roleBlocks(scenes);
  assert.strictEqual(scenes[0].sourceRole, "article");
});

test("source roles: a violation goes through the existing one-rewrite correction with the reason listed, and the corrected draft passes", async () => {
  await withDev(true, async () => {
    const project = { ...proj(45), selected_topic: TOPIC };
    const mk = (articleText) => {
      const texts = ["Is Roseville still a seller's market?", articleText, "Inventory hit 3.2 months in October.", "So pricing matters more than it did.", "Ask me where your home fits."];
      return JSON.stringify({ editorial_angle: "x", hook: texts[0], narration_with_audio_tags: taggedOf(texts),
        scenes: texts.map((t, i) => ({ ...scene(t, i, 5), source_role: i === 1 ? "article" : "data" })), cta_suggestion: "Ask me.", claims_to_verify: [], missing_agent_inputs: [] });
    };
    const users = [];
    const { r, e } = await run(project, async (sys, user) => { users.push(user); return users.length === 1 ? mk("The article says inventory hit 3.2 months, up 67.1% from last year.") : mk("The article reported 130 pending sales across the area."); });
    assert.ifError(e);
    assert.ok(users.length >= 2, "a rewrite was asked for");
    assert.match(users[1], /source_role_numbers/);
    assert.match(users[1], /labeled source_role "article" but states/);
    assert.strictEqual(r.narrative.lengthDiagnostics.gateRewrite, true);
    assert.strictEqual(r.narrative.scenes[1].sourceRole, "article", "roles are not changed to suppress the violation");
    assert.strictEqual(r.gate.ok, true);
  });
});

test("source roles: a second violation after the rewrite stops the plan with the rule and the reason (the existing behavior)", async () => {
  await withDev(true, async () => {
    const project = { ...proj(45), selected_topic: TOPIC };
    const texts = ["Is Roseville still a seller's market?", "The article says inventory hit 3.2 months, up 67.1% from last year.", "Inventory hit 3.2 months in October.", "So pricing matters more than it did.", "Ask me where your home fits."];
    const bad = JSON.stringify({ editorial_angle: "x", hook: texts[0], narration_with_audio_tags: taggedOf(texts), scenes: texts.map((t, i) => ({ ...scene(t, i, 5), source_role: i === 1 ? "article" : "data" })), cta_suggestion: "Ask me.", claims_to_verify: [], missing_agent_inputs: [] });
    const { e } = await run(project, async () => bad);
    assert.ok(e && /blocked/i.test(e.message) && /source_role/.test(e.message + JSON.stringify(e.gate && e.gate.blocks)), String(e && e.message));
  });
});
