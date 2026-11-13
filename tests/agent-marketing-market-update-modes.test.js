// Run with: npm test
// Market Update modes (Nov 8, 2026): the three explicit choices, the source-of-truth correction (local market performance statistics vs article
// facts), and B2's structured Realtor editorial step (validation and topic cards). No network, no private data.
const test = require("node:test");
const assert = require("node:assert");
const rl = require("../netlify/functions/lib/agent-marketing-research-lib");
const art = require("../netlify/functions/lib/agent-marketing-article-lib");
const b2 = require("../netlify/functions/lib/agent-marketing-b2-lib");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");
const reportLib = require("../netlify/functions/lib/agent-marketing-report-lib");
const rt = require("../netlify/functions/lib/agent-marketing-research-report-lib");
const tv = require("./helpers/trend-fixture");

const ID = "11111111-1111-4111-8111-111111111111";
const BASE = { mode: "market_update", audience: "sellers", geography: { zip: "95648", type: "city", name: "Lincoln" } };
const v = (x) => rl.validateResearchRequest({ ...BASE, ...x });

test("modes: each Market Update type allows exactly one data source; types 1 and 2 need the confirmed report, type 3 does not", () => {
  assert.deepStrictEqual(rl.MARKET_UPDATE_MODES.map((m) => [m.key, m.dataSource, m.reportRequired]),
    [["trend_report", "upload", true], ["article_report", "both", true], ["article_editorial", "web", false]]);
  assert.deepStrictEqual([v({ marketUpdateMode: "trend_report", uploadIds: [ID] }).request.dataSource, v({ marketUpdateMode: "article_report", uploadIds: [ID] }).request.dataSource], ["upload", "both"]);
  const m3 = v({ marketUpdateMode: "article_editorial", uploadIds: [ID] });
  assert.deepStrictEqual([m3.ok, m3.request.dataSource, m3.request.uploadIds], [true, "web", []], "type 3 never uses a report, even if one is attached");
  for (const m of ["trend_report", "article_report"]) {
    const r = v({ marketUpdateMode: m });
    assert.strictEqual(r.ok, false, m);
    assert.ok(r.errors.some((e) => /needs your uploaded Trend or CMA report/.test(e.message)), m);
  }
  assert.strictEqual(v({ marketUpdateMode: "everything" }).ok, false);
  assert.strictEqual(v({ marketUpdateMode: "article_editorial" }).request.marketUpdateMode, "article_editorial");
  assert.strictEqual(rl.validateResearchRequest({ ...BASE, mode: "local_events", marketUpdateMode: "trend_report" }).request.marketUpdateMode, undefined, "Local Events has no Market Update type");
  assert.strictEqual(v({}).request.dataSource, "web", "no type chosen: the earlier default");
});

test("source of truth: local market performance statistics are the report's; planned-development counts, dates and financing are article facts", () => {
  const roles = (s) => art.numberRoles(s).map((n) => n.role);
  assert.deepStrictEqual(roles("Could 81 builder listings change what Lincoln resale sellers can ask?"), ["market"]);
  assert.deepStrictEqual(roles("A proposed 132-unit affordable apartment complex is planned at Poker Lane."), ["fact"]);
  assert.deepStrictEqual(roles("Village 7 will add 1,200 homes, the city said in March 2026."), ["fact", "fact", "fact"]);
  assert.deepStrictEqual(roles("The median sold price was $625,000, the same as in September of 2025."), ["market", "fact"]);
  assert.deepStrictEqual(roles("Homes sold in about 49 days at 95% of original list price."), ["market", "market"]);
  assert.deepStrictEqual(roles("Mortgage rates near 6.5% have kept buyers cautious."), ["fact"]);
  assert.deepStrictEqual(roles("Builders are offering $20,000 in incentives."), ["fact"]);
  assert.deepStrictEqual(roles("Mello-Roos fees can add $300 a month."), ["fact"]);
  assert.deepStrictEqual(roles("There are 2.7 months of inventory."), ["market"]);
});

test("source of truth: a mode-2 question keeps its idea with only the market figure removed (no placeholder); statistic sentences are dropped elsewhere", () => {
  const t = { reportFirst: true, question: "Could 81 builder listings change what Lincoln resale sellers can ask?", whyItMatters: "Builders filed plans for 1,200 homes at Village 7. Active listings rose 12% from August.", trendSignals: ["Median price fell 3.1%.", "A 132-unit complex was approved in May."] };
  const f = art.articleFacts(t);
  assert.strictEqual(f.question, "Could builder listings change what Lincoln resale sellers can ask?");
  assert.strictEqual(f.whyItMatters, "Builders filed plans for 1,200 homes at Village 7.");
  assert.deepStrictEqual(f.trendSignals, ["A 132-unit complex was approved in May."]);
  const brief = planLib.topicBrief({ ...t, sources: [{ url: "https://x.example/a", title: "A" }] });
  assert.strictEqual(brief.topic_question, "Could builder listings change what Lincoln resale sellers can ask?");
  assert.notStrictEqual(brief.topic_question, "the topic's question");
});

