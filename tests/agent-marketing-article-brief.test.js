// Oct 30, 2026 (Sam): one Claude read of the article keeps only its perspective, opinion and context; the planner gets that and never the article.
const test = require("node:test");
const assert = require("node:assert");
const lib = require("../netlify/functions/lib/agent-marketing-article-brief-lib");

const ARTICLE = "How do you sell a home in Lincoln when you compete with new construction? Roughly one in three homes for sale in the ZIP code is a builder home, 81 new-construction listings out of 237 total. You cannot match a builder's incentive dollar for dollar. The winning strategy is pricing against their net, not their sticker, and selling what a builder cannot deliver. The city approved a plan for 132 apartments near the downtown core in July. Median prices rose 3.1% last quarter.";
const GOOD = { idea: "Resale sellers compete with builders who offer incentives, so price against what a buyer nets.", perspective_points: ["Price against the builder's net, not the sticker.", "Sell what a builder cannot deliver."], opinion_angles: ["Incentives change how buyers compare a resale home."], context: ["The city approved a plan for 132 apartments near the downtown core in July."], questions_to_ponder: ["Are buyers weighing your home against brand-new ones?"] };

test("a good brief passes: words only in the opinion fields, a project fact the article states in context", () => {
  const v = lib.validateBrief(GOOD, ARTICLE);
  assert.strictEqual(v.ok, true, v.problems.join("; "));
  assert.deepStrictEqual(v.brief.context, GOOD.context);
});

test("a number in an opinion field is sent back, a year is fine, and a context number the article does not give as a project fact is sent back", () => {
  const withNum = { ...GOOD, perspective_points: ["Builders are 81 of the listings.", "Sell what a builder cannot deliver."] };
  const a = lib.validateBrief(withNum, ARTICLE);
  assert.strictEqual(a.ok, false);
  assert.match(a.problems[0], /perspective_points contains a number/);
  assert.strictEqual(lib.validateBrief({ ...GOOD, idea: "Since 2024 builders have changed how sellers compete." }, ARTICLE).ok, true, "a year is not a figure");
  const stat = lib.validateBrief({ ...GOOD, context: ["Builder homes are 81 of 237 listings."] }, ARTICLE);
  assert.strictEqual(stat.ok, false, "81 and 237 are the article's market statistic, not a project fact");
  const invented = lib.validateBrief({ ...GOOD, context: ["The city approved 400 apartments."] }, ARTICLE);
  assert.match(invented.problems[0], /context states 400/);
  assert.strictEqual(lib.validateBrief({ idea: "x", perspective_points: ["one only"] }, ARTICLE).ok, false);
});

test("the read: one corrective ask when the first brief is unusable, the article only in the user message, and a second failure reports why", async () => {
  const seen = [];
  const bad = { ...GOOD, opinion_angles: ["Prices rose 3.1% so sellers hold firm."] };
  const ok = await lib.perspectiveFromArticle({ articleText: ARTICLE, topic: { question: "Could builders change what sellers can ask?" }, intake: { market: "Lincoln, CA", audience: "Home sellers" }, anthropicKey: "k",
    callFn: async (sys, user) => { seen.push({ sys, user }); return JSON.stringify(seen.length === 1 ? bad : GOOD); } });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(seen.length, 2);
  assert.match(seen[1].user, /Your previous answer could not be used.*opinion_angles contains a number/);
  assert.doesNotMatch(seen[0].sys, /one in three homes|132 apartments/, "the article is data in the user message, not part of the instructions");
  assert.match(seen[0].user, /pricing against their net/);
  assert.match(seen[0].sys, /untrusted web content/);
  const fail = await lib.perspectiveFromArticle({ articleText: ARTICLE, topic: {}, anthropicKey: "k", callFn: async () => JSON.stringify(bad) });
  assert.strictEqual(fail.ok, false);
  assert.ok(fail.problems.length);
  const boom = await lib.perspectiveFromArticle({ articleText: ARTICLE, topic: {}, anthropicKey: "k", callFn: async () => { throw new Error("down"); } });
  assert.strictEqual(boom.ok, false, "a model error never throws");
});
