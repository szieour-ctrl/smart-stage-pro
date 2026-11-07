// b1-flag-check.js — Netlify Function. TEMPORARY, DEVELOPMENT ONLY (Nov 7, 2026). Remove after the hosted FA/FB/FC run.
// Two questions on the b1-stageb-dev branch deploy, answered without revealing any value:
//   1. agentMarketingEnabled: does AGENT_MARKETING_ENABLED (a Netlify secret variable, unreadable in the dashboard) evaluate to on at runtime, by
//      the same rule the feature uses (lib/agent-marketing-lib.js isEnabledFor: trimmed, case-insensitive "true")?
//   2. workerAuth: does the fixture worker accept this deploy's B1_WORKER_SECRET? One signed POST /v1/fixture/article for a deliberately
//      non-allowlisted URL under the reserved .invalid domain, so no article is served and no provider is involved.
//      Worker contract (ssp-b1-evidence src/stageb_worker.py + src/stageb_fixtures.py):
//        authenticated   → reply signed for THIS request's nonce (X-B1-Response-Signature); for this URL 404 {"code":"not_in_fixture_allowlist"}
//        unauthenticated → 401 (bad_signature / stale_or_future_timestamp / replayed / unauthenticated), NOT signed
//        unknown path    → 404 not_found, NOT signed
//      So a 404 alone proves nothing. workerAuth is true only when the reply signature verifies with our secret and our nonce, which a worker
//      holding a different secret cannot produce.
//   GET → 200 { agentMarketingEnabled, runtime: { context, branch }, workerAuth: true|false|null, workerAuthCode, workerStatus, workerRefusal,
//              clockSkewSec, deploy: { deployId, source }, secret: { present, length, hex64, ... }, stagebCaps: { perUserDay, globalDay } }
//        workerRefusal: the worker's own (unsigned, informational) refusal code; secret: the runtime value's length and character class only.
//        on the b1-stageb-dev branch deploy only; 404 everywhere else. workerAuth null = could not be checked (see workerAuthCode).
// Isolation: the request host must be the branch deploy host AND the functions must point at the development database. Netlify's CONTEXT and
// BRANCH are build-time values that may be absent inside functions at runtime, so, as in b1-env-check, a missing value is accepted and a
// present-but-different value is refused. runtime reports only "branch-deploy"/"b1-stageb-dev" when seen, otherwise "unset".
// It never returns or logs a secret, a URL, a signature or any other variable. The branch deploy is also behind Netlify team login.
"use strict";

const https = require("https");
const br = require("./lib/agent-marketing-b1-bridge-lib");

const BRANCH = "b1-stageb-dev";
const BRANCH_HOST = `${BRANCH}--smart-stage-pro.netlify.app`;
const CONTEXT = "branch-deploy";
const DEV_URL = "https://ooxigbxthabstahrexia.supabase.co";
const PROBE_PATH = "/v1/fixture/article";
const PROBE_URL = "https://b1-flag-check.invalid/not-a-fixture";   // reserved TLD: can never be on the fixture allowlist
const PROBE_TIMEOUT_MS = 10000;
// The worker's 401/503 refusal codes before authentication (ssp-b1-evidence src/stageb_worker.py).
const WORKER_REFUSALS = ["unauthenticated", "stale_or_future_timestamp", "bad_signature", "replayed", "replay_cache_full"];
const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const hostOf = (event) => String((event && event.headers && (event.headers.host || event.headers.Host)) || "").toLowerCase().replace(/:\d+$/, "");

/** Same rule as isEnabledFor's switch check in lib/agent-marketing-lib.js. */
const switchOn = (env) => String(env.AGENT_MARKETING_ENABLED || "").trim().toLowerCase() === "true";

/** POST over HTTPS; resolves { status, signature, body } (body as a Buffer). Never rejects on an HTTP status. */
function httpsPost(url, pathname, hdrs, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: url.hostname, port: url.port || 443, path: pathname, method: "POST", agent: false, headers: hdrs }, (res) => {
      const parts = []; let size = 0;
      res.on("data", (d) => { size += d.length; if (size <= 65536) parts.push(d); });
      res.on("end", () => resolve({ status: res.statusCode, signature: String(res.headers["x-b1-response-signature"] || ""), body: Buffer.concat(parts), date: String(res.headers.date || "") }));
    });
    req.setTimeout(PROBE_TIMEOUT_MS, () => { req.destroy(new Error("timeout")); });
    req.on("error", reject);
    req.end(body);
  });
}

