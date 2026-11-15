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

// ── Nov 14, 2026 (round 2): identified request headers, a sanitized diagnostic sample, and no discovery for a chosen article ──────
test("the article fetch identifies Smart Stage PRO and sends ordinary content-negotiation headers, not a browser's", async () => {
  let sent = null;
  await br.fetchArticle(URL1, { fetchFn: async (u, o) => { sent = o.headers; return resp(200, PAGE); } });
  assert.match(sent["user-agent"], /^SmartStagePRO-ArticleReader\/1\.0 \(\+https:\/\/smartstagepro\.com\)$/);
  assert.match(sent.accept, /text\/html/);
  assert.match(sent["accept-language"], /^en-US/);
  assert.ok(!/mozilla|chrome|safari|firefox/i.test(sent["user-agent"]), "never a consumer browser");
});

test("the diagnostic sample is short, tag-free and redacted, and holds no article body", () => {
  const stub = "<html><head><title>x</title><style>.a{}</style><script>var token='abcdefghijklmnopqrstuvwxyz0123456789'</script></head><body><p>Please verify you are human. Contact help@example.com ref ABCDEFGHIJKLMNOPQRSTUVWXYZ12</p>" + "<p>filler </p>".repeat(100) + "</body></html>";
  const s = br.responseSample(Buffer.from(stub));
  assert.ok(s.length <= 300);
  assert.ok(!/[<>]/.test(s) && !/var token/.test(s) && !/example\.com/.test(s) && !/ABCDEFGHIJKLMNOPQRSTUVWXYZ12/.test(s));
  assert.match(s, /verify you are human/);
});

test("the sample is stored only when there is one, as a short text field", () => {
  const src = fs.readFileSync(require("path").join(__dirname, "..", "netlify/functions/lib/agent-marketing-b1-store-lib.js"), "utf8");
  assert.match(src, /a\.responseSample \? \{ response_sample: str\(a\.responseSample, 300\) \} : \{\}/);
  assert.ok(fs.existsSync(require("path").join(__dirname, "..", "supabase/migrations/20261114_agent_marketing_article_capture_response_sample.sql")));
});

test("a chosen article skips discovery: the compatible 'ready' result carries no topics, and a failed read still ends uncharged", async () => {
  const f = rl.chosenArticleFields({ usage: { pathway: "article_led" }, focus: { articleUrl: URL1 } });
  assert.strictEqual(f.status, "ready"); assert.deepStrictEqual(f.topics, []); assert.strictEqual(f.error, null);
  assert.strictEqual(f.usage.pathway, "article_led"); assert.strictEqual(f.usage.discovery, "skipped_chosen_article");
  assert.match(f.research_date, /^\d{4}-\d{2}-\d{2}$/);
  const out = await b2.enrich({ row: row({ marketUpdateMode: "article_editorial", articleUrl: URL1 }), fields: f, uploads: [], userId: U, env: ENV, deps: { store: anyStore(), provider: null, fetchFn: async () => resp(404, "x") } });
  assert.strictEqual(out.status, "failed"); assert.strictEqual(out.charged_at, null);
  assert.strictEqual(out.usage.discovery, "skipped_chosen_article");
});

test("the research run skips discovery only when a chosen article is present and Article-Led is on; otherwise discovery is unchanged", () => {
  const src = fs.readFileSync(require("path").join(__dirname, "..", "netlify/functions/agent-marketing-research-background.js"), "utf8");
  assert.match(src, /const skipDiscovery = !!chosenUrl && require\(".\/lib\/agent-marketing-b2-lib"\)\.applies\(row, process\.env\);/);
  assert.match(src, /skipDiscovery \? \{ fields: [^}]*chosenArticleFields\(row\)[^}]*\} : await runLib\.runResearch\(/);
  assert.match(src, /source !== "upload" && !chosenUrl && !process\.env\.PERPLEXITY_API_KEY/, "no discovery key is needed for a chosen article");
});

// ── Subscriber-supplied article text (Nov 14, 2026): a site that blocks automated readers; the same B1 -> B2 -> Planner path, no discovery, no site contact ──
const BODY = Array.from({ length: 14 }, (_, i) => `Paragraph ${i + 1}: Lincoln resale sellers compete against builder financing advantages that affect buyer affordability, so lowering the asking price alone may overlook an important competitive factor.`).join("\n\n");
const TXT = { articleText: BODY, articleTitle: "Selling Against New Construction in Lincoln", articlePermission: true };

test("article text needs a title, the permission confirmation and enough text; the original address is optional and must be https", () => {
  const ok = req(TXT);
  assert.ok(ok.ok, JSON.stringify(ok.errors));
  assert.strictEqual(ok.request.articleText, BODY);
  assert.ok(!("articleSourceUrl" in ok.request));
  assert.strictEqual(req({ ...TXT, articleSourceUrl: URL1 }).request.articleSourceUrl, URL1);
  const f = (x) => req({ ...TXT, ...x }).errors.map((e) => e.field);
  assert.ok(f({ articleTitle: "  " }).includes("articleTitle"));
  assert.ok(f({ articlePermission: false }).includes("articlePermission"));
  assert.ok(f({ articlePermission: undefined }).includes("articlePermission"));
  assert.ok(f({ articleText: "too short" }).includes("articleText"));
  assert.ok(f({ articleText: "x".repeat(60001) }).includes("articleText"));
  assert.ok(f({ articleSourceUrl: "http://example.com/a" }).includes("articleSourceUrl"));
  assert.ok(f({ articleUrl: URL1 }).includes("articleText"), "a link and text together are refused");
});

