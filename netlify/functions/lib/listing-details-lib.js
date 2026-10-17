// lib/listing-details-lib.js — Netlify (shared helpers)
// Smart Stage PRO™ — Listing Details (Oct 17, 2026)
//
// Beds / baths / sqft / year built live on the `listings` row (NOT price —
// price changes constantly and is entered per Reel/video). Shown on the My
// Listings card, the public compliance page, and prefilled into the video
// and Reel builders. All values optional.

// Parse one numeric field. Blank → null (clears the value). Anything that
// isn't a sane number → { error }.
function parseField(raw, { label, min, max, integer, halfSteps }) {
  if (raw === undefined) return { skip: true };
  if (raw === null || raw === "") return { value: null };
  const n = Number(String(raw).replace(/,/g, "").trim());
  if (!Number.isFinite(n)) return { error: `${label} must be a number.` };
  if (n < min || n > max) return { error: `${label} must be between ${min} and ${max}.` };
  if (integer && !Number.isInteger(n)) return { error: `${label} must be a whole number.` };
  if (halfSteps && Math.round(n * 2) !== n * 2) return { error: `${label} must be a whole or half number (e.g. 2.5).` };
  return { value: n };
}

// Returns { updates } (only the fields that were sent) or { error }.
function validateDetails(body) {
  const specs = {
    beds:       { label: "Beds",       min: 0,    max: 99,     integer: true },
    baths:      { label: "Baths",      min: 0,    max: 99,     halfSteps: true },
    sqft:       { label: "Sq ft",      min: 0,    max: 999999, integer: true },
    year_built: { label: "Year built", min: 1600, max: 2100,   integer: true },
  };
  const updates = {};
  for (const [key, spec] of Object.entries(specs)) {
    const r = parseField(body[key], spec);
    if (r.error) return { error: r.error };
    if (!r.skip) updates[key] = r.value;
  }
  if (Object.keys(updates).length === 0) return { error: "No listing details provided." };
  return { updates };
}

// "3 bd · 2.5 ba · 2,150 sq ft · Built 1998" — only the fields present.
function formatDetailsLine(d) {
  if (!d) return "";
  const parts = [];
  if (d.beds != null)       parts.push(`${d.beds} bd`);
  if (d.baths != null)      parts.push(`${Number(d.baths)} ba`);
  if (d.sqft != null)       parts.push(`${Number(d.sqft).toLocaleString("en-US")} sq ft`);
  if (d.year_built != null) parts.push(`Built ${d.year_built}`);
  return parts.join(" · ");
}

module.exports = { validateDetails, formatDetailsLine };
