// b1-flag-check.js — Netlify Function. TEMPORARY, DEVELOPMENT ONLY (Nov 7, 2026). Remove after the hosted FA/FB/FC run.
// AGENT_MARKETING_ENABLED is a Netlify secret variable, so its b1-stageb-dev value cannot be read back in the dashboard or API. This answers one
// question on the branch deploy: does the switch evaluate to on at runtime, by the same rule the feature uses (lib/agent-marketing-lib.js
// isEnabledFor: trimmed, case-insensitive "true")?
//   GET → 200 { agentMarketingEnabled: true|false, runtime: { context, branch } } on the b1-stageb-dev branch deploy only; 404 everywhere else.
// Isolation: the request host must be the branch deploy host AND the functions must point at the development database. Netlify's CONTEXT and
// BRANCH are build-time values that may be absent inside functions at runtime (the first version required them and answered 404 on the real
// branch deploy), so, as in b1-env-check, a missing value is accepted and a present-but-different value is refused. runtime reports only
// "branch-deploy"/"b1-stageb-dev" when seen, otherwise "unset" (never another value).
// It never returns or logs the value, its length or any other variable. The branch deploy is also behind Netlify team login.
"use strict";

const BRANCH = "b1-stageb-dev";
const BRANCH_HOST = `${BRANCH}--smart-stage-pro.netlify.app`;
const CONTEXT = "branch-deploy";
const DEV_URL = "https://ooxigbxthabstahrexia.supabase.co";
const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const hostOf = (event) => String((event && event.headers && (event.headers.host || event.headers.Host)) || "").toLowerCase().replace(/:\d+$/, "");

/** Same rule as isEnabledFor's switch check in lib/agent-marketing-lib.js. */
const switchOn = (env) => String(env.AGENT_MARKETING_ENABLED || "").trim().toLowerCase() === "true";

exports.handler = async (event, context, deps) => {
  const env = (deps && deps.env) || process.env;
  const notFound = { statusCode: 404, headers, body: JSON.stringify({ error: "Not found" }) };
  if (hostOf(event) !== BRANCH_HOST) return notFound;
  if (env.CONTEXT && env.CONTEXT !== CONTEXT) return notFound;
  if (env.BRANCH && env.BRANCH !== BRANCH) return notFound;
  if (env.SUPABASE_URL !== DEV_URL) return notFound;   // never answers against the production (or any other) database
  const agentMarketingEnabled = switchOn(env);
  const runtime = { context: env.CONTEXT ? CONTEXT : "unset", branch: env.BRANCH ? BRANCH : "unset" };
  console.log(`b1-flag-check agentMarketingEnabled=${agentMarketingEnabled} context=${runtime.context} branch=${runtime.branch}`);
  return { statusCode: 200, headers, body: JSON.stringify({ agentMarketingEnabled, runtime }) };
};

exports._internals = { BRANCH_HOST, DEV_URL, switchOn };
