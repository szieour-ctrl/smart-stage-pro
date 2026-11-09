// lib/self-dispatch-lib.js — Netlify (shared). Where a function sends its own background job (Nov 5, 2026).
//
// Problem: dispatchers built the background URL from URL / SITE_URL / NETLIFY_URL (or a hardcoded production fallback). Those name the
// PRODUCTION site, so a Deploy Preview or branch deploy could start its background job on production's functions (production credentials,
// production database), not its own.
// Rule: selfBase(event, legacy)
//   - production host (or no request host at all): returns `legacy`, the call site's existing expression, unchanged: production routing is
//     byte-for-byte what it was;
//   - any other host: the deploy that received the request (https://<host>, or http:// for localhost under netlify dev). Never URL, SITE_URL,
//     NETLIFY_URL or a production fallback;
//   - a malformed host outside production throws: it never silently falls back to production.
"use strict";

const { isProductionHost } = require("./public-config-lib");

function requestHost(event) {
  const h = event && event.headers ? (event.headers.host || event.headers.Host || "") : "";
  return String(h).trim().toLowerCase();
}

function selfBase(event, legacy, env) {
  const host = requestHost(event);
  if (!host || isProductionHost(host, env || process.env)) return legacy;
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(host)) { const e = new Error("dispatch_host_invalid"); e.code = "dispatch_host_invalid"; throw e; }
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  return `${local ? "http" : "https"}://${host}`;
}

/**
 * Development deploys sit behind Netlify team login, so a function cannot call its own background function there (the edge answers 401).
 * pageDispatch(event, env) is true only when AGENT_MARKETING_B1_EVIDENCE=dev, the request host is not production and the database is not the
 * production project: the page then starts the background job itself with the subscriber's own login token. pageDispatchUser(event, env)
 * is the background side: the logged-in user's id under the same conditions, else null. Same rule as research and script mode.
 */
function pageDispatch(event, env) {
  const e = env || process.env;
  if (!require("./agent-marketing-b1-evidence-lib").enabled(e)) return false;
  const pc = require("./public-config-lib");
  return !isProductionHost(requestHost(event), e) && !!e.SUPABASE_URL && !String(e.SUPABASE_URL).includes(pc.PRODUCTION_REF);
}
async function pageDispatchUser(event, env) {
  if (!pageDispatch(event, env)) return null;
  const auth = await require("./reel-auth-lib").requireUser(event);
  return auth && !auth.error && auth.user ? auth.user.id : null;
}

module.exports = { selfBase, requestHost, pageDispatch, pageDispatchUser };
