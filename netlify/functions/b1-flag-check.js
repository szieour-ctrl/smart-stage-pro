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
//   GET → 200 { agentMarketingEnabled, runtime: { context, branch }, workerAuth: true|false|null, workerAuthCode, workerStatus }
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
      res.on("end", () => resolve({ status: res.statusCode, signature: String(res.headers["x-b1-response-signature"] || ""), body: Buffer.concat(parts) }));
    });
    req.setTimeout(PROBE_TIMEOUT_MS, () => { req.destroy(new Error("timeout")); });
    req.on("error", reject);
    req.end(body);
  });
}

/** One signed probe. → { workerAuth: true|false|null, workerAuthCode, workerStatus }. */
async function probeWorker(env, post) {
  let c;
  try { c = br.config(env); } catch (e) { return { workerAuth: null, workerAuthCode: "not_configured", workerStatus: null }; }
  if (c.transport !== "https") return { workerAuth: null, workerAuthCode: "not_configured", workerStatus: null };
  const body = Buffer.from(JSON.stringify({ url: PROBE_URL }), "utf8");
  const { ts, nonce, sig } = br.signRequest(c.secret, "POST", PROBE_PATH, body);
  let r;
  try {
    r = await (post || httpsPost)(c.url, PROBE_PATH, { "Content-Type": "application/json", "Content-Length": body.length, "X-B1-Timestamp": ts, "X-B1-Nonce": nonce, "X-B1-Signature": sig }, body);
  } catch (e) { return { workerAuth: null, workerAuthCode: "unreachable", workerStatus: null }; }
  const status = Number(r.status) || null;
  const want = br.replySignature(c.secret, nonce, r.status, r.body);
  const got = String(r.signature || "");
  const signed = got.length === want.length && require("crypto").timingSafeEqual(Buffer.from(got), Buffer.from(want));
  if (!signed) return { workerAuth: false, workerAuthCode: status === 401 ? "rejected_401_unsigned" : "unsigned_reply", workerStatus: status };
  let code = ""; try { code = String(JSON.parse(r.body.toString("utf8")).code || ""); } catch (e) { /* signed but not JSON */ }
  return { workerAuth: true, workerAuthCode: status === 404 && code === "not_in_fixture_allowlist" ? "accepted_not_in_allowlist" : "accepted_unexpected_reply", workerStatus: status };
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
  console.log(`b1-flag-check agentMarketingEnabled=${agentMarketingEnabled} workerAuth=${w.workerAuth} code=${w.workerAuthCode} status=${w.workerStatus} context=${runtime.context} branch=${runtime.branch}`);
  return { statusCode: 200, headers, body: JSON.stringify({ agentMarketingEnabled, runtime, ...w }) };
};

exports._internals = { BRANCH_HOST, DEV_URL, PROBE_URL, PROBE_PATH, switchOn, probeWorker };
