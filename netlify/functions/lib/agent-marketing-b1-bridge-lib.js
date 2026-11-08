// lib/agent-marketing-b1-bridge-lib.js — Netlify (shared). DEVELOPMENT ONLY (Nov 5, 2026). Stage B: article snapshot, Python B1 gate bridge, persistence flow.
//
//   selected article ──plain fetch──> raw HTML ──bridge "snapshot" (Python extract_v2 + B1 wrapper)──> snapshot + exact B1 input + request
//        ──[B1 provider call: NOT implemented; offline tests pass a saved response]──> raw response
//        ──bridge "gate" (Python output_gate + export: authoritative)──> ssp-b1-evidence/1 bundle ──> stored record ──> stageb.topicWithEvidence
//
// The Python B1 code stays authoritative for extraction, quotation verification, recovery, review, validated/held/excluded, completeness, hashes and
// the audit chain. This file only spawns it from the SERVER (never reachable from a browser: no handler exports, nothing reads a request) and then
// re-checks every reply independently, failing closed. Requires AGENT_MARKETING_B1_EVIDENCE=dev and either B1_WORKER_URL + B1_WORKER_SECRET (the
// private HTTPS worker: signed requests and replies) or B1_WORKSPACE (a local child process, development only).
// No Perplexity fetch_url. No paid call anywhere in this file.
"use strict";

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const https = require("https");
const net = require("net");
const crypto = require("crypto");
const b1 = require("./agent-marketing-b1-evidence-lib");
const sb = require("./agent-marketing-b1-stageb-lib");

const BEGIN = "=====BEGIN RETRIEVED TEXT=====\n", END = "\n=====END RETRIEVED TEXT=====";
const MAX_HTML = 4000000, FETCH_TIMEOUT_MS = 20000, BRIDGE_TIMEOUT_MS = 60000;
// detail (live-fetch milestone): { stage: "fetch"|"snapshot"|"compare", httpStatus, contentType, bytes, finalUrl, observedTitle, rawHtmlSha256,
// snapshotSha256 }: what the durable attempt log may record about a capture that produced no evidence row. Never HTML, text or a credential.
class StageBError extends Error { constructor(code, message, detail) { super(message); this.code = code; this.detail = detail || null; } }
const fail = (code, msg, detail) => { throw new StageBError(code, msg, detail); };

function config(env) {
  const e = env || process.env;
  if (!b1.enabled(e)) fail("disabled", "Stage B is development-only and switched off");
  const url = String(e.B1_WORKER_URL || "");
  if (url) {   // the private HTTPS worker (src/stageb_worker.py in the B1 workspace)
    let u; try { u = new URL(url); } catch (x) { fail("not_configured", "B1_WORKER_URL is not a URL"); }
    if (u.protocol !== "https:") fail("not_configured", "B1_WORKER_URL must be https");
    const secret = String(e.B1_WORKER_SECRET || "");
    if (Buffer.byteLength(secret) < 32) fail("not_configured", "B1_WORKER_SECRET must be at least 32 bytes");
    return { transport: "https", url: u, secret, caFile: String(e.B1_WORKER_CA_FILE || "") };
  }
  const ws = String(e.B1_WORKSPACE || "");
  if (!ws) fail("not_configured", "neither B1_WORKER_URL nor B1_WORKSPACE is set");
  return { transport: "spawn", python: String(e.B1_BRIDGE_PYTHON || "python3"), script: path.join(ws, "src", "stageb_bridge.py") };
}

