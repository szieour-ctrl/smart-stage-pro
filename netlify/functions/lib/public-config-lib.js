// lib/public-config-lib.js — Netlify (shared). Browser-safe Supabase configuration per deployment (Nov 5, 2026).
//
// The browser and the server functions must talk to the SAME Supabase project: the browser signs in against SUPABASE_URL's Auth, and the
// functions verify that login token against their own SUPABASE_URL. Production values are fixed (they were hardcoded in the pages and are
// unchanged); every other deployment must be configured explicitly and is checked here, failing closed:
//   - SSP_PUBLIC_SUPABASE_URL must equal the server's SUPABASE_URL (same project for browser and server),
//   - SSP_PUBLIC_SUPABASE_ANON_KEY must be an anon (or publishable) key for that same project: never a service-role or secret key,
//   - outside production, the production project is refused: a development deployment never falls back to production.
// Only public values ever leave this module: the project URL, its anon key and the project ref.
"use strict";

const PRODUCTION_REF = "dnpaenpwdhjmslymgkse";
const PRODUCTION = Object.freeze({
  env: "production",
  supabaseUrl: `https://${PRODUCTION_REF}.supabase.co`,
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRucGFlbnB3ZGhqbXNseW1na3NlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4NjczNTIsImV4cCI6MjA5NjQ0MzM1Mn0.pEdH1YgINYjj8sAutsJJoO8x4VUxTCfIzVbjSu_yBTY",
  projectRef: PRODUCTION_REF,
});
const PRODUCTION_HOSTS = Object.freeze(["smartstagepro.com", "www.smartstagepro.com", "smart-stage-pro.netlify.app", "main--smart-stage-pro.netlify.app"]);

/** The Supabase project ref of a project URL (https://<ref>.supabase.co), or null. */
function refOf(url) {
  try { const u = new URL(String(url)); const m = u.protocol === "https:" && u.hostname.match(/^([a-z0-9]{20})\.supabase\.co$/); return m ? m[1] : null; } catch (e) { return null; }
}
/** What a key is: { kind: "anon"|"publishable"|"service_role"|"secret"|"unknown", ref }. Never returns the key. */
function keyInfo(key) {
  const k = String(key || "");
  if (/^sb_publishable_/.test(k)) return { kind: "publishable", ref: null };
  if (/^sb_secret_/.test(k)) return { kind: "secret", ref: null };
  const parts = k.split(".");
  if (parts.length !== 3) return { kind: "unknown", ref: null };
  try {
    const p = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    const role = String(p.role || "");
    return { kind: role === "anon" ? "anon" : role === "service_role" ? "service_role" : "unknown", ref: p.ref ? String(p.ref) : null };
  } catch (e) { return { kind: "unknown", ref: null }; }
}

/** Is this request host a production host? The fixed list, plus the host of Netlify's production URL (env URL) for any other production alias. */
function isProductionHost(host, env) {
  const h = String(host || "").toLowerCase().replace(/:\d+$/, "");
  if (PRODUCTION_HOSTS.includes(h)) return true;
  try { return !!(env && env.URL) && new URL(env.URL).hostname.toLowerCase() === h && String(env.CONTEXT || "production") === "production"; } catch (e) { return false; }
}

/**
 * publicConfig({ host, env }) → { ok: true, config } | { ok: false, code, message }
 * config is safe to send to a browser.
 */
function publicConfig({ host, env }) {
  const e = env || process.env;
  if (isProductionHost(host, e)) return { ok: true, config: PRODUCTION };
  const url = String(e.SSP_PUBLIC_SUPABASE_URL || ""), key = String(e.SSP_PUBLIC_SUPABASE_ANON_KEY || ""), server = String(e.SUPABASE_URL || "");
  const no = (code, message) => ({ ok: false, code, message });
  if (!url || !key) return no("unconfigured", "This deployment has no Supabase configuration of its own.");
  const ref = refOf(url);
  if (!ref) return no("bad_url", "SSP_PUBLIC_SUPABASE_URL is not a Supabase project URL.");
  if (ref === PRODUCTION_REF) return no("production_refused", "A non-production deployment may not use the production Supabase project.");
  if (url.replace(/\/+$/, "") !== server.replace(/\/+$/, "")) return no("mismatch", "The browser and server Supabase projects differ for this deployment.");
  if (key === String(e.SUPABASE_SERVICE_ROLE_KEY || "\u0000")) return no("secret_key_refused", "The service-role key is never sent to a browser.");
  const k = keyInfo(key);
  if (k.kind === "service_role" || k.kind === "secret" || k.kind === "unknown") return no("secret_key_refused", "SSP_PUBLIC_SUPABASE_ANON_KEY must be an anon or publishable key.");
  if (k.kind === "anon" && k.ref !== ref) return no("mismatch", "The anon key belongs to a different Supabase project.");
  return { ok: true, config: Object.freeze({ env: "development", supabaseUrl: url.replace(/\/+$/, ""), supabaseAnonKey: key, projectRef: ref }) };
}

module.exports = { PRODUCTION, PRODUCTION_REF, PRODUCTION_HOSTS, refOf, keyInfo, isProductionHost, publicConfig };
