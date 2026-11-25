// Run with: npm test   (needs B1_WORKSPACE = the private ssp-b1-evidence workspace and Python 3 with beautifulsoup4 + lxml; skipped with the reason
// otherwise; B1_FIXTURES_REQUIRED=1 makes a missing workspace a failure). No network: a local HTTP server serves the frozen article HTML.
// DEVELOPMENT ONLY (live-fetch milestone, Nov 8, 2026): article capture for evidence through the REAL worker snapshot code, and the audit trail of
// capture failures. Acceptance cases LF-02, LF-10, LF-17, LF-19…LF-21 (docs/b1-live-fetch-spec.md). Nov 8, 2026 (workflow scope correction): the
// subscriber-facing source re-check (verify_source; LF-01, LF-03, LF-04, LF-18) was removed, so those cases are gone and the background function
// now refuses that mode. Every failure case proves the no-spend rule: no evidence row, no ledger reservation, no provider call, one attempt record.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { Readable } = require("stream");
const br = require("../netlify/functions/lib/agent-marketing-b1-bridge-lib");
const sb = require("../netlify/functions/lib/agent-marketing-b1-stageb-lib");
const run = require("../netlify/functions/lib/agent-marketing-b1-stageb-run-lib");
const PRIV = require("./helpers/b1-private");

const WS = PRIV.workspace || "";
const SKIP = PRIV.skip || (!fs.existsSync(path.join(WS, "src", "stageb_bridge.py")) && "B1_WORKSPACE has no src/stageb_bridge.py") || false;
const M = !SKIP ? JSON.parse(fs.readFileSync(path.join(WS, "frozen", "manifest_cases.json"), "utf8")) : {};
const FX = !SKIP ? JSON.parse(fs.readFileSync(path.join(WS, "fixtures", "manifest.json"), "utf8")).cases : {};
const raw = (c) => fs.readFileSync(path.join(WS, "frozen", "raw", `${c}.html`));
const UID = "f3abd467-cf79-455d-bdae-a2b32bafaa17";
const ENV = { AGENT_MARKETING_B1_EVIDENCE: "dev", B1_EXTRACTOR: "extract_v2", AGENT_MARKETING_ENABLED: "true", AGENT_MARKETING_USER_IDS: UID, B1_STAGEB_USER_IDS: UID,
  SUPABASE_URL: "https://ooxigbxthabstahrexia.supabase.co", B1_WORKSPACE: WS };

// The local "web": path /<host><path> → body and type; set per test.
let srv, port, web = {}, hits = [];
test.before(async () => {
  if (SKIP) return;
  srv = http.createServer((q, s) => { hits.push(q.url); const r = web[q.url]; if (!r) { s.writeHead(404); return s.end(); } s.writeHead(r.status || 200, r.headers || { "content-type": "text/html; charset=utf-8" }); s.end(r.body); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r)); port = srv.address().port;
});
test.after(() => { if (srv) srv.close(); });
function localFetch(url, init) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const q = http.request({ host: "127.0.0.1", port, path: `/${u.hostname}${u.pathname}${u.search}`, method: "GET" }, (res) => {
      const headers = new Headers(); for (const [k, v] of Object.entries(res.headers)) headers.set(k, String(v));
      resolve({ status: res.statusCode, headers, url, body: Readable.toWeb(res) });
    });
    q.on("error", reject); if (init && init.signal) init.signal.addEventListener("abort", () => q.destroy()); q.end();
  });
}
const serve = (url, body, extra) => { const u = new URL(url); web[`/${u.hostname}${u.pathname}${u.search}`] = { body, ...(extra || {}) }; };