// Worker signing (must match src/stageb_worker.py): request "b1-stageb-req/1\n{METHOD}\n{PATH}\n{TS}\n{NONCE}\n{sha256(body)}",
// reply "b1-stageb-res/1\n{NONCE}\n{STATUS}\n{sha256(reply)}", both HMAC-SHA256 with the dedicated B1_WORKER_SECRET.
const MAX_REPLY = 16 * 1024 * 1024;
const hmacHex = (secret, msg) => crypto.createHmac("sha256", secret).update(msg, "utf8").digest("hex");
const sha256Hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
function signRequest(secret, method, pathname, body, now) {
  const ts = String(Math.floor((now || Date.now()) / 1000)), nonce = crypto.randomBytes(18).toString("base64url");
  return { ts, nonce, sig: hmacHex(secret, `b1-stageb-req/1\n${method}\n${pathname}\n${ts}\n${nonce}\n${sha256Hex(body)}`) };
}
const replySignature = (secret, nonce, status, buf) => hmacHex(secret, `b1-stageb-res/1\n${nonce}\n${status}\n${sha256Hex(buf)}`);

/** One op on the private HTTPS worker. Rejects unless the reply is 200 and carries a valid signature for THIS request's nonce. */
function callWorker(c, op, payload, timeoutMs) {
  const pathname = `/v1/${op}`;
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const { ts, nonce, sig } = signRequest(c.secret, "POST", pathname, body);
  const ca = c.caFile ? fs.readFileSync(c.caFile) : undefined;
  return new Promise((resolve, reject) => {
    let done = false;
    const settle = (fn, v) => { if (!done) { done = true; fn(v); } };
    const req = https.request({ hostname: c.url.hostname, port: c.url.port || 443, path: pathname, method: "POST", ca, agent: false,
      servername: net.isIP(c.url.hostname) ? undefined : c.url.hostname,
      headers: { "Content-Type": "application/json", "Content-Length": body.length, "X-B1-Timestamp": ts, "X-B1-Nonce": nonce, "X-B1-Signature": sig } }, (res) => {
      const parts = []; let size = 0;
      res.on("data", (d) => { size += d.length; if (size > MAX_REPLY) { settle(reject, new StageBError("bridge_error", "the B1 worker reply is too large")); req.destroy(); } else parts.push(d); });
      res.on("end", () => {
        const buf = Buffer.concat(parts);
        const got = String(res.headers["x-b1-response-signature"] || "");
        const want = replySignature(c.secret, nonce, res.statusCode, buf);
        if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return settle(reject, new StageBError("bridge_auth", `the B1 worker reply is not signed for this request (HTTP ${res.statusCode})`));
        if (res.statusCode !== 200) return settle(reject, new StageBError("bridge_error", `the B1 worker answered HTTP ${res.statusCode}`));
        let j = null; try { j = JSON.parse(buf.toString("utf8")); } catch (x) { /* below */ }
        if (!j || typeof j !== "object") return settle(reject, new StageBError("bridge_error", "the B1 worker returned no JSON"));
        settle(resolve, j);
      });
    });
    req.setTimeout(timeoutMs || BRIDGE_TIMEOUT_MS, () => { settle(reject, new StageBError("bridge_timeout", "the B1 worker timed out")); req.destroy(); });
    req.on("error", (e) => settle(reject, new StageBError("bridge_unavailable", `could not reach the B1 worker: ${e.code || e.message}`)));
    req.end(body);
  });
}

/** Run one bridge op: on the private HTTPS worker when B1_WORKER_URL is set, otherwise in a local child Python process (isolated mode,
 *  minimal environment). Rejects on timeout, non-JSON, an unsigned or wrongly signed worker reply, or a bridge fault. The caller ALWAYS
 *  re-checks the reply (checkSnapshot / checkGate), whichever transport answered. */
