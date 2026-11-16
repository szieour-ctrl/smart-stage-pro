// Complete-source Writer, end to end with a fake database and a stand-in model (Nov 15, 2026). No network, no paid call.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const U1 = "11111111-1111-4111-8111-111111111111", ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const rows = [];
const libPath = require.resolve("../netlify/functions/lib/marketing-profile-lib");
const authPath = require.resolve("../netlify/functions/lib/reel-auth-lib");
function fakeSupabase(method, table, body, qs = "") {
  if (table !== "agent_marketing_projects") return Promise.resolve({ status: 200, data: [] });
  const idEq = (new URLSearchParams(String(qs).replace(/^\?/, "")).get("id") || "").replace("eq.", "");
  const match = rows.filter((r) => !idEq || r.id === idEq);
  if (method === "GET") return Promise.resolve({ status: 200, data: match.map((r) => JSON.parse(JSON.stringify(r))) });
  if (method === "PATCH") { match.forEach((r) => Object.assign(r, JSON.parse(JSON.stringify(body)))); return Promise.resolve({ status: 200, data: match }); }
  throw new Error("unexpected " + method);
}
require.cache[libPath] = { id: libPath, filename: libPath, loaded: true, exports: { supabase: fakeSupabase } };
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { requireUser: async () => ({ user: { id: U1 } }) } };
const { handler } = require("../netlify/functions/agent-marketing-project");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");
const runLib = require("../netlify/functions/lib/agent-marketing-plan-run-lib");
const am = require("../netlify/functions/lib/agent-marketing-lib");
const PARK = require("./fixtures/parkwood-option2-t1.json");

const intake = { angle: "", market: "Lincoln, CA", audience: "Home sellers", issue: "", action: "Ask for a local perspective", observation: "" };
const ARTICLE = "The Lincoln City Council adopted the Parkwood development agreement on Oct. 27. The plan allows 122 single-family homes.";
const words = (n) => Array.from({ length: n }, (_, i) => (i === 0 ? "Parkwood" : "word" + i)).join(" ") + ".";
const DRAFT = words(148);
const snap = { text: ARTICLE, sha256: "abc", evidenceId: "f5ff5b4f", url: "https://news.example.org/p", title: "Parkwood" };

