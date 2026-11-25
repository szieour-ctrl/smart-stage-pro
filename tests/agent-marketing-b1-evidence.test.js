// Run with: npm test   (B1_WORKSPACE=<private ssp-b1-evidence workspace> for the fixture tests; they are skipped, with the reason, without it)
// DEVELOPMENT ONLY (Nov 5, 2026): B1 article evidence between Article-Led research extraction and the Planner. Fixtures are the frozen v1.2.1 FA, FB
// and FC outputs after the B1 evidence gate, exported through load_evidence(). They are PRIVATE: loaded from the B1 workspace by
// tests/helpers/b1-private.js, never stored in this public repository. No provider call.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const b1 = require("../netlify/functions/lib/agent-marketing-b1-evidence-lib");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");
const gate = require("../netlify/functions/lib/agent-marketing-gate");

const PRIV = require("./helpers/b1-private");
const FX = (n) => PRIV.bundle(n);
const K = () => PRIV.cases.evidence;
const NEEDS = { skip: PRIV.skip };
const ON = { AGENT_MARKETING_B1_EVIDENCE: "dev" };
const payload = (doc) => JSON.parse(doc.payload);
const nrm = (s) => String(s).replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, " ").trim(); // the gate's own normalization
const quotes = (items) => items.flatMap((x) => b1.quotesOf(x.finding));
const withFlag = async (fn) => { const old = process.env.AGENT_MARKETING_B1_EVIDENCE; process.env.AGENT_MARKETING_B1_EVIDENCE = "dev"; try { return await fn(); } finally { if (old === undefined) delete process.env.AGENT_MARKETING_B1_EVIDENCE; else process.env.AGENT_MARKETING_B1_EVIDENCE = old; } };

// A selected Article-Led topic (Stage A) for the article B1 analysed; only the shape topicBrief and the gate read.
const topic = (doc) => b1.attachToTopic({ id: "t1", question: "What is happening to Sacramento housing prices?", whyItMatters: "Sellers are pricing for the spring market.",
  scope: "selected", scopeNote: "", sources: [{ title: "Article", url: "https://example.org/a" }], trendSignals: [] }, doc);
const project = (doc) => ({ template: "local_market_insider", duration_sec: 45, formats: ["9x16", "16x9"], selected_topic: topic(doc),
  intake: { angle: "neighborhood", market: "Sacramento, CA", audience: "Home sellers", issue: "Prices", action: "Understand the market", observation: "Buyers are taking their time this spring." } });

const ex = ["What does this spring market mean for your sale?", "Here is what I am seeing as buyers take their time.", "Pricing well still matters.",
  "Some homes still draw several offers when they are priced right, and that shapes how you should approach your own list price this season.", "Watch the homes near yours.", "Ask me for a local view."];
const sc = (i, k) => ({ role: ["local_hook", "tension", "insight", "comparison", "advice", "cta"][i], narration_excerpt: ex[i], purpose: "p" + i, visual_source: k, visual_brief: "b" + i,
  reuse_of_scene: k === "CONCEPT_REUSE" ? 2 : null, card_text: k === "BRAND_CARD" ? "Ask me for a local view" : null, authentic_photo_request: null,
  ai_generation_prompt: k === "GPT_IMAGE_2_CONCEPT" ? "Photorealistic editorial street of ordinary homes, soft light, no people, no text, wide composition" : null,
  camera_motion: "push_in", framing_9x16: "f", framing_16x9: "f", text_safe_placement: "lower middle" });
const goodPlan = () => JSON.stringify({ editorial_angle: "Spring pricing.", hook: ex[0], narration_with_audio_tags: `[conversational] ${ex.join(" ")}`,
  scenes: [sc(0, "GPT_IMAGE_2_CONCEPT"), sc(1, "GPT_IMAGE_2_CONCEPT"), sc(2, "CONCEPT_REUSE"), sc(3, "GPT_IMAGE_2_CONCEPT"), sc(4, "AGENT_PROFILE"), sc(5, "BRAND_CARD")],
  cta_suggestion: "Ask me for a local view.", claims_to_verify: [], missing_agent_inputs: [] });