async function callBridge(op, payload, env, timeoutMs) {
  const c = config(env);
  if (c.transport === "https") return callWorker(c, op, payload, timeoutMs);
  return new Promise((resolve, reject) => {
    const child = spawn(c.python, ["-I", c.script], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH || "/usr/bin:/bin" } });
    let out = "", errText = "";
    const t = setTimeout(() => { child.kill("SIGKILL"); reject(new StageBError("bridge_timeout", "the B1 bridge timed out")); }, timeoutMs || BRIDGE_TIMEOUT_MS);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { errText += d; });
    child.on("error", (e) => { clearTimeout(t); reject(new StageBError("bridge_unavailable", `could not start the B1 bridge: ${e.code || e.message}`)); });
    child.on("close", () => {
      clearTimeout(t);
      let j = null; try { j = JSON.parse(out); } catch (e) { /* handled below */ }
      if (!j || typeof j !== "object") return reject(new StageBError("bridge_error", "the B1 bridge returned no JSON"));
      resolve(j);
    });
    child.stdin.end(JSON.stringify({ ...payload, op }));
  });
}

/** The selected article: the topic's first non-background source. */
/**
 * DEVELOPMENT FIXTURE MODE (Nov 7, 2026). B1_SNAPSHOT_SOURCE=worker-fixture replaces the live article GET with the private worker's signed
 * /v1/fixture/article endpoint, which answers ONLY for the three frozen Article-Led cases (FA, FB, FC) and returns their approved raw HTML byte for
 * byte (src/stageb_fixtures.py, Dockerfile.fixtures). No live article is fetched. Needs the Stage B flag (config() refuses otherwise) and the HTTPS
 * worker. Returns a fetch-compatible function for fetchArticle, or null when the setting is absent (normal live fetch).
 */
function fixtureSource(env) {
  const e = env || process.env;
  if (String(e.B1_SNAPSHOT_SOURCE || "").trim().toLowerCase() !== "worker-fixture") return null;
  const c = config(e);
  if (c.transport !== "https") fail("not_configured", "B1_SNAPSHOT_SOURCE=worker-fixture needs B1_WORKER_URL (the private fixture worker)");
  return async (url) => {
    let j;
    try { j = await callWorker(c, "fixture/article", { url }); }   // signed both ways; a URL outside the allowlist answers a signed 404
    catch (e) { if (e && e.code === "bridge_error" && /HTTP 404\b/.test(String(e.message))) fail("fixture_refused", "the article is not one of the frozen fixture cases"); throw e; }
    if (!j || j.ok !== true || typeof j.html_b64 !== "string") fail("fixture_refused", "the fixture worker returned no article");
    const buf = Buffer.from(j.html_b64, "base64");
    if (sha256Hex(buf) !== j.html_sha256) fail("fixture_inconsistent", "the fixture article does not match its hash");
    return { status: 200, url: String(j.final_url || url), headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? String(j.content_type || "") : null) },
      arrayBuffer: async () => buf };
  };
}

function articleOf(topic) {
  const s = (topic && Array.isArray(topic.sources) ? topic.sources : []).find((x) => x && x.role !== "background" && /^https?:\/\//.test(String(x.url || "")));
  return s ? { url: String(s.url), title: String(s.title || "") } : null;
}

// Live fetch limits (live-fetch milestone, Nov 8, 2026).
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const siteOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch (e) { return ""; } };

/** The article URL rule: https only, a DNS name (no IP literal, no localhost), no credentials, the default port. Returns a URL or null. */
function articleUrl(raw) {
  let u; try { u = new URL(String(raw || "")); } catch (e) { return null; }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null;
  const h = u.hostname.toLowerCase();
  if (!h || h === "localhost" || h.endsWith(".localhost") || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":") || h.startsWith("[") || !h.includes(".")) return null;
  return u;
}