async function withDev(fn) {
  const prev = { f: process.env.AGENT_MARKETING_B1_EVIDENCE, k: process.env.ANTHROPIC_API_KEY, e: process.env.AGENT_MARKETING_ENABLED };
  process.env.AGENT_MARKETING_B1_EVIDENCE = "dev"; process.env.ANTHROPIC_API_KEY = "k"; process.env.AGENT_MARKETING_ENABLED = "true";
  try { return await fn(); } finally { for (const [k, v] of [["AGENT_MARKETING_B1_EVIDENCE", prev.f], ["ANTHROPIC_API_KEY", prev.k], ["AGENT_MARKETING_ENABLED", prev.e]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const seed = () => { rows.length = 0; rows.push({ id: ID, user_id: U1, template: "local_market_insider", duration_sec: 60, formats: ["9x16", "16x9"], intake, selected_topic: PARK.topic, status: "draft", created_at: "t", updated_at: "t", narrative: { status: "planning", startedAt: Date.now(), attempts: 1, intakeHash: planLib.intakeHash(intake, PARK.topic) } }); };
const post = (b) => handler({ httpMethod: "POST", headers: {}, body: JSON.stringify(b), queryStringParameters: null });

test("runPlan on a dev Article-Led project makes ONE Writer call and stores the unmodified draft and the exact record", async () => {
  await withDev(async () => {
    seed(); let calls = 0, seen;
    const out = await runLib.runPlan({ id: ID, userId: U1, deps: { supabase: fakeSupabase, env: process.env, anthropicKey: "k", withEvidence: async (p) => ({ ...p, articleSnapshot: snap }), callFn: async (s, u) => { calls++; seen = { s, u }; return DRAFT; } } });
    assert.strictEqual(out.state, "ready");
    assert.strictEqual(calls, 1);
    const n = rows[0].narrative;
    assert.strictEqual(n.engine, am.WRITER_ENGINE);
    assert.strictEqual(n.narrationTagged, DRAFT);
    assert.strictEqual(n.writerDraft.narration, DRAFT);
    assert.strictEqual(n.writerRecord.user, seen.u);
    assert.ok(JSON.parse(seen.u).article.text === ARTICLE);
    assert.deepStrictEqual(n.scenes, []);
  });
});

test("the page never receives writerRecord or polishRecords; it does receive the original draft", async () => {
  await withDev(async () => {
    seed(); rows[0].narrative = { engine: am.WRITER_ENGINE, status: "ready", narrationTagged: DRAFT, writerDraft: { narration: DRAFT, words: 148 }, writerRecord: { system: "SECRET-SYSTEM", user: "u" }, polishRecords: [{ request: "r" }], scenes: [] };
    const res = await handler({ httpMethod: "GET", headers: {}, body: null, queryStringParameters: { id: ID } });
    assert.doesNotMatch(res.body, /writerRecord|polishRecords|SECRET-SYSTEM/);
    assert.strictEqual(JSON.parse(res.body).project.narrative.writerDraft.narration, DRAFT);
  });
});

test("polish_narrative: only on request, one call, returns text without saving or approving the script; the original draft is untouched", async () => {
  await withDev(async () => {
    seed(); rows[0].narrative = { engine: am.WRITER_ENGINE, status: "ready", narrationTagged: DRAFT, writerDraft: { narration: DRAFT, words: 148 }, scenes: [] };
    const orig = planLib.callClaudeText; let calls = 0;
    planLib.callClaudeText = async () => { calls++; return words(141); };
    try {
      const res = await post({ action: "polish_narrative", id: ID, narrationTagged: DRAFT, request: "Tighten the close." });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(calls, 1);
      assert.strictEqual(JSON.parse(res.body).polished.words, 141);
      assert.strictEqual(rows[0].narrative.narrationTagged, DRAFT, "the saved script is unchanged");
      assert.strictEqual(rows[0].narrative.writerDraft.narration, DRAFT);
      assert.strictEqual(rows[0].narrative.polishRecords.length, 1);
    } finally { planLib.callClaudeText = orig; }
  });
});

test("saving an edited script keeps the Writer's original draft and record, and stores the subscriber's words exactly", async () => {
  await withDev(async () => {
    seed(); const writer = require("../netlify/functions/lib/agent-marketing-writer-lib");
    await runLib.runPlan({ id: ID, userId: U1, deps: { supabase: fakeSupabase, env: process.env, anthropicKey: "k", withEvidence: async (p) => ({ ...p, articleSnapshot: snap }), callFn: async () => DRAFT } });
    const edited = words(146);
    const s = await post({ action: "save_narrative", id: ID, narrative: { narrationTagged: edited, cta: null } });
    assert.strictEqual(s.statusCode, 200, s.body);
    const n = rows[0].narrative;
    assert.strictEqual(n.narrationTagged, edited);
    assert.strictEqual(n.writerDraft.narration, DRAFT, "the first draft stays exactly as generated");
    assert.ok(n.writerRecord && n.engine === writer.ENGINE);
  });
});

test("runStoryboard: plans the scenes from the approved words in the existing storyboard step, never rewrites the narration, writes scenes to both copies", async () => {
  await withDev(async () => {
    seed(); const approved = { engine: am.WRITER_ENGINE, narrationTagged: DRAFT, captionText: DRAFT, scenes: [], status: "ready" };
    rows[0].narrative = { ...approved }; rows[0].narrative_approved = { ...approved };
    const orig = planLib.rebuildApprovedStoryboard; let got;
    planLib.rebuildApprovedStoryboard = async (a) => { got = a; return { ...a.narrative, scenes: [{ index: 0, narrationExcerpt: "x" }], scenesFor: am.narrationKey(a.narrative.narrationTagged) }; };
    try {
      const r = await runLib.runStoryboard({ id: ID, userId: U1, deps: { supabase: fakeSupabase, env: process.env, anthropicKey: "k" } });
      assert.strictEqual(r.state, "ready");
      assert.strictEqual(got.narrative.narrationTagged, DRAFT);
      assert.strictEqual(rows[0].narrative_approved.narrationTagged, DRAFT);
      assert.strictEqual(rows[0].narrative.scenes.length, 1);
      assert.strictEqual(rows[0].narrative_approved.scenes.length, 1);
      const again = await runLib.runStoryboard({ id: ID, userId: U1, deps: { supabase: fakeSupabase, env: process.env, anthropicKey: "k" } });
      assert.strictEqual(again.state, "skipped", "scenes already match these exact words: no second call");
    } finally { planLib.rebuildApprovedStoryboard = orig; }
  });
});
