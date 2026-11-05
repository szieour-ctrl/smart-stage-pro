// lib/agent-marketing-b1-provider-lib.js — Netlify (shared). DEVELOPMENT ONLY (Nov 5, 2026). The B1 provider used by Stage B.
//
// ONLY a mock exists. The live B1 provider call is NOT implemented: it is paid and needs separate approval. createProvider() returns:
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
  if (kind !== "mock") throw new ProviderError("provider_not_implemented", "the live B1 provider is not implemented (it is paid and needs separate approval)");
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

module.exports = { createProvider, ProviderError };