/** In-memory Stage B store that counts every write; evidence rows are frozen copies so any change is detected. */
function world(c, { attached = true } = {}) {
  const ev = [], attempts = [], ledger = [], calls = { insert: 0, update: 0, attach: 0, reserve: 0 };
  const project = { id: `b1e00000-0000-4000-8000-00000000000${{ FA: 1, FB: 2, FC: 3 }[c]}`, user_id: UID, template: "local_market_insider", article_evidence_id: null,
    selected_research_id: `b1e00000-0000-4000-8000-00000000010${{ FA: 1, FB: 2, FC: 3 }[c]}`,
    selected_topic: { id: `t-${c}`, researchId: `b1e00000-0000-4000-8000-00000000010${{ FA: 1, FB: 2, FC: 3 }[c]}`, question: "q", whyItMatters: "w", scope: "selected",
      sources: [{ title: M[c].page_title, url: M[c].final_url, role: "primary" }], candidate: { id: `cand-${c}` } } };
  const store = {
    ev, attempts, ledger, calls,
    async findForProject(pid, tid) { return ev.filter((r) => r.project_id === pid && r.topic_id === tid && r.status !== "failed").pop() || null; },
    async findLive(key) { return ev.find((r) => r.cache_key === key && r.status === "ready") || null; },
    async insert(r) { calls.insert++; const row = { ...r, id: `ev-${ev.length + 1}` }; ev.push(row); return row; },
    async update() { calls.update++; throw new Error("no update expected"); },
    async attach() { calls.attach++; throw new Error("no attach expected"); },
    async latestForProject(pid, tid) { return ev.filter((r) => r.project_id === pid && r.topic_id === tid).pop() || null; },
    async maxProviderSeq() { return 1000; }, async countProviderCalls() { return 0; },
    async reserveProvider() { calls.reserve++; throw new Error("no reservation expected"); },
    async fail() { calls.update++; throw new Error("no fail expected"); },
    async forPlan(p) { return p.article_evidence_id ? ev.find((r) => r.id === p.article_evidence_id) || null : null; },
    async insertAttempt(a) { const row = { ...a, id: `at-${attempts.length + 1}`, created_at: new Date(Date.now() + attempts.length).toISOString() }; attempts.push(row); return row; },
    async latestAttempt(pid, tid) { const a = attempts.filter((x) => x.projectId === pid && x.topicId === tid).pop(); return a ? { mode: a.mode, stage: a.stage, outcome: a.outcome, http_status: a.httpStatus || null, created_at: a.created_at } : null; },
  };
  return { project, store, loadProject: async (id, uid) => (id === project.id && uid === UID ? project : null),
    async baseline() {   // the approved snapshot of the frozen article, captured without HTTP, attached as the project's ready evidence row
      const cap = await br.capture({ art: br.articleOf(project.selected_topic), fetchFn: async (u) => ({ status: 200, url: u, headers: { get: (k) => (k === "content-type" ? "text/html" : null) }, arrayBuffer: async () => raw(c) }), env: ENV });
      const row = Object.freeze({ id: `ev-ready-${c}`, project_id: project.id, user_id: UID, topic_id: project.selected_topic.id, status: "ready", cache_key: cap.key,
        snapshot_sha256: cap.snap.snapshot_sha256, request_sha256: cap.snap.request_sha256, provider_seq: 1001 });
      ev.push(row); if (attached) project.article_evidence_id = row.id; return { row, cap };
    } };
}
const evidence = (w, env) => run.runJob({ userId: UID, projectId: w.project.id, store: w.store, loadProject: w.loadProject, fetchFn: localFetch,
  provider: { call: async () => { throw new Error("no provider call expected"); } }, env: env || ENV });
function noSpend(w, evBefore, pointer) {
  assert.strictEqual(w.store.ev.length, evBefore, "no evidence row was inserted");
  assert.deepStrictEqual(w.store.calls, { insert: 0, update: 0, attach: 0, reserve: 0 }, "no evidence write, link change or reservation");
  assert.strictEqual(w.project.article_evidence_id, pointer, "the project's evidence link is unchanged");
}