// ── B2 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const RECORDS = [{
  id: "A1", title: "How do you sell a home in Lincoln when you're competing with new construction?", url: "https://example.org/lincoln", completeness: "COMPLETE", held_findings_not_used: 0,
  findings: [
    { id: "A1-F1", kind: "explanation", finding: "Builders compete with incentives resale sellers cannot match.", source_quotes: ["Builders often offer rate buy-downs and closing-cost credits that resale sellers can't match."], attribution: "the article", qualifications: null },
    { id: "A1-F2", kind: "figure", finding: "81 builder listings make up a large share of for-sale homes.", source_quotes: ["There are 81 builder listings in Lincoln right now."], attribution: "the article", qualifications: null },
    { id: "A1-F3", kind: "consequence", finding: "Resale homes can win on what builders cannot deliver.", source_quotes: ["A finished yard, a known HOA history and a closing date you control are things a new build can't offer."], attribution: "the article", qualifications: null },
  ],
}];
const cand = (over) => ({ id: "C1", question: "Can my resale home compete with builder incentives?", article: "A1", findings: ["A1-F1"], mechanism: "Builder incentives", homeowner_implication: "Price against the builder's net, not its sticker.", editorial_angle: "Compete on what builders can't offer.", why_it_matters: "Builders' credits change the comparison buyers make.", ...over });

test("B2: candidates must cite findings of ONE article, be distinct, and up to five are selected (filled in order when the model picks fewer)", () => {
  const raw = { candidates: [cand(), cand({ id: "C2", question: "What can a resale home offer that a new build can't?", findings: ["A1-F3"] }), cand({ id: "C3", question: "Can my resale home compete with builder incentives?" }),
    cand({ id: "C4", findings: ["A9-F1"], question: "Bad ref?" }), cand({ id: "C5", findings: [], question: "No ref?" })], selected: ["C2"] };
  const r = b2.validate(raw, { records: RECORDS, mode: "article_editorial", reportFigures: [] });
  assert.deepStrictEqual(r.candidates.map((c) => c.id), ["C1", "C2"]);
  assert.deepStrictEqual(r.selected, ["C2", "C1"]);
  assert.ok(r.problems.some((p) => /duplicate/.test(p)) && r.problems.some((p) => /cites no finding/.test(p)));
});

test("B2 (Nov 9, 2026): number-matching no longer drops candidates in mode 2 or mode 3; report figure ids are still kept", () => {
  const facts = reportLib.analyzePages(tv.standard().pages).facts;
  const ctx = rt.buildContext([{ id: ID, facts }], { geography: { type: "city", name: "Lincoln", zip: "95648" } });
  const figs = [...ctx.figures.values()].map((cf) => ({ ref: cf.ref, text: rt.figureText(cf) }));
  const dom = figs.findIndex((f) => /days on market/i.test(f.text));
  assert.ok(dom >= 0, "the fixture report has a days-on-market figure");
  const domNum = (figs[dom].text.match(/\d[\d,]*(?:\.\d+)?/) || [])[0];
  const raw2 = { candidates: [
    cand({ id: "C1", question: "Will 81 builder listings push Lincoln prices down?", findings: ["A1-F2"] }),
    cand({ id: "C2", question: `Homes take ${domNum} days on market: should I price against builders?`, findings: ["A1-F1"], report_figures: [`R${dom + 1}`] }),
  ], selected: ["C1", "C2"] };
  const r2 = b2.validate(raw2, { records: RECORDS, mode: "article_report", reportFigures: figs });
  assert.deepStrictEqual(r2.candidates.map((c) => c.id), ["C1", "C2"]);
  assert.deepStrictEqual(r2.candidates[1].reportFigureRefs, [`R${dom + 1}`]);
  const raw3 = { candidates: [
    cand({ id: "C1", question: "What do 95 builder listings mean for Lincoln sellers?", findings: ["A1-F2"] }),
    cand({ id: "C2", question: "Thinking of selling in 2 to 5 years: does new construction change the plan?", findings: ["A1-F2"] }),
  ], selected: ["C1", "C2"] };
  const r3 = b2.validate(raw3, { records: RECORDS, mode: "article_editorial", reportFigures: [] });
  assert.deepStrictEqual(r3.candidates.map((c) => c.id), ["C1", "C2"]);
  assert.deepStrictEqual(r3.problems, []);
  // structure is still checked: a finding from another article, or a duplicate question, is dropped
  const r4 = b2.validate({ candidates: [cand({ id: "C1", findings: ["A9-F1"] }), cand({ id: "C2" }), cand({ id: "C3" })], selected: ["C1", "C2", "C3"] }, { records: RECORDS, mode: "article_editorial", reportFigures: [] });
  assert.deepStrictEqual(r4.candidates.map((c) => c.id), ["C2"]);
});