/** The page's <title>, as observed provenance only (never used in a request). Plain text, whitespace collapsed, at most 500 characters. */
function observedTitle(html) {
  const m = /<title[^>]*>([\s\S]{0,4000}?)<\/title>/i.exec(Buffer.isBuffer(html) ? html.subarray(0, 262144).toString("utf8") : String(html || "").slice(0, 262144));
  if (!m) return null;
  const ents = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "\u2013", mdash: "\u2014", rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201d", ldquo: "\u201c" };
  const t = m[1].replace(/<[^>]*>/g, "").replace(/&#x([0-9a-f]+);/gi, (x, h) => { const n = parseInt(h, 16); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ""; })
    .replace(/&#(\d+);/g, (x, d) => { const n = Number(d); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ""; })
    .replace(/&([a-z]+);/gi, (x, n) => (ents[n.toLowerCase()] !== undefined ? ents[n.toLowerCase()] : x)).replace(/\s+/g, " ").trim();
  return t ? t.slice(0, 500) : null;
}

/** Read a response body with a hard cap: stops (and cancels the stream) as soon as more than max bytes arrived. → Buffer, or null when over. */
async function readCapped(r, max) {
  if (r.body && typeof r.body.getReader === "function") {
    const reader = r.body.getReader(); const parts = []; let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > max) { try { await reader.cancel(); } catch (e) { /* already closed */ } return null; }
      parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts);
  }
  const buf = Buffer.from(await r.arrayBuffer());   // fetch-compatible stubs (fixture source, tests) without a stream
  return buf.length > max ? null : buf;
}

/**
 * Plain server-side GET of the article's HTML (no provider, no retry with another page). Redirects are followed by hand (at most 5), each hop
 * must stay https on the same site, so a cross-site hop is refused BEFORE it is requested. Explicit failure codes, each with stage "fetch":
 *   bad_url, fetch_timeout, fetch_failed, too_many_redirects, redirected_elsewhere, http_error (+ httpStatus), not_html, empty, too_large.
 * Returns { html, finalUrl, retrievedAt, httpStatus, contentType, bytes, observedTitle }.
 */
async function fetchArticle(url, { fetchFn, now, timeoutMs, maxBytes } = {}) {
  const f = fetchFn || fetch;
  const max = maxBytes || MAX_HTML;
  const d = { stage: "fetch", httpStatus: null, contentType: null, bytes: null, finalUrl: null };
  const start = articleUrl(url);
  if (!start) fail("bad_url", "the article URL must be https on a public host name (no IP address, credentials or custom port)", d);
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs || FETCH_TIMEOUT_MS);
  try {
    let current = start.href, r = null;
    for (let hop = 0; ; hop++) {
      try { r = await f(current, { redirect: "manual", signal: ac.signal, headers: { accept: "text/html,application/xhtml+xml" } }); }
      catch (e) {
        d.finalUrl = current;
        if (ac.signal.aborted) fail("fetch_timeout", "the article did not answer in time", d);
        if (e instanceof StageBError) { e.detail = { ...d, ...(e.detail || {}), stage: "fetch" }; throw e; }   // a fetch source's own code (fixture worker)
        fail("fetch_failed", "the article could not be fetched", d);
      }
      if (!r) { d.finalUrl = current; fail("fetch_failed", "the article returned no response", d); }
      if (!REDIRECT_STATUSES.has(r.status)) break;
      d.httpStatus = r.status;
      const loc = r.headers && r.headers.get ? r.headers.get("location") : null;
      let next = null; try { next = loc ? new URL(loc, current).href : null; } catch (e) { next = null; }
      try { if (r.body && r.body.cancel) await r.body.cancel(); } catch (e) { /* nothing to release */ }
      if (!next) { d.finalUrl = current; fail("fetch_failed", "a redirect had no usable location", d); }
      if (siteOf(next) !== siteOf(start.href)) { d.finalUrl = current; fail("redirected_elsewhere", `the article redirected to another site (${siteOf(next)})`, d); }
      if (!articleUrl(next)) { d.finalUrl = current; fail("bad_url", "the article redirected to a URL that is not https on a public host name", d); }
      if (hop + 1 > MAX_REDIRECTS) { d.finalUrl = current; fail("too_many_redirects", `more than ${MAX_REDIRECTS} redirects`, d); }
      current = next;
    }
    // A fetch-compatible source that resolves redirects itself (the fixture worker) reports the final URL in r.url; it must stay on the site.
    const finalUrl = String((r.url && siteOf(r.url) === siteOf(current)) ? r.url : current);
    if (r.url && siteOf(r.url) !== siteOf(current)) { d.finalUrl = String(r.url); fail("redirected_elsewhere", `the article redirected to another site (${siteOf(r.url)})`, d); }
    d.finalUrl = finalUrl; d.httpStatus = r.status;
    const ct = String((r.headers && r.headers.get && r.headers.get("content-type")) || "");
    d.contentType = ct ? ct.slice(0, 200) : null;
    if (r.status !== 200) fail("http_error", `the article returned HTTP ${r.status}`, d);
    if (!/\bx?html\b/i.test(ct)) fail("not_html", `the article is not HTML (${ct || "no content type"})`, d);
    const len = Number(r.headers && r.headers.get && r.headers.get("content-length"));
    if (Number.isFinite(len) && len > max) { d.bytes = len; try { if (r.body && r.body.cancel) await r.body.cancel(); } catch (e) { /* ignore */ } fail("too_large", `the article is over ${Math.round(max / 1048576)} MB`, d); }
    let buf;
    try { buf = await readCapped(r, max); }
    catch (e) { if (ac.signal.aborted) fail("fetch_timeout", "the article did not finish in time", d); fail("fetch_failed", "the article body could not be read", d); }
    if (buf === null) { d.bytes = max + 1; fail("too_large", `the article is over ${Math.round(max / 1048576)} MB`, d); }
    d.bytes = buf.length;
    if (!buf.length) fail("empty", "the article returned no content", d);
    return { html: buf, finalUrl, retrievedAt: (now ? new Date(now) : new Date()).toISOString(), httpStatus: r.status, contentType: d.contentType,
      bytes: buf.length, observedTitle: observedTitle(buf) };
  } finally { clearTimeout(t); }
}

