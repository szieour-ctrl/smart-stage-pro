// agent-marketing-pronunciations.js — Netlify Function (Oct 29, 2026)
// Each agent's saved narrator pronunciations, and a "Hear this word" preview.
//
//   GET                              → { items: [{ written, say }] }
//   POST { action: "save", items }   → { items }                 replaces the agent's saved list
//   POST { action: "hear", say, projectId? } → { audio_base64, mime }   one short ElevenLabs call in the project's voice
//
// The user always comes from the login token. The saved list is applied by the Reel build (agent-marketing-prepare-background) to any script that
// contains the written word. "Hear" speaks only the respelling (at most 40 characters), so the cost is a few characters of narration per click.
const https = require("https");
const { supabase } = require("./lib/marketing-profile-lib");
const { requireUser } = require("./lib/reel-auth-lib");
const am = require("./lib/agent-marketing-lib");
const assetsLib = require("./lib/agent-marketing-assets-lib");
const timing = require("./lib/agent-marketing-timing-lib");

const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Cache-Control": "no-store" };
const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });
const TTS_MODEL = process.env.AGENT_MARKETING_TTS_MODEL || "eleven_v4";

function speak(voiceId, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text, model_id: TTS_MODEL });
    const req = https.request({
      hostname: "api.elevenlabs.io", path: `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_64`, method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json", Accept: "audio/mpeg", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    });
    req.setTimeout(30000, () => req.destroy(new Error("The narration service timed out")));
    req.on("error", reject); req.write(body); req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" }, body: "" };
  const auth = await requireUser(event);
  if (auth.error) return reply(auth.error.status, auth.error.body);
  const userId = auth.user.id;
  if (!am.isEnabledFor(userId)) return reply(404, { error: "Not found" });
  try {
    if (event.httpMethod === "GET") {
      const r = await supabase("GET", "agent_marketing_pronunciations", null, `?user_id=eq.${userId}&select=items&limit=1`);
      return reply(200, { items: timing.cleanPronunciations(Array.isArray(r.data) && r.data[0] ? r.data[0].items : []) });
    }
    if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" });
    let b;
    try { b = JSON.parse(event.body || "{}"); } catch { return reply(400, { error: "Invalid JSON" }); }
    if (b.action === "save") {
      const items = timing.cleanPronunciations(b.items);
      const now = new Date().toISOString();
      const ex = await supabase("GET", "agent_marketing_pronunciations", null, `?user_id=eq.${userId}&select=user_id&limit=1`);
      const res = Array.isArray(ex.data) && ex.data[0]
        ? await supabase("PATCH", "agent_marketing_pronunciations", { items, updated_at: now }, `?user_id=eq.${userId}`)
        : await supabase("POST", "agent_marketing_pronunciations", { user_id: userId, items, updated_at: now });
      if (res.status >= 300) return reply(500, { error: "Could not save your pronunciations" });
      return reply(200, { items });
    }
    if (b.action === "hear") {
      const say = timing.cleanPronunciations([{ written: "x", say: b.say }])[0];
      if (!say) return reply(400, { error: "Type how the word should sound first." });
      if (!process.env.ELEVENLABS_API_KEY) return reply(500, { error: "Narration is not configured." });
      let voice = "ssp_male";
      if (am.UUID_RE.test(String(b.projectId || ""))) {
        const p = await supabase("GET", "agent_marketing_projects", null, `?id=eq.${b.projectId}&user_id=eq.${userId}&select=voice&limit=1`);
        if (Array.isArray(p.data) && p.data[0] && p.data[0].voice) voice = p.data[0].voice;
      }
      const voiceId = assetsLib.voiceIdFor(voice);
      if (!voiceId) return reply(500, { error: "This voice is not configured yet." });
      const r = await speak(voiceId, say.say);
      if (r.status !== 200 || !r.buf.length) return reply(502, { error: "The narration service could not make the preview. Please try again." });
      return reply(200, { audio_base64: r.buf.toString("base64"), mime: "audio/mpeg" });
    }
    return reply(400, { error: "Unknown action" });
  } catch (e) {
    console.error("agent-marketing-pronunciations error:", e.message);
    return reply(500, { error: "Something went wrong. Please try again." });
  }
};
