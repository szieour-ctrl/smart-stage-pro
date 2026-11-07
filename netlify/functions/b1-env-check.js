// b1-env-check.js — Netlify Function. DEVELOPMENT ONLY (Nov 7, 2026). Verifies, on the real `b1-stageb-dev` branch deploy, that the branch-specific
// Netlify values took effect: production database administration, paid providers, Stripe, S3, the renderer, Pabbly, Blobs job storage, legacy
// integrations and billing call-backs are cut off, inbound-verification secrets are private development values, and Stage B is still switched off.
//   GET → 200 { ok, host, context, branch, checks: [{ name, want, state, ok }], blobs } on the branch deploy host only; 404 everywhere else.
// It never returns or logs a value. States: "unset", "empty", "disabled" (the approved placeholder), "set", and for checked values "dev-project",
// "branch", "short", "placeholder" or "other". The Blobs probe is a read of a key that does not exist, never a write. The branch deploy is also
// behind Netlify team login.
"use strict";

const BRANCH = "b1-stageb-dev";
const BRANCH_HOST = `${BRANCH}--smart-stage-pro.netlify.app`;
const BRANCH_URL = `https://${BRANCH_HOST}`;
const PRODUCTION_REF = "dnpaenpwdhjmslymgkse";
const DEV_REF = "ooxigbxthabstahrexia";
const DEV_URL = `https://${DEV_REF}.supabase.co`;
// Netlify refuses empty values, so the approved placeholders stand for "cut off".
const PLACEHOLDERS = ["b1-dev-disabled", "https://b1-dev-disabled.invalid"];

// Must be unset, empty or a placeholder on the branch. A branch value that did not take effect shows up as "set" (the production value leaked).
const CUT_OFF = [
  // site-level job storage (Netlify Blobs; account-wide token)
  "NETLIFY_ACCESS_TOKEN",
  // media storage
  "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET_NAME",
  // paid AI and data providers
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "PERPLEXITY_API_KEY", "ELEVENLABS_API_KEY", "REPLICATE_API_KEY", "BRIGHTDATA_API_KEY", "RENTCAST_API_KEY", "GOOGLE_MAPS_API_KEY",
  // payments
  "STRIPE_SECRET_KEY",
  // renderer (outbound)
  "RAILWAY_SECRET", "RAILWAY_RENDER_URL", "RAILWAY_SMART_CORRECT_URL", "RAILWAY_SMART_CORRECT_UPLOAD_URL",
  // customer email and webhooks (outbound)
  "PABBLY_COMPLIANCE_REPORT_WEBHOOK_URL", "PABBLY_VIDEO_DELIVERY_WEBHOOK_URL", "PABBLY_TRANSACTIONAL_EMAIL_WEBHOOK_URL", "PABBLY_IMAGE_PACK_WEBHOOK_URL",
  // legacy credentials no longer read by this code but still injected into every function's environment
  "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET", "MIGRATION_SECRET", "DECOR8_API_KEY", "IMGBB_API_KEY",
  // Stage B stays off until the development database and worker are ready
  "AGENT_MARKETING_B1_EVIDENCE",
];

// Secrets that verify inbound requests or sign links: a published placeholder would let anyone forge them, so these must be private random values.
const PRIVATE_SECRETS = ["INTERNAL_API_KEY", "WEBHOOK_SECRET", "STRIPE_WEBHOOK_SECRET"];
// Optional signing secrets that may be absent (Nov 7: they do not exist on the site), because the code then fails closed or stays private:
//   REEL_SHARE_SECRET absent -> lib/reel-share-lib.js signs with a key derived from SUPABASE_SERVICE_ROLE_KEY, which must then be the development key.
//   PROMO_LINK_SECRET absent -> create-promo-link.js answers 401 to every request.
// If present they must be private values; the published placeholder always fails.
const OPTIONAL_SECRETS = ["REEL_SHARE_SECRET", "PROMO_LINK_SECRET"];