/** Independently re-check a snapshot reply from the bridge (never trust it). Returns the checked snapshot. */
function checkSnapshot(s, expectedExtractor) {
  // The worker's "inaccessible" (a script, robot-check, paywall-like or error page) is reported as capture_blocked, so it cannot be confused
  // with a fetch failure; every snapshot refusal carries stage "snapshot".
  if (!s || s.ok !== true) {
    const c = s && s.code ? (s.code === "inaccessible" ? "capture_blocked" : String(s.code)) : "snapshot_refused";
    fail(c, (s && s.message) || "the snapshot was refused", { stage: "snapshot", rawHtmlSha256: s && /^[0-9a-f]{64}$/.test(String(s.raw_html_sha256 || "")) ? s.raw_html_sha256 : null });
  }
  const p = [];
  if (sb.sha(s.snapshot_text) !== s.snapshot_sha256) p.push("snapshot hash");
  if (sb.sha(s.input) !== s.input_sha256) p.push("input hash");
  if (!String(s.input).includes(`${BEGIN}${s.snapshot_text}${END}`)) p.push("input does not carry the snapshot");
  if (sb.sha(s.request_text) !== s.request_sha256) p.push("request hash");
  let req = null; try { req = JSON.parse(s.request_text); } catch (e) { p.push("request not JSON"); }
  if (req) {
    if (req.input !== s.input) p.push("request input differs from the snapshot input");
    if (sb.sha(String(req.instructions)) !== sb.APPROVED_B1.instructions_sha256) p.push("request does not use the approved B1 prompt");
    if (req.model !== sb.APPROVED_B1.model || req.max_output_tokens !== sb.APPROVED_B1.max_output_tokens || !req.reasoning || req.reasoning.effort !== sb.APPROVED_B1.reasoning_effort) p.push("request settings");
  }
  if (s.extractor !== (expectedExtractor || sb.APPROVED_B1.extractor) || !sb.EXTRACTORS.includes(s.extractor)) p.push("extractor");
  if (p.length) fail("snapshot_inconsistent", `snapshot failed independent checks: ${p.join(", ")}`, { stage: "snapshot" });
  return s;
}

