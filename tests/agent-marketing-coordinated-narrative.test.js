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

test("rules the corrections must not touch are pinned word for word: 2h, 2k (2g was deliberately corrected in Phase C, Nov 13: pathway wording, tested in agent-marketing-pathway-instructions)", () => {
  const pins = {
    "2h": "9f935f284d9f27545a22c409ad5a0237f25b308be9dc709a6894abbbddd056e8", // Nov 14: central_argument is the author's governing position; the article is named once
    "2k": "5ac72dcd79ae60bf5a8a1403bee0490fb9de6b7dd0e8dbfafaf5e82e912884c2",
  };
  Object.entries(pins).forEach(([id, h]) => assert.strictEqual(sha(rule(DEV, id)), h, `rule ${id} changed`));
});

test("source roles (Nov 13 correction): position does not decide the source; sources are never combined into one comparison; 2h attribution intact", () => {
  assert.ok(!/The FIRST and the LAST scene are always/.test(rule(DEV, "2g")), "no position rule in Test");
  assert.match(rule(DEV, "2g"), /says what evidence it may contain, not where it sits in the Reel: any scene, the first and the last included/);
  assert.match(rule(DEV, "2g"), /an article figure and a report figure may stand in the same scene or comparison when each keeps its own source, period, measure and geography/);
  assert.match(rule(DEV, "2g"), /where both cover the same measure the report's figure is the one stated/);
  assert.match(rule(DEV, "2h"), /When a numerical example depends on a material stated assumption \(for example the down payment behind a monthly payment\), state that assumption with the example, and say what the figure measures \(a monthly payment difference is a payment difference, never a rate\)\./);
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

test("change 2 (rule 2i B, Nov 15): sources may reinforce, complicate, give context or have no relationship; nothing is forced; restrictions kept", () => {
  const r = rule(DEV, "2i");
  assert.match(r, /the report may reinforce the article, complicate or contradict it, give it local context only, or have no real bearing on it/);
  assert.match(r, /Do not imply that one source caused or explains the other unless a source says so, and never link them just to make a stronger hook/);
  assert.match(r, /Do not name the article's publisher, brokerage, team, agent or website anywhere in the narration, captions or scene copy/, "competitor naming restriction kept");
  assert.match(r, /every scene is source_role "data"/, "trend_commentary behavior kept");
  assert.match(r, /leave out any that compare different groups of homes or different measures as if they were the same/);
});

test("change 4 (rule 7, Test): the story is the question, the evidence and answer, the homeowner meaning, then the call to action; slice rules unchanged", () => {
  const r = rule(DEV, "7");
  assert.match(r, /in story order: the opening question, then middle scenes that advance one connected argument/);
  assert.ok(!/tension or misconception/.test(r));
  assert.match(r, /Every scene has a narration_excerpt that is an exact consecutive slice of your narration/);
});

test("change 5 (rule 5b, Test, Nov 15): the hook is a question or a declarative tension; 14 words; no answer; alignment rule kept", () => {
  const r = rule(DEV, "5b");
  assert.match(r, /14 words or fewer, a question or a declarative statement, grounded in the selected direction and built on the hinge the answer turns on/);
  assert.match(r, /raises a genuine uncertainty, tests a common assumption or states a surprising contrast, and it does not give the answer away/);
  assert.match(r, /Never open with a greeting/);
  assert.match(r, /The hook field repeats the first sentence exactly\./);
  assert.match(r, /not held back for the last scene/);
  assert.ok(!/single most surprising or specific thing/.test(r));
});

test("change 6 (rule 2i C and E, Nov 15): facts are chosen by what changes the viewer's understanding; figures keep their own label", () => {
  const r = rule(DEV, "2i");
  assert.match(r, /Choose a fact by whether it changes what the viewer understands, not by how many are available/);
  assert.match(r, /figures that establish one condition may be stated together/);
  assert.match(r, /A figure means what its own label and basis say/);
  assert.match(r, /State each figure as figures_you_may_state gives it/);
});

test("change 7 (rule 2i A and D): the selected direction is the one point; the conclusion is specific to the audience's decision", () => {
  const r = rule(DEV, "2i");
  assert.match(r, /that angle is the one point the Reel makes, and editorial_angle restates it/);
  assert.match(r, /State a clear professional conclusion and what it means for the audience's decision \(rule 2k\), confident and specific/);
});

test("the editorial rules are consolidated: 2j, 2l, 2n, 2o, 2p, 2q and 2r no longer exist; every other rule label appears once", () => {
  const labels = lines(DEV).map((l) => (l.match(/^(\d+[a-z]?)\. /) || [])[1]).filter(Boolean);
  ["2j", "2l", "2n", "2o", "2p", "2q", "2r", "2s"].forEach((id) => assert.ok(!labels.includes(id), id + " is gone"));
  ["2f", "2g", "2h", "2i", "2k", "5a", "5b", "7"].forEach((id) => assert.strictEqual(labels.filter((x) => x === id).length, 1, id));
});

const topicWith = (b2) => ({ id: "t1", question: "Is supply changing?", whyItMatters: "w", scope: "selected", origin: "web", reportFirst: false, trendSignals: [], reportFigures: [],
  sources: [{ url: "https://example.org/a", kind: "article", role: "primary", title: "t" }], ...(b2 ? { b2 } : {}) });
const userFor = (topic, env) => { const prev = process.env.AGENT_MARKETING_B1_EVIDENCE; if (env) process.env.AGENT_MARKETING_B1_EVIDENCE = "dev"; else delete process.env.AGENT_MARKETING_B1_EVIDENCE;
  try { return JSON.parse(planLib.buildUserMessage({ template: "local_market_insider", duration_sec: 60, formats: ["9x16"], intake: { market: "Roseville, CA", audience: "Home sellers", action: "Ask for a local perspective" }, selected_topic: topic })); }
  finally { if (prev === undefined) delete process.env.AGENT_MARKETING_B1_EVIDENCE; else process.env.AGENT_MARKETING_B1_EVIDENCE = prev; } };

test("change 1: the narrative architecture is question, answer from the evidence, specific meaning, next step; the other architectures are unchanged", () => {
  const b2 = { mode: "article_report", mechanism: "m", homeownerImplication: "i", editorialAngle: "a", audienceJourney: "j", sourceRefs: [] }; // Option 2 keeps the article-plus-report architecture (Phase C: Option 3 has its own, tested in agent-marketing-pathway-instructions)
  const withDir = userFor(topicWith(b2), true).narrative_architecture;
  assert.strictEqual(withDir, "A hook, a question or a declarative tension, naming what is at stake → the Realtor's answer, built from the evidence that establishes it (the article's facts and the report's figures, each in the scene where it does its work) → what that answer means for the seller, specifically → low-pressure next step");
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
test("5b and 2i: the answer begins right after the hook, is not given in the hook, and is not saved for a final scene", () => {
  const r = rule(DEV, "5b");
  assert.match(r, /does not give the answer away/);
  assert.match(r, /answer starts developing straight after the hook/);
  assert.match(r, /not held back for the last scene/);
  assert.match(rule(DEV, "2i"), /Realtor's conclusion/);
});

test("7: Test storyboard advances one connected argument; scene count, roles and continuity language are unchanged", () => {
  const r = rule(DEV, "7");
  assert.match(r, /advance one connected argument/);
  assert.match(r, /never a statistical recital alone/);
  assert.match(r, /scenes need not share one function/);
  assert.match(r, /exact consecutive slice of your narration/);
  assert.match(r, /the number of scenes you are given/);
});

test("2i: the selected direction defines the point; the topic does not decide the hook", () => {
  const r = rule(DEV, "2i");
  assert.match(r, /Do not replace it with a premise of your own and add no second point/);
  assert.match(rule(DEV, "5b"), /grounded in the selected direction/);
});

test("5a Test variant: example is generic, shows early interpretation, connected evidence, conclusion, homeowner consequence and a warm close; production 5a unchanged", () => {
  const d = rule(DEV, "5a"), p = rule({}, "5a");
  assert.ok(p.includes("Buyers have more choices right now") && p.includes("This means condition and pricing precision matter"), "production example untouched");
  assert.ok(!d.includes("Buyers have more choices") && !d.includes("condition and pricing precision") && !d.includes("Active listings are sitting a median"), "old template gone from Test");
  assert.ok(!/Roseville|2\.8|3\.2|31 days|99\.2/.test(d.split("Style example only")[1]), "no Roseville statistics or wording in the example");
  const ex = d.split("Style example only")[1];
  assert.match(ex, /\[conversational\] Everyone says <the common belief>/);
  assert.match(ex, /\? \[thoughtful\] The honest answer starts with <the clear professional conclusion>/, "unanswered question, then interpretation begins at once, in the second or third person");
  assert.match(ex, /points to <what it means>/, "evidence tied to its meaning");
  assert.doesNotMatch(ex, /\bI\b|I'm|\bmy\b/, "the example is not in the first person");
  assert.match(ex, /For a seller, that means <specific consequence/);
  assert.match(ex, /\[warm\] Want to talk through where your home fits\?/);
  assert.match(d, /\(d\) Contractions always/, "voice rules kept");
  assert.match(d, /\(b\) Use an ellipsis/, "delivery rules kept");
  ["[pause]", "[thoughtful]", "[emphasis]", "[warm]", "[conversational]"].forEach((t) => assert.ok(ex.includes(t), t));
  assert.match(d, /Say what each figure means in the same breath/);
});
