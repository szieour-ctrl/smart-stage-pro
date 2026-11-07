// Run with: npm test   (no private material, no network: a local HTTP server stands in for article sites)
// DEVELOPMENT ONLY (live-fetch milestone, Nov 8, 2026): the live article fetch (lib/agent-marketing-b1-bridge-lib.js fetchArticle).
// Acceptance cases LF-05…LF-16 (docs/b1-live-fetch-spec.md) at the fetch stage: explicit codes, https only, redirects followed by hand and kept on
// the same site (a cross-site hop is never requested), early and streaming size limits, the timeout, and observed-title provenance.
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const { Readable } = require("stream");
const br = require("../netlify/functions/lib/agent-marketing-b1-bridge-lib");

const PAGE = "<!doctype html><html><head><title>Local housing &amp; prices &#8211; Example Sentinel</title></head><body><article><p>Body.</p></article></body></html>";
let srv, port; const hits = [];
const routes = {
  "/news.example/a": (q, s) => { s.writeHead(200, { "content-type": "text/html; charset=utf-8" }); s.end(PAGE); },
  "/news.example/r301": (q, s) => { s.writeHead(301, { location: "/a" }); s.end(); },
  "/news.example/rwww": (q, s) => { s.writeHead(302, { location: "https://www.news.example/a" }); s.end(); },
  "/www.news.example/a": (q, s) => { s.writeHead(200, { "content-type": "text/html" }); s.end(PAGE); },
  "/news.example/away": (q, s) => { s.writeHead(302, { location: "https://other.example/a" }); s.end(); },
  "/news.example/tohttp": (q, s) => { s.writeHead(302, { location: "http://news.example/a" }); s.end(); },
  "/news.example/loop": (q, s) => { s.writeHead(302, { location: "/loop" }); s.end(); },
  "/news.example/noloc": (q, s) => { s.writeHead(302); s.end(); },
  "/news.example/pdf": (q, s) => { s.writeHead(200, { "content-type": "application/pdf" }); s.end("%PDF-1.7"); },
  "/news.example/json": (q, s) => { s.writeHead(200, { "content-type": "application/json" }); s.end("{}"); },
  "/news.example/text": (q, s) => { s.writeHead(200, { "content-type": "text/plain" }); s.end("plain"); },
  "/news.example/empty": (q, s) => { s.writeHead(200, { "content-type": "text/html" }); s.end(); },
  "/news.example/big-declared": (q, s) => { s.writeHead(200, { "content-type": "text/html", "content-length": String(5 * 1024 * 1024) }); s.write("<html>"); },
  "/news.example/big-chunked": (q, s) => {
    s.writeHead(200, { "content-type": "text/html" });
    const chunk = Buffer.alloc(256 * 1024, 97); let sent = 0;
    const pump = () => { while (sent < 6 * 1024 * 1024) { sent += chunk.length; if (!s.write(chunk)) return s.once("drain", pump); } s.end(); };
    s.on("close", () => { routes.lastBigSent = sent; }); pump();
  },
  "/news.example/slow": () => { /* never answers */ },
};
for (const c of [401, 402, 403, 404, 410, 451, 500, 503]) routes[`/news.example/s${c}`] = (q, s) => { s.writeHead(c, { "content-type": "text/html" }); s.end("<html>no</html>"); };

test.before(async () => {
  srv = http.createServer((q, s) => { hits.push(q.url); (routes[q.url] || ((x, y) => { y.writeHead(404); y.end(); }))(q, s); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r)); port = srv.address().port;
});
test.after(() => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(); });

/** A fetch-compatible adapter: https://<host><path> is served by the local server at /<host><path> (plain node http, no proxy). */
function localFetch(url, init) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const q = http.request({ host: "127.0.0.1", port, path: `/${u.hostname}${u.pathname}`, method: "GET", headers: init && init.headers }, (res) => {
      const headers = new Headers(); for (const [k, v] of Object.entries(res.headers)) headers.set(k, Array.isArray(v) ? v.join(", ") : String(v));
      resolve({ status: res.statusCode, headers, url, body: Readable.toWeb(res) });
    });
    q.on("error", reject);
    if (init && init.signal) init.signal.addEventListener("abort", () => q.destroy(Object.assign(new Error("aborted"), { name: "AbortError" })));
    q.end();
  });
}
const get = (path, opts) => br.fetchArticle(`https://news.example${path}`, { fetchFn: localFetch, ...(opts || {}) });
const fails = async (p, code, check, opts) => {
  const at = hits.length;
  await assert.rejects(get(p, opts), (e) => { assert.strictEqual(e.code, code, `${p}: ${e.code} ${e.message}`); assert.strictEqual(e.detail.stage, "fetch"); if (check) check(e.detail, hits.slice(at)); return true; });
};

test("fetch: a plain HTML page is captured with its status, type, size, final URL and observed <title> (decoded, provenance only)", async () => {
  const p = await get("/a");
  assert.strictEqual(p.html.toString("utf8"), PAGE);
  assert.deepStrictEqual([p.httpStatus, p.contentType, p.bytes, p.finalUrl], [200, "text/html; charset=utf-8", Buffer.byteLength(PAGE), "https://news.example/a"]);
  assert.strictEqual(p.observedTitle, "Local housing & prices – Example Sentinel");
});

test("LF-05 same-site redirects (relative, and to www.) are followed and the final URL is recorded", async () => {
  assert.strictEqual((await get("/r301")).finalUrl, "https://news.example/a");
  assert.strictEqual((await get("/rwww")).finalUrl, "https://www.news.example/a");
});

