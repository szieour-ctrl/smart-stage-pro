// public-config.js — Netlify Function (Nov 5, 2026). GET → the browser-safe Supabase configuration for THIS deployment (see lib/public-config-lib.js).
// Used by /ssp-public-config.js on non-production hosts. Answers 503 (and nothing else) when the deployment is not configured consistently:
// a development deployment never falls back to production. Returns only public values (project URL, anon key, ref).
const { publicConfig } = require("./lib/public-config-lib");

exports.handler = async (event) => {
  const h = (event && event.headers) || {};
  if (event && event.httpMethod && event.httpMethod !== "GET") return { statusCode: 405, headers: { "Cache-Control": "no-store" }, body: "" };
  const r = publicConfig({ host: h.host || h.Host || "", env: process.env });
  return { statusCode: r.ok ? 200 : 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    body: JSON.stringify(r.ok ? r.config : { error: r.code }) };
};