const isPlaceholder = (v) => PLACEHOLDERS.includes(String(v));
const stateOf = (v) => (v === undefined ? "unset" : v === "" ? "empty" : isPlaceholder(v) ? "disabled" : "set");
const hostOf = (event) => String((event && event.headers && (event.headers.host || event.headers.Host)) || "").toLowerCase().replace(/:\d+$/, "");

/** A Supabase key's project and role when it is a JWT; null for other key formats. Only these two claims are read. */
function jwtClaims(key) {
  const parts = String(key || "").split(".");
  if (parts.length !== 3) return null;
  try { const p = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")); return { ref: String(p.ref || ""), role: String(p.role || "") }; }
  catch (e) { return null; }
}
function keyState(v, wantRole) {
  if (v === undefined || v === "" || isPlaceholder(v)) return { state: stateOf(v), ok: false };
  const c = jwtClaims(v);
  if (!c) return { state: "set (non-JWT key; project checked through the URL)", ok: true };
  if (c.ref === PRODUCTION_REF) return { state: "production-project", ok: false };
  if (c.ref !== DEV_REF) return { state: "other-project", ok: false };
  return { state: c.role === wantRole ? "dev-project" : `dev-project (role ${c.role || "?"})`, ok: c.role === wantRole };
}

function report(env) {
  const checks = CUT_OFF.map((name) => { const state = stateOf(env[name]); return { name, want: "unset, empty or placeholder", state, ok: state !== "set" }; });
  for (const name of PRIVATE_SECRETS) {
    const v = env[name];
    const state = v === undefined || v === "" ? stateOf(v) : isPlaceholder(v) ? "placeholder" : String(v).length < 32 ? "short" : "set";
    checks.push({ name, want: "a private development value (32+ characters, not the placeholder)", state, ok: state === "set" });
  }
  const sr0 = keyState(env.SUPABASE_SERVICE_ROLE_KEY, "service_role");
  for (const name of OPTIONAL_SECRETS) {
    const v = env[name];
    const absent = v === undefined || v === "";
    const state = absent ? `${stateOf(v)} (${name === "REEL_SHARE_SECRET" ? "derived from the development service-role key" : "endpoint refuses every request"})`
      : isPlaceholder(v) ? "placeholder" : String(v).length < 32 ? "short" : "set";
    const ok = absent ? (name === "REEL_SHARE_SECRET" ? sr0.ok && env.SUPABASE_URL === DEV_URL : true) : state === "set";
    checks.push({ name, want: "absent (fails closed) or a private development value", state, ok });
  }
  for (const name of ["SUPABASE_URL", "SSP_PUBLIC_SUPABASE_URL"]) {
    const v = String(env[name] || "");
    checks.push({ name, want: "the development project", state: v === DEV_URL ? "dev-project" : v.includes(PRODUCTION_REF) ? "production-project" : stateOf(env[name]) === "set" ? "other" : stateOf(env[name]), ok: v === DEV_URL });
  }
  const sr = keyState(env.SUPABASE_SERVICE_ROLE_KEY, "service_role");
  checks.push({ name: "SUPABASE_SERVICE_ROLE_KEY", want: "the development project's service-role key", state: sr.state, ok: sr.ok && env.SUPABASE_URL === DEV_URL });
  const an = keyState(env.SSP_PUBLIC_SUPABASE_ANON_KEY, "anon");
  checks.push({ name: "SSP_PUBLIC_SUPABASE_ANON_KEY", want: "the development project's anon key", state: an.state, ok: an.ok && env.SSP_PUBLIC_SUPABASE_URL === DEV_URL });
  for (const name of ["SITE_URL", "NETLIFY_URL"]) {
    const v = env[name];
    checks.push({ name, want: "this branch deploy (or unset, NETLIFY_URL only)", state: v === BRANCH_URL ? "branch" : stateOf(v), ok: v === BRANCH_URL || (name === "NETLIFY_URL" && v === undefined) });
  }
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

exports._internals = { CUT_OFF, PRIVATE_SECRETS, OPTIONAL_SECRETS, PLACEHOLDERS, BRANCH_HOST, BRANCH_URL, DEV_URL, report };
