// Nov 14, 2026 (Sam): the subscriber may choose the article for an Article-Led Market Update (Options 2 and 3).
// Request validation and identity, a 2xx capture with a page-identity check, the chosen article as the ONLY B1 source, and a visible failure when it
// cannot be read (no discovered article is substituted). No provider call, no database, no network.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const rl = require("../netlify/functions/lib/agent-marketing-research-lib");
const br = require("../netlify/functions/lib/agent-marketing-b1-bridge-lib");
const b2 = require("../netlify/functions/lib/agent-marketing-b2-lib");

const URL1 = "https://richandkatsoldthat.com/blog/selling-home-against-new-construction-lincoln-ca";
const base = { mode: "market_update", audience: "sellers", geography: { type: "city", name: "Lincoln", zip: "95648" }, focus: { new_construction: true }, keywords: "", dataFocus: "none", period: null };
const req = (extra) => rl.validateResearchRequest({ ...base, marketUpdateMode: "article_editorial", ...extra });

test("an Article URL is optional: with none, the request is the same as before", () => {
  const a = req({}), b = req({ articleUrl: "   " });
  assert.ok(a.ok && b.ok);
  assert.ok(!("articleUrl" in a.request) && !("articleUrl" in b.request));
});

test("an https Article URL is accepted for both Article-Led types", () => {
  assert.strictEqual(req({ articleUrl: URL1 }).request.articleUrl, URL1);
  const o2 = rl.validateResearchRequest({ ...base, dataFocus: "all", period: { days: 30 }, marketUpdateMode: "article_report", dataSource: "both", uploadIds: ["11111111-1111-4111-8111-111111111111"], articleUrl: URL1 });
  assert.ok(o2.ok, JSON.stringify(o2.errors));
  assert.strictEqual(o2.request.articleUrl, URL1);
});

test("an unusable Article URL is refused with a plain message; another type never takes one", () => {
  for (const bad of ["http://example.com/a", "not a url", "https://127.0.0.1/a", "https://user:pw@example.com/a", "https://localhost/a"]) {
    const r = req({ articleUrl: bad });
    assert.ok(!r.ok && r.errors.some((e) => e.field === "articleUrl"), bad);
  }
  const t = rl.validateResearchRequest({ ...base, marketUpdateMode: "trend_report", dataSource: "upload", dataFocus: "all", period: { days: 30 }, uploadIds: ["11111111-1111-4111-8111-111111111111"], articleUrl: URL1 });
  assert.ok(!t.ok && t.errors.some((e) => e.field === "articleUrl"));
});

test("the Article URL is part of the request identity: another article is never returned as the same session", () => {
  const k = (r) => rl.requestKey(r.request);
  assert.notStrictEqual(k(req({})), k(req({ articleUrl: URL1 })));
  assert.notStrictEqual(k(req({ articleUrl: URL1 })), k(req({ articleUrl: "https://example.com/blog/other-article" })));
  assert.strictEqual(k(req({ articleUrl: URL1 })), k(req({ articleUrl: URL1 + "/" })), "a trailing slash is the same article");
  assert.strictEqual(k(req({})), k(req({ articleUrl: "" })), "no URL keeps the earlier identity");
});

// ── capture: any 2xx, with the page's identity and completeness still checked ──────────────────────────────────────
const resp = (status, html, extra) => ({ status, headers: { get: (h) => ({ "content-type": "text/html; charset=utf-8" }[String(h).toLowerCase()] || (extra && extra[String(h).toLowerCase()]) || null) },
  body: new ReadableStream({ start(c) { c.enqueue(Buffer.from(html)); c.close(); } }) });
const PAGE = "<!doctype html><html><head><title>Selling a Home Against New Construction in Lincoln</title></head><body><article><p>Body.</p></article></body></html>";

test("a nonstandard 2xx answer (218) is accepted, and the page identity is recorded", async () => {
  const seen = [];
  const page = await br.fetchArticle(URL1, { fetchFn: async (u) => { seen.push(u); return resp(218, PAGE); } });
  assert.strictEqual(page.httpStatus, 218);
  assert.strictEqual(page.finalUrl, URL1);
  assert.match(page.observedTitle, /Selling a Home Against New Construction/);
  assert.deepStrictEqual(seen, [URL1]);
});

test("non-2xx answers are still refused", async () => {
  for (const s of [199, 300, 404, 500]) {
    await assert.rejects(br.fetchArticle(URL1, { fetchFn: async () => resp(s, PAGE) }), (e) => e.code === "http_error" || e.code === "fetch_failed", String(s));
  }
});