/** Independently re-check a gate reply against the record it was run for. Returns the bundle doc. */
function checkGate(g, record, responseText) {
  if (!g || g.ok !== true || !g.bundle) fail("gate_refused", (g && g.message) || "the B1 gate returned no bundle");
  const v = b1.readBundle(g.bundle);
  const p = [];
  if (sb.sha(responseText) !== g.raw_response_sha256 || g.raw_response_sha256 !== record.raw_response_sha256) p.push("raw response hash");
  if (g.request_sha256 !== sb.sha(record.request_text)) p.push("request hash");
  if (g.completeness_status !== v.status) p.push("completeness status");
  if (v.status !== b1.BLOCKED) {
    if (v.provenance.input_sha256 !== record.input_sha256) p.push("bundle input");
    if (v.provenance.raw_response_sha256 !== record.raw_response_sha256) p.push("bundle raw response");
  }
  if (p.length) fail("gate_inconsistent", `gate reply failed independent checks: ${p.join(", ")}`);
  return g.bundle;
}

/** The attempt-log detail of a capture (hashes, URL, status, type, size, observed title). Never HTML or text. */
function captureDetail(page, snap, stage) {
  return { stage, httpStatus: page ? page.httpStatus || null : null, contentType: page ? page.contentType || null : null, bytes: page ? page.bytes || null : null,
    finalUrl: page ? page.finalUrl : null, observedTitle: page ? page.observedTitle || null : null,
    rawHtmlSha256: snap && /^[0-9a-f]{64}$/.test(String(snap.raw_html_sha256 || "")) ? snap.raw_html_sha256 : null,
    snapshotSha256: snap && /^[0-9a-f]{64}$/.test(String(snap.snapshot_sha256 || "")) ? snap.snapshot_sha256 : null };
}

/**
 * capture({ art, fetchFn, env, now }) → { page, snap, key }: live fetch (or the fixture source), the worker snapshot, the independent re-check.
 * The request title is ALWAYS the selected topic's source title (art.title, authoritative for this milestone); the fetched page's <title> is
 * only recorded as observed provenance (page.observedTitle). Errors carry detail.stage "fetch" or "snapshot".
 */
async function capture({ art, fetchFn, env, now }) {
  const page = await fetchArticle(art.url, { fetchFn, now });
  let snap;
  try {
    const extractor = sb.extractorFor(env);
    snap = checkSnapshot(await callBridge("snapshot", { url: page.finalUrl, title: art.title, html_b64: page.html.toString("base64"), retrieved_at: page.retrievedAt, extractor }, env), extractor);
  } catch (e) {
    const err = e instanceof StageBError ? e : new StageBError("bridge_error", "the snapshot could not be taken");
    err.detail = { ...captureDetail(page, null, "snapshot"), ...(err.detail && err.detail.rawHtmlSha256 ? { rawHtmlSha256: err.detail.rawHtmlSha256 } : {}) };
    throw err;
  }
  return { page, snap, key: sb.approvedKey(snap.snapshot_sha256, snap.extractor) };
}

/**
 * Step 1: capture (or reuse) the snapshot for the project's selected article and reserve the B1 run.
 * store: { findForProject(projectId, topicId), findLive(cacheKey), insert(row), update(id, fields, expectStatus) } (lib/agent-marketing-b1-store-lib.js;
 * the proposed migration enforces at most one reserved/running row per cache key overall and one ready row per project, key and gate version).
 * Returns { record, reused }. Reuse: a live record with the same cache key (same snapshot text and approved settings) is used, so B1 is never run
 * twice for unchanged input. A project whose stored snapshot differs from a new capture is NOT silently switched: code source_changed.
 */