test("B2 audience continuum: the prompt carries the Seller and Buyer decision journey and professional interpretation; audience_journey reaches the planner", () => {
  for (const mode of ["article_editorial", "article_report"]) {
    const sp = b2.systemPrompt(mode);
    assert.match(sp, /2 to 5 years/); assert.match(sp, /renters and existing homeowners/);
    assert.match(sp, /do not assume an immediate listing, purchase, tour or transaction/);
    assert.match(sp, /not the boundary of the agent's professional interpretation/);
    assert.match(sp, /Never invent a specific date, price, assessment or guaranteed outcome/);
    assert.match(sp, /"audience_journey": string/);
  }
  const articles = [{ url: RECORDS[0].url, title: RECORDS[0].title, domain: "example.org", published: "2026-10-20", fromTopic: { scope: "selected" } }];
  const result = b2.validate({ candidates: [cand({ audience_journey: "Useful whether you sell next spring or in a few years." })], selected: ["C1"] }, { records: RECORDS, mode: "article_editorial", reportFigures: [] });
  const [t] = b2.toTopics({ result, records: RECORDS, articles, evidence: new Map(), mode: "article_editorial", reportSource: null });
  assert.strictEqual(t.b2.audienceJourney, "Useful whether you sell next spring or in a few years.");
  const old = process.env.AGENT_MARKETING_B1_EVIDENCE; process.env.AGENT_MARKETING_B1_EVIDENCE = "dev";
  try {
    const brief = planLib.topicBrief({ ...t, sources: t.sources });
    assert.strictEqual(brief.editorial_direction.audience_journey, "Useful whether you sell next spring or in a few years.");
    assert.ok(brief.editorial_direction.mechanism && brief.editorial_direction.homeowner_implication !== undefined);
  } finally { if (old === undefined) delete process.env.AGENT_MARKETING_B1_EVIDENCE; else process.env.AGENT_MARKETING_B1_EVIDENCE = old; }
});

test("B2 topic cards carry the B1 evidence reference and the B2 editorial direction; mode decides report-first", () => {
  const articles = [{ url: RECORDS[0].url, title: RECORDS[0].title, domain: "example.org", published: "2026-10-20", fromTopic: { scope: "selected", editorial: { development: "Lincoln new construction" } } }];
  const result = b2.validate({ candidates: [cand(), cand({ id: "C2", question: "What can a resale home offer that a new build can't?", findings: ["A1-F3"] })], selected: ["C2", "C1"] }, { records: RECORDS, mode: "article_editorial", reportFigures: [] });
  const evidence = new Map([[RECORDS[0].url, { id: "ev-1" }]]);
  for (const mode of ["article_editorial", "article_report"]) {
    const ts = b2.toTopics({ result, records: RECORDS, articles, evidence, mode, reportSource: mode === "article_report" ? { type: "report", title: "Your MLS report" } : null });
    assert.deepStrictEqual(ts.map((t) => t.id), ["t1", "t2"]);
    const t = ts[0];
    assert.strictEqual(t.question, "What can a resale home offer that a new build can't?");
    assert.deepStrictEqual(t.b1, { articleKey: b2.articleKey(RECORDS[0].url), evidenceId: "ev-1", completeness: "COMPLETE", findings: ["A1-F3"] });
    assert.strictEqual(t.b2.sourceRefs[0].quote, RECORDS[0].findings[2].source_quotes[0]);
    assert.strictEqual(t.reportFirst, mode === "article_report");
    assert.ok(t.candidate && t.sources[0].url === RECORDS[0].url);
    assert.strictEqual(t.sources.some((s) => s.type === "report"), mode === "article_report");
  }
});

test("planner: B2 direction reaches the script writer only with the development switch; mode 2 quotations never carry an article market statistic", () => {
  const t = { reportFirst: true, question: "Q?", whyItMatters: "W.", sources: [{ url: "https://x.example/a", title: "A" }],
    b2: { editorialAngle: "Compete on what builders can't offer.", mechanism: "Builder incentives", homeownerImplication: "Price against the net.", sourceRefs: [{ finding: "A1-F2", quote: "There are 81 builder listings in Lincoln right now.", attribution: "the article" }, { finding: "A1-F1", quote: "Builders often offer rate buy-downs.", attribution: null }] } };
  assert.strictEqual(planLib.topicBrief(t, {}).editorial_direction, undefined, "switch off: unchanged");
  const ed = planLib.topicBrief(t, { AGENT_MARKETING_B1_EVIDENCE: "dev" }).editorial_direction;
  assert.strictEqual(ed.angle, "Compete on what builders can't offer.");
  assert.deepStrictEqual(ed.source_refs.map((r) => r.finding), ["A1-F1"], "the listing statistic is the report's job");
  const ed3 = planLib.topicBrief({ ...t, reportFirst: false }, { AGENT_MARKETING_B1_EVIDENCE: "dev" }).editorial_direction;
  assert.deepStrictEqual(ed3.source_refs.map((r) => r.finding), ["A1-F2", "A1-F1"], "mode 3: attributed article figures may be used");
  assert.match(planLib.buildSystemPrompt({ AGENT_MARKETING_B1_EVIDENCE: "dev" }), /^2i\. EDITORIAL DIRECTION/m);
  assert.doesNotMatch(planLib.buildSystemPrompt({}), /editorial_direction/);
});

test("the page offers the three types, requires the report for types 1 and 2, and starts the research job itself on a development deploy", () => {
  const fs = require("fs"), path = require("path");
  const ui = fs.readFileSync(path.join(__dirname, "..", "agent-marketing-research-ui.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "agent-marketing.html"), "utf8");
  assert.match(html, /id="muModeChoices"/);
  assert.match(ui, /action: "set_mode"/);
  assert.match(ui, /This Market Update type uses your Trend or CMA report/);
  assert.match(ui, /if \(r\.json\.dispatch\) \{\s*var bg = await api\("\/\.netlify\/functions\/agent-marketing-research-background", "POST", "", \{ researchId: r\.json\.research\.id \}\)/);
  assert.doesNotThrow(() => new Function(ui));
});

test("script writer handoff (development): a B2 topic gets the interpretation-and-audience story architecture; the system prompt carries rules 2j and 2k", () => {
  const old = process.env.AGENT_MARKETING_B1_EVIDENCE; process.env.AGENT_MARKETING_B1_EVIDENCE = "dev";
  try {
    const topic = { id: "t2", question: "Hidden Hills Phase 2 is going up nearby: when will those homes be for sale?", whyItMatters: "w", scope: "selected", origin: "web", reportFirst: false, trendSignals: [], reportFigures: [],
      sources: [{ url: "https://example.org/a", kind: "article", role: "primary", title: "t" }],
      b2: { mode: "article_editorial", mechanism: "Design review is not lot creation", homeownerImplication: "Plan with the real timeline", editorialAngle: "Design review is an early step", audienceJourney: "Matters whether you sell this year or later.", sourceRefs: [{ finding: "A2-F1", quote: "the city held a design review" }] } };
    const u = JSON.parse(planLib.buildUserMessage({ template: "local_market_insider", duration_sec: 45, formats: ["9x16"], intake: { market: "Lincoln, CA", audience: "Home sellers", action: "Ask for a local perspective" }, selected_topic: topic }));
    assert.match(u.narrative_architecture, /^A question naming what is at stake → the Realtor's answer, built from the evidence that establishes it/); assert.match(u.narrative_architecture, /what that answer means for the seller, specifically/); assert.ok(!/different points in their decision|what is still unresolved/.test(u.narrative_architecture));
    assert.deepStrictEqual(Object.keys(u.selected_topic.editorial_direction).slice(0, 4), ["angle", "mechanism", "homeowner_implication", "audience_journey"]);
    const sp = planLib.buildSystemPrompt();
    assert.ok(sp.includes("\n2j. REALTOR INTERPRETATION.") && sp.includes("\n2k. AUDIENCE."));
  } finally { if (old === undefined) delete process.env.AGENT_MARKETING_B1_EVIDENCE; else process.env.AGENT_MARKETING_B1_EVIDENCE = old; }
  // without the development switch the legacy architecture and prompt are unchanged
  const u0 = JSON.parse(planLib.buildUserMessage({ template: "local_market_insider", duration_sec: 45, formats: ["9x16"], intake: { market: "Lincoln, CA", audience: "Home sellers" }, selected_topic: { question: "q", sources: [{ url: "https://example.org/a" }], b2: { editorialAngle: "a" } } }));
  assert.match(u0.narrative_architecture, /what the sourced facts show \(only those\)/);
});
