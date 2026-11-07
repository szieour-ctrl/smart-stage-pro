/* ssp-public-config.js (Nov 5, 2026). The browser's Supabase configuration for this deployment. Loaded synchronously BEFORE any page script.
 * Production hosts get the production values directly (unchanged from what the pages had hardcoded; no network request).
 * Any other host (Deploy Previews, branch deploys, local development) gets its configuration from the server, which checks that it is the same
 * Supabase project the server functions use and never the production project. If that fails, the page stops with a visible message:
 * it never falls back to production. Only public values: the project URL, its anon key and its ref. Kept equal to
 * netlify/functions/lib/public-config-lib.js by tests/ssp-public-config.test.js. */
(function () {
  "use strict";
  var PRODUCTION = { env: "production", supabaseUrl: "https://dnpaenpwdhjmslymgkse.supabase.co",
    supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRucGFlbnB3ZGhqbXNseW1na3NlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4NjczNTIsImV4cCI6MjA5NjQ0MzM1Mn0.pEdH1YgINYjj8sAutsJJoO8x4VUxTCfIzVbjSu_yBTY",
    projectRef: "dnpaenpwdhjmslymgkse" };
  var PRODUCTION_HOSTS = ["smartstagepro.com","www.smartstagepro.com","smart-stage-pro.netlify.app","main--smart-stage-pro.netlify.app"];
  var host = String((window.location && window.location.hostname) || "").toLowerCase();
  function fail(code) {
    window.SSP_PUBLIC_CONFIG = Object.freeze({ env: "unconfigured", error: code });
  }
  if (PRODUCTION_HOSTS.indexOf(host) !== -1) { window.SSP_PUBLIC_CONFIG = Object.freeze(PRODUCTION); }
  else {
    var cfg = null;
    try {
      var x = new XMLHttpRequest();
      x.open("GET", "/.netlify/functions/public-config", false);   // synchronous: the page scripts below need it before they run
      x.send(null);
      if (x.status === 200) cfg = JSON.parse(x.responseText);
    } catch (e) { cfg = null; }
    var okShape = cfg && typeof cfg.supabaseUrl === "string" && typeof cfg.supabaseAnonKey === "string" && /^[a-z0-9]{20}$/.test(String(cfg.projectRef || ""))
      && cfg.supabaseUrl === "https://" + cfg.projectRef + ".supabase.co";
    // A production answer is accepted only when the server itself says this host is production (another production alias).
    if (!okShape) fail("unconfigured");
    else if (cfg.projectRef === PRODUCTION.projectRef && cfg.env !== "production") fail("production_refused");
    else window.SSP_PUBLIC_CONFIG = Object.freeze({ env: String(cfg.env), supabaseUrl: cfg.supabaseUrl, supabaseAnonKey: cfg.supabaseAnonKey, projectRef: cfg.projectRef });
  }
  /** The page's configuration, or a visible stop: an unconfigured deployment never signs in anywhere. */
  window.sspPublicConfig = function () {
    var c = window.SSP_PUBLIC_CONFIG;
    if (c && !c.error) return c;
    try {
      var d = document.createElement("div");
      d.setAttribute("role", "alert");
      d.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:24px;background:#fff;color:#111;font:16px/1.5 system-ui,sans-serif;text-align:center";
      d.textContent = "This deployment is not configured for sign-in (" + ((c && c.error) || "unconfigured") + "). Nothing was sent anywhere.";
      (document.body || document.documentElement).appendChild(d);
    } catch (e) { /* no DOM yet */ }
    throw new Error("SSP public configuration unavailable: " + ((c && c.error) || "unconfigured"));
  };
})();