test("b1: the fixtures read with the expected status and four separate collections", NEEDS, () => {
  for (const [n, st, counts] of [["FA", "PASSED_WITH_HOLDS", [21, 2, 1]], ["FB", "COMPLETE", [14, 0, 1]], ["FC", "PASSED_WITH_HOLDS", [10, 4, 0]], ["BLOCKED", "BLOCKED", [0, 0, 0]]]) {
    const v = b1.readBundle(FX(n));
    assert.strictEqual(v.status, st, n);
    assert.deepStrictEqual([v.validated.length, v.held.length, v.excluded.length], counts, n);
    assert.strictEqual(v.incomplete, st !== "COMPLETE");
    const vj = new Set(v.validated.map((x) => JSON.stringify(x.finding)));
    for (const h of v.held) assert.ok(!vj.has(JSON.stringify(h.finding)), "a held finding is never in the validated collection");
  }
});

test("b1: FA A1 stays held; A6 and A7 stay validated", NEEDS, () => {
  const v = b1.readBundle(FX("FA"));
  const a1 = v.held.filter((h) => h.section === "source_contradictions");
  assert.strictEqual(a1.length, 1);
  for (const m of PRIV.cases.fa_markers.A1_all) assert.ok(JSON.stringify(a1[0].finding).includes(m));
  assert.ok(!v.validated.some((x) => x.section === "source_contradictions" && JSON.stringify(x.finding).includes(K().fa_a1_figure)));
  assert.ok(v.validated.some((x) => x.section === "source_contradictions" && x.finding.first.quote.includes(K().fa_a6_quote)), "A6 validated");
  assert.ok(v.validated.some((x) => JSON.stringify(x.finding).includes(K().fa_a7_defect)), "A7 validated (as an extraction defect)");
});

test("b1: FC's headline stays held without review approval", NEEDS, () => {
  const v = b1.readBundle(FX("FC"));
  assert.ok(!v.validated.some((x) => x.section === "headline_claims"));
  const h = v.held.find((x) => x.section === "headline_claims");
  assert.ok(h); assert.strictEqual(h.quotes[0].recovery_outcome, "RECOVERY_CANDIDATE_REVIEW"); assert.strictEqual(payload(FX("FC")).provenance.authorized_reviewers, 0);
});

test("b1: no held or excluded finding reaches the Planner input or the gate's verified text", NEEDS, async () => {
  await withFlag(async () => {
    for (const n of ["FA", "FB", "FC"]) {
      const doc = FX(n), v = b1.readBundle(doc), p = project(doc);
      const msg = planLib.buildUserMessage(p);
      const ver = gate.verifiedFromProject(p).texts.join("\n");
      for (const x of [...v.held, ...v.excluded]) {
        for (const q of b1.quotesOf(x.finding)) { assert.ok(!msg.includes(JSON.stringify(q).slice(1, -1)), `${n}: held/excluded quotation in Planner input: ${q}`); assert.ok(!ver.includes(nrm(q)), `${n}: held/excluded quotation verified: ${q}`); }
        const c = b1.claimText(x.section, x.finding);
        if (c) assert.ok(!msg.includes(JSON.stringify(c).slice(1, -1)), `${n}: held/excluded claim in Planner input: ${c}`);
      }
      const ae = JSON.parse(msg).selected_topic.article_evidence;
      assert.strictEqual(ae.held_findings_not_verified, v.held.length);
      for (const f of ae.validated_findings) for (const q of f.source_quotes) assert.ok(quotes(v.validated).includes(q));
      for (const q of b1.verifiedQuotes(v)) assert.ok(ver.includes(nrm(q)), `${n}: validated quotation missing from verified text: ${q}`);
    }
  });
});

test("b1: extraction defects are never passed on as article claims", NEEDS, async () => {
  await withFlag(async () => {
    const ae = JSON.parse(planLib.buildUserMessage(project(FX("FA")))).selected_topic.article_evidence;
    assert.ok(!JSON.stringify(ae).includes(K().fa_a7_defect));
  });
});

