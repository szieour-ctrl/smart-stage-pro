"use strict";
// Nov 12, 2026 (Sam): the seven coordinated corrections to the Test planner's story construction. Sources decide WHAT a scene may contain, not the ORDER
// of the story; the hook is a question on the hinge of the premise; the answer develops throughout. Test-only variants; production wording is untouched.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");

const DEV = { AGENT_MARKETING_B1_EVIDENCE: "dev" };
const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
const lines = (env) => planLib.buildSystemPrompt(env).split("\n");
const rule = (env, id) => { const l = lines(env).filter((x) => x.startsWith(id + ". ") || x.startsWith(id + " ")); assert.strictEqual(l.length, 1, id); return l[0]; };
const PROD_SHA256 = "25f3118fed1b9726fc4dc78b16dcc92233cef785d3c074ef89a6ee7aaf7b0495";

test("production prompt is byte-for-byte unchanged", () => {
  assert.strictEqual(sha(planLib.buildSystemPrompt({})), PROD_SHA256);
  const p = lines({});
  assert.match(rule({}, "2f"), /tell what the article reports in its own terms \(for example the size and place of a project\), then give the agent's perspective/);
  assert.match(rule({}, "5b"), /it leads with the single most surprising or specific thing in selected_topic/);
  assert.match(rule({}, "7"), /local hook, tension or misconception, grounded insight and consequence, then solution plus the branded call to action/);
  assert.ok(!p.some((l) => /^2[hijklnopq]\. /.test(l)), "no Test rule leaks into production");
});

test("rules the corrections must not touch are pinned word for word: 2g, 2h, 2j, 2k, 2o, 2p", () => {
  const pins = {
    "2g": "5b83c6e60e912f594395e2453badc7010357152ed29cc63ee1bd67c95e5c666d", "2h": "9f74dd63826e49b26b5c4329e1cc0442579dfc55ae78786e003b736dc9405ae2",
    "2j": "aaf6f1ea54c5720056c38d680839eea6bc8e974c932b97036ef7c76bbb4182b8", "2k": "5ac72dcd79ae60bf5a8a1403bee0490fb9de6b7dd0e8dbfafaf5e82e912884c2",
    "2o": "94e674ff1baeb206af1ba0a78d149518a1d7170e31485be8f0948ad5622fe2a6", "2p": "5ac912ad449e17fa119006604e03166b55f1a10b4b15eccde33baae4a6972408", // Nov 12: only the two "60-second" references were made duration-neutral
  };
  Object.entries(pins).forEach(([id, h]) => assert.strictEqual(sha(rule(DEV, id)), h, `rule ${id} changed`));
});

test("source roles stay separate: 2g still fixes first/last scenes to data and keeps article and data numbers apart; 2h attribution intact", () => {
  assert.match(rule(DEV, "2g"), /The FIRST and the LAST scene are always \"data\"/);
  assert.match(rule(DEV, "2g"), /never put an article number and a data number in the same scene/);
  assert.match(rule(DEV, "2h"), /Attribute an article finding by role/);
  assert.match(rule(DEV, "2f"), /at least one middle scene must have source_role \"article\"/, "an article scene is still required (Test variant of 2f)");
  assert.match(rule(DEV, "2f"), /Where the article and the report disagree about the same area, the report wins/);
  assert.match(rule(DEV, "2f"), /never a prediction/);
});

test("change 3 (rule 2f, Test): source_role says what a scene may contain, not where it sits; article and report scenes may alternate", () => {
  const r = rule(DEV, "2f");
  assert.match(r, /The Reel is ABOUT the article's story \(selected_topic's question, why_it_matters and trend_signals\) and the agent's answer to it/);
  assert.match(r, /A scene's source_role says what evidence it may contain, not where it sits in the story: article and report scenes may alternate/);
  assert.match(r, /develops throughout the Reel instead of waiting for the end/);
  assert.ok(!/tell what the article reports in its own terms/.test(r) && !/then give the agent's perspective/.test(r));
});

test("change 2 (rule 2l, Sam's wording): complementary evidence, one interpretation, developed throughout; restrictions kept", () => {
  const r = rule(DEV, "2l");
  assert.match(r, /the article's findings and the subscriber's report figures are complementary evidence supporting one Realtor interpretation\. Use each source's evidence in scenes authorized for that source, with the required attribution\. Connect their meaning across scenes so the narration develops one cohesive argument rather than separate article and report summaries\. The Realtor's interpretation should develop throughout the Reel, not be reserved for a final conclusion scene\./);
  assert.ok(!/the article stays the central story/.test(r) && !/then, in a data scene, say how the report/.test(r));
  assert.match(r, /Do not name the article's publisher, brokerage, team, agent or website anywhere in the narration, captions or scene copy/, "competitor naming restriction kept");
  assert.match(r, /Do not turn a reading into a number, and never present an article figure as the agent's own market data/, "unsupported-number restriction kept");
  assert.match(r, /state each figure exactly as figures_you_may_state gives it/, "trend_commentary behavior kept");
});

test("change 4 (rule 7, Test): the story is the question, the evidence and answer, the homeowner meaning, then the call to action; slice rules unchanged", () => {
  const r = rule(DEV, "7");
  assert.match(r, /in story order: the opening question, then middle scenes that advance one connected argument/);
  assert.ok(!/tension or misconception/.test(r));
  assert.match(r, /Every scene has a narration_excerpt that is an exact consecutive slice of your narration/);
});

test("change 5 (rule 5b, Test): the hook is a question built on the hinge of the premise; 14 words; no answer; alignment rule kept", () => {
  const r = rule(DEV, "5b");
  assert.match(r, /is the hook \(rule 2q\) and must stop a scroll: a question of 14 words or fewer built on the hinge of the premise \(the specific figure, threshold, contrast or assumption the answer turns on\), not a general question about the market, and it does not give the answer/);
  assert.match(r, /Never open with a greeting/);
  assert.match(r, /The hook field repeats that sentence\./);
  assert.ok(!/single most surprising or specific thing/.test(r));
});

test("change 6 (rule 2n): the figures that carry the finding are named with their comparison; the rest stay out; a counter-figure only to avoid misleading", () => {
  const r = rule(DEV, "2n");
  assert.match(r, /read them together, then state the one thing they show together, naming the one or two figures that carry it with their comparison and leaving the rest out/);
  assert.match(r, /A figure that cuts against the story is stated only where leaving it out would make the answer misleading \(rule 2o\)/);
  assert.ok(!/closed sales, months of inventory, days on market and price/.test(r), "the four-figure bundle is no longer suggested");
  assert.match(r, /the report's whole menu, not a list to cover/, "the existing menu rule stays");
});

test("change 7 (rule 2i): the implication becomes the specific consequence the evidence supports for the seller", () => {
  const r = rule(DEV, "2i");
  assert.match(r, /Use the market_interpretation readings when present, and turn the implication into the specific consequence the evidence supports for the seller \(leverage, pricing, expectations or timing\), not general advice/);
  assert.match(r, /make its angle the one point the Reel makes/);
});

test("the corrections reconcile existing rules: no new rule (no 2r), same rule labels as before plus nothing", () => {
  const labels = lines(DEV).map((l) => (l.match(/^(\d+[a-z]?)\. /) || [])[1]).filter(Boolean);
  assert.ok(!labels.includes("2r"));
  ["2f", "2g", "2h", "2i", "2j", "2k", "2l", "2n", "2o", "2p", "2q", "5a", "5b", "7"].forEach((id) => assert.strictEqual(labels.filter((x) => x === id).length, 1, id));
});

const topicWith = (b2) => ({ id: "t1", question: "Is supply changing?", whyItMatters: "w", scope: "selected", origin: "web", reportFirst: false, trendSignals: [], reportFigures: [],
  sources: [{ url: "https://example.org/a", kind: "article", role: "primary", title: "t" }], ...(b2 ? { b2 } : {}) });
const userFor = (topic, env) => { const prev = process.env.AGENT_MARKETING_B1_EVIDENCE; if (env) process.env.AGENT_MARKETING_B1_EVIDENCE = "dev"; else delete process.env.AGENT_MARKETING_B1_EVIDENCE;
  try { return JSON.parse(planLib.buildUserMessage({ template: "local_market_insider", duration_sec: 60, formats: ["9x16"], intake: { market: "Roseville, CA", audience: "Home sellers", action: "Ask for a local perspective" }, selected_topic: topic })); }
  finally { if (prev === undefined) delete process.env.AGENT_MARKETING_B1_EVIDENCE; else process.env.AGENT_MARKETING_B1_EVIDENCE = prev; } };

test("change 1: the narrative architecture is question, answer from the evidence, specific meaning, next step; the other architectures are unchanged", () => {
  const b2 = { mode: "article_editorial", mechanism: "m", homeownerImplication: "i", editorialAngle: "a", audienceJourney: "j", sourceRefs: [] };
  const withDir = userFor(topicWith(b2), true).narrative_architecture;
  assert.strictEqual(withDir, "A question naming what is at stake → the Realtor's answer, built from the evidence that establishes it (the article's facts and the report's figures, each in the scene where it does its work) → what that answer means for the seller, specifically → low-pressure next step");
  assert.ok(!/different points in their decision/.test(withDir), "no longer invites a stage-by-stage close (rule 2k)");
  assert.strictEqual(userFor(topicWith(null), false).narrative_architecture, "Hook on the topic's question → what the sourced facts show (only those) → what it means for the audience → low-pressure next step");
});

test("the hook stays the first spoken sentence: a question hook the narration opens with is matched, one it does not is spoken first", () => {
  const q = "Roseville is at 3.2 months of supply: is it still a seller's market?";
  const raw = { hook: q, narration_with_audio_tags: `[conversational] ${q} [pause] Here is what the numbers say.`, scenes: [{ narration_excerpt: `${q} Here is what the numbers say.` }] };
  const a = planLib.alignHook(raw);
  assert.strictEqual(a.how, "matched");
  assert.strictEqual(a.raw.narration_with_audio_tags, raw.narration_with_audio_tags, "narration untouched");
  const other = planLib.alignHook({ ...raw, hook: "Is Roseville still a seller's market, or did that just change?" });
  assert.strictEqual(other.how, "inserted");
  assert.match(other.raw.narration_with_audio_tags, /^\[conversational\] Is Roseville still a seller's market, or did that just change\? Roseville is at 3\.2/);
});

// Nov 12, 2026 (Sam): progressive revelation. Curiosity sustained by interpretation that begins early and deepens; not a question followed by a statistics lecture,
// and not a question followed at once by the full answer.
test("2q: the answer begins developing within a few sentences after the hook, is not given in the hook, and is not saved for a final scene", () => {
  const r = rule(DEV, "2q");
  assert.match(r, /begins developing the Realtor's answer/);
  assert.match(r, /deepens, substantiates, or clarifies that interpretation/);
  assert.match(r, /Do not follow the hook with a complete answer/);
  assert.match(r, /do not hold the interpretation back for a final scene/);
  assert.match(r, /EVIDENCE AND PROGRESSIVE ANSWER\./);
  assert.ok(!/EVIDENCE AND PAYOFF/.test(r) && !/must investigate it/.test(r));
  assert.match(r, /Do not answer the question in the hook/, "the question-led hook is kept");
  assert.match(r, /first spoken sentence of `narration_with_audio_tags`, word for word/);
});

test("7: Test storyboard advances one connected argument; scene count, roles and continuity language are unchanged", () => {
  const r = rule(DEV, "7");
  assert.match(r, /advance one connected argument/);
  assert.match(r, /never a statistical recital alone/);
  assert.match(r, /scenes need not share one function/);
  assert.match(r, /exact consecutive slice of your narration/);
  assert.match(r, /the number of scenes you are given/);
});

test("2i: the topic defines the subject, not the hook", () => {
  const r = rule(DEV, "2i");
  assert.match(r, /defines the subject, not the final hook/);
  assert.match(r, /instead of paraphrasing the topic's question/);
  assert.ok(!/Keep the selected topic and its question/.test(r));
});

test("5a Test variant: example is generic, shows early interpretation, connected evidence, conclusion, homeowner consequence and a warm close; production 5a unchanged", () => {
  const d = rule(DEV, "5a"), p = rule({}, "5a");
  assert.ok(p.includes("Buyers have more choices right now") && p.includes("This means condition and pricing precision matter"), "production example untouched");
  assert.ok(!d.includes("Buyers have more choices") && !d.includes("condition and pricing precision") && !d.includes("Active listings are sitting a median"), "old template gone from Test");
  assert.ok(!/Roseville|2\.8|3\.2|31 days|99\.2/.test(d.split("Style example only")[1]), "no Roseville statistics or wording in the example");
  const ex = d.split("Style example only")[1];
  assert.match(ex, /\[conversational\] Everyone says <the common belief>/);
  assert.match(ex, /\? \[thoughtful\] Here's how I read it\./, "unanswered question, then interpretation begins at once");
  assert.match(ex, /which tells me <what it means>/, "evidence tied to its meaning");
  assert.match(ex, /So the honest answer is <clear professional conclusion>/);
  assert.match(ex, /For you as a seller, that means <specific consequence/);
  assert.match(ex, /\[warm\] Want to talk through where your home fits\?/);
  assert.match(d, /\(d\) Contractions always/, "voice rules kept");
  assert.match(d, /\(b\) Use an ellipsis/, "delivery rules kept");
  ["[pause]", "[thoughtful]", "[emphasis]", "[warm]", "[conversational]"].forEach((t) => assert.ok(ex.includes(t), t));
  assert.match(d, /Say what each figure means in the same breath/);
});
