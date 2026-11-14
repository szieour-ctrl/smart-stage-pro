"use strict";
// Nov 13, 2026 (Sam): rule 2g source-role correction, Test only (C1-C3). Position (first or last scene) no longer decides a scene's source: the planner's
// label stands in Test, the manifest keeps it, and an accurately sourced article fact such as the Roseville $354 payment difference may open the Reel.
// Production keeps the first and last scene as "data". The code check (sourceRoleBlocks) is unchanged and still catches a figure labeled with the wrong source.
const test = require("node:test");
const assert = require("node:assert");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");
const assets = require("../netlify/functions/lib/agent-marketing-assets-lib");

const TEST_DB = "https://test-ref.supabase.co";
async function withTest(on, fn) {
  const keep = { b: process.env.AGENT_MARKETING_B1_EVIDENCE, u: process.env.SUPABASE_URL };
  if (on) { process.env.AGENT_MARKETING_B1_EVIDENCE = "dev"; process.env.SUPABASE_URL = TEST_DB; } else { delete process.env.AGENT_MARKETING_B1_EVIDENCE; }
  try { return await fn(); } finally {
    if (keep.b === undefined) delete process.env.AGENT_MARKETING_B1_EVIDENCE; else process.env.AGENT_MARKETING_B1_EVIDENCE = keep.b;
    if (keep.u === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = keep.u;
  }
}

// The Roseville topic as B2 stored it: the question carries the article's $354; the report supplies the market figures.
const fig = (key, text) => ({ key, ref: "r1." + key, role: "area_statistic", text, label: key, period: "October 2026", areaLabel: "ROSEVILLE", scopeKind: "exact", partialPeriod: false, partialComparison: false });
const TOPIC = {
  id: "t2", question: "A monthly payment jumped $354 since last year—how does that reshape who can buy my home?", trendSignals: [], scope: "selected", origin: "web", reportFirst: false,
  reportFigures: [
    fig("count_active", "ROSEVILLE, October 2026: Active listings: 443 up 2.8% from September 2026; up 19.7% from October 2025 (Oct 1, 2026 to Oct 31, 2026)"),
    fig("count_closed", "ROSEVILLE, October 2026: Closed sales: 139 down 16.8% from September 2026; down 28.4% from October 2025 (Oct 1, 2026 to Oct 31, 2026)"),
    fig("sold_to_list", "ROSEVILLE, October 2026: Sold price as a percent of list price: 99.2% up 0.2% from September 2026; down 0.1% from October 2025 (Oct 1, 2026 to Oct 31, 2026)"),
    fig("months_supply", "ROSEVILLE, October 2026: Months of inventory: 3.2 months up 23.5% from September 2026; up 67.1% from October 2025 (Oct 1, 2026 to Oct 31, 2026)"),
  ],
  reportPrecedence: [], sources: [{ url: "https://example.org/a", kind: "article", role: "primary", title: "t" }],
};
const sc = (role, text) => ({ sourceRole: role, narrationExcerpt: text });
const blocks = (scenes) => planLib.sourceRoleBlocks({ selected_topic: TOPIC }, { scenes });

// The opening scenes of the three retained E5 drafts (X, Y, Z in e5_side_by_side). X and Z were blocked in the experiment only because scene 1 was forced to "data".
const OPENING = {
  Z: "Did a $354 monthly jump just shrink your buyer pool? According to Freddie Mac data compiled by the Federal Reserve, the average 30-year fixed rate hit 7.33% in October—up from 6.25% a year ago. That means a buyer financing a median-priced Roseville home now pays about $3,408 a month in principal and interest… $354 more than a year ago.",
  X: "Has a $354 monthly jump already changed who can buy your home? Here's what the numbers are telling me. Freddie Mac data compiled by the Federal Reserve shows the average 30-year rate was 7.33% in October—up from 6.25% a year ago—and at that rate a buyer would pay about $3,408 per month in principal and interest on a median-priced Roseville home… $354 more than last October.",
  Y: "Here's what the numbers are telling me. According to Freddie Mac data compiled by the Federal Reserve, the average 30-year rate hit 7.33% in October—up from 6.25% a year ago. That difference alone pushes the monthly payment on a Roseville median-priced home to about $3,408 in principal and interest… $354 more than a buyer faced last October.",
};
const REST = "Active listings rose to 443, up 19.7% from a year ago, while closed sales fell to 139. Homes that sold closed at 99.2% of list price. I'm happy to walk you through where your home lands.";

test("retained E5 drafts: the $354 opening is blocked when forced to data (the experiment's failure) and passes when its role is article", async () => {
  await withTest(true, async () => {
    for (const k of ["X", "Y", "Z"]) {
      const forced = blocks([sc("data", OPENING[k]), sc("data", REST)]);
      assert.strictEqual(forced.length, 1, `${k}: forced data role reproduces the original block`);
      assert.strictEqual(forced[0].field, "sceneText[0]"); assert.match(forced[0].match, /^354(, 354)*$/);
      assert.deepStrictEqual(blocks([sc("article", OPENING[k]), sc("data", REST)]), [], `${k}: an article scene may open the Reel`);
      assert.deepStrictEqual(blocks([sc("data", REST), sc("article", OPENING[k])]), [], `${k}: and may close it`);
    }
  });
});

test("detectability is intact: a figure with the wrong source label is still blocked, in the first scene as anywhere", async () => {
  await withTest(true, async () => {
    // a report figure presented in an article scene
    const a = blocks([sc("article", "Inventory is 3.2 months, up 67.1% from a year ago."), sc("data", REST)]);
    assert.strictEqual(a.length, 1); assert.strictEqual(a[0].rule, "source_role_numbers"); assert.match(a[0].match, /3\.2/); assert.match(a[0].message, /come only from the subscriber's report/);
    // the article's $354 presented in a data scene (the Realtor's own market data)
    const d = blocks([sc("data", "Our market data shows buyers now pay $354 more each month."), sc("data", REST)]);
    assert.strictEqual(d.length, 1); assert.match(d[0].match, /^354(, 354)*$/); assert.match(d[0].message, /come only from the article/);
    // the same holds for the last scene
    const l = blocks([sc("data", REST), sc("article", "Closed sales were 139 in October.")]);
    assert.strictEqual(l.length, 1); assert.strictEqual(l[0].field, "sceneText[1]");
  });
});

test("the code check never runs in production", async () => {
  await withTest(false, async () => {
    assert.deepStrictEqual(blocks([sc("data", OPENING.X)]), []);
  });
});

// ---- C1: normalizePlan ----
const TAGS = ["[conversational]", "[thoughtful]", "[emphasis]", "[confident]", "[warm]"];
const ROLES = ["local_hook", "tension", "insight", "advice", "cta"];
const scn = (text, i, role) => ({ role: ROLES[i], narration_excerpt: text, purpose: "p" + i, visual_source: i < 3 ? "GPT_IMAGE_2_CONCEPT" : (i === 4 ? "BRAND_CARD" : "CONCEPT_REUSE"),
  visual_brief: "brief " + i, reuse_of_scene: i < 3 || i === 4 ? null : 1, card_text: i === 4 ? "Ask me" : null,
  ai_generation_prompt: i < 3 ? "Photorealistic editorial tabletop with architectural home models, soft light, no people, no text" : null, camera_motion: "push_in",
  framing_9x16: "a", framing_16x9: "b", text_safe_placement: "lower middle", source_role: role });
const RAW = (roles) => {
  const texts = ["Did a $354 monthly jump just shrink your buyer pool?", "Active listings are up and closed sales are down here.", "Buyers who qualified last year may not today.", "Homes that sold closed near list price.", "Ask me where your home lands."];
  return { editorial_angle: "x", hook: texts[0], narration_with_audio_tags: texts.map((t, i) => `${TAGS[i]} ${t}`).join(" "), scenes: texts.map((t, i) => scn(t, i, roles[i])), cta_suggestion: "Ask me.", claims_to_verify: [], missing_agent_inputs: [] };
};
const PROJECT = { template: "local_market_insider", duration_sec: 45, formats: ["9x16"], intake: { angle: "a", market: "Roseville, CA", audience: "Home sellers", issue: "i", action: "x", observation: "o" } };

test("C1: in Test the planner's label stands for every scene; in production the first and last scene are data", async () => {
  const roles = ["article", "data", "article", "data", "article"];
  const test_ = await withTest(true, async () => planLib.normalizePlan(RAW(roles), PROJECT));
  assert.deepStrictEqual(test_.narrative.scenes.map((s) => s.sourceRole), roles, "Test keeps every label, first and last included");
  const prod = await withTest(false, async () => planLib.normalizePlan(RAW(roles), PROJECT));
  assert.deepStrictEqual(prod.narrative.scenes.map((s) => s.sourceRole), ["data", "data", "article", "data", "data"], "production unchanged");
  const odd = await withTest(true, async () => planLib.normalizePlan(RAW(["nonsense", "data", "data", "data", "data"]), PROJECT));
  assert.strictEqual(odd.narrative.scenes[0].sourceRole, "data", "an unknown value still falls back to data");
});

test("C1: the article credit footer lands on an opening article scene (Test)", async () => {
  const proj = { ...PROJECT, selected_topic: { ...TOPIC, b2: { article: true }, sources: [{ kind: "article", role: "primary", title: "Roseville home sales fell", url: "https://example.org/a", site: "Example", published: "2026-11-05" }] }, template: "local_market_insider" };
  const n = { scenes: [sc("article", "a"), sc("data", "b"), sc("data", "c")] };
  const am = require("../netlify/functions/lib/agent-marketing-lib");
  await withTest(true, async () => { am.attachNotice(proj, n); });
  assert.ok(n.sourceCredit, "a credit is attached");
  assert.deepStrictEqual(n.sourceCredit.scenes, [0], "the credit names scene 1");
});

// ---- C3: manifest build ----
test("C3 (Nov 14): the manifest keeps source_role article on the first and last scene when the article-led switch is on, in Test and in production, and demotes it only with the switch off", async () => {
  const src = require("fs").readFileSync(require.resolve("../netlify/functions/lib/agent-marketing-assets-lib"), "utf8");
  assert.match(src, /source_role: v\.sourceRole === "article" && \(testRoles \|\| \(i > 0 && i < pl\.scenes\.length - 1\)\) \? "article" : "data"/);
  assert.match(src, /const testRoles = require\("\.\/agent-marketing-b1-evidence-lib"\)\.enabled\(\);/);
  assert.ok(assets, "module loads");
});
