// b1-env-check.js — Netlify Function. DEVELOPMENT ONLY (Nov 7, 2026). Verifies, on the real `b1-stageb-dev` branch deploy, that the branch-specific
// Netlify values took effect: production database administration, paid providers, Stripe, S3, the renderer, Pabbly, Blobs job storage and billing
// call-backs are cut off, and Stage B is still switched off.
//   GET → 200 { ok, host, context, branch, checks: [{ name, want, state, ok }], blobs, ... } on the branch deploy host only; 404 everywhere else.
// It never returns or logs a value: each variable is reported only as "unset", "empty" or "set". The Blobs probe is a read of a key that does not
// exist, never a write. The branch deploy is also behind Netlify team login.
"use strict";

const BRANCH = "b1-stageb-dev";
const BRANCH_HOST = `${BRANCH}--smart-stage-pro.netlify.app`;
const BRANCH_URL = `https://${BRANCH_HOST}`;
const PRODUCTION_REF = "dnpaenpwdhjmslymgkse";

// Must be empty or unset on the branch (a branch value that did not take effect shows up as "set": the production value was inherited).
const CUT_OFF = [
  "SUPABASE_SERVICE_ROLE_KEY", "NETLIFY_ACCESS_TOKEN",
  "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET_NAME",
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "PERPLEXITY_API_KEY", "ELEVENLABS_API_KEY", "REPLICATE_API_KEY", "BRIGHTDATA_API_KEY", "RENTCAST_API_KEY", "GOOGLE_MAPS_API_KEY",
  "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET",
  "RAILWAY_SECRET", "WEBHOOK_SECRET", "RAILWAY_RENDER_URL", "RAILWAY_SMART_CORRECT_URL", "RAILWAY_SMART_CORRECT_UPLOAD_URL",
  "PABBLY_COMPLIANCE_REPORT_WEBHOOK_URL", "PABBLY_VIDEO_DELIVERY_WEBHOOK_URL", "PABBLY_TRANSACTIONAL_EMAIL_WEBHOOK_URL", "PABBLY_IMAGE_PACK_WEBHOOK_URL",
  "REEL_SHARE_SECRET", "PROMO_LINK_SECRET",
  "AGENT_MARKETING_B1_EVIDENCE",   // Stage B stays off until the development database and worker exist
];

const stateOf = (v) => (v === undefined ? "unset" : v === "" ? "empty" : "set");
const hostOf = (event) => String((event && event.headers && (event.headers.host || event.headers.Host)) || "").toLowerCase().replace(/:\d+$/, "");

function report(env) {
  const checks = CUT_OFF.map((name) => { const state = stateOf(env[name]); return { name, want: "empty or unset", state, ok: state !== "set" }; });
  const db = String(env.SUPABASE_URL || "");
  checks.push({ name: "SUPABASE_URL", want: "empty, unset or a non-production project", state: stateOf(env.SUPABASE_URL), ok: !db.includes(PRODUCTION_REF) });
  for (const name of ["SITE_URL", "NETLIFY_URL"]) {
    const v = env[name];
    checks.push({ name, want: "this branch deploy (or unset, NETLIFY_URL only)", state: v === BRANCH_URL ? "branch" : stateOf(v), ok: v === BRANCH_URL || (name === "NETLIFY_URL" && v === undefined) });
  }
  checks.push({ name: "INTERNAL_API_KEY", want: "set (a development value)", state: stateOf(env.INTERNAL_API_KEY), ok: !!env.INTERNAL_API_KEY });
  return checks;
}

/** Read-only Blobs probe with the same credentials the functions use. "blocked" = no access to the site's stores from this deploy. */
async function probeBlobs(env, getStore) {
  try {
    const store = getStore({ name: "b1-env-check-probe", siteID: env.SZREG_SITE_ID || env.NETLIFY_SITE_ID, token: env.NETLIFY_ACCESS_TOKEN });
    await store.get("never-written");
    return { result: "reachable", ok: false };
  } catch (e) {
    return { result: "blocked", error: String((e && e.name) || "error").slice(0, 60), ok: true };
  }
}

exports.handler = async (event, context, deps) => {
  const d = deps || {};
  const env = d.env || process.env;
  const notFound = { statusCode: 404, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify({ error: "Not found" }) };
  if (hostOf(event) !== BRANCH_HOST) return notFound;
  if (env.CONTEXT && env.CONTEXT !== "branch-deploy") return notFound;
  if (env.BRANCH && env.BRANCH !== BRANCH) return notFound;
  const checks = report(env);
  const blobs = await probeBlobs(env, d.getStore || require("@netlify/blobs").getStore);
  const ok = checks.every((c) => c.ok) && blobs.ok;
  // One line for the function log (read through Netlify observability): names and states only, never a value.
  console.log(`b1-env-check ${ok ? "PASS" : "FAIL"} checks=${checks.length} failing=[${checks.filter((c) => !c.ok).map((c) => `${c.name}:${c.state}`).join(",")}] blobs=${blobs.result} context=${env.CONTEXT || "-"} branch=${env.BRANCH || "-"}`);
  return { statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify({ ok, host: BRANCH_HOST, context: env.CONTEXT || null, branch: env.BRANCH || null, checks, blobs }) };
};

exports._internals = { CUT_OFF, BRANCH_HOST, BRANCH_URL, report };
