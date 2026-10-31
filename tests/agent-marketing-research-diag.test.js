// Run with: npm test
// PR 1: research diagnostics. The first group proves NOTHING else changed (output identical to the code before PR 1); the rest check what is recorded.
const test = require("node:test");
const assert = require("node:assert");
const run = require("../netlify/functions/lib/agent-marketing-research-run-lib");
const rl = require("../netlify/functions/lib/agent-marketing-research-lib");
const dg = require("../netlify/functions/lib/agent-marketing-research-diag-lib");
const fx = require("./fixtures/research-diag/scenarios");
const golden = require("./fixtures/research-diag/golden.json");
const baseline = require("../scripts/research-baseline");

const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
const discoveryOf = (r) => r.fields.usage && r.fields.usage.discovery;
const strip = (fields) => { const f = JSON.parse(JSON.stringify(fields)); if (f.usage) delete f.usage.discovery; return f; };
const byName = (n) => fx.scenarios().find((s) => s.name === n);

// ── Nothing else changed ───────────────────────────────────────────────────────────────────────
for (const sc of fx.scenarios()) {
  test(`unchanged: ${sc.name} gives the same fields, problems, attempts and provider requests as before PR 1`, async () => {
    const { result, sent } = await quiet(() => fx.runScenario(run, sc));
    const g = golden[sc.name];
    assert.deepStrictEqual(strip(result.fields), g.fields);
    assert.deepStrictEqual(result.problems, g.problems);
    assert.strictEqual(result.attempts, g.attempts);
    assert.deepStrictEqual(sent, g.payloads, "the prompt and search settings sent to the provider are identical");
  });
}

test("unchanged: a diagnostics failure cannot change the research result", async () => {
  const sc = byName("all_lost_then_retry_ok");
  for (const name of ["buildRecord", "attemptConfig", "candidatesOf", "newAttemptDiag", "depthOf", "bound"]) {
    const orig = dg[name];
    dg[name] = () => { throw new Error(`boom ${name}`); };
    try {
      const { result } = await quiet(() => fx.runScenario(run, sc));
      assert.deepStrictEqual(strip(result.fields), golden[sc.name].fields, `${name} threw`);
      assert.strictEqual(result.attempts, golden[sc.name].attempts);
    } finally { dg[name] = orig; }
  }
});

test("unchanged: validateTopics and groundTopics return the same without a collector", () => {
  const t = [{ question: "Why is it slow here?", why_it_matters: "x", trend_signals: [], sources: [{ title: "a", url: "https://a.example/news/x", published: "2026-10-20" }] }];
  assert.deepStrictEqual(rl.validateTopics(t, { mode: "market_update", today: "2026-10-24" }), rl.validateTopics(t, { mode: "market_update", today: "2026-10-24", diag: dg.newAttemptDiag() }));
  assert.deepStrictEqual(run.groundTopics(t, { search_results: [] }), run.groundTopics(t, { search_results: [] }, dg.newAttemptDiag()));
});

// ── Stage and reason for every source ──────────────────────────────────────────────────────────
test("each dropped source records the stage that removed it and a reason code", async () => {
  const { result } = await quiet(() => fx.runScenario(run, byName("all_lost_then_retry_ok")));
  const a1 = discoveryOf(result).attempts[0];
  const got = Object.fromEntries(a1.sources.map((s) => [s.topic, `${s.stage}/${s.code}`]));
  assert.deepStrictEqual(got, {
    1: "provider_grounding/not_in_provider_results", 2: "article_eligibility/paywalled", 3: "publication_date/stale",
    4: "publication_date/no_publication_date", 5: "article_eligibility/listing_or_agent_site",
  });
  assert.ok(a1.sources.every((s) => s.outcome === "dropped"));
  assert.ok(a1.topics.every((t) => t.stage === "topic_selection" && t.outcome === "left_out" && t.code === "no_usable_source"));
});

test("duplicates, future dates and topic-selection decisions are separate stages", async () => {
  let r = await quiet(() => fx.runScenario(run, byName("overlap_duplicate_future_sixth")));
  let a = discoveryOf(r.result).attempts[0];
  assert.ok(a.sources.some((s) => s.stage === "duplicate" && s.code === "duplicate_address_in_topic" && s.topic === 3));
  assert.ok(a.sources.some((s) => s.stage === "publication_date" && s.code === "future_dated" && s.topic === 4));
  assert.ok(a.topics.some((t) => t.code === "overlaps_earlier_topic" && t.topic === 2 && /topic 1/.test(t.detail)));
  r = await quiet(() => fx.runScenario(run, byName("six_with_repeat_article")));
  a = discoveryOf(r.result).attempts[0];
  assert.ok(a.topics.some((t) => t.code === "ranked_beyond_five" && t.outcome === "left_out"));
  r = await quiet(() => fx.runScenario(run, byName("five_with_repeat_article")));
  a = discoveryOf(r.result).attempts[0];
  const rep = a.topics.find((t) => t.code === "kept_repeat_article");
  assert.ok(rep && rep.final_rank === 5 && rep.outcome === "kept");
});

