// Nov 14, 2026 (Sam, development only): the article's governing professional position is carried from B1 through B2 and the Planner, cannot be lost in
// selection, and the claim check blocks only contradictions of a figure. Production behavior is unchanged.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const b2 = require("../netlify/functions/lib/agent-marketing-b2-lib");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");
const claims = require("../netlify/functions/lib/agent-marketing-b1-claims-lib");

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const DEV = { AGENT_MARKETING_B1_EVIDENCE: "dev" };
const POSITION = "Lincoln resale sellers compete against builder financing advantages that affect buyer affordability, and lowering the asking price alone may overlook a competitive factor.";
const ARTICLE = { url: "https://example.com/builders", title: "Selling against new construction", domain: "example.com", published: "2026-09-15" };
const records = () => [{ id: "A1", title: ARTICLE.title, url: ARTICLE.url, completeness: "COMPLETE", held_findings_not_used: 0, central_argument: POSITION, findings: [
  { id: "A1-F1", kind: "claim", finding: "Builders advertise rate buydowns.", source_quotes: ["Builders are advertising permanent buydowns."], attribution: "The author" },
  { id: "A1-F2", kind: "figure", finding: "63% of builders use incentives.", source_quotes: ["63% of builders were using sales incentives in August 2026."], attribution: "NAHB" },
  { id: "A1-F3", kind: "claim", finding: "A concession cap applies to sellers.", source_quotes: ["Fannie Mae caps seller contributions."], attribution: "The author" },
] }];
const cand = (id, q, f, extra) => ({ id, question: q, article: "A1", findings: f, mechanism: "m " + id, homeowner_implication: "h", editorial_angle: "a", audience_journey: "j", why_it_matters: "w", ...(extra || {}) });
const POS = { develops_position: true, position_basis: POSITION };
const six = (extra) => Array.from({ length: 6 }, (_, i) => cand(`C${i + 1}`, `Question number ${i + 1} about a different Realtor implication?`, ["A1-F" + ((i % 3) + 1)], i === 5 ? extra : undefined));

// ── B2: the position candidate is required, tied to the stored text, and never lost in selection ─────────────────────────────────────────
test("B2 keeps a valid position candidate in the five even when B2's own selection left it out, replacing the weakest pick", () => {
  const raw = { candidates: six(POS), selected: ["C1", "C2", "C3", "C4", "C5"] };
  const v = b2.validate(raw, { records: records(), mode: "article_editorial" });
  assert.deepStrictEqual(v.positionMissing, []);
  assert.strictEqual(v.selected.length, 5);
  assert.ok(v.selected.includes("C6"), "the position candidate is selected");
  assert.ok(!v.selected.includes("C5"), "the weakest other pick made room");
  assert.strictEqual(v.candidates.find((c) => c.id === "C6").developsPosition, true);
});

