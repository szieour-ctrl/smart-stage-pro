// agent-marketing-voice-lib.js — the subscriber's own ElevenLabs voice (Agent Marketing, slice 3, Nov 27, 2026).
// Their key and voice id are saved after one short test narration passes. The key is encrypted at rest, never sent back to the browser and never logged.
// Narration for a reel whose voice is "custom" is made with their key (billed to their ElevenLabs account); with none saved, the SSP voices are unchanged.
const crypto = require("crypto");
const https = require("https");

const CONSENT_VERSION = "2026-11-27";
const CONSENT_STORE = "I authorize Smart Stage PRO to store my ElevenLabs API key and use it to narrate my reels. The narration is billed to my ElevenLabs account.";
const CONSENT_RIGHTS = "This voice is my own, or I have the right to use it for my marketing videos.";
const TEST_MODEL = "eleven_v4";
const TEST_TEXT = "Hi, this is a quick check of your voice for Smart Stage PRO reels.";

// ── encryption ───────────────────────────────────────────────────────────────────────────────
// AGENT_MARKETING_VOICE_SECRET is the preferred secret; without it the key is derived from the server's own database key, so nothing new has to be set.
// (Rotating that secret makes saved keys unreadable; subscribers would simply save them again.)
function secretKey(env) {
  const e = env || process.env;
  const base = e.AGENT_MARKETING_VOICE_SECRET || e.SUPABASE_SERVICE_ROLE_KEY || e.SUPABASE_SERVICE_KEY;
  if (!base) throw new Error("No encryption secret is configured.");
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(base), Buffer.from("ssp-agent-marketing-voice-v1"), Buffer.from("api-key"), 32));
}
const b64u = (b) => Buffer.from(b).toString("base64url");
function encryptKey(plain, env) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", secretKey(env), iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return ["v1", b64u(iv), b64u(c.getAuthTag()), b64u(ct)].join(".");
}
function decryptKey(blob, env) {
  const p = String(blob || "").split(".");
  if (p.length !== 4 || p[0] !== "v1") throw new Error("Saved key is unreadable.");
  const d = crypto.createDecipheriv("aes-256-gcm", secretKey(env), Buffer.from(p[1], "base64url"));
  d.setAuthTag(Buffer.from(p[2], "base64url"));
  return Buffer.concat([d.update(Buffer.from(p[3], "base64url")), d.final()]).toString("utf8");
}

// ── input checks ─────────────────────────────────────────────────────────────────────────────
function validateInput(b) {
  const apiKey = String((b && b.apiKey) || "").trim(), voiceId = String((b && b.voiceId) || "").trim();
  if (!apiKey) return { error: "Paste your ElevenLabs API key." };
  if (!/^[\x21-\x7e]{16,200}$/.test(apiKey)) return { error: "That does not look like an ElevenLabs API key. Copy it again from ElevenLabs." };
  if (!voiceId) return { error: "Paste your voice ID." };
  if (!/^[A-Za-z0-9]{10,40}$/.test(voiceId)) return { error: "That does not look like a voice ID. Copy it again from My Voices in ElevenLabs." };
  if (!b || b.consentStore !== true || b.consentRights !== true) return { error: "Please tick both boxes to continue." };
  return { apiKey, voiceId };
}

// ── what ElevenLabs said, in plain words ─────────────────────────────────────────────────────
function explainFailure(status, body) {
  const d = body && (body.detail || body);
  const code = String((d && (d.status || d.code)) || "").toLowerCase();
  const msg = String((d && (d.message || (typeof d === "string" ? d : ""))) || "").toLowerCase();
  if (status === 401 || /invalid_api_key|api key|unauthor/.test(code + " " + msg)) {
    if (/permission|missing_permissions|text_to_speech/.test(code + " " + msg)) return { code: "key_permission", message: "Your API key does not allow text to speech. In ElevenLabs, edit the key and turn on Text to Speech." };
    return { code: "bad_key", message: "ElevenLabs did not accept that API key. Copy it again from ElevenLabs." };
  }
  if (/voice_not_found|voice.*not.*found|not_found/.test(code + " " + msg) || status === 404) return { code: "voice_not_found", message: "That voice ID was not found in your ElevenLabs account. Copy it again from My Voices." };
  if (/quota|credit|insufficient/.test(code + " " + msg) || status === 402) return { code: "no_credits", message: "Your ElevenLabs account is out of credits. Add credits or upgrade your plan, then try again." };
  if (/model|v4|not.*support|fine.?tun/.test(msg) || status === 400 || status === 422) return { code: "voice_not_v4", message: "That voice could not be used with Eleven v4. A professional voice must be fine-tuned for Eleven v4 in My Voices first." };
  if (status === 429) return { code: "busy", message: "ElevenLabs is busy right now. Please try again in a minute." };
  return { code: "unavailable", message: "ElevenLabs could not make the test narration. Please try again." };
}

// ── the one short test call (costs the subscriber a few credits) ──────────────────────────────
function elevenSpeak({ apiKey, voiceId, text, modelId, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text, model_id: modelId || TEST_MODEL });
    const req = https.request({
      hostname: "api.elevenlabs.io", path: `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_64`, method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    });
    req.setTimeout(timeoutMs || 20000, () => req.destroy(new Error("timeout")));
    req.on("error", reject); req.write(body); req.end();
  });
}
async function testVoice({ apiKey, voiceId, speak }) {
  let r;
  try { r = await (speak || elevenSpeak)({ apiKey, voiceId, text: TEST_TEXT, modelId: TEST_MODEL }); }
  catch (e) { return { ok: false, code: "unavailable", message: "ElevenLabs did not answer in time. Please try again." }; }
  if (r.status === 200 && r.buf && r.buf.length > 1000) return { ok: true, audio_base64: r.buf.toString("base64"), mime: "audio/mpeg" };
  let body = null; try { body = JSON.parse(r.buf.toString("utf8")); } catch {}
  return { ok: false, ...explainFailure(r.status, body) };
}

// ── saved settings ───────────────────────────────────────────────────────────────────────────
const last4 = (k) => String(k).slice(-4);
/** What the browser may see: never the key. */
function publicState(row) {
  return row ? { saved: true, voiceId: row.voice_id, keyLast4: row.key_last4 || null, testedAt: row.tested_at || null, model: row.test_model || TEST_MODEL } : { saved: false };
}
/** { voiceId, apiKey } for a saved voice, or null. Throws only when the saved key can no longer be read. */
function credentialsFrom(row, env) { return row ? { voiceId: row.voice_id, apiKey: decryptKey(row.key_enc, env) } : null; }

module.exports = { CONSENT_VERSION, CONSENT_STORE, CONSENT_RIGHTS, TEST_MODEL, TEST_TEXT, encryptKey, decryptKey, validateInput, explainFailure, elevenSpeak, testVoice, publicState, credentialsFrom, last4 };