test("LF-06 a redirect to another site is refused BEFORE the other site is requested", async () => {
  await fails("/away", "redirected_elsewhere", (d, seen) => { assert.deepStrictEqual(seen, ["/news.example/away"]); assert.strictEqual(d.httpStatus, 302); });
});

test("LF-07 a redirect loop stops at the hop limit; a redirect without a location fails; an https→http hop is refused", async () => {
  await fails("/loop", "too_many_redirects", (d, seen) => assert.strictEqual(seen.length, br.MAX_REDIRECTS + 1));
  await fails("/noloc", "fetch_failed");
  await fails("/tohttp", "bad_url", (d, seen) => assert.deepStrictEqual(seen, ["/news.example/tohttp"]));
});

test("LF-08/LF-09 every non-200 answer is http_error with its status (missing, gone, legal, server errors, hard paywalls, blocks)", async () => {
  for (const c of [401, 402, 403, 404, 410, 451, 500, 503]) await fails(`/s${c}`, "http_error", (d) => assert.strictEqual(d.httpStatus, c));
});

test("LF-11 non-HTML content is not_html (PDF, JSON, plain text)", async () => {
  for (const [p, ct] of [["/pdf", "application/pdf"], ["/json", "application/json"], ["/text", "text/plain"]]) await fails(p, "not_html", (d) => assert.strictEqual(d.contentType, ct));
});

test("LF-12 a declared size over 4 MB is too_large without reading the body", async () => {
  await fails("/big-declared", "too_large", (d) => assert.strictEqual(d.bytes, 5 * 1024 * 1024));
});

test("LF-13 an undeclared (chunked) body over 4 MB is too_large and the read stops at the limit", async () => {
  await fails("/big-chunked", "too_large", (d) => assert.strictEqual(d.bytes, 4000001, "the read stopped at the 4,000,000-byte limit"));
});

test("LF-14 no answer within the time limit is fetch_timeout", async () => {
  const t0 = Date.now();
  await fails("/slow", "fetch_timeout", null, { timeoutMs: 300 });
  assert.ok(Date.now() - t0 < 5000);
});

test("LF-15 only https on a public host name: http, IP literals, localhost, credentials, odd ports and junk are bad_url and never requested", async () => {
  const at = hits.length;
  for (const u of ["http://news.example/a", "https://127.0.0.1/a", "https://[::1]/a", "https://localhost/a", "https://user:pw@news.example/a",
    "https://news.example:8443/a", "https://intranet/a", "ftp://news.example/a", "not a url", ""]) {
    await assert.rejects(br.fetchArticle(u, { fetchFn: localFetch }), (e) => e.code === "bad_url" && e.detail.stage === "fetch", u);
  }
  assert.strictEqual(hits.length, at, "no request was sent");
  assert.ok(br.articleUrl("https://www.news.example/a?b=1") && br.articleUrl("https://news.example:443/a"));
});

test("LF-16 an empty 200 page is empty; a network error is fetch_failed", async () => {
  await fails("/empty", "empty", (d) => assert.strictEqual(d.bytes, 0));
  await assert.rejects(br.fetchArticle("https://news.example/a", { fetchFn: async () => { throw new Error("ECONNRESET"); } }), (e) => e.code === "fetch_failed");
});

test("a fetch source's own Stage B code is kept (the fixture worker's refusal), with stage fetch", async () => {
  const f = async () => { throw new br.StageBError("fixture_refused", "not a fixture"); };
  await assert.rejects(br.fetchArticle("https://news.example/a", { fetchFn: f }), (e) => e.code === "fixture_refused" && e.detail.stage === "fetch");
});

test("observedTitle: plain text only, bounded, null when absent", () => {
  assert.strictEqual(br.observedTitle(Buffer.from("<title> A <b>bold</b>\n title </title>")), "A bold title");
  assert.strictEqual(br.observedTitle("<html><body>none</body></html>"), null);
  assert.strictEqual(br.observedTitle(`<title>${"x".repeat(900)}</title>`).length, 500);
});

// The same scenarios through Node's REAL fetch (undici, as in the deployed functions): only the host is rewritten to the local server. This covers
// undici's manual-redirect responses, its streaming body, header handling and abort, which the plain-http adapter above does not.
function realFetch(url, init) {
  const u = new URL(url);
  return fetch(`http://127.0.0.1:${port}/${u.hostname}${u.pathname}`, init).then((r) => ({ status: r.status, headers: r.headers, body: r.body, url, arrayBuffer: () => r.arrayBuffer() }));
}
test("the fetch-stage cases hold with Node's real fetch (undici): redirects, codes, size limits, timeout", async () => {
  const g = (p, o) => br.fetchArticle(`https://news.example${p}`, { fetchFn: realFetch, ...(o || {}) });
  const code = async (p, c, o) => assert.rejects(g(p, o), (e) => e.code === c && e.detail.stage === "fetch", `${p} → ${c}`);
  assert.strictEqual((await g("/a")).observedTitle, "Local housing & prices – Example Sentinel");
  assert.strictEqual((await g("/r301")).finalUrl, "https://news.example/a");
  assert.strictEqual((await g("/rwww")).finalUrl, "https://www.news.example/a");
  const at = hits.length; await code("/away", "redirected_elsewhere"); assert.deepStrictEqual(hits.slice(at), ["/news.example/away"]);
  await code("/loop", "too_many_redirects");
  await code("/tohttp", "bad_url");
  for (const c of [403, 404, 451, 503]) await assert.rejects(g(`/s${c}`), (e) => e.code === "http_error" && e.detail.httpStatus === c);
  await code("/pdf", "not_html");
  await code("/big-declared", "too_large");
  await code("/big-chunked", "too_large");
  await code("/empty", "empty");
  await code("/slow", "fetch_timeout", { timeoutMs: 300 });
});