test("a same-site redirect that lands on the home page is not the chosen article", async () => {
  const f = async (u) => (u === URL1 ? { status: 302, headers: { get: (h) => (String(h).toLowerCase() === "location" ? "https://richandkatsoldthat.com/" : null) }, body: null } : resp(200, PAGE));
  await assert.rejects(br.fetchArticle(URL1, { fetchFn: f }), (e) => e.code === "page_identity");
});

test("an incomplete page behind a 2xx answer is still refused by the snapshot check (status alone is not enough)", () => {
  const snapshot = fs.readFileSync(require("path").join(__dirname, "..", "netlify/functions/lib/agent-marketing-b1-bridge-lib.js"), "utf8");
  assert.match(snapshot, /art\.title \|\| page\.observedTitle/, "a chosen article takes the page's own title");
});

// ── the chosen article is the only B1 source ─────────────────────────────────────────────────────────────────────
const U = "f3abd467-cf79-455d-bdae-a2b32bafaa17";
const ENV = { AGENT_MARKETING_B1_EVIDENCE: "dev", AGENT_MARKETING_ENABLED: "true", AGENT_MARKETING_USER_IDS: U, B1_STAGEB_USER_IDS: U, SUPABASE_URL: "https://dev-project.supabase.co" };
const row = (focus) => ({ id: "22222222-2222-4222-8222-222222222222", project_id: "33333333-3333-4333-8333-333333333333", mode: "market_update", data_source: "web", audience: "sellers",
  geography: { type: "city", name: "Lincoln", zip: "95648" }, created_at: new Date().toISOString(), focus });
const discovered = [{ id: "t1", sources: [{ url: "https://www.houseberry.com/blog/lincoln-parkwood-122-homes-development-agreement/", title: "Parkwood", kind: "article", role: "primary" }] },
  { id: "t2", sources: [{ url: "https://klin.com/2026/11/03/south-beltway/", title: "KLIN", kind: "article", role: "primary" }] }];
class EmptyStore {}   // a store that holds nothing: every lookup answers "none", every write is accepted
for (const m of ["findForProject", "findReadyForTopic", "findReadyForProjectKey", "findLiveByKey", "findByCacheKey", "recordAttempt", "attach", "fail"]) EmptyStore.prototype[m] = async () => null;
const anyStore = () => new EmptyStore();

test("with a chosen article B1 reads only that article, and a failed read says so instead of substituting a discovered one", async () => {
  const fetched = [];
  const out = await b2.enrich({ row: row({ marketUpdateMode: "article_editorial", articleUrl: URL1 }), fields: { status: "ready", topics: discovered, usage: {} }, uploads: [], userId: U, env: ENV,
    deps: { store: anyStore(), provider: null, fetchFn: async (u) => { fetched.push(u); return resp(404, "not found"); } } });
  assert.strictEqual(out.status, "failed");
  assert.strictEqual(out.charged_at, null);
  assert.strictEqual(out.usage.b1b2.state, "chosen_article_unavailable");
  assert.match(out.error, /No other article was used/);
  assert.deepStrictEqual(out.usage.b1b2.articles.map((a) => a.url), [URL1]);
  assert.deepStrictEqual(fetched, [URL1], "only the chosen article was requested");
  assert.strictEqual(out.usage.b1b2.articles[0].code, "http_error");
});

test("a chosen article does not need discovery topics, and without one the discovery path is unchanged", async () => {
  const none = await b2.enrich({ row: row({ marketUpdateMode: "article_editorial" }), fields: { status: "ready", topics: [], usage: {} }, uploads: [], userId: U, env: ENV, deps: { store: anyStore(), provider: null } });
  assert.deepStrictEqual(none, { status: "ready", topics: [], usage: {} }, "no article and no discovery topics: nothing to do, as before");
  const fetched = [];
  await b2.enrich({ row: row({ marketUpdateMode: "article_editorial", articleUrl: URL1 }), fields: { status: "ready", topics: [], usage: {} }, uploads: [], userId: U, env: ENV,
    deps: { store: anyStore(), provider: null, fetchFn: async (u) => { fetched.push(u); return resp(404, "x"); } } });
  assert.deepStrictEqual(fetched, [URL1]);
});

test("the Article link field is on the form, shown only for the Article-Led types, and sent with the request", () => {
  const html = fs.readFileSync(require("path").join(__dirname, "..", "agent-marketing.html"), "utf8");
  const ui = fs.readFileSync(require("path").join(__dirname, "..", "agent-marketing-research-ui.js"), "utf8");
  assert.match(html, /id="articleUrl"/);
  assert.match(html, /id="articleUrlBox" class="hidden"/);
  assert.match(ui, /articleUrl: articleUrlValue\(\) \|\| undefined/);
  assert.match(ui, /m === "article_report" \|\| m === "article_editorial"/);
});