test("b1: PASSED_WITH_HOLDS is labeled incomplete in the Planner input and as a plan warning", NEEDS, async () => {
  await withFlag(async () => {
    const p = project(FX("FC"));
    const ae = JSON.parse(planLib.buildUserMessage(p)).selected_topic.article_evidence;
    assert.strictEqual(ae.status, "PASSED_WITH_HOLDS"); assert.match(ae.status_label, /^INCOMPLETE \(PASSED_WITH_HOLDS\): 4 B1 finding\(s\)/);
    const out = await planLib.generatePlan({ project: p, anthropicKey: "k", callFn: async () => goodPlan() });
    assert.match(out.warnings[0], /^Article evidence is INCOMPLETE \(PASSED_WITH_HOLDS\): 4 B1 finding\(s\) are held for review/);
    const outB = await planLib.generatePlan({ project: project(FX("FB")), anthropicKey: "k", callFn: async () => goodPlan() });
    assert.ok(!outB.warnings.some((w) => /INCOMPLETE/.test(w)));
    assert.strictEqual(JSON.parse(planLib.buildUserMessage(project(FX("FB")))).selected_topic.article_evidence.status, "COMPLETE");
  });
});

test("b1: BLOCKED evidence stops the Planner before any model call", NEEDS, async () => {
  await withFlag(async () => {
    const tampered = { ...FX("FC"), payload: FX("FC").payload.replace("PASSED_WITH_HOLDS", "COMPLETE") };
    for (const doc of [FX("BLOCKED"), tampered, { format: "x" }, null]) {
      let called = false;
      await assert.rejects(planLib.generatePlan({ project: project(doc), anthropicKey: "k", callFn: async () => { called = true; return goodPlan(); } }), (e) => e.code === "B1_EVIDENCE_BLOCKED");
      assert.strictEqual(called, false);
      assert.strictEqual(JSON.parse(planLib.buildUserMessage(project(doc))).selected_topic.article_evidence, undefined);
      assert.deepStrictEqual(b1.verifiedQuotes(b1.readBundle(doc)), []);
    }
  });
});

test("b1: a changed or malformed bundle reads as BLOCKED", NEEDS, () => {
  const fc = FX("FC");
  assert.strictEqual(b1.readBundle({ ...fc, payload_sha256: "0".repeat(64) }).status, "BLOCKED");
  assert.strictEqual(b1.readBundle({ ...fc, format: "other" }).status, "BLOCKED");
  const p = payload(fc); p.validated.push(p.held[0]); delete p.provenance;
  const s = JSON.stringify(p); const h = require("crypto").createHash("sha256").update(s).digest("hex");
  assert.strictEqual(b1.readBundle({ format: b1.FORMAT, payload: s, payload_sha256: h }).status, "BLOCKED");
});

test("b1: a COMPLETE bundle that lists held findings is treated as incomplete", NEEDS, () => {
  const p = payload(FX("FC")); p.completeness_status = "COMPLETE";
  const s = JSON.stringify(p); const h = require("crypto").createHash("sha256").update(s).digest("hex");
  assert.strictEqual(b1.readBundle({ format: b1.FORMAT, payload: s, payload_sha256: h }).status, "PASSED_WITH_HOLDS");
});

test("b1: with the development switch off nothing changes (production path)", async () => {
  assert.strictEqual(b1.enabled({}), false); assert.strictEqual(b1.enabled({ AGENT_MARKETING_B1_EVIDENCE: "true" }), false); assert.strictEqual(b1.enabled(ON), true);
  const p = project({ format: "ssp-b1-evidence/1", payload: "{}", payload_sha256: "0".repeat(64) });   // any evidence value: ignored with the switch off
  assert.strictEqual(JSON.parse(planLib.buildUserMessage(p)).selected_topic.article_evidence, undefined);
  const plain = { ...p, selected_topic: { ...p.selected_topic } }; delete plain.selected_topic.b1Evidence;
  assert.deepStrictEqual(gate.verifiedFromProject(p), gate.verifiedFromProject(plain));
  const out = await planLib.generatePlan({ project: p, anthropicKey: "k", callFn: async () => goodPlan() });
  assert.ok(!out.warnings.some((w) => /Article evidence/.test(w)));
});

test("b1: the switch is server-side only: nothing in the module reads a request", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "lib", "agent-marketing-b1-evidence-lib.js"), "utf8");
  assert.ok(!/event\.|body\.|queryStringParameters|headers/.test(src));
});
