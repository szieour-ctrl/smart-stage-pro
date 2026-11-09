// lib/agent-marketing-b1-provider-lib.js — Netlify (shared). DEVELOPMENT ONLY (Nov 5, 2026). The B1 provider used by Stage B.
//
// ONLY mocks exist (B1_PROVIDER=mock, or worker-fixture: the private fixture worker's saved FA/FB/FC responses). The live B1 provider call is NOT implemented: it is paid and needs separate approval. createProvider() returns:
//   - B1_PROVIDER=mock: a provider that answers with a SAVED raw B1 response looked up by the sha256 of the exact request text (offline fixtures:
//     a directory of <request_sha256>.response.json files, B1_MOCK_RESPONSES_DIR, or an in-memory map passed by tests). No network, no key, no cost.
//   - anything else: throws ProviderError("provider_not_implemented"). Stage B then marks the run failed; nothing is sent anywhere.
// The mock is refused unless AGENT_MARKETING_B1_EVIDENCE=dev.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const b1 = require("./agent-marketing-b1-evidence-lib");

class ProviderError extends Error { constructor(code, message) { super(message); this.code = code; } }
const sha = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");

function createProvider({ env, responses } = {}) {
  const e = env || process.env;
  if (!b1.enabled(e)) throw new ProviderError("disabled", "Stage B is development-only and switched off");
  const kind = String(e.B1_PROVIDER || "").trim().toLowerCase();
  if (kind === "worker-fixture") return workerFixtureProvider(e);
  if (kind === "live") return liveProvider(e);
  if (kind !== "mock") throw new ProviderError("provider_not_implemented", "no B1 provider is configured (B1_PROVIDER=live is paid and needs explicit approval)");
  const dir = String(e.B1_MOCK_RESPONSES_DIR || "");
  if (!responses && !dir) throw new ProviderError("not_configured", "B1_PROVIDER=mock needs saved responses (B1_MOCK_RESPONSES_DIR)");
  return {
    name: "mock", paid: false, calls: 0,
    /** call({ requestText }) → the saved raw response text for exactly this request. */
    async call({ requestText }) {
      this.calls += 1;
      const key = sha(requestText);
      if (responses) { if (responses.has(key)) return responses.get(key); throw new ProviderError("mock_no_response", "no saved B1 response for this exact request"); }
      const f = path.join(dir, `${key}.response.json`);
      if (!/^[0-9a-f]{64}$/.test(key) || !fs.existsSync(f)) throw new ProviderError("mock_no_response", "no saved B1 response for this exact request");
      return fs.readFileSync(f, "utf8");
    },
  };
}

/**
 * B1_PROVIDER=worker-fixture (development fixture mode, Nov 7, 2026): the saved raw B1 response for EXACTLY one of the three frozen FA/FB/FC requests,
 * from the private fixture worker's signed /v1/fixture/provider endpoint (keyed by the request's sha256). Any other request has no response and the
 * run fails with mock_no_response. No network beyond the private worker, no key, no cost.
 */
function workerFixtureProvider(e) {
  const br = require("./agent-marketing-b1-bridge-lib");
  let c;
  try { c = br.config(e); } catch (x) { throw new ProviderError("not_configured", x.message); }
  if (c.transport !== "https") throw new ProviderError("not_configured", "B1_PROVIDER=worker-fixture needs B1_WORKER_URL (the private fixture worker)");
  return {
    name: "worker-fixture", paid: false, calls: 0,
    async call({ requestText }) {
      this.calls += 1;
      let j;
      try { j = await br.callWorker(c, "fixture/provider", { request_sha256: sha(requestText) }); }
      catch (x) { throw new ProviderError("mock_no_response", "no saved B1 response for this exact request"); }
      if (!j || j.ok !== true || typeof j.response_text !== "string" || sha(j.response_text) !== j.response_sha256) throw new ProviderError("mock_inconsistent", "the saved B1 response does not match its hash");
      return j.response_text;
    },
  };
}

/**
 * B1_PROVIDER=live (Nov 8, 2026): the PAID B1 call, exactly as the approved v1.2.1 runs made it (frozen/runner/run_b1_baseline.mjs in the private
 * workspace): the stored request body is POSTed byte for byte to B1_ENDPOINT (a Responses-style URL) with Authorization: Bearer B1_API_KEY,
 * 120 s timeout. Accepted only when the answer is HTTP 200 with status "completed"; the raw response text is returned for the evidence gate.
 * Configured only by the server environment, development only (Stage B admission refuses the production database), and always behind Stage B's
 * ledger reservation and its per-user / global daily caps, which run before any call. Turning it on is an owner decision (paid).
 */
// The approved B1 v1.2.1 calls ran on the Perplexity Agent API. SSP's research already holds a server-side Perplexity key (PERPLEXITY_API_KEY);
// B1 may use it ONLY when B1_ENDPOINT is exactly this endpoint, so that key is never sent to any other host (Nov 9, 2026).
const PERPLEXITY_AGENT_ENDPOINT = "https://api.perplexity.ai/v1/agent";
function isPerplexityAgentEndpoint(ep) {
  let u; try { u = new URL(String(ep || "")); } catch (x) { return false; }
  return u.protocol === "https:" && u.hostname === "api.perplexity.ai" && !u.port && !u.username && !u.password && u.pathname === "/v1/agent" && !u.search && !u.hash;
}
/** The B1 credential: B1_API_KEY first; otherwise PERPLEXITY_API_KEY, and only for the exact Perplexity Agent endpoint. Never logged or returned. */
function liveCredential(e, ep) {
  const own = String(e.B1_API_KEY || "").trim();
  if (own) return own;
  return isPerplexityAgentEndpoint(ep) ? String(e.PERPLEXITY_API_KEY || "").trim() : "";
}

function liveProvider(e, fetchImpl) {
  const ep = String(e.B1_ENDPOINT || "").trim(), key = liveCredential(e, ep);
  if (!/^https:\/\//.test(ep) || !key) throw new ProviderError("not_configured", "B1_PROVIDER=live needs B1_ENDPOINT (https) and a credential: B1_API_KEY, or PERPLEXITY_API_KEY when B1_ENDPOINT is the Perplexity Agent API");
  const doFetch = fetchImpl || fetch;
  return {
    name: "live", paid: true, calls: 0,
    async call({ requestText }) {
      this.calls += 1;
      let r, text;
      try {
        r = await doFetch(ep, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: requestText, signal: AbortSignal.timeout(120000) });
        text = await r.text();
      } catch (x) { throw new ProviderError("provider_unreachable", "the B1 provider could not be reached"); }
      if (r.status !== 200) throw new ProviderError("provider_http_error", `the B1 provider answered HTTP ${r.status}`);
      let j = null; try { j = JSON.parse(text); } catch (x) { j = null; }
      if (!j || j.status !== "completed") throw new ProviderError("provider_incomplete", "the B1 provider did not complete the analysis");
      return text;
    },
  };
}

/** The provider's reported cost of a raw B1 response (usage.cost.total_cost), or null. */
function reportedCost(responseText) {
  try { const c = JSON.parse(String(responseText)).usage.cost.total_cost; return typeof c === "number" && c >= 0 && c < 100 ? c : null; } catch (x) { return null; }
}

module.exports = { createProvider, liveProvider, reportedCost, ProviderError, PERPLEXITY_AGENT_ENDPOINT, isPerplexityAgentEndpoint };
