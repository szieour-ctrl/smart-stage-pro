// Oct 30, 2026 (Sam): Claude reads the whole article for its perspective, so only articles we can open and read are kept. An unreadable article (paywall,
// bot wall, script shell, HTTP error) is dropped at research time; at script time the article is read once and handed to the planner, never stored.
const test = require("node:test");
const assert = require("node:assert");
delete process.env.AGENT_MARKETING_READABILITY; // these tests exercise the check itself
const af = require("../netlify/functions/lib/agent-marketing-article-fetch-lib");
const run = require("../netlify/functions/lib/agent-marketing-research-run-lib");

const para = (n) => Array.from({ length: n }, (_, i) => `Builders in the area price their homes against what a buyer nets after incentives, not the sticker, number ${i}.`).join(" ");
const PAGE = `<html><head><title>x</title><script>var a=1;</script></head><body><nav>Home About Contact</nav><article><h1>Selling a home against new construction</h1><p>${para(30)}</p></article><footer>Subscribe to our newsletter</footer></body></html>`;
const res = (body, over) => ({ ok: true, status: 200, url: "https://news.example.org/a", headers: { get: (h) => ({ "content-type": "text/html; charset=utf-8" }[String(h).toLowerCase()]) }, text: async () => body, ...(over || {}) });

test("safeUrl: only public https pages are fetched", () => {
  assert.ok(af.safeUrl("https://www.example.org/a?b=1"));
  for (const bad of ["http://example.org/a", "https://localhost/a", "https://127.0.0.1/a", "https://10.0.0.5/a", "https://[::1]/a", "https://example.org:8443/a", "https://user:pw@example.org/a", "file:///etc/passwd", "not a url", "https://intranet/a", "https://printer.local/a"]) assert.strictEqual(af.safeUrl(bad), null, bad);
});

test("htmlToText: the article body without scripts, menus or the footer", () => {
  const t = af.htmlToText(PAGE);
  assert.match(t, /Selling a home against new construction/);
  assert.match(t, /price their homes against what a buyer nets/);
  assert.doesNotMatch(t, /var a=1|Home About Contact|Subscribe to our newsletter/);
  assert.match(af.htmlToText("<p>Fish &amp; chips&nbsp;&mdash; it&#39;s &#x41;</p>"), /Fish & chips — it's A/);
});

test("fetchArticle: a readable article is returned; every failure says why", async () => {
  const ok = await af.fetchArticle("https://news.example.org/a", { fetchFn: async () => res(PAGE) });
  assert.strictEqual(ok.ok, true);
  assert.ok(ok.text.length > 1000 && ok.text.length <= af.MAX_TEXT_CHARS);
  const why = async (fetchFn, url) => (await af.fetchArticle(url || "https://news.example.org/a", { fetchFn })).reason;
  assert.strictEqual(await why(async () => res("", { ok: false, status: 403 })), "blocked");
  assert.strictEqual(await why(async () => res(PAGE, { headers: { get: () => "application/pdf" } })), "not_html");
  assert.strictEqual(await why(async () => res("<html><body><p>Just a few words here.</p></body></html>")), "too_short");
  assert.strictEqual(await why(async () => res("<html><body><article><p>Subscribe to continue reading. You have reached your free article limit.</p></article></body></html>")), "wall");
  assert.strictEqual(await why(async () => res(PAGE, { url: "https://127.0.0.1/x" })), "bad_url", "a redirect to a private address is refused");
  assert.strictEqual(await why(async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; }), "timeout");
  assert.strictEqual(await why(async () => { throw new Error("ECONNRESET"); }), "error");
  assert.strictEqual(await why(async () => res(PAGE), "http://news.example.org/a"), "bad_url");
});

test("a long article that mentions 'subscribe' in passing is still readable (only a short page with a wall phrase is a wall)", async () => {
  const body = `<article><p>${para(60)} Subscribe to continue reading the rest of our local coverage.</p></article>`;
  assert.strictEqual((await af.fetchArticle("https://news.example.org/a", { fetchFn: async () => res(body) })).ok, true);
});

