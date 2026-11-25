// Run with: npm test
// DEVELOPMENT ONLY (Nov 5, 2026): Stage B record checks (reuse key, project association, fail-closed). No database, no provider call.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const sb = require("../netlify/functions/lib/agent-marketing-b1-stageb-lib");
const b1 = require("../netlify/functions/lib/agent-marketing-b1-evidence-lib");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");

// PRIVATE fixtures (frozen v1.2.1 FA request/response and exported bundles) come from the B1 workspace: tests/helpers/b1-private.js.
const PRIV = require("./helpers/b1-private");
const NEEDS = { skip: PRIV.skip };
const BUNDLE = (n) => PRIV.bundle(n);
let F = null;
const fx = () => {
  if (F) return F;
  const REQ = PRIV.request("FA"), RESP = PRIV.response("FA"), INPUT = JSON.parse(REQ).input;
  const SNAP = INPUT.slice(INPUT.indexOf("=====BEGIN RETRIEVED TEXT=====\n") + 31, INPUT.lastIndexOf("\n=====END RETRIEVED TEXT====="));
  return (F = { REQ, RESP, INPUT, SNAP });
};
const ON = { AGENT_MARKETING_B1_EVIDENCE: "dev" };
const PID = "22222222-2222-4222-8222-222222222222", RID = "33333333-3333-4333-8333-333333333333";

const project = () => ({ id: PID, template: "local_market_insider", duration_sec: 45, formats: ["9x16"], intake: { market: "Sacramento County" },
  selected_topic: { id: "t-fa", researchId: RID, question: "q", whyItMatters: "w", scope: "selected", sources: [{ title: "a", url: "https://example.org/fa" }], candidate: { id: "c1" } } });
const record = (over) => {
  const { REQ, RESP, INPUT, SNAP } = fx();
  const r = { project_id: PID, research_id: RID, topic_id: "t-fa", status: "ready", ...sb.APPROVED_B1,
    snapshot_text: SNAP, snapshot_sha256: sb.sha(SNAP), request_text: REQ, input_sha256: sb.sha(INPUT), raw_response_text: RESP, raw_response_sha256: sb.sha(RESP),
    bundle: BUNDLE("FA"), completeness_status: "PASSED_WITH_HOLDS" };
  r.cache_key = sb.cacheKey(r);
  return { ...r, ...(over || {}) };
};

test("stageb: the frozen v1.2.1 FA run makes a valid record for its project", NEEDS, () => {
  assert.deepStrictEqual(sb.checkRecord(record(), project()), []);
  assert.strictEqual(sb.sha(fx().RESP), "9a8bf66e9486b80938d36cefb68294902d0d10c7d79543a2a6ad87a1e919207c"); // the frozen raw response
  const t = sb.topicWithEvidence(project(), record(), ON);
  assert.strictEqual(b1.readBundle(t.b1Evidence).status, "PASSED_WITH_HOLDS");
});

test("stageb: reuse key: same snapshot and approved settings reuse; any change in snapshot or B1 settings does not; the gate version is not part of it", NEEDS, () => {
  const k = sb.approvedKey(sb.sha(fx().SNAP));
  assert.strictEqual(k, record().cache_key);
  assert.notStrictEqual(sb.approvedKey(sb.sha(fx().SNAP + " ")), k);
  for (const [f, v] of [["instructions_sha256", "0".repeat(64)], ["model", "x"], ["max_output_tokens", 6000], ["reasoning_effort", "low"], ["extractor", "extract_v1"]]) {
    assert.notStrictEqual(sb.cacheKey({ ...sb.APPROVED_B1, snapshot_sha256: sb.sha(fx().SNAP), [f]: v }), k, f);
  }
  assert.strictEqual(sb.cacheKey({ ...sb.APPROVED_B1, snapshot_sha256: sb.sha(fx().SNAP), gate_version: "anything" }), k);
  assert.throws(() => sb.cacheKey({ ...sb.APPROVED_B1, snapshot_sha256: "nope" }));
});

