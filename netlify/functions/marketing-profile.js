// marketing-profile.js — Netlify Function
// Smart Stage PRO™ — Marketing Profile (Oct 16, 2026)
//
// The user's reusable public branding: licensed name, DRE number, licensed
// brokerage, contact details, logo, headshot and brand colors. Shared by Smart
// Stage PRO (compliance page, ZIP, QR card) and PRO Plus (closing card, Reels).
//
// Routes (all require Authorization: Bearer <supabase jwt>):
//   GET                       → { profile, prefill }   (profile null if not set up yet)
//   POST ?action=save         → body = profile fields   → { profile }
//   POST ?action=presign      → body { kind: "logo"|"headshot", contentType }
//                               → { uploadUrl, key, publicUrl } (browser PUTs the file)
//
// Required (California advertising): licensedName (exactly as licensed),
// dreNumber, brokerageName. Everything else is optional; logo and headshot are
// optional and the layouts handle their absence.
//
// This function only ever reads/writes the caller's OWN profile (user id comes
// from the verified JWT, never from the request body).

const crypto = require("crypto");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const {
  supabase, verifyJWT, brandingKeyPrefix, publicUrlForKey, getProfileRow, rowToBranding,
} = require("./lib/marketing-profile-lib");

const s3 = new S3Client({
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

const ALLOWED_IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  // Per-user data: never let a shared cache serve one user's profile to another
  // (same lesson as media-gallery.js, Aug 2026).
  "Cache-Control": "no-store",
};

function reply(statusCode, obj) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(obj) };
}