test("LF-21 the live path reproduces the APPROVED frozen requests (seeded title authoritative; hashes unchanged)", { skip: SKIP }, async () => {
  for (const c of ["FA", "FB", "FC"]) {
    const w = world(c); serve(M[c].final_url, raw(c));
    const cap = await br.capture({ art: br.articleOf(w.project.selected_topic), fetchFn: localFetch, env: ENV });
    assert.strictEqual(cap.snap.request_sha256, FX[c].request.sha256, `${c} request hash`);
    assert.strictEqual(cap.page.observedTitle !== null, true, `${c} observed title recorded`);
  }
});

test("LF-02 markup-only changes (scripts, comments, attributes outside the article) give the same snapshot and cache key as the approved capture", { skip: SKIP }, async () => {
  const w = world("FB"); const { cap } = await w.baseline();
  const html = raw("FB").toString("utf8").replace(/<head([^>]*)>/i, '<head$1><script>window.ad = "' + Date.now() + '";</script><!-- cache 123 -->');
  assert.notStrictEqual(html, raw("FB").toString("utf8"));
  serve(M.FB.final_url, html);
  const live = await br.capture({ art: br.articleOf(w.project.selected_topic), fetchFn: localFetch, env: ENV });
  assert.notStrictEqual(live.snap.raw_html_sha256, cap.snap.raw_html_sha256);
  assert.deepStrictEqual([live.snap.snapshot_sha256, live.key], [cap.snap.snapshot_sha256, cap.key]);
});

test("LF-10 a 200 robot-check / paywall page is capture_blocked at the snapshot stage; too little text is incomplete (evidence attempt, no spend)", { skip: SKIP }, async () => {
  for (const [body, code] of [["<html><body><p>Just a moment... verify you are human. " + "x ".repeat(900) + "</p></body></html>", "capture_blocked"],
    ["<html><body><p>Subscribe to read.</p></body></html>", "incomplete"]]) {
    const w = world("FA", { attached: false }); serve(M.FA.final_url, body);
    const r = await evidence(w);
    assert.deepStrictEqual([r.state, r.code, r.providerAttempted], ["failed", code, undefined]);
    noSpend(w, 0, null);
    const a = w.store.attempts[0];
    assert.deepStrictEqual([a.mode, a.stage, a.outcome, a.httpStatus, a.comparedTo], ["evidence", "snapshot", code, 200, null]);
  }
});

test("LF-17 evidence mode: a capture failure before any row is recorded as an evidence attempt; no row, no reservation, no provider call", { skip: SKIP }, async () => {
  const w = world("FB", { attached: false }); serve(M.FB.final_url, "<html>gone</html>", { status: 410 });
  let providerCalls = 0;
  const r = await run.runJob({ userId: UID, projectId: w.project.id, store: w.store, loadProject: w.loadProject, fetchFn: localFetch,
    provider: { call: async () => { providerCalls++; return "x"; } }, env: ENV });
  assert.deepStrictEqual([r.state, r.code, providerCalls], ["failed", "http_error", 0]);
  noSpend(w, 0, null);
  assert.deepStrictEqual([w.store.attempts.length, w.store.attempts[0].mode, w.store.attempts[0].stage, w.store.attempts[0].httpStatus], [1, "evidence", "fetch", 410]);
  // and a project that already has ready evidence is answered from it: no fetch at all
  const w2 = world("FB"); const { row } = await w2.baseline(); const before = hits.length;
  const s = await run.startRequest({ userId: UID, projectId: w2.project.id, store: w2.store, loadProject: w2.loadProject, env: ENV });
  assert.deepStrictEqual([s.status, s.body.state], [200, "ready"]); assert.strictEqual(hits.length, before); assert.strictEqual(w2.project.article_evidence_id, row.id);
});