test("stageb: missing, malformed or mismatched records fail closed", NEEDS, () => {
  const p = project();
  const cases = {
    missing: null,
    "other project": record({ project_id: RID }),
    "topic changed": record({ topic_id: "t-other" }),
    "not ready": record({ status: "running" }),
    "other prompt": record({ instructions_sha256: "0".repeat(64) }),
    "other model": record({ model: "anthropic/claude-haiku-5-5" }),
    "snapshot changed": record({ snapshot_text: fx().SNAP + "x" }),
    "raw response changed": record({ raw_response_text: fx().RESP + " " }),
    "request changed": record({ request_text: fx().REQ.replace("5000", "6000") }),
    "request not JSON": record({ request_text: "{" }),
    "bundle from another article": record({ bundle: BUNDLE("FC"), completeness_status: "PASSED_WITH_HOLDS" }),
    "blocked bundle": record({ bundle: BUNDLE("BLOCKED") }),
    "tampered bundle": record({ bundle: { ...BUNDLE("FA"), payload: BUNDLE("FA").payload.replace("PASSED_WITH_HOLDS", "COMPLETE") } }),
    "status mismatch": record({ completeness_status: "COMPLETE" }),
    "cache key mismatch": record({ cache_key: "0".repeat(64) }),
  };
  for (const [name, r] of Object.entries(cases)) {
    assert.ok(sb.checkRecord(r, p).length > 0, name);
    const t = sb.topicWithEvidence(p, r, ON);
    const v = b1.readBundle(t.b1Evidence);
    assert.strictEqual(v.status, "BLOCKED", name);
    if (name !== "blocked bundle") assert.match(v.blockedReason, /Stage B evidence record rejected/, name);
  }
});

test("stageb: a rejected record stops the Planner before any model call", NEEDS, async () => {
  const old = process.env.AGENT_MARKETING_B1_EVIDENCE; process.env.AGENT_MARKETING_B1_EVIDENCE = "dev";
  try {
    for (const r of [null, record({ topic_id: "t-other" })]) {
      let called = false;
      const p = { ...project(), selected_topic: sb.topicWithEvidence(project(), r) };
      await assert.rejects(planLib.generatePlan({ project: p, anthropicKey: "k", callFn: async () => { called = true; return "{}"; } }), (e) => e.code === "B1_EVIDENCE_BLOCKED");
      assert.strictEqual(called, false);
    }
  } finally { if (old === undefined) delete process.env.AGENT_MARKETING_B1_EVIDENCE; else process.env.AGENT_MARKETING_B1_EVIDENCE = old; }
});

test("stageb: switch off, or a legacy (non Article-Led) topic, leaves the topic unchanged", () => {
  const p = project();
  assert.strictEqual(sb.topicWithEvidence(p, null, {}), p.selected_topic);
  const legacy = { ...p, selected_topic: { ...p.selected_topic } }; delete legacy.selected_topic.candidate;
  assert.strictEqual(sb.topicWithEvidence(legacy, null, ON), legacy.selected_topic);
});

test("stageb: the Planner input keeps each validated finding's attribution and limits, and never a held one", NEEDS, () => {
  const ae = b1.plannerArticleEvidence(b1.readBundle(BUNDLE("FC")));
  const K = PRIV.cases.fc;
  const fig = ae.validated_findings.find((f) => f.kind === "figure" && new RegExp(K.validated_figure_regex).test(f.finding));
  assert.strictEqual(fig.attribution, K.validated_attribution);
  const ex = ae.validated_findings.filter((f) => f.kind === "explanation");
  assert.ok(ex.length && ex.every((f) => /no data or source given/.test(f.attribution || "")), "unsupported explanations say so");
  assert.ok(!JSON.stringify(ae).includes(K.held_headline));
});