function clean(v, max) {
  if (v == null) return "";
  return String(v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

// Normalizes and validates the editable fields. Returns { error } or { row }.
function validateProfile(body, userId) {
  const licensedName = clean(body.licensedName, 80);
  if (licensedName.length < 2) {
    return { error: "Enter your name exactly as it appears on your real estate license." };
  }

  // DRE numbers are 7-8 digits. Accept "DRE #01397303", "01397303", etc.
  const dreDigits = clean(body.dreNumber, 20).replace(/dre|license|lic|#|\s|-/gi, "");
  if (!/^\d{7,8}$/.test(dreDigits)) {
    return { error: "Enter your DRE license number (7 or 8 digits)." };
  }

  const brokerageName = clean(body.brokerageName, 100);
  if (brokerageName.length < 2) {
    return { error: "Enter your responsible broker's licensed brokerage name." };
  }

  const teamName = clean(body.teamName, 80);

  const phone = clean(body.phone, 30);
  if (phone && !/^[0-9 ()+.\-]{7,30}$/.test(phone)) {
    return { error: "Phone number can only contain digits, spaces and ( ) + - ." };
  }

  const contactEmail = clean(body.contactEmail, 120).toLowerCase();
  if (contactEmail && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/.test(contactEmail)) {
    return { error: "Enter a valid contact email, or leave it blank." };
  }

  let website = clean(body.website, 200);
  if (website) {
    if (!/^https?:\/\//i.test(website)) website = "https://" + website;
    let u;
    try { u = new URL(website); } catch { return { error: "Enter a valid website, or leave it blank." }; }
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) {
      return { error: "Enter a valid website, or leave it blank." };
    }
    website = u.toString();
  }

  const brandPrimary = clean(body.brandPrimary, 7);
  const brandAccent = clean(body.brandAccent, 7);
  if (brandPrimary && !HEX_RE.test(brandPrimary)) return { error: "Brand color must look like #1a2b3c." };
  if (brandAccent && !HEX_RE.test(brandAccent)) return { error: "Accent color must look like #b8975a." };

  // Image keys must live in THIS user's branding folder (they come back from
  // the presign step); anything else is rejected, so a user can never point
  // their profile at someone else's files or an arbitrary object.
  const prefix = brandingKeyPrefix(userId);
  const keyOrNull = (k) => {
    const s = clean(k, 300);
    if (!s) return { ok: true, value: null };
    if (!s.startsWith(prefix) || s.includes("..")) return { ok: false };
    return { ok: true, value: s };
  };
  const logo = keyOrNull(body.logoKey);
  const headshot = keyOrNull(body.headshotKey);
  if (!logo.ok || !headshot.ok) return { error: "Invalid image reference. Please upload the image again." };

  return {
    row: {
      licensed_name: licensedName,
      dre_number: dreDigits,
      brokerage_name: brokerageName,
      team_name: teamName || null,
      phone: phone || null,
      contact_email: contactEmail || null,
      website: website || null,
      logo_key: logo.value,
      headshot_key: headshot.value,
      brand_primary: brandPrimary || null,
      brand_accent: brandAccent || null,
    },
  };
}

function profileForClient(row) {
  if (!row) return null;
  const b = rowToBranding(row);
  return {
    licensedName: b.licensedName,
    dreNumber: b.dreNumber,
    brokerageName: b.brokerageName,
    teamName: b.teamName,
    phone: b.phone,
    contactEmail: b.email,
    website: b.website,
    logoKey: row.logo_key || "",
    headshotKey: row.headshot_key || "",
    logoUrl: b.logoUrl,
    headshotUrl: b.headshotUrl,
    brandPrimary: b.brandPrimary,
    brandAccent: b.brandAccent,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: JSON_HEADERS, body: "" };

  const authUser = await verifyJWT(event.headers?.authorization || event.headers?.Authorization);
  if (!authUser) return reply(401, { error: "Please sign in again." });
  const userId = authUser.id;

  try {
    if (event.httpMethod === "GET") {
      const row = await getProfileRow(userId);
      // Prefill name/email from the account for first-time setup. The login
      // email may not be the address buyers should contact, so these only
      // pre-populate the form; the user confirms or changes them.
      let prefill = { licensedName: "", contactEmail: authUser.email || "" };
      try {
        const u = await supabase("GET", "users", null, `?id=eq.${userId}&select=full_name,email`);
        const rec = u.data?.[0];
        if (rec) prefill = { licensedName: rec.full_name || "", contactEmail: rec.email || authUser.email || "" };
      } catch (_) { /* prefill is a convenience only */ }
      return reply(200, { profile: profileForClient(row), prefill });
    }

    if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" });

    const action = event.queryStringParameters?.action || "save";
    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch { return reply(400, { error: "Invalid request." }); }

    if (action === "presign") {
      const kind = body.kind === "headshot" ? "headshot" : body.kind === "logo" ? "logo" : null;
      const ext = ALLOWED_IMAGE_TYPES[body.contentType];
      if (!kind || !ext) return reply(400, { error: "Upload a PNG, JPG or WebP image." });
      const bucket = process.env.S3_BUCKET_NAME;
      if (!bucket || !process.env.S3_REGION) return reply(500, { error: "Storage is not configured." });

      const key = `${brandingKeyPrefix(userId)}${kind}_${Date.now()}_${crypto.randomBytes(3).toString("hex")}.${ext}`;
      const uploadUrl = await getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: body.contentType }),
        { expiresIn: 300 }
      );
      return reply(200, { uploadUrl, key, publicUrl: publicUrlForKey(key) });
    }

    if (action === "save") {
      const v = validateProfile(body, userId);
      if (v.error) return reply(400, { error: v.error });

      const existing = await getProfileRow(userId);
      let saved;
      if (existing) {
        const res = await supabase("PATCH", "marketing_profiles", v.row,
          `?id=eq.${existing.id}&user_id=eq.${userId}`);
        saved = Array.isArray(res.data) ? res.data[0] : null;
        if (res.status >= 300 || !saved) {
          console.error("marketing-profile update failed:", res.status, JSON.stringify(res.data).slice(0, 300));
          return reply(500, { error: "Could not save your branding. Please try again." });
        }
      } else {
        const res = await supabase("POST", "marketing_profiles", { ...v.row, user_id: userId, is_default: true });
        saved = Array.isArray(res.data) ? res.data[0] : null;
        if (res.status >= 300 || !saved) {
          console.error("marketing-profile insert failed:", res.status, JSON.stringify(res.data).slice(0, 300));
          return reply(500, { error: "Could not save your branding. Please try again." });
        }
      }
      return reply(200, { profile: profileForClient(saved) });
    }

    return reply(400, { error: "Unknown action." });
  } catch (err) {
    console.error("marketing-profile error:", err.message);
    return reply(500, { error: "Something went wrong. Please try again." });
  }
};