test("LF-19 provenance: a capture-failure attempt keeps source URL, final URL, observed title and hashes, and never article text or HTML", { skip: SKIP }, async () => {
  const w = world("FC", { attached: false });
  const body = "<html><head><title>Just a moment</title></head><body><p>Just a moment... verify you are human. " + "x ".repeat(900) + "</p></body></html>";
  serve(M.FC.final_url, body);
  const r = await evidence(w);
  assert.deepStrictEqual([r.state, r.code], ["failed", "capture_blocked"]);
  const a = w.store.attempts[0];
  assert.deepStrictEqual([a.sourceUrl, a.finalUrl, a.mode, a.stage], [M.FC.final_url, M.FC.final_url, "evidence", "snapshot"]);
  assert.strictEqual(a.observedTitle, "Just a moment");
  assert.ok(/^[0-9a-f]{64}$/.test(a.rawHtmlSha256));
  assert.ok(a.bytes === Buffer.byteLength(body) && /html/.test(a.contentType) && a.httpStatus === 200);
  const all = JSON.stringify(a);
  assert.ok(all.length < 2000, "a small record");
  assert.ok(!all.includes("verify you are human"), "no page text in the record");
  assert.deepStrictEqual(Object.keys(a).filter((k) => /text|html$|body|response|request|secret|token/i.test(k)), [], "no text, HTML, request, response or credential field");
  // the request title is still the seeded title, even when the page's own <title> differs
  assert.strictEqual(w.project.selected_topic.sources[0].title, M.FC.page_title);
});

test("LF-20 isolation: switch off, not allowlisted, production database, wrong owner → refused before any fetch", { skip: SKIP }, async () => {
  const w = world("FA", { attached: false }); serve(M.FA.final_url, raw("FA")); const before = hits.length;
  assert.deepStrictEqual(await evidence(w, { ...ENV, AGENT_MARKETING_B1_EVIDENCE: "" }), { state: "refused", code: "not_found" });
  assert.deepStrictEqual(await evidence(w, { ...ENV, B1_STAGEB_USER_IDS: "" }), { state: "refused", code: "not_found" });
  assert.deepStrictEqual(await evidence(w, { ...ENV, SUPABASE_URL: "https://dnpaenpwdhjmslymgkse.supabase.co" }), { state: "refused", code: "production_database_refused" });
  const other = await run.runJob({ userId: "0aaaaaaa-0000-4000-8000-000000000000", projectId: w.project.id, store: w.store, loadProject: w.loadProject, fetchFn: localFetch, provider: null, env: ENV });
  assert.deepStrictEqual(other, { state: "refused", code: "not_found" });
  assert.strictEqual(hits.length, before, "nothing was fetched");
  noSpend(w, 0, null);
});

test("the removed source re-check: the background function and the start endpoint refuse verify_source; nothing is fetched", { skip: SKIP }, async () => {
  const fn = require("../netlify/functions/agent-marketing-stageb-background");
  const ep = require("../netlify/functions/agent-marketing-stageb");
  const w = world("FA"); const { row } = await w.baseline(); serve(M.FA.final_url, raw("FA")); const before = hits.length;
  const deps = { env: ENV, requireUser: async () => ({ user: { id: UID } }), store: w.store, loadProject: w.loadProject, fetchFn: localFetch, provider: { call: async () => { throw new Error("no provider call"); } } };
  const ev = (body) => ({ httpMethod: "POST", headers: { host: "b1-stageb-dev--smart-stage-pro.netlify.app" }, body: JSON.stringify(body) });
  assert.strictEqual((await fn.handler(ev({ projectId: w.project.id, mode: "verify_source" }), {}, deps)).statusCode, 400);
  assert.strictEqual((await fn.handler(ev({ projectId: w.project.id, mode: "live_research" }), {}, deps)).statusCode, 400);
  const r = await ep.handler(ev({ action: "verify_source", projectId: w.project.id }), {}, deps);
  assert.deepStrictEqual([r.statusCode, JSON.parse(r.body).code], [400, "bad_request"]);
  assert.strictEqual(hits.length, before); assert.strictEqual(w.store.attempts.length, 0);
  noSpend(w, 1, row.id);
  for (const k of ["verifyJob", "startVerifyRequest", "verifyCap"]) assert.strictEqual(run[k], undefined, k);
});