test("a kept source says whether its date came from the provider or from the model, and keeps the model's own date", async () => {
  const { result } = await quiet(() => fx.runScenario(run, byName("five_clean")));
  const s = discoveryOf(result).attempts[0].sources[0];
  assert.strictEqual(s.outcome, "kept"); assert.strictEqual(s.stage, "accepted");
  assert.strictEqual(s.date_from, "provider"); assert.strictEqual(s.model_date, "2026-10-18"); assert.ok(/^2026-10-\d\d$/.test(s.provider_date));
});

test("the funnel only narrows, for every attempt of every scenario", async () => {
  for (const sc of fx.scenarios()) {
    const { result } = await quiet(() => fx.runScenario(run, sc));
    for (const a of discoveryOf(result).attempts) {
      if (!a.funnel) continue;
      const f = a.funnel;
      assert.ok(f.named_by_model >= f.grounded_by_provider && f.grounded_by_provider >= f.article_eligible && f.article_eligible >= f.date_ok && f.date_ok >= f.unique_sources, `${sc.name} attempt ${a.n}`);
      assert.ok(f.topics_answered >= f.topics_kept);
    }
  }
});

// ── Search configuration, retries and cost ─────────────────────────────────────────────────────
test("every attempt records the full search configuration, the retry reason and its own usage and cost", async () => {
  const { result } = await quiet(() => fx.runScenario(run, byName("all_lost_then_retry_ok")));
  const d = discoveryOf(result);
  assert.strictEqual(d.attempts.length, 2);
  assert.deepStrictEqual(d.attempts[0].config, { model: "perplexity/sonar", search_context: "medium", max_results: 10, search_context_tokens: 6000, max_output_tokens: 2200, published_after: "08/25/2026" });
  assert.strictEqual(d.attempts[1].config.max_results, 20);              // the retry widens both numbers
  assert.strictEqual(d.attempts[1].config.search_context_tokens, 10000);
  assert.strictEqual(d.attempts[0].retry_reason, null);
  assert.ok(Array.isArray(d.attempts[1].retry_reason) && d.attempts[1].retry_reason.length);
  const u = d.attempts[0].usage;
  assert.strictEqual(u.promptTokens, 4002); assert.strictEqual(u.completionTokens, 1502); assert.strictEqual(u.searchQueries, 2); assert.ok(u.costUsd > 0);
  assert.ok(Math.abs(d.attempts.reduce((s, a) => s + a.usage.costUsd, 0) - result.fields.usage.costUsd) < 1e-9, "attempt costs add up to the stored total");
  assert.strictEqual(d.used_attempt, 2);
  assert.ok(/^[0-9a-f]{16}$/.test(d.reproduce.instructions_sha256) && /^[0-9a-f]{16}$/.test(d.reproduce.input_sha256));
});

test("a provider failure is recorded as a failed attempt and never contains the key", async () => {
  const { result } = await quiet(() => fx.runScenario(run, byName("provider_rejects_key")));
  const d = discoveryOf(result);
  assert.strictEqual(result.fields.status, "failed");
  assert.strictEqual(d.attempts[0].provider_error, true);
  assert.ok(!JSON.stringify(d).includes("SECRET") && !JSON.stringify(result.fields.usage).includes("SECRET"));
});

// ── Sanitized and bounded ──────────────────────────────────────────────────────────────────────
test("urls are stored without query strings, fragments, credentials, ports or opaque ids", () => {
  assert.strictEqual(dg.safeUrl("https://www.Example.com/news/a?token=SECRET&x=1#frag"), "https://example.com/news/a");
  assert.strictEqual(dg.safeUrl("https://user:pw@site.example:8443/a/b"), "https://site.example/a/b");
  assert.strictEqual(dg.safeUrl("https://site.example/s/" + "A".repeat(40) + "/page"), "https://site.example/s/…/page");
  assert.strictEqual(dg.safeUrl("javascript:alert(1)"), "");
  assert.strictEqual(dg.safeUrl("not a url"), "");
  assert.ok(dg.safeUrl("https://site.example/" + "p".repeat(500)).length <= 200);
  assert.ok(!/pplx-|Bearer/.test(dg.safeText("see pplx-ABC123 and Bearer abc.def and api_key=zzz", 100)));
});

