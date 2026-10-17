// lib/rentcast-lib.js — Netlify (shared helper)
// Smart Stage PRO™ — RentCast property lookup (Oct 17, 2026)
//
// Fills a NEW listing's beds / baths / sqft / year built from public records
// (RentCast GET /v1/properties?address=...). Used only by project-manage.js
// when a real Listing row is first created — Prospecting/Marketing lives in
// marketing-manage.js and never calls this, so prospect addresses cost no
// RentCast requests (Free plan = 50 requests/month).
//
// Never throws and never blocks listing creation: no key, no match, a slow
// response or an error all return null and the fields simply stay blank for
// the agent to fill in with "Edit Details".

const https = require("https");

const LOOKUP_TIMEOUT_MS = 3500; // Netlify functions default to a 10s limit

// Google Places style "234 Bent Tree Ct, Roseville, CA 95661, USA" →
// RentCast's "Street, City, State, Zip" ("234 Bent Tree Ct, Roseville, CA, 95661").
function toRentcastAddress(address) {
  let a = String(address || "").replace(/,?\s*(USA|United States)\s*$/i, "").trim();
  a = a.replace(/,\s*([A-Z]{2})\s+(\d{5})(-\d{4})?\s*$/, ", $1, $2");
  return a;
}

function numberInRange(v, min, max) {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

// Map a RentCast property record to our four columns. Out-of-range or
// missing values become null so a bad record can never violate a CHECK.
function normalizeProperty(rec) {
  if (!rec || typeof rec !== "object") return null;
  const beds  = numberInRange(rec.bedrooms, 0, 99);
  const baths = numberInRange(rec.bathrooms, 0, 99);
  const sqft  = numberInRange(rec.squareFootage, 1, 999999);
  const year  = numberInRange(rec.yearBuilt, 1600, 2100);
  const out = {
    beds:       beds  != null && Number.isInteger(beds)  ? beds  : null,
    baths:      baths != null && Math.round(baths * 2) === baths * 2 ? baths : null,
    sqft:       sqft  != null ? Math.round(sqft) : null,
    year_built: year  != null && Number.isInteger(year)  ? year  : null,
  };
  return Object.values(out).some(v => v != null) ? out : null;
}

function lookupPropertyDetails(address) {
  return new Promise((resolve) => {
    const key = process.env.RENTCAST_API_KEY;
    if (!key || !address) { resolve(null); return; }
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };

    const req = https.request({
      hostname: "api.rentcast.io",
      path: `/v1/properties?address=${encodeURIComponent(toRentcastAddress(address))}`,
      method: "GET",
      headers: { "X-Api-Key": key, "Accept": "application/json" },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        if (res.statusCode !== 200) {
          console.log("rentcast lookup: status", res.statusCode);
          return done(null);
        }
        try {
          const body = JSON.parse(data);
          done(normalizeProperty(Array.isArray(body) ? body[0] : body));
        } catch { done(null); }
      });
    });
    req.setTimeout(LOOKUP_TIMEOUT_MS, () => { req.destroy(); done(null); });
    req.on("error", err => { console.log("rentcast lookup error:", err.message); done(null); });
    req.end();
  });
}

module.exports = { lookupPropertyDetails, normalizeProperty, toRentcastAddress };