test("a candidate that claims the position without developing the stored text is not accepted, and the run reports the position as missing", () => {
  const raw = { candidates: six({ develops_position: true, position_basis: "Months of supply rose to three in September" }), selected: ["C1", "C2", "C3", "C4", "C5"] };
  const v = b2.validate(raw, { records: records(), mode: "article_editorial" });
  assert.deepStrictEqual(v.positionMissing, ["A1"]);
  assert.ok(v.candidates.every((c) => !c.developsPosition));
  assert.ok(v.problems.some((p) => /no valid candidate develops the article's position/.test(p)));
  const none = b2.validate({ candidates: six(), selected: ["C1"] }, { records: records(), mode: "article_report", reportFigures: [] });
  assert.deepStrictEqual(none.positionMissing, ["A1"], "an unflagged set is missing the position too");
});

test("only one candidate per article develops the position, and a record with no stored position is unaffected", () => {
  const v = b2.validate({ candidates: [cand("C1", "First question about the position?", ["A1-F1"], POS), cand("C2", "Second question about the same position?", ["A1-F2"], POS)], selected: ["C2"] }, { records: records(), mode: "article_editorial" });
  assert.deepStrictEqual(v.candidates.map((c) => c.developsPosition), [true, false]);
  assert.ok(v.selected.includes("C1"));
  const legacy = records().map(({ central_argument, ...r }) => r);
  const l = b2.validate({ candidates: six(), selected: ["C1", "C2"] }, { records: legacy, mode: "article_editorial" });
  assert.deepStrictEqual(l.positionMissing, []);
});

test("the topic card carries the position: developsPosition, and editorial.thesis is the stored position, not the mechanism", () => {
  const raw = { candidates: [cand("C1", "Why do builder incentives change a seller's pricing?", ["A1-F1", "A1-F2"], { ...POS, mechanism: "Fannie Mae caps seller concessions." }), cand("C2", "What does the concession cap mean for sellers?", ["A1-F3"])], selected: ["C1", "C2"] };
  const v = b2.validate(raw, { records: records(), mode: "article_editorial" });
  const topics = b2.toTopics({ result: v, records: records(), articles: [ARTICLE], evidence: new Map([[ARTICLE.url, { id: "ev1" }]]), mode: "article_editorial", reportSource: null, trend: null });
  assert.strictEqual(topics[0].b2.developsPosition, true);
  assert.strictEqual(topics[0].editorial.thesis, POSITION);
  assert.ok(topics[0].b2.positionBasis);
  assert.ok(!("developsPosition" in topics[1].b2), "a narrower topic is not the position topic");
  assert.strictEqual(topics[1].editorial.thesis, "m C2");
});

test("one corrected request is made when the position is missing and the run has the time; otherwise the missing position is reported, never substituted", async () => {
  const mk = (withPosition) => JSON.stringify({ candidates: six(withPosition ? POS : undefined), selected: ["C1", "C2", "C3", "C4", "C5"] });
  const base = { records: records(), articles: [ARTICLE], evidence: new Map([[ARTICLE.url, { id: "ev1" }]]), mode: "article_editorial", market: "Lincoln", audience: "sellers", reportFigures: [], anthropicKey: "k" };
  let calls = [];
  const fixes = async (sys, user) => { calls.push(JSON.parse(user)); return mk(calls.length > 1); };
  const ok = await b2.generate({ ...base, callFn: fixes, canRepair: () => true });
  assert.strictEqual(calls.length, 2);
  assert.match(calls[1].correction, /no valid position candidate for A1/);
  assert.deepStrictEqual([ok.positionMissing, ok.repaired, ok.topics.length], [[], true, 5]);
  assert.ok(ok.topics.some((t) => t.b2.developsPosition === true));
  calls = [];
  const noTime = await b2.generate({ ...base, callFn: async (s, u) => { calls.push(1); return mk(false); }, canRepair: () => false });
  assert.deepStrictEqual([calls.length, noTime.positionMissing, noTime.repaired], [1, ["A1"], false]);
  calls = [];
  const still = await b2.generate({ ...base, callFn: async () => { calls.push(1); return mk(false); }, canRepair: () => true });
  assert.deepStrictEqual([calls.length, still.positionMissing, still.repaired], [2, ["A1"], true], "exactly one repair, then the caller ends the run visibly");
});

test("B2 prompt: the position is a required candidate, supporting mechanisms are not the position, and no duration is assumed", () => {
  for (const mode of ["article_report", "article_editorial"]) {
    const p = b2.systemPrompt(mode, false);
    assert.match(p, /REQUIRED POSITION CANDIDATE/);
    assert.match(p, /develops_position/);
    assert.match(p, /position_basis/);
    assert.match(p, /Rules, calculations, financing details and other supporting mechanisms in the article are material that supports the position; they are not the position/);
    assert.match(p, /mechanism is optional supporting explanation/);
    assert.doesNotMatch(p, /45-second|45 seconds|60-second/);
  }
});

// ── Planner: voice, position governs, judgment is not hedged ──────────────────────────────────────────────────────────────────────────────────
test("Planner (development): AI scripts default to second or third person; production rule 1 is unchanged", () => {
  const dev = planLib.buildSystemPrompt(DEV, {}), prod = planLib.buildSystemPrompt({}, {});
  const r1 = (p) => p.split("\n").find((l) => l.startsWith("1. "));
  assert.match(r1(dev), /second or third person by default/);
  assert.match(r1(dev), /do not write in the agent's first person/);
  assert.match(r1(dev), /The subscriber can rewrite the narration in first person later/);
  assert.match(r1(prod), /first-person voice where natural/);
  assert.strictEqual(sha(prod), "25f3118fed1b9726fc4dc78b16dcc92233cef785d3c074ef89a6ee7aaf7b0495", "the production prompt is byte-identical");
  const ex = dev.split("\n").find((l) => l.startsWith("5a. ")).split("Style example only")[1];
  assert.doesNotMatch(ex, /\bI\b|I'm|\bmy\b/, "the development style example is not first person");
});

test("Planner (development): the position governs the Reel; mechanisms, rules and calculations are optional; judgment needs no label; specifics must be accurate", () => {
  const dev = planLib.buildSystemPrompt(DEV, {});
  const rule = (id) => dev.split("\n").find((l) => l.startsWith(id + ". "));
  assert.match(rule("2i"), /develops_article_position is true, article_evidence\.central_argument is the article's governing professional position/);
  assert.match(rule("2i"), /is not required to recite any of those/);
  assert.match(rule("2i"), /Market Trend figures support the position; they never substitute for it/);
  assert.match(rule("2i"), /mechanism, when present, is optional supporting material/);
  assert.match(rule("2i"), /A specific rule or eligibility statement must be accurate, and the narration is never required to include one/);
  assert.match(rule("2j"), /needs no label such as "in my view" and no habitual qualifier/);
  assert.match(rule("2j"), /guarantees, no implied results/, "the advertising safeguard stays");
  assert.match(rule("2g"), /may stand in the same scene or comparison when each keeps its own source, period, measure and geography/);
});

test("Planner brief: the position topic is flagged and the stored position travels as article_evidence.central_argument", () => {
  const topic = { id: "t1", question: "q", whyItMatters: "w", scope: "selected", origin: "web", sources: [{ title: "a", url: ARTICLE.url, role: "primary", kind: "article" }],
    b2: { mode: "article_editorial", editorialAngle: "Pricing alone misses the financing gap.", mechanism: "", homeownerImplication: "Price for the monthly payment.", developsPosition: true, sourceRefs: [] } };
  const brief = planLib.topicBrief(topic, DEV);
  assert.strictEqual(brief.editorial_direction.develops_article_position, true);
  assert.strictEqual(brief.editorial_direction.angle, "Pricing alone misses the financing gap.");
  const plain = planLib.topicBrief({ ...topic, b2: { ...topic.b2, developsPosition: undefined } }, DEV);
  assert.ok(!("develops_article_position" in plain.editorial_direction));
});

// ── Claim check: a figure may not be contradicted; the Realtor's own interpretation around it is never blocked ───────────────────────────
const phrase = (s) => ` ${String(s).toLowerCase().replace(/(\d),(\d)/g, "$1$2").replace(/[^a-z0-9%.'\s-]/g, " ").replace(/(?<!\d)\.|\.(?!\d)/g, " ").replace(/-/g, " ").split(/\s+/).filter(Boolean).join(" ")} `;
const figs = (t) => new Set((String(t).match(/\d[\d,]*(?:\.\d+)?/g) || []).map((x) => x.replace(/,/g, "")));
function ctxFor(quote) {
  return { blocked: false, held: [], numbers: figs(quote), validated: [{ section: "claims", quotes: [quote], support: phrase(quote), attrNames: [], numbers: figs(quote) }] };
}
const scanOne = (quote, sentence) => { const blocks = [], facts = []; claims.scan(sentence, "narration", ctxFor(quote), { figureTokens: figs, agentNumbers: new Set() }, blocks, facts); return blocks.map((b) => b.rule); };

test("claim check: interpretation, names and context around a correct figure are allowed", () => {
  const q = "In September, the median sold price was $634,000, up slightly from August.";
  assert.deepStrictEqual(scanOne(q, "Builders like Toll Brothers compete on payment, and a median sold price of $634,000 in September tells Lincoln sellers to price for today's buyer."), []);
  assert.deepStrictEqual(scanOne(q, "Lowering your price alone may overlook financing: the median sold price was $634,000 in September."), []);
});

test("claim check: a figure stated with a different period, statistical basis, direction or without the source's qualifier is still blocked", () => {
  const q = "In September, the median sold price was $634,000, up slightly from August.";
  assert.deepStrictEqual(scanOne(q, "The median sold price was $634,000 in October."), ["b1_claim_context"]);
  assert.deepStrictEqual(scanOne(q, "The average sold price was $634,000 in September."), ["b1_claim_context"]);
  assert.deepStrictEqual(scanOne(q, "The median sold price fell to $634,000 in September."), ["b1_claim_context"]);
  const hedged = "About 130 homes went pending in September.";
  assert.deepStrictEqual(scanOne(hedged, "130 homes went pending in September."), ["b1_claim_context"], "a qualifier the source puts on the figure is kept");
  assert.deepStrictEqual(scanOne(hedged, "About 130 homes went pending in September, which should shape your price."), []);
});

// ── Nov 14, 2026 (Lincoln script acceptance, evening): the Planner followed a regulation-led angle instead of the stored position ───────────────
// The fixture is the stored Lincoln Topic 1 as B2 produced it (its angle, mechanism and implication all lead with the Fannie Mae cap), with B1's stored central_argument.
const LINCOLN_CENTRAL = "The authors (Rich & Kat Farless, a real estate team) argue that Lincoln, CA sellers cannot match builder incentives because seller contributions are capped under Fannie Mae rules while builder forward-commitment buydowns are generally outside the cap. They argue sellers should price against the builder's net price rather than its sticker, and sell what builders cannot deliver.";
const LINCOLN_T1 = { id: "t1", question: "Can a resale seller ever match what a builder is offering buyers right now?", whyItMatters: "w", scope: "selected", origin: "web", candidate: {},
  sources: [{ title: "Selling a Lincoln, CA Home Against New Construction", url: "https://richandkatsoldthat.com/blog/selling-home-against-new-construction-lincoln-ca", role: "primary", kind: "article", submitted: true }],
  b1CentralArgument: LINCOLN_CENTRAL,
  b2: { mode: "article_editorial", developsPosition: true, positionBasis: LINCOLN_CENTRAL.slice(0, 200),
    editorialAngle: "Fannie Mae caps what a resale seller can contribute at closing, while a builder's rate buydown generally sits outside that cap—so the article argues the winning move is to stop trying to match the builder and start competing differently.",
    mechanism: "Under Fannie Mae guidelines, seller contributions count as interested-party concessions capped at 3% to 9% of the sale price depending on the buyer's down payment.",
    homeownerImplication: "Sellers who try to out-incentivize builders by piling on concessions may hit a financing ceiling before they move the needle.", sourceRefs: [] } };

test("Lincoln Topic 1 (stored data): the stored position is the angle the Planner receives; B2's regulation-led angle, implication and journey are not competing authorities", () => {
  const brief = planLib.topicBrief({ ...LINCOLN_T1, b2: { ...LINCOLN_T1.b2, audienceJourney: "A seller two years out needs their concession ceiling." } }, DEV);
  const ed = brief.editorial_direction;
  assert.strictEqual(ed.develops_article_position, true);
  assert.strictEqual(ed.angle, LINCOLN_CENTRAL, "the angle is the stored position");
  assert.doesNotMatch(JSON.stringify(ed), /Fannie Mae caps what a resale seller/, "B2's cap-led angle is not passed");
  assert.strictEqual(ed.homeowner_implication, "", "B2's cap-led implication is not passed");
  assert.ok(!("audience_journey" in ed), "B2's cap-led journey is not passed");
  assert.match(ed.mechanism, /3% to 9%/, "the mechanism stays available as optional supporting material");
  const dev = planLib.buildSystemPrompt(DEV, {});
  assert.match(dev.split("\n").find((l) => l.startsWith("2i. ")), /is not required to recite any of those/);
});

test("a topic that does not develop the position, or has no stored position, is handed over exactly as before", () => {
  const other = planLib.topicBrief({ ...LINCOLN_T1, b2: { ...LINCOLN_T1.b2, developsPosition: undefined, audienceJourney: "j" } }, DEV).editorial_direction;
  assert.strictEqual(other.angle, LINCOLN_T1.b2.editorialAngle);
  assert.strictEqual(other.homeowner_implication, LINCOLN_T1.b2.homeownerImplication);
  assert.strictEqual(other.audience_journey, "j");
  assert.ok(!("develops_article_position" in other));
  const noPos = planLib.topicBrief({ ...LINCOLN_T1, b1CentralArgument: undefined }, DEV).editorial_direction;
  assert.strictEqual(noPos.angle, LINCOLN_T1.b2.editorialAngle, "without a stored position nothing is substituted");
});

test("B2 prompt: the position candidate's angle is the position in seller terms, not led by a rule or calculation, and its mechanism is the lever in plain terms", () => {
  const src = require("fs").readFileSync(__dirname + "/../netlify/functions/lib/agent-marketing-b2-lib.js", "utf8");
  assert.match(src, /editorial_angle must not lead with a rule, limit, percentage or calculation/);
  assert.match(src, /homeowner_implication is the seller consequence of the position, not of a supporting rule/);
  assert.match(src, /Its mechanism states, in two or three plain homeowner sentences, the competitive lever/);
});

test("the production Planner prompt is byte-identical after the correction", () => {
  assert.strictEqual(sha(planLib.buildSystemPrompt({})), "25f3118fed1b9726fc4dc78b16dcc92233cef785d3c074ef89a6ee7aaf7b0495");
});