test("the record holds no keys, request text, keywords or uploaded-report content, and no raw answer or article text", async () => {
  const row = { ...byName("five_clean").row, focus: { keywords: "ZZZKEYWORD" }, upload_refs: [{ scope_note: "SECRET-SCOPE-NOTE median price 999,999" }] };
  const { result } = await quiet(() => fx.runScenario(run, { ...byName("five_clean"), row }));
  const text = JSON.stringify(discoveryOf(result));
  for (const bad of ["ZZZKEYWORD", "SECRET-SCOPE-NOTE", "999,999", "utm_source", "session=abc123", "output_text", "```json", "Active listings rose"]) assert.ok(!text.includes(bad), `found ${bad}`);
  assert.strictEqual(discoveryOf(result).request.keywords_given, true);
  assert.deepStrictEqual(Object.keys(discoveryOf(result).request.geography).sort(), ["city", "name", "type", "zip"]);
});

test("the record is bounded: oversized input is trimmed, and what was trimmed is listed", () => {
  const cands = Array.from({ length: 500 }, (_, i) => ({ url: `https://c${i}.example/` + "x".repeat(150), host: `c${i}.example`, provider_date: "2026-10-01", via: "search_results" }));
  const resp = { search_results: cands.map((c) => ({ url: c.url, date: c.provider_date })) };
  const found = dg.candidatesOf(resp);
  assert.strictEqual(found.total, 500); assert.strictEqual(found.list.length, dg.MAX_CANDIDATES);
  const diag = dg.newAttemptDiag();
  for (let i = 0; i < 400; i++) dg.pushSource(diag, { topic: (i % 5) + 1, url: `https://s${i}.example/` + "y".repeat(150), title: "T".repeat(500), outcome: "dropped", stage: "article_eligibility", code: "paywalled", detail: "D".repeat(500) });
  const rec = dg.buildRecord({ request: { mode: "market_update", geography: { type: "city", name: "Lincoln" } }, dataSource: "web", cfg: {}, firstPayload: {}, today: "2026-10-24",
    attempts: [1, 2, 3].map((n) => ({ n, config: {}, usage: {}, ms: 1, candidates: found, diag })), usedAttempt: 3, finalTopics: [] });
  dg.bound(rec);
  assert.ok(rec.bytes <= dg.MAX_BYTES, `size ${rec.bytes}`);
  assert.ok(rec.attempts.every((a) => (a.sources || []).length <= dg.MAX_SOURCE_RECORDS));
  assert.ok(Array.isArray(rec.trimmed) && rec.trimmed.length > 0, "something was trimmed and the record says what");
  assert.ok(JSON.stringify(rec).length < dg.MAX_BYTES + 200);
});

test("every record carries a retention date 90 days out", async () => {
  const { result } = await quiet(() => fx.runScenario(run, byName("five_clean")));
  assert.deepStrictEqual(discoveryOf(result).retention, { days: 90, expires: "2027-01-22" });
  assert.strictEqual(dg.RETENTION_DAYS, 90);
});

test("real-run stored records stay well inside the size cap for every scenario", async () => {
  for (const sc of fx.scenarios()) {
    const { result } = await quiet(() => fx.runScenario(run, sc));
    assert.ok(discoveryOf(result).bytes <= dg.MAX_BYTES, sc.name);
  }
});

// ── Research depth ─────────────────────────────────────────────────────────────────────────────
test("depth: government and housing-research sources, wider-area topics and substance are measured per topic", () => {
  const topics = [
    { id: "t1", origin: "web", scope: "selected", question: "Is Lincoln inventory growing?", whyItMatters: "x".repeat(130), trendSignals: ["Lincoln listings were 210 in September 2026", "Pending fell 4% last month"],
      sources: [{ url: "https://www.lincolnca.gov/news/a", published: "2026-10-20" }, { url: "https://www.redfin.com/news/b", published: "2026-10-10" }] },
    { id: "t2", origin: "web", scope: "broader_context", scopeNote: "Placer County", question: "County permits rose.", whyItMatters: "short", trendSignals: [],
      sources: [{ url: "https://news.example/a", published: "2026-09-01" }] },
  ];
  const d = dg.depthOf({ topics, geography: { name: "Lincoln" }, today: "2026-10-24", overlaps: 1 });
  assert.strictEqual(d.rubric, 1);
  const [p1, p2] = d.topics;
  assert.deepStrictEqual(p1.source_kinds, ["government", "housing_research"]);
  assert.strictEqual(p1.substance.score, 4); assert.strictEqual(p1.substantive, true); assert.strictEqual(p1.names_market_in_hook, true);
  assert.strictEqual(p1.newest_source_days, 4); assert.strictEqual(p1.oldest_source_days, 14);
  assert.strictEqual(p2.geographic_relationship, "wider_area_with_note"); assert.strictEqual(p2.substantive, false);
  assert.strictEqual(d.set.broader_context, 1); assert.strictEqual(d.set.exact_market, 1); assert.strictEqual(d.set.topics_with_government_source, 1);
  assert.strictEqual(d.set.overlapping_topics_removed, 1); assert.strictEqual(d.set.distinct_publishers, 3);
});