async function prepare({ project, userId, store, fetchFn, env, now }) {
  const t = project && project.selected_topic;
  if (!t || !t.candidate) fail("not_article_led", "the project has no selected Article-Led topic");
  const art = articleOf(t);
  if (!art) fail("no_article", "the selected topic has no article URL");
  const found = await store.findForProject(project.id, sb.topicKeyOf(t), t.researchId);   // topic ids repeat across research sets (Nov 8, 2026)
  const existing = found && found.status !== "failed" ? found : null;   // a failed run never blocks a retry (migration R4)
  const { page, snap, key } = await capture({ art, fetchFn, env, now });
  if (existing && existing.cache_key !== key) fail("source_changed", "the article changed since its snapshot was taken; a new snapshot needs an explicit decision",
    { ...captureDetail(page, snap, "compare"), comparedTo: existing.status === "ready" ? existing.id : null });
  if (existing) return { record: existing, reused: existing.status === "ready" };   // a reserved row is resumed, not duplicated (idempotent retry)
  const live = await store.findLive(key);
  const base = { user_id: userId, project_id: project.id, research_id: t.researchId, topic_id: sb.topicKeyOf(t), source_url: art.url, final_url: page.finalUrl,
    snapshot_retrieved_at: page.retrievedAt, raw_html_sha256: snap.raw_html_sha256, extractor_sha256: snap.extractor_sha256, bridge_version: snap.bridge, capture_flags: snap.flags };
  if (live && live.status !== "ready") fail("in_progress", "a B1 run for this exact article and settings is already in progress; try again when it finishes");
  if (live) {   // no new B1 call: copy the completed result (its own snapshot, request, raw response and bundle) to this project
    const { id, created_at, reserved_at, finished_at, cost_usd, error, provider_seq, provider_reservation_id, ...copy } = live;   // a copy makes no call: no ledger link
    return { record: await store.insert({ ...copy, ...base, status: "ready", reused_from: id }), reused: true };
  }
  const row = { ...base, ...sb.APPROVED_B1, extractor: snap.extractor, snapshot_text: snap.snapshot_text, snapshot_sha256: snap.snapshot_sha256, input_sha256: snap.input_sha256,
    request_text: snap.request_text, request_sha256: snap.request_sha256, cache_key: key, status: "reserved" };
  return { record: await store.insert(row), reused: false };
}

/** Step 3 (after the provider call, or a saved response offline): gate the raw response through the Python bridge and complete the record.
 *  The record must still be in the state it was claimed in (Stage B claims it as "running" after its ledger reservation; offline tools may
 *  complete a "reserved" row directly), and the update is conditional on that state, so two workers can never both complete one run.
 *  A BLOCKED gate result is stored for audit and finishes the row as "failed" (evidence_blocked): it is never "ready". */
async function complete({ record, responseText, store, env }) {
  if (!record || !["reserved", "running"].includes(record.status)) fail("not_reserved", "only a reserved or running record can be completed");
  const withRaw = { ...record, raw_response_text: responseText, raw_response_sha256: sb.sha(responseText) };
  const g = await callBridge("gate", { request_text: record.request_text, response_text: responseText }, env);
  const bundle = checkGate(g, withRaw, responseText);
  const blocked = g.completeness_status === b1.BLOCKED;
  return store.update(record.id, { raw_response_text: responseText, raw_response_sha256: withRaw.raw_response_sha256, gate_version: g.gate_version,
    bundle, completeness_status: g.completeness_status, cost_usd: require("./agent-marketing-b1-provider-lib").reportedCost(responseText), status: blocked ? "failed" : "ready", ...(blocked ? { error: "evidence_blocked" } : {}),
    finished_at: new Date().toISOString() }, record.status);
}

module.exports = { StageBError, callBridge, callWorker, fixtureSource, signRequest, replySignature, articleOf, articleUrl, observedTitle, fetchArticle, capture, captureDetail,
  checkSnapshot, checkGate, prepare, complete, config, MAX_REDIRECTS };
