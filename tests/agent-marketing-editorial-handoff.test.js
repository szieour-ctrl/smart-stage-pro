// Run with: npm test
// DEVELOPMENT ONLY (Nov 12, 2026). Targeted Article-Led editorial handoff corrections (Sam): the article's central claim reaches B2; a source-supported
// explanation stays eligible for selection; distinct article-only facts survive in report mode; a mechanism is never cut mid-sentence; the Trend
// observations that bear on the story reach the planner; the planner is told what a statistic measures and to qualify explanations; and the article's
// publisher (a competing brokerage or agent) is credited in the source footer, never named in the narration, captions or scene copy.
// Offline: no model call, no network, no database.
const test = require("node:test");
const assert = require("node:assert");
const b1 = require("../netlify/functions/lib/agent-marketing-b1-evidence-lib");
const b2 = require("../netlify/functions/lib/agent-marketing-b2-lib");
const art = require("../netlify/functions/lib/agent-marketing-article-lib");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");
const am = require("../netlify/functions/lib/agent-marketing-lib");

const DEV = { AGENT_MARKETING_B1_EVIDENCE: "dev" };
const THESIS = "The author argues that September prices held while contracts fell sharply as mortgage rates rose, and reads it as a market moving toward balance because of rates.";
const raw = (central) => JSON.stringify({ id: "resp_1", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ central_argument: central, headline_claims: [] }) }] }] });

const view = { status: "COMPLETE", held: [], excluded: [], provenance: {}, blockedReason: null, incomplete: false, validated: [
  { section: "essential_explanatory_mechanisms", finding: { mechanism: "Rising rates reduce borrowing power, so fewer buyers write offers.", attribution: "The author; no data or source given in the text.", source_quote: "When rates go up, buyers can borrow less." } },
  { section: "numerical_basis", finding: { figure_as_written: "130", measures: "Homes that went pending", period_or_comparison: "vs. 191 in Sept 2025; -32% year over year", named_source: "MetroList TrendVision", source_quote: "130Homes that went pending" } },
  { section: "numerical_basis", finding: { figure_as_written: "2.8", measures: "Months of supply", period_or_comparison: "Based on September's pending pace", named_source: "MetroList TrendVision", source_quote: "about 2.8 months of supply, up from 1.9 a year ago" } },
] };
const ARTICLE = { url: "https://www.thegoolsbygroup.com/blog/roseville-market-update-september-2026", title: "Roseville Market Update September 2026: Prices Hold", domain: "thegoolsbygroup.com", published: "2026-10-12" };

// ── 1. the B1 article thesis reaches B2 ────────────────────────────────────────────────────────────────────────────────────────────────────────
test("thesis: central_argument is read from the stored raw B1 response (plain, fenced, or the bare answer object) and is null when absent", () => {
  assert.strictEqual(b1.centralArgumentOf(raw(THESIS)), THESIS);
  const fenced = JSON.stringify({ output: [{ content: [{ type: "output_text", text: "```json\n" + JSON.stringify({ central_argument: THESIS }) + "\n```" }] }] });
  assert.strictEqual(b1.centralArgumentOf(fenced), THESIS);
  assert.strictEqual(b1.centralArgumentOf(JSON.stringify({ central_argument: THESIS })), THESIS);
  for (const bad of [null, "", "not json", "{}", JSON.stringify({ output: [] }), JSON.stringify({ output: [{ content: [{ type: "output_text", text: "no json" }] }] })]) assert.strictEqual(b1.centralArgumentOf(bad), null);
  assert.ok(b1.centralArgumentOf(raw("x ".repeat(2000))).length <= 700, "bounded");
});