/** One signed probe. → { workerAuth: true|false|null, workerAuthCode, workerStatus }. */
async function probeWorker(env, post) {
  let c;
  try { c = br.config(env); } catch (e) { return { workerAuth: null, workerAuthCode: "not_configured", workerStatus: null, workerRefusal: null, clockSkewSec: null }; }
  if (c.transport !== "https") return { workerAuth: null, workerAuthCode: "not_configured", workerStatus: null, workerRefusal: null, clockSkewSec: null };
  const body = Buffer.from(JSON.stringify({ url: PROBE_URL }), "utf8");
  const { ts, nonce, sig } = br.signRequest(c.secret, "POST", PROBE_PATH, body);
  let r;
  try {
    r = await (post || httpsPost)(c.url, PROBE_PATH, { "Content-Type": "application/json", "Content-Length": body.length, "X-B1-Timestamp": ts, "X-B1-Nonce": nonce, "X-B1-Signature": sig }, body);
  } catch (e) { return { workerAuth: null, workerAuthCode: "unreachable", workerStatus: null, workerRefusal: null, clockSkewSec: null }; }
  const status = Number(r.status) || null;
  const want = br.replySignature(c.secret, nonce, r.status, r.body);
  const got = String(r.signature || "");
  const signed = got.length === want.length && require("crypto").timingSafeEqual(Buffer.from(got), Buffer.from(want));
  // Worker clock vs ours (whole seconds, from the reply's Date header): the worker refuses timestamps outside its CLOCK_SKEW window.
  const wd = Date.parse(String(r.date || "")), clockSkewSec = Number.isFinite(wd) ? Math.round((wd - Date.now()) / 1000) : null;
  if (!signed) {
    // An unsigned reply cannot be trusted, but the worker's own refusal code says WHICH check failed (informational; fixed set only).
    let reason = null; try { reason = String(JSON.parse(r.body.toString("utf8")).code || ""); } catch (e) { /* not JSON */ }
    if (!WORKER_REFUSALS.includes(reason)) reason = reason ? "other" : null;
    return { workerAuth: false, workerAuthCode: status === 401 ? "rejected_401_unsigned" : "unsigned_reply", workerStatus: status, workerRefusal: reason, clockSkewSec };
  }
  let code = ""; try { code = String(JSON.parse(r.body.toString("utf8")).code || ""); } catch (e) { /* signed but not JSON */ }
  return { workerAuth: true, workerAuthCode: status === 404 && code === "not_in_fixture_allowlist" ? "accepted_not_in_allowlist" : "accepted_unexpected_reply", workerStatus: status, workerRefusal: null, clockSkewSec };
}

/** The shape of the runtime B1_WORKER_SECRET, never the value nor anything derived from it beyond its length and character class. */
function secretShape(env) {
  const v = env.B1_WORKER_SECRET;
  if (v === undefined) return { present: false };
  const s = String(v);
  return { present: true, length: s.length, hex64: /^[0-9a-f]{64}$/.test(s), hexAnyCase64: /^[0-9a-fA-F]{64}$/.test(s), edgeWhitespace: s !== s.trim(),
    innerWhitespace: /\s/.test(s.trim()), quoted: /^["']|["']$/.test(s), unresolvedReference: /\$\{|\{\{|\}\}/.test(s), nonPrintable: /[^\x21-\x7e]/.test(s.trim()) };
}

/** Which deploy is answering: Netlify's x-nf-deploy-id request header, else the id in DEPLOY_URL. Deploy ids are public identifiers. */
function deployOf(event, env) {
  const h = (event && event.headers) || {};
  const fromHeader = String(h["x-nf-deploy-id"] || h["X-Nf-Deploy-Id"] || "");
  if (/^[0-9a-f]{24}$/.test(fromHeader)) return { deployId: fromHeader, source: "header" };
  const m = /^https:\/\/([0-9a-f]{24})--/.exec(String(env.DEPLOY_URL || ""));
  return m ? { deployId: m[1], source: "DEPLOY_URL" } : { deployId: null, source: "unavailable" };
}

exports.handler = async (event, context, deps) => {
  const d = deps || {};
  const env = d.env || process.env;
  const notFound = { statusCode: 404, headers, body: JSON.stringify({ error: "Not found" }) };
  if (hostOf(event) !== BRANCH_HOST) return notFound;
  if (env.CONTEXT && env.CONTEXT !== CONTEXT) return notFound;
  if (env.BRANCH && env.BRANCH !== BRANCH) return notFound;
  if (env.SUPABASE_URL !== DEV_URL) return notFound;   // never answers against the production (or any other) database
  const agentMarketingEnabled = switchOn(env);
  const runtime = { context: env.CONTEXT ? CONTEXT : "unset", branch: env.BRANCH ? BRANCH : "unset" };
  const w = await probeWorker(env, d.post);
  const deploy = deployOf(event, env), secret = secretShape(env);
  const stagebCaps = require("./lib/agent-marketing-b1-stageb-run-lib").caps(env);   // the limits the Stage B job applies: { perUserDay, globalDay }
  console.log(`b1-flag-check agentMarketingEnabled=${agentMarketingEnabled} workerAuth=${w.workerAuth} code=${w.workerAuthCode} status=${w.workerStatus} refusal=${w.workerRefusal} skew=${w.clockSkewSec} deploy=${deploy.deployId} secretLen=${secret.length} hex64=${secret.hex64}`);
  return { statusCode: 200, headers, body: JSON.stringify({ agentMarketingEnabled, runtime, ...w, deploy, secret, stagebCaps }) };
};

exports._internals = { BRANCH_HOST, DEV_URL, PROBE_URL, PROBE_PATH, WORKER_REFUSALS, switchOn, probeWorker, secretShape, deployOf };
