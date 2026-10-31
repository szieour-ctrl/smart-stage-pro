"use strict";
// Deterministic research scenarios used by tests/agent-marketing-research-diag.test.js and by scripts/research-baseline.js --replay.
// Providers are replaced by recorded-style answers; hosts are fictional (.example) so no real publisher is implied.
// tests/fixtures/research-diag/golden.json holds the output of each scenario from the code BEFORE PR 1 (main at 4037967): the tests prove that
// adding diagnostics changed nothing else (fields, problems, attempts).

const NOW = "2026-10-24T17:00:00Z";
const noSleep = async () => {};
const mkRow = (geo, extra) => ({ id: "r1", mode: "market_update", audience: "sellers", geography: geo, focus: {}, upload_refs: [], data_source: "web", ...(extra || {}) });
const GEO = {
  lincoln: { type: "city", name: "Lincoln", city: "", zip: "95648", state: "CA", label: "Lincoln, CA" },
  natomas: { type: "neighborhood", name: "Natomas", city: "Sacramento", zip: "95835", state: "CA", label: "Natomas, Sacramento, CA" },
  crocker: { type: "neighborhood", name: "Crocker Ranch", city: "Roseville", zip: "95747", state: "CA", label: "Crocker Ranch, Roseville, CA" },
  thin: { type: "city", name: "Colfax", city: "", zip: "95713", state: "CA", label: "Colfax, CA" },
};

const U = (host, path) => `https://${host}/${path}`;
const usage = (n) => ({ input_tokens: 4000 + n, output_tokens: 1500 + n, output_tokens_details: { reasoning_tokens: 200 }, tool_calls_details: { web_search: { invocation: 2 } }, cost: { total_cost: 0.0125 + n / 1e4 } });
const reply = (urls, topics, n) => ({
  status: 200,
  json: {
    output: [
      { type: "search_results", results: urls.map((u, i) => (typeof u === "object" ? { url: u.url } : { url: u, date: `2026-10-${String(10 + (i % 12)).padStart(2, "0")}T08:00:00Z` })) },
      { type: "message", content: [{ type: "output_text", text: "```json\n" + JSON.stringify({ topics }) + "\n```" }] },
    ],
    usage: usage(n || 0),
  },
});
const T = (q, why, srcs, extra) => ({ question: q, why_it_matters: why, trend_signals: ["Active listings rose in September 2026 from August 2026"], local_intent: true, scope: "selected", scope_note: null, event: null, sources: srcs, ...(extra || {}) });
const S = (url, published, title) => ({ title: title || "Local housing story", url, published: published === undefined ? "2026-10-20" : published });
const WHY = "It changes how sellers price and how long they should expect to wait, which affects their plans and the offers they take this fall season.";

const good = (host) => [1, 2, 3, 4, 5].map((i) => T(
  ["Are new subdivisions pulling buyers from resale homes?", "Why did the city approve more apartments this fall?", "What do higher mortgage rates mean for move-up buyers?", "Is the school-year calendar shifting listing timing?", "Which price bands saw pending sales slip last month?"][i - 1],
  WHY, [S(U(`site${i}.${host}`, `news/story-${i}?utm_source=nl&session=abc123`), "2026-10-18")]));
const goodUrls = (host) => [1, 2, 3, 4, 5].map((i) => U(`site${i}.${host}`, `news/story-${i}`)).concat([U(`extra1.${host}`, "news/x"), U(`extra2.${host}`, "news/y")]);