test("depth is stored with each run and counts the web topics before report topics are added", async () => {
  const { result } = await quiet(() => fx.runScenario(run, byName("five_clean")));
  const d = discoveryOf(result);
  assert.strictEqual(d.depth.set.topics, 5); assert.strictEqual(d.depth.set.distinct_articles, 5);
  assert.deepStrictEqual(d.final, { topics: 5, origin: { web: 5, report: 0 }, scope: { selected: 5, broader_context: 0 }, reframed: 0 });
});

// ── Baseline harness ───────────────────────────────────────────────────────────────────────────
test("baseline: four markets by five cells; the 10/20 comparison separates result count from context tokens", () => {
  assert.deepStrictEqual(Object.keys(baseline.MARKETS), ["lincoln", "natomas", "crocker", "thin"]);
  const cells = Object.fromEntries(baseline.CELLS.map((c) => [c.id, c]));
  assert.deepStrictEqual([cells.r10_c6000, cells.r20_c6000, cells.r10_c10000, cells.r20_c10000].map((c) => [c.results, c.context]), [[10, 6000], [20, 6000], [10, 10000], [20, 10000]]);
  assert.strictEqual(cells.as_shipped.results, null);
  assert.strictEqual(baseline.plan(Object.keys(baseline.MARKETS), 2).length, 4 * 5 * 2);
  assert.throws(() => baseline.parseArgs([]), /exactly one/);
  assert.throws(() => baseline.parseArgs(["--live", "--markets", "atlantis"]), /Unknown market/);
});

test("baseline: a fixed cell sends exactly one search with the stated limits, and records them", async () => {
  for (const cell of baseline.CELLS.filter((c) => c.results != null)) {
    const sc = byName("five_clean");
    const { result, sent } = await quiet(() => fx.runScenario(run, { ...sc, env: baseline.cellEnv({}, cell) }));
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].tools[0].max_results, cell.results);
    assert.strictEqual(sent[0].tools[0].max_tokens, cell.context);
    const c = discoveryOf(result).attempts[0].config;
    assert.strictEqual(c.max_results, cell.results); assert.strictEqual(c.search_context_tokens, cell.context);
  }
});

test("limits: unset, the named size decides as before; a bad value is ignored", () => {
  const p = (env) => rl.buildResearchPayload({ request: { mode: "market_update", audience: "sellers", geography: fx.GEO.lincoln, focus: {}, keywords: "" }, today: "2026-10-24", uploadContext: "", env }).tools[0];
  assert.deepStrictEqual([p({}).max_results, p({}).max_tokens], [10, 6000]);
  assert.deepStrictEqual([p({ AGENT_MARKETING_RESEARCH_CONTEXT: "high" }).max_results, p({ AGENT_MARKETING_RESEARCH_CONTEXT: "high" }).max_tokens], [20, 10000]);
  assert.deepStrictEqual([p({ AGENT_MARKETING_RESEARCH_MAX_RESULTS: "99", AGENT_MARKETING_RESEARCH_SEARCH_TOKENS: "abc" }).max_results, p({ AGENT_MARKETING_RESEARCH_MAX_RESULTS: "99", AGENT_MARKETING_RESEARCH_SEARCH_TOKENS: "abc" }).max_tokens], [10, 6000]);
});

test("baseline summary: one row per market and cell, with candidates, depth and cost", () => {
  const rows = [{ market: "lincoln", cell: "r10_c6000", status: "ready", funnel: { provider_candidates: 12, grounded_by_provider: 6 }, topics_kept: 5, substantive_topics: 2, distinct_publishers: 4, cost_usd: 0.02, cost_per_kept_topic: 0.004 },
    { market: "lincoln", cell: "r10_c6000", status: "failed", funnel: { provider_candidates: 8, grounded_by_provider: 0 }, topics_kept: 0, substantive_topics: null, distinct_publishers: null, cost_usd: 0.01, cost_per_kept_topic: null }];
  const md = baseline.summaryMarkdown(rows);
  assert.ok(/\| lincoln \| r10_c6000 \| 2 \| 1 \| 10\.0 \| 3\.0 \| 2\.5 \|/.test(md));
  assert.ok(/Total provider cost of these runs: \$0\.0300/.test(md));
});
