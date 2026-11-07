// b1-flag-check.js — Netlify Function. TEMPORARY, DEVELOPMENT ONLY (Nov 7, 2026). Remove after the hosted FA/FB/FC run.
// AGENT_MARKETING_ENABLED is a Netlify secret variable, so its b1-stageb-dev value cannot be read back in the dashboard or API. This answers one
// question on the branch deploy: does the switch evaluate to on at runtime, by the same rule the feature uses (lib/agent-marketing-lib.js
// isEnabledFor: trimmed, case-insensitive "true")?
//   GET → 200 { agentMarketingEnabled: true|false } on the b1-stageb-dev branch deploy host only; 404 everywhere else.
// It never returns or logs the value, its length or any other variable. The branch deploy is also behind Netlify team login.
"use strict";

const BRANCH = "b1-stageb-dev";
const BRANCH_HOST = `${BRANCH}--smart-stage-pro.netlify.app`;
const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const hostOf = (event) => String((event && event.headers && (event.headers.host || event.headers.Host)) || "").toLowerCase().replace(/:\d+$/, "");

/** Same rule as isEnabledFor's switch check in lib/agent-marketing-lib.js. */
const switchOn = (env) => String(env.AGENT_MARKETING_ENABLED || "").trim().toLowerCase() === "true";

exports.handler = async (event, context, deps) => {
  const env = (deps && deps.env) || process.env;
  const notFound = { statusCode: 404, headers, body: JSON.stringify({ error: "Not found" }) };
  if (hostOf(event) !== BRANCH_HOST) return notFound;
  if (env.CONTEXT !== "branch-deploy" || env.BRANCH !== BRANCH) return notFound;
  const agentMarketingEnabled = switchOn(env);
  console.log(`b1-flag-check agentMarketingEnabled=${agentMarketingEnabled}`);
  return { statusCode: 200, headers, body: JSON.stringify({ agentMarketingEnabled }) };
};

exports._internals = { BRANCH_HOST, switchOn };
