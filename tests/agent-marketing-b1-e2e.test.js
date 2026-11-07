// Run with: npm test   (the end-to-end part needs B1_WORKSPACE=<path to the B1 workspace> and Python 3 with beautifulsoup4 + lxml; it is skipped otherwise)
// DEVELOPMENT ONLY (Nov 5, 2026). Offline end-to-end Stage B path on the frozen v1.2.1 FA, FB and FC cases:
//   article snapshot (plain fetch of the saved raw HTML, Python extract_v2 via the bridge) -> saved B1 response (no provider call)
//   -> Python evidence gate via the bridge -> validated bundle -> Stage B record (in-memory store with the migration's constraints)
//   -> stageb.topicWithEvidence -> Planner input / generatePlan -> content gate.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const br = require("../netlify/functions/lib/agent-marketing-b1-bridge-lib");
const sb = require("../netlify/functions/lib/agent-marketing-b1-stageb-lib");
const b1 = require("../netlify/functions/lib/agent-marketing-b1-evidence-lib");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");
const gate = require("../netlify/functions/lib/agent-marketing-gate");
const PRIV = require("./helpers/b1-private");   // PRIVATE fixtures and article-derived test strings, from the B1 workspace

const WS = process.env.B1_WORKSPACE || "";
const HAVE = !PRIV.skip && fs.existsSync(path.join(WS, "src", "stageb_bridge.py"));
const SKIP = HAVE ? false : (PRIV.skip || "B1_WORKSPACE has no src/stageb_bridge.py");
const ENV = { AGENT_MARKETING_B1_EVIDENCE: "dev", B1_WORKSPACE: WS };
const M = HAVE ? JSON.parse(fs.readFileSync(path.join(WS, "frozen", "manifest_cases.json"), "utf8")) : {};
const raw = (c) => fs.readFileSync(path.join(WS, "frozen", "raw", `${c}.html`));
const saved = (c, k) => fs.readFileSync(path.join(WS, "frozen", "v121_run", `${c}.${k}.json`), "utf8");
const nrm = (s) => String(s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();

// In-memory store enforcing the proposed migration's constraints (rev 2; the real ones are checked by scripts/b1-migration-check.sh).
function memStore() {
  const rows = []; let n = 0;
  const FROZEN = ["snapshot_text", "snapshot_sha256", "request_text", "request_sha256", "input_sha256", "cache_key", "user_id", "topic_id", "source_url", "extractor"];
  return { rows,
    async findForProject(pid, tid) { return rows.filter((r) => r.project_id === pid && r.topic_id === tid && r.status !== "failed").pop() || null; },
    async findLive(key) { return rows.find((r) => r.cache_key === key && ["reserved", "running"].includes(r.status)) || rows.find((r) => r.cache_key === key && r.status === "ready") || null; },
    async insert(r) {
      if (!(r.status === "reserved" || (r.status === "ready" && r.reused_from))) throw new Error("a new row is reserved, or ready only as a copy");
      if (["reserved", "running"].includes(r.status) && rows.some((x) => x.cache_key === r.cache_key && ["reserved", "running"].includes(x.status))) throw new Error("unique: one in-flight run per cache key");
      if (r.status === "ready" && rows.some((x) => x.status === "ready" && x.project_id === r.project_id && x.cache_key === r.cache_key && x.gate_version === r.gate_version)) throw new Error("unique: project + cache key + gate");
      const row = { ...r, id: `ev-${++n}` }; rows.push(row); return row;
    },
    async update(id, f, expect) {
      const i = rows.findIndex((x) => x.id === id); const old = rows[i];
      if (expect && old.status !== expect) throw new Error(`not ${expect}`);
      for (const k of FROZEN) if (k in f && f[k] !== old[k]) throw new Error(`immutable: ${k}`);
      if (["ready", "failed"].includes(old.status)) throw new Error(`immutable: a ${old.status} row is final`);
      rows[i] = { ...old, ...f }; return rows[i];
    } };
}
const fetchFrom = (c) => async (url) => ({ status: 200, url, headers: { get: () => "text/html; charset=utf-8" }, arrayBuffer: async () => raw(c) });
const project = (c) => ({ id: `p-${c}`, template: "local_market_insider", duration_sec: 45, formats: ["9x16"], intake: { market: "Sacramento County", audience: "Home sellers", angle: "neighborhood" },
  selected_topic: { id: `t-${c}`, researchId: `r-${c}`, question: "What is the market doing?", whyItMatters: "Pricing decisions.", scope: "selected",
    sources: [{ title: M[c] && M[c].page_title, url: M[c] && M[c].final_url, role: "primary" }], candidate: { id: `cand-${c}` } } });

async function runCase(c, store) {
  const p = project(c);
  const { record } = await br.prepare({ project: p, userId: "u1", store, fetchFn: fetchFrom(c), env: ENV, now: "2026-11-05T06:00:00Z" });
  assert.strictEqual(record.request_text, saved(c, "request"), `${c}: snapshot reproduces the exact frozen V121 request`);
  const done = await br.complete({ record, responseText: saved(c, "response"), store, env: ENV });   // the saved response stands in for the provider call
  return { p, row: done, topic: sb.topicWithEvidence(p, done, ENV) };
}
const EX = ["What does this spring market mean for your sale?", "Here is what I am seeing as buyers take their time.", "Pricing well still matters.", null, "Watch the homes near yours.", "Ask me for a local view."];
const sc = (i, k, ex) => ({ role: ["local_hook", "tension", "insight", "comparison", "advice", "cta"][i], narration_excerpt: ex[i], purpose: "p" + i, visual_source: k, visual_brief: "b" + i,
  reuse_of_scene: k === "CONCEPT_REUSE" ? 2 : null, card_text: k === "BRAND_CARD" ? "Ask me for a local view" : null, authentic_photo_request: null,
  ai_generation_prompt: k === "GPT_IMAGE_2_CONCEPT" ? "Photorealistic editorial street of ordinary homes, soft light, no people, no text, wide composition" : null,
  camera_motion: "push_in", framing_9x16: "f", framing_16x9: "f", text_safe_placement: "lower middle" });
const plan = (line) => { const ex = EX.slice(); ex[3] = `${line} That shapes how you should approach your own list price this season, and it is worth a careful look.`;
  return JSON.stringify({ editorial_angle: "Spring pricing.", hook: ex[0], narration_with_audio_tags: `[conversational] ${ex.join(" ")}`,
    scenes: [sc(0, "GPT_IMAGE_2_CONCEPT", ex), sc(1, "GPT_IMAGE_2_CONCEPT", ex), sc(2, "CONCEPT_REUSE", ex), sc(3, "GPT_IMAGE_2_CONCEPT", ex), sc(4, "AGENT_PROFILE", ex), sc(5, "BRAND_CARD", ex)],
    cta_suggestion: "Ask me for a local view.", claims_to_verify: [], missing_agent_inputs: [] }); };
const withFlag = async (fn) => { const o = process.env.AGENT_MARKETING_B1_EVIDENCE; process.env.AGENT_MARKETING_B1_EVIDENCE = "dev"; try { return await fn(); } finally { if (o === undefined) delete process.env.AGENT_MARKETING_B1_EVIDENCE; else process.env.AGENT_MARKETING_B1_EVIDENCE = o; } };

test("e2e: full offline Stage B path on FA, FB and FC", { skip: SKIP }, async () => {
  const store = memStore();
  const res = {};
  for (const c of ["FA", "FB", "FC"]) res[c] = await runCase(c, store);
  assert.deepStrictEqual(["FA", "FB", "FC"].map((c) => res[c].row.completeness_status), ["PASSED_WITH_HOLDS", "COMPLETE", "PASSED_WITH_HOLDS"]);
  for (const c of ["FA", "FB", "FC"]) {
    assert.deepStrictEqual(sb.checkRecord(res[c].row, res[c].p), [], c);
    const fx = PRIV.bundle(c);
    assert.strictEqual(res[c].row.bundle.payload, fx.payload, `${c}: bridge bundle equals the reviewed fixture`);
  }
  // FA A1 held; A6 and A7 validated
  const fa = b1.readBundle(res.FA.topic.b1Evidence);
  const it = PRIV.faItems(fa.validated, PRIV.cases);
  assert.deepStrictEqual([it.A1, it.A6, it.A7], [false, true, true]);
  assert.ok(fa.held.some((h) => h.section === "source_contradictions" && JSON.stringify(h.finding).includes(PRIV.cases.evidence.fa_a1_figure)));
  await withFlag(async () => {
    for (const c of ["FA", "FB", "FC"]) {
      const p = { ...res[c].p, selected_topic: res[c].topic };
      const v = b1.readBundle(res[c].topic.b1Evidence);
      const msg = planLib.buildUserMessage(p);
      const ver = gate.verifiedFromProject(p).texts.join("\n");
      for (const x of [...v.held, ...v.excluded]) for (const q of b1.quotesOf(x.finding)) {
        assert.ok(!msg.includes(JSON.stringify(q).slice(1, -1)), `${c}: held/excluded quotation reached the Planner`);
        assert.ok(!ver.includes(nrm(q)), `${c}: held/excluded quotation became verified text`);
      }
      const ae = JSON.parse(msg).selected_topic.article_evidence;
      assert.strictEqual(ae.status, v.status);
      if (v.status === "PASSED_WITH_HOLDS") assert.match(ae.status_label, /^INCOMPLETE \(PASSED_WITH_HOLDS\)/);
    }
    // FC's held headline is kept out of the Planner input (asserted below), and the content gate blocks a script that restores it (D1): verbatim,
    // or as a paraphrase that adds its period / geography framing to the validated figure. Both attempts are blocked.
    const p = { ...res.FC.p, selected_topic: res.FC.topic };
    const E = PRIV.cases.e2e;
    for (const line of E.fc_restore_lines) {
      let n = 0;
      await assert.rejects(planLib.generatePlan({ project: p, anthropicKey: "k", callFn: async () => { n++; return plan(line); } }), /blocked by Agent Marketing's check/, line);
      assert.strictEqual(n, 2, line);
    }
    // The content gate still enforces source-grounded claims: a script stating a figure no validated finding gives is blocked (both attempts).
    let calls = 0;
    await assert.rejects(planLib.generatePlan({ project: p, anthropicKey: "k", callFn: async () => { calls++; return plan(E.fc_unsupported_line); } }), /blocked by Agent Marketing's check/);
    assert.strictEqual(calls, 2);
    // ...while the validated figure, as its quotation gives it, passes
    const ok = await planLib.generatePlan({ project: p, anthropicKey: "k", callFn: async () => plan(E.fc_valid_line) });
    assert.match(ok.warnings[0], /^Article evidence is INCOMPLETE \(PASSED_WITH_HOLDS\)/);
    assert.ok(!JSON.stringify(JSON.parse(planLib.buildUserMessage(p)).selected_topic.article_evidence).includes(PRIV.cases.fc.held_headline));
  });
});

test("e2e: no duplicate B1 run for an unchanged article; a changed article is not silently substituted", { skip: SKIP }, async () => {
  const store = memStore();
  const a = await br.prepare({ project: project("FA"), userId: "u1", store, fetchFn: fetchFrom("FA"), env: ENV });
  assert.strictEqual(a.reused, false);
  await assert.rejects(br.prepare({ project: { ...project("FA"), id: "p-other" }, userId: "u2", store, fetchFn: fetchFrom("FA"), env: ENV }), (e) => e.code === "in_progress");
  const done = await br.complete({ record: a.record, responseText: saved("FA", "response"), store, env: ENV });
  const again = await br.prepare({ project: project("FA"), userId: "u1", store, fetchFn: fetchFrom("FA"), env: ENV });
  assert.strictEqual(again.reused, true); assert.strictEqual(again.record.id, done.id);
  const other = await br.prepare({ project: { ...project("FA"), id: "p-other" }, userId: "u2", store, fetchFn: fetchFrom("FA"), env: ENV });
  assert.strictEqual(other.reused, true); assert.strictEqual(other.record.status, "ready"); assert.strictEqual(other.record.raw_response_text, done.raw_response_text);
  const changed = async (url) => ({ status: 200, url, headers: { get: () => "text/html" }, arrayBuffer: async () => Buffer.from(raw("FA").toString("utf8").split(PRIV.cases.e2e.fa_change[0]).join(PRIV.cases.e2e.fa_change[1])) });   // the article itself changed
  await assert.rejects(br.prepare({ project: project("FA"), userId: "u1", store, fetchFn: changed, env: ENV }), (e) => e.code === "source_changed");
  await assert.rejects(store.update(done.id, { raw_response_text: "x" }), /immutable/);
  await assert.rejects(store.update(done.id, { snapshot_text: "a later version" }), /immutable/);
});

test("e2e: bad captures and inconsistent bridge replies fail closed", { skip: SKIP }, async () => {
  const store = memStore(), p = project("FA");
  const page = (body, over) => async (url) => ({ status: 200, url, headers: { get: () => "text/html" }, arrayBuffer: async () => Buffer.from(body), ...(over || {}) });
  await assert.rejects(br.prepare({ project: p, userId: "u", store, fetchFn: page("<html><body><p>Too short.</p></body></html>"), env: ENV }), (e) => e.code === "incomplete");
  await assert.rejects(br.prepare({ project: p, userId: "u", store, fetchFn: page("<html><body><p>Just a moment... verify you are human. " + "x ".repeat(900) + "</p></body></html>"), env: ENV }), (e) => e.code === "capture_blocked" && e.detail.stage === "snapshot");
  await assert.rejects(br.prepare({ project: p, userId: "u", store, fetchFn: page("x", { status: 404 }), env: ENV }), (e) => e.code === "http_error" && e.detail.httpStatus === 404 && e.detail.stage === "fetch");
  await assert.rejects(br.prepare({ project: p, userId: "u", store, fetchFn: async (url) => ({ status: 200, url, headers: { get: () => "application/pdf" }, arrayBuffer: async () => Buffer.from("%PDF") }), env: ENV }), (e) => e.code === "not_html");
  await assert.rejects(br.prepare({ project: p, userId: "u", store, fetchFn: async () => ({ status: 200, url: "https://elsewhere.example/x", headers: { get: () => "text/html" }, arrayBuffer: async () => raw("FA") }), env: ENV }), (e) => e.code === "redirected_elsewhere");
  // a tampered snapshot or gate reply is caught by the Node checks
  const s = await br.callBridge("snapshot", { url: M.FA.final_url, title: M.FA.page_title, html_b64: raw("FA").toString("base64") }, ENV);
  assert.throws(() => br.checkSnapshot({ ...s, snapshot_text: s.snapshot_text + " " }), (e) => e.code === "snapshot_inconsistent");
  assert.throws(() => br.checkSnapshot({ ...s, request_text: s.request_text.replace('"max_output_tokens": 5000', '"max_output_tokens": 6000'), request_sha256: sb.sha(s.request_text.replace('"max_output_tokens": 5000', '"max_output_tokens": 6000')) }), (e) => e.code === "snapshot_inconsistent");
  const { record } = await br.prepare({ project: p, userId: "u", store, fetchFn: fetchFrom("FA"), env: ENV });
  await assert.rejects(br.complete({ record: { ...record, input_sha256: "0".repeat(64) }, responseText: saved("FA", "response"), store, env: ENV }), (e) => e.code === "gate_inconsistent");
  // an invalid bundle blocks the Planner before any model call
  await withFlag(async () => {
    const bad = { ...record, status: "ready", bundle: { format: "ssp-b1-evidence/1", payload: "{}", payload_sha256: "0".repeat(64) } };
    let called = false;
    await assert.rejects(planLib.generatePlan({ project: { ...p, selected_topic: sb.topicWithEvidence(p, bad, ENV) }, anthropicKey: "k", callFn: async () => { called = true; return "{}"; } }), (e) => e.code === "B1_EVIDENCE_BLOCKED");
    assert.strictEqual(called, false);
  });
});

test("e2e: the bridge cannot run with the switch off or without a workspace", async () => {
  await assert.rejects(br.callBridge("gate", {}, {}), (e) => e.code === "disabled");
  await assert.rejects(br.callBridge("gate", {}, { AGENT_MARKETING_B1_EVIDENCE: "dev" }), (e) => e.code === "not_configured");
  const src = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "lib", "agent-marketing-b1-bridge-lib.js"), "utf8");
  assert.ok(!/exports\.handler|queryStringParameters|event\.body/.test(src), "no HTTP entry point");
  assert.ok(!/fetch_url|perplexity/i.test(src.replace(/No Perplexity fetch_url\./, "")), "no Perplexity fetch_url");
});

test("e2e: with the switch off the Planner input and verified text are unchanged", () => {
  const p = { id: "p", template: "local_market_insider", duration_sec: 45, formats: ["9x16"], intake: { angle: "neighborhood", market: "Sacramento, CA", audience: "Home sellers" }, selected_topic: { id: "t", sources: [{ url: "https://x.example" }], question: "q", whyItMatters: "w", candidate: {} } };
  const t = sb.topicWithEvidence(p, null, {});
  assert.strictEqual(t, p.selected_topic);
  assert.strictEqual(JSON.parse(planLib.buildUserMessage(p)).selected_topic.article_evidence, undefined);
});