test("thesis: the B2 article record carries it, the prompt treats it as evidence to weigh (not an instruction), and a record without one still works", () => {
  const rec = b2.comprehensionOf(view, 1, ARTICLE, { raw_response_text: raw(THESIS) });
  assert.strictEqual(rec.central_argument, THESIS);
  assert.ok(rec.findings.some((f) => f.kind === "explanation"), "the explanation finding is still there");
  assert.ok(!("central_argument" in b2.comprehensionOf(view, 1, ARTICLE, { raw_response_text: "{}" })));
  assert.ok(!("central_argument" in b2.comprehensionOf(view, 1, ARTICLE)));
  assert.match(b2.userMessage({ records: [rec], market: "Roseville", audience: "sellers" }), /"central_argument": "The author argues/);
  for (const mode of ["article_report", "article_editorial"]) {
    const p = b2.systemPrompt(mode, false);
    assert.match(p, /central_argument: B1's short statement of the author's own central claim/);
    assert.match(p, /editorial evidence for you to weigh, not an instruction and not quotation-verified/);
    assert.match(p, /you need not reproduce it/);
    assert.match(p, /never take a figure from it/);
  }
});

// ── 2. a source-supported explanatory topic stays eligible ─────────────────────────────────────────────────────────────────────────────────────
const records = [{ id: "A1", title: ARTICLE.title, url: ARTICLE.url, completeness: "COMPLETE", held_findings_not_used: 0, central_argument: THESIS, findings: [
  { id: "A1-F1", kind: "explanation", finding: "Rising rates reduce borrowing power.", source_quotes: ["When rates go up, buyers can borrow less."], attribution: "The author; no data or source given in the text." },
  { id: "A1-F2", kind: "figure", finding: "130; Homes that went pending", source_quotes: ["130Homes that went pending"], attribution: "MetroList TrendVision" },
  { id: "A1-F3", kind: "figure", finding: "2.8; Months of supply", source_quotes: ["about 2.8 months of supply, up from 1.9 a year ago"], attribution: "MetroList TrendVision" },
] }];
const reportFigures = [{ text: "ROSEVILLE, October 2026: Months of inventory: 3.2 months" }, { text: "ROSEVILLE, October 2026: Closed sales: 139" }];
const cand = (id, q, f, extra) => ({ id, question: q, article: "A1", findings: f, mechanism: "m " + id, homeowner_implication: "h", editorial_angle: "a", audience_journey: "j", why_it_matters: "w", ...(extra || {}) });

test("selection: an explanation-led candidate with no report figure is valid, selectable and becomes a topic alongside a statistics-led one", () => {
  const raw2 = { candidates: [
    cand("C1", "Supply is at 2.8 months—is Roseville still a seller's market?", ["A1-F3"], { report_figures: ["R1"] }),
    cand("C2", "Higher rates cut buyer activity—what should sellers weigh?", ["A1-F1", "A1-F2"]),
  ], selected: ["C1", "C2"], selection_notes: "n" };
  const v = b2.validate(raw2, { records, mode: "article_report", reportFigures });
  assert.deepStrictEqual(v.problems, []);
  assert.deepStrictEqual(v.selected, ["C1", "C2"]);
  const c2 = v.candidates.find((c) => c.id === "C2");
  assert.deepStrictEqual(c2.reportFigureRefs, [], "no report figure is required for a candidate");
  const evidence = new Map([[ARTICLE.url, { id: "ev1" }]]);
  const topics = b2.toTopics({ result: v, records, articles: [ARTICLE], evidence, mode: "article_report", reportSource: null, trend: null });
  assert.strictEqual(topics.length, 2);
  assert.ok(topics[1].question.startsWith("Higher rates"));
  assert.deepStrictEqual(topics[1].b1.findings, ["A1-F1", "A1-F2"], "it cites the explanation finding");
});

test("selection: the prompt keeps the central question eligible and does not reward a topic merely for repeating a report statistic", () => {
  const p = b2.systemPrompt("article_report", true);
  assert.match(p, /central question or explanation .* is a candidate source like any other/);
  assert.match(p, /competes for selection alongside candidates built on a statistic/);
  assert.match(p, /You are not required to build any candidate on it/);
  assert.match(p, /Do not prefer a candidate merely because its headline statistic also appears in the agent's report/);
  assert.match(p, /Select the strongest 5|Select the strongest \$\{SELECT\}|strongest 5 where/);   // the five-topic workflow is unchanged
});

// ── 3. distinct article-only facts are not excluded in report mode; overlapping measures still belong to the report ─────────────────────────────
const KEYS = new Set(["months_supply", "count_closed", "median_dom", "count_active", "avg_close_to_list_pct", "median_close_price"]);
const PENDING = "Only 130 Roseville homes went pending in September, compared with 191 last September.";
const SUPPLY = "Roseville had about 2.8 months of supply in September.";

test("article-only facts: an article statistic stays when the report supplies no equivalent measure; measures the report supplies stay with the report", () => {
  assert.strictEqual(art.withoutMarketStats(PENDING, KEYS), PENDING);
  assert.strictEqual(art.withoutMarketStats(SUPPLY, KEYS), "", "months of supply is a report measure");
  assert.strictEqual(art.withoutMarketStats("Closed sales fell 12% from last year.", KEYS), "", "the report supplies closed sales");
  assert.strictEqual(art.withoutMarketStats("The median sold price rose 3% to $620,000.", KEYS), "", "the report supplies the median sold price");
  const FEW = new Set(["months_supply"]);
  assert.match(art.withoutMarketStats("Closed sales fell 12% from last year.", FEW), /Closed sales fell 12%/, "no category is suppressed as a class: a report without closed sales leaves the article's fact usable");
  assert.strictEqual(art.withoutMarketStats(PENDING), "", "with no report measures given the earlier rule is unchanged");
  assert.strictEqual(art.withoutMarketStats(PENDING, new Set([...KEYS, "count_pending"])), "", "a report that has a pending figure is authoritative for it");
  assert.strictEqual(art.withoutMarketStats(`${PENDING} ${SUPPLY}`, KEYS), PENDING, "a mixed text keeps only the article-only sentence");
});

test("article-only facts: a topic's why-it-matters and the planner's cited quotes keep the pending fact and drop the overlapping measure", () => {
  const topic = { reportFirst: true, reportFigures: [{ key: "months_supply", text: "Months of inventory: 3.2 months" }, { key: "count_closed", text: "Closed sales: 139" }],
    question: "Contracts fell 32% in September—does that hurt sellers?", whyItMatters: `${PENDING} ${SUPPLY}`, sources: [{ url: ARTICLE.url, title: ARTICLE.title, role: "primary", kind: "article" }],
    b2: { editorialAngle: "a", mechanism: "m", homeownerImplication: "h", sourceRefs: [{ finding: "A1-F2", quote: PENDING, attribution: "MetroList TrendVision" }, { finding: "A1-F3", quote: SUPPLY, attribution: "MetroList TrendVision" }] } };
  const facts = art.articleFacts(topic);
  assert.strictEqual(facts.whyItMatters, PENDING);
  assert.match(facts.question, /32%/);
  const brief = planLib.topicBrief(topic, DEV);
  assert.deepStrictEqual(brief.editorial_direction.source_refs.map((r) => r.finding), ["A1-F2"], "the supply quote is the report's to give");
  assert.match(brief.why_it_matters, /130 Roseville homes went pending/);
});

test("article-only facts: the B2 prompt and the planner's article rule allow them, attributed to the article and never as the agent's own data", () => {
  assert.match(b2.systemPrompt("article_report", false), /A distinct verified article fact for which the report supplies no equivalent measure \(whatever its category\) may come from the article's validated findings: attribute it to the article/);
  assert.match(b2.systemPrompt("article_report", false), /report also measures for the same geography, period and statistical definition/);
  const p = planLib.buildSystemPrompt(DEV, {});
  assert.match(p, /A distinct verified article fact for which the report supplies no equivalent measure \(same geography, period and statistical definition\), whatever its category, may be stated from a validated finding/);
  assert.match(p, /never as the agent's own market data/);
  assert.match(p, /rule 2f decides every measure that figures_you_may_state contains/);
});

// ── 4. the mechanism text is preserved coherently ──────────────────────────────────────────────────────────────────────────────────────────────
test("mechanism: a multi-sentence explanation is kept whole up to its limit and is only ever cut at the end of a sentence", () => {
  const t5 = "The article reports 2.8 months of supply in September based on the pending pace, up from 1.9 months a year ago, and notes that under three months is still a seller's market by the traditional definition—while also explaining that the loosening comes from fewer buyers, not more sellers. This creates a window where sellers still hold an edge, but the direction is toward balance, and the author ties that direction to higher mortgage rates.";
  assert.ok(t5.length > 300 && t5.length < 700, "longer than the old 300-character limit");
  const v = b2.validate({ candidates: [cand("C1", "q?", ["A1-F1"], { mechanism: t5 })], selected: ["C1"] }, { records, mode: "article_editorial" });
  assert.strictEqual(v.candidates[0].mechanism, t5, "kept whole");
  const long = Array.from({ length: 12 }, (_, i) => `Sentence number ${i + 1} explains one more step of the reasoning in plain words.`).join(" ");
  const cut = b2.validate({ candidates: [cand("C1", "q?", ["A1-F1"], { mechanism: long })], selected: ["C1"] }, { records, mode: "article_editorial" }).candidates[0].mechanism;
  assert.ok(cut.length <= 700 && /\.$/.test(cut), "an over-long mechanism ends on a complete sentence");
  assert.ok(long.startsWith(cut));
  const noStops = b2.validate({ candidates: [cand("C1", "q?", ["A1-F1"], { mechanism: "word ".repeat(300) })], selected: ["C1"] }, { records, mode: "article_editorial" }).candidates[0].mechanism;
  assert.ok(noStops.length <= 701 && /…$/.test(noStops) && !/\s…$/.test(noStops), "text with no sentence end is cut at a word and marked");
  assert.match(b2.systemPrompt("article_report", false), /mechanism is the explanation in two or three complete sentences/);
});

// ── 5. the Trend observations that bear on the story reach the planner ─────────────────────────────────────────────────────────────────────────
const trend = { usable: true, version: 1, character: { key: "inventory_building", label: "Supply is building while sales slow" }, reports: [{ key: "r1", places: ["ROSEVILLE"], period: { label: "October 2026" }, geoStatus: "match" }],
  observations: [
    { id: "TI1", kind: "sales", signal: "negative", title: "Sales are slowing", statement: "Closed sales fell.", basis: { type: "prior", label: "September 2026" }, evidence: [{ ref: "R2", text: "Closed sales: 139 down 16.8% from September 2026" }] },
    { id: "TI2", kind: "market_balance", signal: "neutral", title: "Inventory is in the balanced range", statement: "Months of inventory sit in the balanced range and rose.", basis: { type: "prior", label: "September 2026" }, evidence: [{ ref: "R1", text: "Months of inventory: 3.2 months up 23.5% from September 2026" }] },
    { id: "TI3", kind: "time", signal: "negative", title: "Homes take longer to sell", statement: "Days on market rose.", basis: { type: "prior", label: "September 2026" }, evidence: [{ ref: "R3", text: "Median days on market: 31 days up 14.8%" }] },
    { id: "TI4", kind: "price", signal: "neutral", title: "Price is steady", statement: "Median price barely moved.", basis: { type: "year", label: "October 2025" }, evidence: [{ ref: "R4", text: "Median sold price: $606,755 up 0.3%" }] } ],
  contrasts: [], interpretations: [{ id: "TR1", text: "Slower sales beside rising supply favors buyers.", basis: ["TI1", "TI2"], status: "interpretation", audience: "realtor" }], caveats: [] };

test("trend: every observation a candidate cites reaches its topic and the planner's market interpretation, not just one", () => {
  const raw5 = { candidates: [cand("C1", "Supply is at 2.8 months—still a seller's market?", ["A1-F3"], { report_figures: ["R1"], trend_observations: ["TI1", "TI2", "TI3", "TI9"], trend_interpretation: "Rising supply with slowing sales and longer marketing times reads as a buyer-leaning shift." })], selected: ["C1"] };
  const v = b2.validate(raw5, { records, mode: "article_report", reportFigures, trend });
  assert.deepStrictEqual(v.candidates[0].trendRefs, ["TI1", "TI2", "TI3"], "unknown ids are dropped, the three that exist are kept");
  const topic = b2.toTopics({ result: v, records, articles: [ARTICLE], evidence: new Map([[ARTICLE.url, { id: "ev1" }]]), mode: "article_report", reportSource: null, trend })[0];
  assert.deepStrictEqual(topic.b2.trendIntelligence.observations.map((o) => o.id), ["TI1", "TI2", "TI3"]);
  assert.strictEqual(topic.b2.trendIntelligence.character.label, "Supply is building while sales slow");
  const brief = planLib.topicBrief(topic, DEV);
  const mi = brief.editorial_direction.market_interpretation;
  assert.strictEqual(mi.relationships.length, 3);
  assert.ok(mi.relationships.some((r) => /Sales are slowing/.test(r.what)) && mi.relationships.some((r) => /take longer to sell/.test(r.what)));
  assert.strictEqual(mi.market_character, "Supply is building while sales slow");
  assert.ok(mi.realtor_readings.length >= 1 && brief.editorial_direction.kind === "article_story_with_market_interpretation");
});

test("trend: the prompt asks for every observation that materially bears on the story, with no quota", () => {
  const p = b2.systemPrompt("article_report", true);
  assert.match(p, /every observation that materially bears on that candidate's story, including one that shows another side of it/);
  assert.match(p, /there is no quota and an observation that does not bear on the story is left out/);
  assert.doesNotMatch(p, /at least (?:two|three|\d) observations/i);
});

// ── 6. the planner distinguishes what a measure shows from unsupported interpretation ──────────────────────────────────────────────────────────
test("planner statistics: the developer prompt chooses figures for the narrative, says what List Price Received does not show, and words explanations by the evidence", () => {
  const p = planLib.buildSystemPrompt(DEV, {});
  const rule = p.split("\n").find((l) => l.startsWith("2n. "));
  assert.ok(rule, "rule 2n is present");
  assert.match(rule, /Choose the ones that bear on the central narrative of editorial_direction/);
  assert.match(rule, /do not pick a figure because it is favorable or reassuring/);
  assert.match(rule, /sold price as a percent of list price compares the closing price with the last list price/);
  assert.match(rule, /how the home was first priced, whether the seller reduced the price, how quickly it sold, or whether buyer demand is rising or falling/);
  assert.match(rule, /read them together, then state the one thing they show together, naming the one or two figures that carry it with their comparison/); assert.match(rule, /A figure that cuts against the story is stated only where leaving it out would make the answer misleading \(rule 2o\)/);
  assert.match(rule, /what the report or article states \(a fact, attributed\), your reading of it \(the agent's interpretation/);
  assert.match(rule, /any explanation, worded with the confidence the evidence earns \(rule 2o\); do not invent a cause for a single figure/);
  assert.doesNotMatch(rule, /at least|must (?:state|include|use) (?:every|all|\d)/i, "no quota and no requirement to use every statistic");
  assert.match(p, /2j\. REALTOR INTERPRETATION[^\n]*professional opinion and interpretation/, "the allowance for professional interpretation is kept");
  assert.ok(!planLib.buildSystemPrompt({}, {}).split("\n").some((l) => l.startsWith("2n. ")), "the production prompt is unchanged");
});

// ── 7. the competing brokerage is credited in the footer, not named in the narration, captions or scene copy ──────────────────────────────────────
const topic7 = { geography: { name: "ROSEVILLE" }, sources: [{ url: ARTICLE.url, title: ARTICLE.title, domain: ARTICLE.domain, published: ARTICLE.published, role: "primary", kind: "article" }, { type: "report", role: "data", title: "Your MLS report", url: null }],
  b2: { article: { title: ARTICLE.title, domain: ARTICLE.domain, published: ARTICLE.published } } };

test("attribution: the planner is no longer told to name the publisher, and is not handed its website name", () => {
  const p = planLib.buildSystemPrompt(DEV, {});
  assert.doesNotMatch(p, /name the publisher in natural speech/);
  assert.doesNotMatch(p, /say who reported it/);
  assert.match(p, /Do not name the article's publisher, brokerage, team, agent or website anywhere in the narration, captions or scene copy/);
  assert.match(p, /Attribute an article finding by role/);
  assert.match(p, /A data source the finding cites \(for example Freddie Mac or MetroList TrendVision\) may be named/);
  const brief = planLib.topicBrief({ ...topic7, question: "q", whyItMatters: "w", b2: { ...topic7.b2, editorialAngle: "a", mechanism: "m", homeownerImplication: "h", sourceRefs: [] } }, DEV);
  assert.ok(!JSON.stringify(brief).includes("thegoolsbygroup"), "the publisher's website name never reaches the planner");
  assert.match(b2.systemPrompt("article_report", false), /Never name the article's author, agent, team or brokerage in any field/);
});

test("attribution: the publisher's name (and its shortened forms) in narration, captions, hook, scene copy or CTA is blocked; data sources and MetroList are not", () => {
  assert.deepStrictEqual(planLib.sourceNameVariants(topic7), ["thegoolsbygroup", "goolsbygroup", "goolsby"]);
  const clean = { narrationTagged: "[confident] A local market update points to rates. Freddie Mac shows 7.40%.", captionText: "A local market update points to rates. Freddie Mac shows 7.40%.", hook: "Did rates slow buyers?", cta: { text: "Ask me." },
    scenes: [{ narrationExcerpt: "A local market update points to rates.", cardText: "Ask me for a local view" }] };
  assert.deepStrictEqual(planLib.competingNameBlocks({ selected_topic: topic7 }, clean), []);
  const named = (field, text) => { const n = JSON.parse(JSON.stringify(clean)); if (field.startsWith("scene")) n.scenes[0].narrationExcerpt = text; else if (field === "card") n.scenes[0].cardText = text; else if (field === "cta") n.cta.text = text; else n[field] = text; return n; };
  for (const [field, text] of [["narrationTagged", "According to The Goolsby Group, rates rose."], ["captionText", "The Goolsby Group says rates rose."], ["hook", "Goolsby says rates rose?"], ["scene", "As thegoolsbygroup.com reports, rates rose."], ["card", "Goolsby Group"], ["cta", "Ask The Goolsby Group."]]) {
    const b = planLib.competingNameBlocks({ selected_topic: topic7 }, named(field, text));
    assert.ok(b.length === 1 && b[0].rule === "competing_source_name", `${field}: blocked`);
  }
  assert.deepStrictEqual(planLib.competingNameBlocks({ selected_topic: { ...topic7, b2: { article: { domain: "" } } } }, named("hook", "Goolsby says")), [], "no publisher recorded, nothing to match");
  assert.deepStrictEqual(planLib.sourceNameVariants({ geography: { name: "ROSEVILLE" }, b2: { article: { domain: "roseville.com" } } }), [], "the market's own name is never a source name");
});

// the planner's first draft names the brokerage; the one rewrite asked for removes it; a draft that still names it is refused
const excerpts = ["Is new construction helping or hurting your resale home?", "Here's what I see near new communities. More interested buyers come into the area, and that can help, because new homes draw people who might otherwise never have looked.", "But it also puts your home next to brand new competition.", "Builders often have incentives and rate buydowns, which changes how buyers compare your home against the ones down the street, which matters before pricing.", "So don't judge your value on resale listings alone, because that alone rarely tells the story.", "Compare the full picture, and ask me for a local perspective."];
const sc = (i, kind) => ({ role: ["local_hook", "tension", "insight", "comparison", "advice", "cta"][i], narration_excerpt: excerpts[i], purpose: "p" + i, visual_source: kind === true ? "GPT_IMAGE_2_CONCEPT" : (kind || "CONCEPT_REUSE"),
  visual_brief: "brief " + i, reuse_of_scene: kind === true ? null : 2, card_text: kind === "BRAND_CARD" ? "Ask me for a local view" : null, authentic_photo_request: null,
  ai_generation_prompt: kind === true ? "Photorealistic editorial tabletop with two architectural home models, soft light, no people, no text, wide composition" : null, camera_motion: "push_in", framing_9x16: "a", framing_16x9: "b", text_safe_placement: "low",
  source_role: i === 2 ? "article" : "data" });
const plan = (hook) => ({ editorial_angle: "a", hook, narration_with_audio_tags: `[conversational] ${hook} [thoughtful] ${excerpts.slice(1).join(" ")}`,
  scenes: [sc(0, true), sc(1, true), sc(2, "CONCEPT_REUSE"), sc(3, true), sc(4, "CONCEPT_REUSE"), sc(5, "BRAND_CARD")], cta_suggestion: "Ask me for a local perspective.", claims_to_verify: [], missing_agent_inputs: [] });
const project7 = { template: "local_market_insider", duration_sec: 45, formats: ["9x16"], selected_topic: { ...topic7, question: "Is new construction helping?", whyItMatters: "It changes how buyers compare homes.", scope: "selected", origin: "web", localIntent: true },
  intake: { angle: "neighborhood", market: "Roseville, CA", audience: "Home sellers", issue: "x", action: "y", observation: "New construction can bring buyers and competition." } };

test("attribution: generatePlan asks for one rewrite when the brokerage is named, and the accepted script never names it", async () => {
  const sent = [];
  const out = await planLib.generatePlan({ project: project7, anthropicKey: "k", callFn: async (system, user) => { sent.push(user); return JSON.stringify(sent.length === 1 ? plan("The Goolsby Group asks: is new construction helping your home?") : plan(excerpts[0])); } });
  assert.ok(sent.length >= 2, "one rewrite was asked for after the brokerage was named (a further length rewrite may follow)");
  assert.match(sent[1], /competing_source_name/);
  assert.match(sent[1], /credit is the on-screen source footer/);
  const n = out.narrative, copy = [n.narrationTagged, n.captionText, n.hook, ...n.scenes.map((s) => s.narrationExcerpt + " " + (s.cardText || ""))].join(" ");
  assert.doesNotMatch(copy, /goolsby/i);
  await assert.rejects(planLib.generatePlan({ project: project7, anthropicKey: "k", callFn: async () => JSON.stringify(plan("The Goolsby Group asks: is new construction helping your home?")) }), /blocked by Agent Marketing's check/);
});

test("source footer: the credit is built by code from the checked article, only when a scene draws on the article, and is not part of the narration", () => {
  const p = { template: "local_market_insider", selected_topic: topic7 };
  const withArticle = { scenes: [{ narrationExcerpt: "a", sourceRole: "data" }, { narrationExcerpt: "b", sourceRole: "article" }, { narrationExcerpt: "c", sourceRole: "data" }], narrationTagged: "n", captionText: "n" };
  am.attachNotice(p, withArticle);
  assert.deepStrictEqual(withArticle.sourceCredit, { text: "Source: Roseville Market Update September 2026: Prices Hold (thegoolsbygroup.com, Oct 12, 2026).", position: "bottom", scenes: [1] });
  assert.doesNotMatch(withArticle.narrationTagged + withArticle.captionText + withArticle.scenes.map((s) => s.narrationExcerpt).join(" "), /goolsby/i);
  const reportOnly = { scenes: [{ narrationExcerpt: "a", sourceRole: "data" }, { narrationExcerpt: "b", sourceRole: "data" }, { narrationExcerpt: "c", sourceRole: "data" }], sourceCredit: { stale: true } };
  am.attachNotice(p, reportOnly);
  assert.ok(!("sourceCredit" in reportOnly), "a Reel that uses only the subscriber's report needs no article credit, and a stale credit is removed");
  const noDate = { ...p, selected_topic: { ...topic7, sources: [{ ...topic7.sources[0], published: null }] } };
  const n2 = { scenes: withArticle.scenes }; am.attachNotice(noDate, n2);
  assert.ok(!("sourceCredit" in n2), "nothing is invented when the source cannot be cited");
});

// ── 8. a saved Research Library topic can weigh the article's thesis and explanation findings without being replaced (Nov 12, 2026) ───────────────
const crypto = require("crypto");
const sbLib = require("../netlify/functions/lib/agent-marketing-b1-stageb-lib");
const bundleOf = (validated) => {
  const payload = JSON.stringify({ format: "ssp-b1-evidence/1", completeness_status: "COMPLETE", validated, held: [], excluded: [], provenance: { input_sha256: "a".repeat(64), raw_b1_output_sha256: "b".repeat(64) } });
  return { format: "ssp-b1-evidence/1", payload, payload_sha256: crypto.createHash("sha256").update(payload, "utf8").digest("hex") };
};
const T5_THESIS = "The author argues Roseville's supply is loosening because higher mortgage rates are cutting buyer demand, so pending contracts fell, though prices have held for now.";
// An older saved topic, written before the thesis handoff: its direction is about supply only (2.8 to 3.2 months), with no mention of rates.
const savedTopic = () => ({ id: "t5", candidate: { id: "c5" }, researchId: "r5", reportFirst: true, scope: "selected", origin: "web", localIntent: true,
  geography: { name: "ROSEVILLE" }, question: "Roseville moved from about 2.8 to 3.2 months of supply. Is it still a seller's market?", whyItMatters: "Supply is the room buyers have.",
  reportFigures: [{ key: "months_supply", text: "ROSEVILLE, October 2026: Months of inventory: 3.2 months" }],
  sources: [{ url: ARTICLE.url, title: ARTICLE.title, domain: ARTICLE.domain, published: ARTICLE.published, role: "primary", kind: "article" }],
  b1Evidence: bundleOf(view.validated), b1CentralArgument: T5_THESIS,
  b2: { article: { title: ARTICLE.title, domain: ARTICLE.domain, published: ARTICLE.published }, editorialAngle: "Under three months is still a seller's market, but the room is growing.",
    mechanism: "Months of supply rose from about 2.8 to 3.2, so buyers have more choice.", homeownerImplication: "Price for today's choice, not last spring's.",
    sourceRefs: [{ finding: "A1-F3", quote: "about 2.8 months of supply, up from 1.9 a year ago", attribution: "MetroList TrendVision" }] } });

test("saved topic: the stored thesis rides in article_evidence, labeled as context to evaluate, beside every validated finding and the unchanged selected topic", () => {
  const brief = planLib.topicBrief(savedTopic(), DEV);
  assert.strictEqual(brief.article_evidence.central_argument, T5_THESIS);
  const kinds = brief.article_evidence.validated_findings.map((f) => f.kind);
  assert.ok(kinds.includes("explanation"), "the rate explanation is in front of the planner");
  assert.ok(brief.article_evidence.validated_findings.some((f) => /pending/i.test(f.finding)), "the pending-contract decline is in front of the planner");
  assert.match(brief.topic_question, /^Roseville moved from .*months of supply\. Is it still a seller's market\?$/, "the subscriber's selected question is kept (only its market figures are left to the report)");
  assert.match(brief.editorial_direction.angle, /seller's market/, "the saved angle is untouched");
  assert.doesNotMatch(brief.editorial_direction.mechanism, /rate/i, "the old direction still omits rates: the planner has to weigh them");
  assert.strictEqual(brief.report_is_source_of_truth_for_market_numbers, true);
  assert.deepStrictEqual(brief.editorial_direction.source_refs, [], "the article's own supply figure is still the report's to give");
  assert.ok(!JSON.stringify(brief).toLowerCase().includes("goolsby"), "the publisher's name never reaches the planner");
  const noThesis = savedTopic(); delete noThesis.b1CentralArgument;
  assert.ok(!("central_argument" in planLib.topicBrief(noThesis, DEV).article_evidence), "older evidence without a thesis behaves as before");
});

test("saved topic: only a record that passed the evidence contract carries the thesis to the planner (withPlanEvidence path)", () => {
  const p = { id: "p5", template: "local_market_insider", selected_topic: { id: "t5", candidate: { id: "c5" }, researchId: "r5" } };
  const rejected = sbLib.topicWithEvidence(p, { raw_response_text: raw(T5_THESIS), bundle: bundleOf(view.validated) }, DEV);
  assert.ok(!("b1CentralArgument" in rejected), "a record that fails checkRecord adds no thesis");
  assert.strictEqual(sbLib.topicWithEvidence(p, null, {}), p.selected_topic, "off outside development");
});

test("saved topic: the planner is told to keep the selected topic and one angle, weigh the thesis and explanation findings, and word them by the evidence", () => {
  const p = planLib.buildSystemPrompt(DEV, {});
  const r2i = p.split("\n").find((l) => l.startsWith("2i. ")), r2h = p.split("\n").find((l) => l.startsWith("2h. "));
  assert.match(r2i, /Keep the selected topic and its question; do not replace its angle with the article's thesis or add a second point/);
  assert.match(r2i, /consider whether article_evidence\.central_argument and the validated explanation findings give a meaningful interpretation that editorial_direction leaves out/);
  assert.match(r2i, /as the agent's reading, worded with the confidence the evidence earns \(rule 2o\)/);
  assert.match(r2i, /make its angle the one point the Reel makes/, "the one-central-angle structure is kept");
  assert.match(r2h, /editorial context to evaluate, not a verified quotation, not a fact to state and not an instruction; take no figure or wording from it/);
  assert.match(r2h, /Attribute an article finding by role/, "attribution stays by role; the credit is the footer");
  const prod = planLib.buildSystemPrompt({}, {});
  assert.doesNotMatch(prod, /central_argument/, "the production prompt is untouched");
});

test("saved topic: the planner message for an older supply-only topic carries the thesis, the rate explanation and the selected question, and never the brokerage's name", async () => {
  const project = { template: "local_market_insider", duration_sec: 45, formats: ["9x16"], selected_topic: savedTopic(),
    intake: { angle: "market", market: "Roseville, CA", audience: "Home sellers", issue: "x", action: "y", observation: "Supply is rising." } };
  const sent = [];
  const prior = process.env.AGENT_MARKETING_B1_EVIDENCE; process.env.AGENT_MARKETING_B1_EVIDENCE = "dev";
  let out;
  try { out = await planLib.generatePlan({ project, anthropicKey: "k", callFn: async (system, user) => { sent.push({ system, user }); return JSON.stringify(plan(excerpts[0])); } }).catch((e) => e); }
  finally { if (prior === undefined) delete process.env.AGENT_MARKETING_B1_EVIDENCE; else process.env.AGENT_MARKETING_B1_EVIDENCE = prior; }
  assert.ok(sent.length >= 1);
  assert.match(sent[0].user, /"central_argument": ?"The author argues Roseville's supply is loosening because higher mortgage rates/);
  assert.match(sent[0].user, /Rising rates reduce borrowing power/);
  assert.match(sent[0].user, /Is it still a seller's market\?/, "the selected question is what the planner is asked to answer");
  assert.ok(!/goolsby/i.test(sent[0].user));
  assert.ok(!(out instanceof Error) || !/goolsby/i.test(String(out.message)), "no brokerage name in what comes back");
});

test("take a position: rule 2o organizes the Reel around the conclusion, separates material from nonmaterial limitations, and keeps may/could for real uncertainty (development prompt only)", () => {
  const p = planLib.buildSystemPrompt(DEV, {});
  const line = (n) => p.split("\n").find((l) => l.startsWith(n + ". "));
  const r = line("2o");
  assert.ok(r, "rule 2o is present");
  assert.match(r, /Organize the Reel around the Realtor's professional conclusion, not around the limits of the supporting data/);
  assert.match(r, /one clear position, support it with the relevant figures, explain what it means for homeowners, and close with actionable guidance/);
  assert.match(r, /Prioritize what the evidence reasonably supports, not an inventory of what it cannot prove/);
  assert.match(r, /Match the strength of the conclusion to the strength of the evidence/);
  assert.match(r, /unsupported factual assertion[^.]*which is not allowed[^.]*professional interpretation reasonably grounded in several indicators/);
  assert.match(r, /A material limitation is one whose omission would make a specific factual statement or the Realtor's conclusion misleading: respect it, and put it in the narration/);
  assert.match(r, /A nonmaterial limitation is any other gap in the evidence: it does not belong in the narration just because it exists/);
  assert.match(r, /Do not replace professional interpretation with methodological commentary, and do not add statements about what the data cannot establish, prove or measure/);
  assert.match(r, /ask whether leaving it out would materially misrepresent the market evidence or the Realtor's conclusion; if not, leave it out/);
  assert.match(r, /Where the evidence is limited or mixed, moderate the conclusion itself/);
  assert.match(r, /\"may\" and \"could\" are right for a genuinely uncertain contributing factor, and are not to be added or stripped by habit/);
  assert.doesNotMatch(r, /without \"may\" or \"could\" hedging/, "may/could are not banned");
  assert.match(r, /Rule 2h attribution and the exact figures stay as they are/);
  // the other rules do not reintroduce methodological commentary
  assert.match(line("2n"), /not material for the narration, and you do not explain what a figure does not show unless rule 2o's material test is met/);
  assert.match(line("2l"), /its caveats are honored where they are material under rule 2o and are otherwise not narrated/);
  assert.doesNotMatch(line("2l"), /caveats must be honored/);
  assert.match(line("2j"), /include a qualification only where leaving it out would make a specific statement materially misleading/);
  assert.doesNotMatch(line("2j"), /acknowledge a material uncertainty/);
  assert.match(line("2i"), /worded with the confidence the evidence earns \(rule 2o\)/);
  assert.ok(!planLib.buildSystemPrompt({}, {}).split("\n").some((x) => x.startsWith("2o. ")), "the production prompt is unchanged");
});
