// Stateless share tokens for Reels: base64url(JSON{k:key,e:expEpochSec}) + "." + HMAC-SHA256.
// No DB: the token itself carries the S3 key and expiry. Secret = REEL_SHARE_SECRET, or (until it is set)
// a value derived from the Supabase service key so sharing works out of the box.
const crypto = require("crypto");
const DRAFT_PREFIX = "smart-stage-reel-drafts/";
const KEY_RE = /^smart-stage-reel-drafts\/[\w-]{6,80}\/(branded|unbranded)_\d+\.mp4$/;
const SHARE_SECONDS = 7 * 24 * 3600;

function secret() {
  return process.env.REEL_SHARE_SECRET || crypto.createHash("sha256").update("reel-share:" + (process.env.SUPABASE_SERVICE_ROLE_KEY || "")).digest("hex");
}
const b64 = (s) => Buffer.from(s).toString("base64url");
const mac = (p) => crypto.createHmac("sha256", secret()).update(p).digest("base64url");

function makeToken(key, expSec) {
  const p = b64(JSON.stringify({ k: key, e: expSec }));
  return `${p}.${mac(p)}`;
}
// Returns {key, exp} or {error: "invalid"|"expired"}
function readToken(t) {
  const [p, sig] = String(t || "").split(".");
  if (!p || !sig) return { error: "invalid" };
  const want = mac(p);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return { error: "invalid" };
  let o; try { o = JSON.parse(Buffer.from(p, "base64url").toString()); } catch { return { error: "invalid" }; }
  if (!o || !KEY_RE.test(String(o.k || ""))) return { error: "invalid" };
  if (!(o.e > Date.now() / 1000)) return { error: "expired" };
  return { key: o.k, exp: o.e };
}
module.exports = { makeToken, readToken, KEY_RE, DRAFT_PREFIX, SHARE_SECONDS };
