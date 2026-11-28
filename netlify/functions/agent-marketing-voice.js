// agent-marketing-voice.js — Netlify Function. The subscriber's own ElevenLabs voice (Agent Marketing, slice 3, Nov 27, 2026).
// Same switch as the rest of Agent Marketing; 404 when off. The user always comes from the login token. The saved key is never returned.
//
//   GET                                  → { saved, voiceId, keyLast4, testedAt, consent: { version, store, rights } }
//   POST { action: "save", apiKey, voiceId, consentStore, consentRights } → one short test narration; saved only if it passes → state + { audio_base64, mime }
//   POST { action: "retest" }            → the same test with the saved key (a few credits of theirs)
//   POST { action: "remove" }            → deletes the key; reels go back to the SSP voices
const { supabase } = require("./lib/marketing-profile-lib");
const { requireUser } = require("./lib/reel-auth-lib");
const am = require("./lib/agent-marketing-lib");
const V = require("./lib/agent-marketing-voice-lib");

const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Cache-Control": "no-store" };
const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });
const consent = { version: V.CONSENT_VERSION, store: V.CONSENT_STORE, rights: V.CONSENT_RIGHTS };

async function loadRow(userId) {
  const r = await supabase("GET", "agent_marketing_voices", null, `?user_id=eq.${userId}&select=*&limit=1`);
  return Array.isArray(r.data) && r.data[0] ? r.data[0] : null;
}
const stateOf = (row) => ({ ...V.publicState(row), consent });

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" }, body: "" };
  const auth = await requireUser(event);
  if (auth.error) return reply(auth.error.status, auth.error.body);
  const userId = auth.user.id;
  if (!am.isEnabledFor(userId)) return reply(404, { error: "Not found" });
  try {
    if (event.httpMethod === "GET") return reply(200, stateOf(await loadRow(userId)));
    if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" });
    let b = {}; try { b = JSON.parse(event.body || "{}"); } catch { return reply(400, { error: "Invalid request." }); }

    if (b.action === "save") {
      const v = V.validateInput(b);
      if (v.error) return reply(400, { error: v.error });
      const t = await V.testVoice({ apiKey: v.apiKey, voiceId: v.voiceId });
      if (!t.ok) return reply(422, { error: t.message, code: t.code });   // nothing is saved when the test fails
      const now = new Date().toISOString();
      const fields = { voice_id: v.voiceId, key_enc: V.encryptKey(v.apiKey), key_last4: V.last4(v.apiKey), consent_version: V.CONSENT_VERSION, consent_at: now, tested_at: now, test_model: V.TEST_MODEL, updated_at: now };
      const had = await loadRow(userId);
      const w = had ? await supabase("PATCH", "agent_marketing_voices", fields, `?user_id=eq.${userId}`) : await supabase("POST", "agent_marketing_voices", { user_id: userId, ...fields });
      if (w.status >= 300) return reply(500, { error: "Could not save your voice. Please try again." });
      return reply(200, { ...stateOf(await loadRow(userId)), audio_base64: t.audio_base64, mime: t.mime });
    }

    if (b.action === "retest") {
      const row = await loadRow(userId);
      if (!row) return reply(404, { error: "No voice is saved yet." });
      let creds; try { creds = V.credentialsFrom(row); } catch { return reply(422, { error: "Your saved key could not be read. Please save it again.", code: "unreadable" }); }
      const t = await V.testVoice(creds);
      if (!t.ok) return reply(422, { error: t.message, code: t.code });
      const now = new Date().toISOString();
      await supabase("PATCH", "agent_marketing_voices", { tested_at: now, updated_at: now }, `?user_id=eq.${userId}`);
      return reply(200, { ...stateOf(await loadRow(userId)), audio_base64: t.audio_base64, mime: t.mime });
    }

    if (b.action === "remove") {
      const w = await supabase("DELETE", "agent_marketing_voices", null, `?user_id=eq.${userId}`);
      if (w.status >= 300) return reply(500, { error: "Could not remove your key. Please try again." });
      return reply(200, stateOf(null));
    }
    return reply(400, { error: "Unknown action." });
  } catch (e) {
    console.error("agent-marketing-voice error:", e.message);   // never the key or the request body
    return reply(500, { error: "Something went wrong. Please try again." });
  }
};