function scenarios() {
  const out = [];
  // 1. Five clean topics on the first answer.
  out.push({ name: "five_clean", row: mkRow(GEO.lincoln), env: {}, answers: [reply(goodUrls("example"), good("example"), 1)] });

  // 2. First answer loses every topic for a different reason; the retry delivers five.
  const lossy = [
    T("Did builders cut prices in Lincoln this month?", WHY, [S(U("invented.example", "news/ghost"), "2026-10-20")]),                           // provider never read it
    T("Why are Lincoln listings sitting longer?", WHY, [S("https://www.wsj.com/articles/lincoln-listings", "2026-10-20")]),                      // paywalled
    T("Is Lincoln inventory still growing?", WHY, [S(U("old.example", "news/old"), "2026-07-01")]),                                              // stale
    T("Are Lincoln buyers waiting on rates?", WHY, [S(U("nodate.example", "news/nodate"), "")]),                                                 // undated
    T("What is a Lincoln home worth now?", WHY, [S("https://www.zillow.com/homedetails/123-main-st/1_zpid/", "2026-10-20")]),                    // listing page
  ];
  const lossyUrls = [{ url: U("old.example", "news/old") }, { url: U("nodate.example", "news/nodate") }, "https://www.wsj.com/articles/lincoln-listings", "https://www.zillow.com/homedetails/123-main-st/1_zpid/"];
  out.push({ name: "all_lost_then_retry_ok", row: mkRow(GEO.lincoln), env: {}, answers: [reply(lossyUrls, lossy, 2), reply(goodUrls("example"), good("example"), 3)] });

  // 3. Overlap, duplicate address, future date, sixth topic.
  const six = good("example");
  six[1].question = "Are new subdivisions pulling buyers away from resale homes?";                       // overlaps topic 1
  six[2].sources.push(S(U("site3.example", "news/story-3?utm_source=nl&session=abc123"), "2026-10-18"));                               // same address twice
  six[3].sources = [S(U("site4.example", "news/story-4"), "2026-12-30")];                                  // future dated
  six.push(T("What is the permit count telling sellers?", WHY, [S(U("site6.example", "news/story-6"), "2026-10-19")]));
  out.push({ name: "overlap_duplicate_future_sixth", row: mkRow(GEO.natomas), env: { AGENT_MARKETING_RESEARCH_RETRIES: "0" }, answers: [reply(goodUrls("example").concat([U("site6.example", "news/story-6")]).map((u) => (u.includes("site4.") ? { url: u } : u)), six, 4)] });

  // 4. A partial first answer (3 usable) and a retry that does worse (2 usable): today the retry's answer is the one kept.
  const part1 = good("example").slice(0, 3).concat([T("Is it a good time to sell?", WHY, [S("https://www.wsj.com/articles/x", "2026-10-20")]), T("Will prices rise?", WHY, [S(U("nodate.example", "news/n"), "")])]);
  const part2 = good("example").slice(0, 2).concat([T("Is it a good time to sell?", WHY, [S("https://www.wsj.com/articles/x", "2026-10-20")]), T("Will prices rise?", WHY, [S(U("nodate.example", "news/n"), "")]), T("Another?", WHY, [S(U("nodate.example", "news/m"), "")])]);
  out.push({ name: "partial_then_worse_retry", row: mkRow(GEO.crocker), env: {}, answers: [reply(goodUrls("example").concat([{ url: U("nodate.example", "news/n") }, "https://www.wsj.com/articles/x"]), part1, 5), reply(goodUrls("example").concat([{ url: U("nodate.example", "news/n") }, { url: U("nodate.example", "news/m") }, "https://www.wsj.com/articles/x"]), part2, 6)] });

  // 5. Nothing usable on either answer: the provider read none of the pages the model named.
  const none = [1, 2, 3, 4, 5].map((i) => T(`Question number ${i} about housing here?`, WHY, [S(U("nodate.example", `news/n${i}`), "")]));
  out.push({ name: "failure_nothing_usable", row: mkRow(GEO.thin), env: {}, answers: [reply([U("elsewhere.example", "news/z")], none, 7), reply([U("elsewhere.example", "news/z")], none, 8)] });

  // 6a. Six valid topics, the second on the first one's article: it is placed after the others and falls past five.
  const rep6 = good("example").concat([T("What are permits saying about next spring?", WHY, [S(U("site6.example", "news/story-6"), "2026-10-19")])]);
  rep6[1].sources = [S(U("site1.example", "news/story-1"), "2026-10-18")];
  out.push({ name: "six_with_repeat_article", row: mkRow(GEO.lincoln), env: { AGENT_MARKETING_RESEARCH_RETRIES: "0" }, answers: [reply(goodUrls("example").concat([U("site6.example", "news/story-6")]), rep6, 9)] });
  // 6b. Five topics, the second on the first one's article: kept, but placed last.
  const rep5 = good("example");
  rep5[1].sources = [S(U("site1.example", "news/story-1"), "2026-10-18")];
  out.push({ name: "five_with_repeat_article", row: mkRow(GEO.natomas), env: { AGENT_MARKETING_RESEARCH_RETRIES: "0" }, answers: [reply(goodUrls("example"), rep5, 10)] });

  // 6. The provider refuses (bad key): a plain failure, no diagnostics detail about the key.
  out.push({ name: "provider_rejects_key", row: mkRow(GEO.lincoln), env: {}, answers: [{ status: 401, json: { error: "bad key pplx-SECRET123" } }] });
  return out;
}

async function runScenario(run, sc, extra) {
  const answers = sc.answers.slice();
  const sent = [];
  const callFn = async (payload) => { sent.push(JSON.parse(JSON.stringify(payload))); return answers.shift() || answers[answers.length - 1]; };
  const r = await run.runResearch({ row: sc.row, apiKey: "k", now: NOW, env: sc.env, sleepFn: noSleep, callFn, ...(extra || {}) });
  return { result: r, sent };
}

/** One clean answer, for the baseline harness's offline smoke run. */
const replayReply = (n) => reply(goodUrls("example"), good("example"), n);

module.exports = { NOW, GEO, scenarios, runScenario, reply, usage, replayReply };