test("readabilityFilter: unreadable web articles are dropped, the agent's own report topics are always kept", async () => {
  const topics = [
    { id: "t1", origin: "report", sources: [] },
    { id: "t2", origin: "web", sources: [{ url: "https://good.example.org/a" }] },
    { id: "t3", origin: "web", sources: [{ url: "https://paywall.example.org/a" }] },
    { id: "t4", origin: "web", sources: [] },
  ];
  const fetchFn = async (u) => (/paywall/.test(u) ? res("", { ok: false, status: 402 }) : res(PAGE));
  const r = await af.readabilityFilter(topics, { fetchFn });
  assert.deepStrictEqual(r.kept.map((t) => t.id), ["t1", "t2"]);
  assert.deepStrictEqual(r.dropped.map((d) => [d.id, d.reason]), [["t3", "blocked"], ["t4", "no_url"]]);
});

// ── research: the check is part of the run ──
const Q = ["Why are some Roseville homes taking longer to sell?", "Does spring bring more competing listings to Roseville?", "How are builder incentives changing resale pricing near new communities?", "What are mortgage rate buydowns doing to buyer budgets?", "Which price bands are seeing the most pending sales this month?"];
const url = (n) => `https://site${n}.example.org/report-${n}`;
const topic = (n) => ({ question: Q[n - 1], why_it_matters: "It changes how sellers price.", trend_signals: ["MLS active listings up month over month"], local_intent: true, scope: "selected", scope_note: null, event: null, sources: [{ title: "Story " + n, url: url(n), published: "2026-10-20" }] });
const reply = (topics) => ({ status: 200, json: { output: [{ type: "search_results", results: [1, 2, 3, 4, 5].map((i) => ({ url: url(i) })) }, { type: "message", content: [{ type: "output_text", text: "```json\n" + JSON.stringify({ topics }) + "\n```" }] }], usage: { input_tokens: 600, output_tokens: 1500 } } });
const row = { id: "r1", mode: "market_update", audience: "sellers", geography: { type: "city", name: "Roseville", city: "", state: "CA", label: "Roseville, CA" }, focus: {}, upload_refs: [] };
const base = { row, apiKey: "k", now: "2026-10-24T17:00:00Z", env: { AGENT_MARKETING_RESEARCH_RETRIES: "0" }, sleepFn: async () => {} };

test("run: with all five articles readable nothing changes", async () => {
  const r = await run.runResearch({ ...base, callFn: async () => reply([1, 2, 3, 4, 5].map(topic)), articleFetchFn: async () => res(PAGE) });
  assert.strictEqual(r.fields.status, "ready");
  assert.strictEqual(r.fields.topics.length, 5);
});

test("run: an unreadable article is dropped, the rest are kept as a partial set, and the agent is told", async () => {
  const r = await run.runResearch({ ...base, callFn: async () => reply([1, 2, 3, 4, 5].map(topic)), articleFetchFn: async (u) => (/site[24]\./.test(u) ? res("", { ok: false, status: 403 }) : res(PAGE)) });
  assert.strictEqual(r.fields.topics.length, 3, "two unreadable articles were dropped");
  assert.ok(r.fields.topics.every((t) => !/site[24]\./.test(t.sources[0].url)));
  assert.strictEqual(r.fields.status, "ready", "a partial set is delivered like any other partial run (Sam, Oct 28)");
});

test("run: when no article can be read the run fails uncharged, and a retry is asked for different articles", async () => {
  const asked = [];
  const r = await run.runResearch({ ...base, env: { AGENT_MARKETING_RESEARCH_RETRIES: "1" }, callFn: async (p) => { asked.push(p.input); return reply([1, 2, 3, 4, 5].map(topic)); }, articleFetchFn: async () => res("", { ok: false, status: 403 }) });
  assert.strictEqual(r.fields.status, "failed");
  assert.strictEqual(r.fields.charged_at, null);
  assert.strictEqual(asked.length, 2);
  assert.match(asked[1], /opened and read/);
});

test("run: the check applies to a market update only", async () => {
  const events = { ...row, mode: "local_events" };
  let fetched = 0;
  await run.runResearch({ ...base, row: events, callFn: async () => reply([]), articleFetchFn: async () => { fetched++; return res(PAGE); } });
  assert.strictEqual(fetched, 0);
});