test("article text is for the two Article-Led types only, and a title alone is not an article", () => {
  const t = rl.validateResearchRequest({ ...base, marketUpdateMode: "trend_report", dataSource: "upload", dataFocus: "all", period: { days: 30 }, uploadIds: ["11111111-1111-4111-8111-111111111111"], ...TXT });
  assert.ok(!t.ok && t.errors.some((e) => e.field === "articleText"));
  assert.ok(!req({ articleTitle: "A title" }).ok);
});

test("different text is a different request; the same text is the same request", () => {
  const k = (r) => rl.requestKey(r.request);
  assert.strictEqual(k(req(TXT)), k(req({ ...TXT })));
  assert.notStrictEqual(k(req(TXT)), k(req({})));
  assert.notStrictEqual(k(req(TXT)), k(req({ ...TXT, articleText: BODY + "\n\nOne more paragraph that changes the article." })));
});

test("submitted text goes through the B1 capture path, never contacts a website, and discovery is not needed", async () => {
  const fetched = [];
  const out = await b2.enrich({ row: row({ marketUpdateMode: "article_editorial", ...TXT, articleSourceUrl: URL1 }), fields: { status: "ready", topics: [], usage: {} }, uploads: [], userId: U, env: ENV,
    deps: { store: anyStore(), provider: null, fetchFn: async (u) => { fetched.push(u); return resp(200, "<html>the real site</html>"); } } });
  assert.deepStrictEqual(fetched, [], "the caller's fetch (the website) is never used for submitted text");
  const a = out.usage.b1b2.articles[0];
  assert.strictEqual(a.url, URL1);
  assert.notStrictEqual(a.code, "http_error");
  assert.notStrictEqual(a.code, "page_identity");
  assert.notStrictEqual(a.code, "incomplete", "a full-length article is not refused as too short");
});

test("submitted text that is too short to understand fails visibly, uncharged, with no other article used", async () => {
  const out = await b2.enrich({ row: row({ marketUpdateMode: "article_editorial", ...TXT, articleText: "Short. ".repeat(60) }), fields: { status: "ready", topics: discovered, usage: {} }, uploads: [], userId: U, env: ENV,
    deps: { store: anyStore(), provider: null, fetchFn: async () => resp(200, "x") } });
  assert.strictEqual(out.status, "failed");
  assert.strictEqual(out.charged_at, null);
  assert.strictEqual(out.usage.b1b2.state, "chosen_article_unavailable");
  assert.match(out.error, /article text you provided/);
  assert.match(out.error, /No other article was used/);
  assert.strictEqual(out.usage.b1b2.articles.length, 1);
});

test("the synthetic page escapes the subscriber's text and keeps their paragraphs", () => {
  const h = b2.submittedArticleHtml("A <b>title</b>", "One & two\n\n<script>x</script>\nThree");
  assert.ok(!/<script>/.test(h) && !/<b>/.test(h));
  assert.strictEqual((h.match(/<p>/g) || []).length, 3);
});

test("the form takes a title, an optional original address, the text and the permission confirmation, and they are sent with the request", () => {
  const html = fs.readFileSync(__dirname + "/../agent-marketing.html", "utf8");
  const ui = fs.readFileSync(__dirname + "/../agent-marketing-research-ui.js", "utf8");
  for (const id of ["articleTitle", "articleSourceUrl", "articleText", "articlePermission"]) { assert.ok(html.includes(`id="${id}"`), id); assert.ok(ui.includes(id), id); }
  assert.match(html, /own this article or have permission/);
  assert.match(ui, /articleText: t\.value/);
});

test("the submitted text is stored with the request but not sent back with every poll", () => {
  const src = fs.readFileSync(__dirname + "/../netlify/functions/agent-marketing-research.js", "utf8");
  assert.match(src, /focus: focusForClient\(row\.focus\)/);
  assert.match(src, /articleTextChars/);
});

test("evidence this project already holds for the article from an earlier research run is found for a later run (Option 3 text, then Option 2)", () => {
  const src = fs.readFileSync(__dirname + "/../netlify/functions/lib/agent-marketing-b1-stageb-run-lib.js", "utf8");
  const i = src.indexOf("async function articleEvidence");
  const body = src.slice(i, i + 3200);
  assert.match(body, /findForProject\(projectId, articleKey, researchId\)/);
  assert.match(body, /if \(!row\) row = await store\.findForProject\(projectId, articleKey\);/);
  assert.match(body, /checkRecord\(row, project\)\.length\) row = null/, "the same contract check still applies to the record found");
});
