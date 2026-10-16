// lib/marketing-profile-lib.js — Netlify (shared helpers)
// Smart Stage PRO™ — Marketing Profile (Oct 16, 2026)
//
// One reliable branding profile per user, shared by Smart Stage PRO and
// PRO Plus. Reads/writes the `marketing_profiles` table (service role only —
// RLS is on with no policies, so the public API can never read it).
//
// WHAT THIS FIXES: before this, index.html sent `agentInfo: {}` to
// project-manage.js, so every subscriber's compliance page, ZIP manifest and
// QR card fell back to the global AGENT_NAME / AGENT_BROKERAGE / AGENT_DRE /
// AGENT_LOGO_URL env vars (the account owner's identity) or blank. Now
// branding is read from the listing owner's profile, and a user with no
// profile gets a NEUTRAL Smart Stage PRO header — never anyone else's identity.
//
// The three fields California requires on a piece of advertising are
// REQUIRED here: the agent's name exactly as licensed, the agent's DRE license
// number, and the responsible broker's licensed brokerage name.

const https = require("https");

// A stalled Supabase call must fail fast (and return a normal JSON error)
// rather than run into Netlify's function limit and surface as an HTML 504.
const REQUEST_TIMEOUT_MS = 8000;

const NEUTRAL_NAME = "Smart Stage PRO™";
const NEUTRAL_LOGO_KEY = "smart-stage-marketing/Smart_Stage_PRO_Logo_zciwlo.png";

// Where a user's logo/headshot live. This prefix is inside the existing
// public-read `smart-stage-marketing/` prefix, so no bucket-policy change is
// needed; the per-user folder is what the save step checks keys against.
function brandingKeyPrefix(userId) {
  return `smart-stage-marketing/branding/${userId}/`;
}

function supabase(method, table, body, queryParams = "") {
  return new Promise((resolve, reject) => {
    const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/${table}${queryParams}`);
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data || "[]") }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`Supabase ${method} ${table} timed out after ${REQUEST_TIMEOUT_MS}ms`)));
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function verifyJWT(authHeader) {
  return new Promise((resolve) => {
    if (!authHeader || !authHeader.startsWith("Bearer ")) { resolve(null); return; }
    const jwt = authHeader.split(" ")[1];
    const url = new URL(`${process.env.SUPABASE_URL}/auth/v1/user`);
    const req = https.request({
      hostname: url.hostname, path: url.pathname, method: "GET",
      headers: { "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${jwt}` },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { const p = JSON.parse(data); resolve(res.statusCode === 200 && p.id ? p : null); }
        catch { resolve(null); }
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => { console.warn("verifyJWT timed out"); req.destroy(); });
    req.on("error", () => resolve(null));
    req.end();
  });
}

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Public URL for an object under the public-read marketing prefix.
function publicUrlForKey(key) {
  if (!key) return "";
  const bucket = process.env.S3_BUCKET_NAME;
  const region = process.env.S3_REGION;
  if (!bucket || !region) return "";
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}

function neutralBranding() {
  return {
    hasProfile: false,
    licensedName: "",
    dreNumber: "",
    brokerageName: "",
    teamName: "",
    phone: "",
    email: "",
    website: "",
    logoUrl: publicUrlForKey(NEUTRAL_LOGO_KEY),
    headshotUrl: "",
    brandTheme: "custom",
    brandPrimary: "#b8975a",
    brandSecondary: "#1a1714",
    brandBorder: "#b8975a",
    brandFont: "Montserrat",
    displayName: NEUTRAL_NAME,
  };
}

function rowToBranding(row) {
  return {
    hasProfile: true,
    licensedName: row.licensed_name || "",
    dreNumber: row.dre_number || "",
    brokerageName: row.brokerage_name || "",
    teamName: row.team_name || "",
    phone: row.phone || "",
    email: row.contact_email || "",
    website: row.website || "",
    logoUrl: publicUrlForKey(row.logo_key),
    headshotUrl: publicUrlForKey(row.headshot_key),
    brandTheme: row.brand_theme || "custom",
    brandPrimary: row.brand_primary || "#b8975a",
    brandSecondary: row.brand_secondary || "#1a1714",
    brandBorder: row.brand_border || "#b8975a",
    brandFont: row.brand_font || "Montserrat",
    displayName: row.licensed_name || NEUTRAL_NAME,
  };
}

async function getProfileRow(userId) {
  if (!userId || !process.env.SUPABASE_URL) return null;
  const res = await supabase("GET", "marketing_profiles", null,
    `?user_id=eq.${encodeURIComponent(userId)}&is_default=eq.true&select=*&limit=1`);
  return Array.isArray(res.data) ? (res.data[0] || null) : null;
}

// Branding for a user id. Never throws: any failure returns the neutral
// header, so a Supabase hiccup can never take down a public compliance page.
async function brandingForUser(userId) {
  try {
    const row = await getProfileRow(userId);
    return row ? rowToBranding(row) : neutralBranding();
  } catch (e) {
    console.warn("marketing-profile-lib: branding lookup failed (using neutral):", e.message);
    return neutralBranding();
  }
}

// Branding for a project record (Netlify Blobs `pid_` project). Branding is
// resolved at render time from the listing owner, so existing listings pick up
// the profile immediately and never show another account's identity.
async function brandingForProject(project) {
  return brandingForUser(project && project.userId);
}

module.exports = {
  NEUTRAL_NAME,
  brandingKeyPrefix,
  supabase,
  verifyJWT,
  escapeHtml,
  publicUrlForKey,
  neutralBranding,
  rowToBranding,
  getProfileRow,
  brandingForUser,
  brandingForProject,
};
