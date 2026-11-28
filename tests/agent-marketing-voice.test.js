// Agent Marketing, slice 3: the subscriber's own ElevenLabs voice. Every outside call is a stand-in: this spends nothing.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const V = require("../netlify/functions/lib/agent-marketing-voice-lib");

const KEY = "sk_live_0123456789abcdefXYZ9";
const ok = { apiKey: KEY, voiceId: "JBFqnCBsd6RMkjVDRZzb", consentStore: true, consentRights: true };

test("the key is encrypted at rest, round-trips, and a different secret cannot read it", () => {
  const env = { AGENT_MARKETING_VOICE_SECRET: "secret-one" };
  const blob = V.encryptKey(KEY, env);
  assert.ok(!blob.includes(KEY) && blob.startsWith("v1."));
  assert.strictEqual(V.decryptKey(blob, env), KEY);
  assert.notStrictEqual(V.encryptKey(KEY, env), blob, "a fresh iv every time");
  assert.throws(() => V.decryptKey(blob, { AGENT_MARKETING_VOICE_SECRET: "secret-two" }));
  assert.throws(() => V.decryptKey(blob.slice(0, -4) + "AAAA", env), "tampering is caught");
  assert.strictEqual(V.decryptKey(V.encryptKey(KEY, { SUPABASE_SERVICE_ROLE_KEY: "svc" }), { SUPABASE_SERVICE_ROLE_KEY: "svc" }), KEY, "falls back to the database key");
  assert.throws(() => V.encryptKey(KEY, {}), /secret/i);
});

test("input checks: both fields, both boxes, plain messages", () => {
  assert.deepStrictEqual(V.validateInput(ok), { apiKey: KEY, voiceId: "JBFqnCBsd6RMkjVDRZzb" });
  assert.match(V.validateInput({ ...ok, apiKey: "" }).error, /API key/);
  assert.match(V.validateInput({ ...ok, apiKey: "short" }).error, /does not look like/);
  assert.match(V.validateInput({ ...ok, voiceId: "" }).error, /voice ID/);
  assert.match(V.validateInput({ ...ok, voiceId: "bad id!" }).error, /does not look like a voice ID/);
  assert.match(V.validateInput({ ...ok, consentStore: false }).error, /both boxes/);
  assert.match(V.validateInput({ ...ok, consentRights: undefined }).error, /both boxes/);
  assert.strictEqual(V.validateInput({ ...ok, apiKey: "  " + KEY + " " }).apiKey, KEY, "pasted spaces are trimmed");
});

test("ElevenLabs failures become clear messages", () => {
  assert.strictEqual(V.explainFailure(401, { detail: { status: "invalid_api_key", message: "Invalid API key" } }).code, "bad_key");
  assert.strictEqual(V.explainFailure(401, { detail: { status: "missing_permissions", message: "missing the permission text_to_speech" } }).code, "key_permission");
  assert.strictEqual(V.explainFailure(404, { detail: { status: "voice_not_found" } }).code, "voice_not_found");
  assert.strictEqual(V.explainFailure(402, { detail: { status: "quota_exceeded", message: "You have insufficient credits" } }).code, "no_credits");
  assert.strictEqual(V.explainFailure(400, { detail: { message: "The selected model can not be used for text to speech" } }).code, "voice_not_v4");
  assert.strictEqual(V.explainFailure(429, {}).code, "busy");
  assert.strictEqual(V.explainFailure(500, null).code, "unavailable");
  for (const c of ["bad_key", "voice_not_found", "no_credits", "voice_not_v4"]) assert.ok(V.explainFailure(c === "bad_key" ? 401 : c === "voice_not_found" ? 404 : c === "no_credits" ? 402 : 400, { detail: { status: c === "bad_key" ? "invalid_api_key" : c === "voice_not_found" ? "voice_not_found" : c === "no_credits" ? "quota_exceeded" : "", message: "model" } }).message.length > 20);
});

test("save-and-test: one eleven_v4 call with their key and voice; success returns audio, failure returns the reason", async () => {
  const calls = [];
  const good = async (a) => { calls.push(a); return { status: 200, buf: Buffer.alloc(4000, 1) }; };
  const r = await V.testVoice({ apiKey: KEY, voiceId: "JBFqnCBsd6RMkjVDRZzb", speak: good });
  assert.ok(r.ok && r.audio_base64 && r.mime === "audio/mpeg");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].modelId, "eleven_v4"); assert.strictEqual(calls[0].apiKey, KEY);
  const bad = await V.testVoice({ apiKey: KEY, voiceId: "x".repeat(12), speak: async () => ({ status: 401, buf: Buffer.from(JSON.stringify({ detail: { status: "invalid_api_key" } })) }) });
  assert.ok(!bad.ok && bad.code === "bad_key" && !("audio_base64" in bad));
  const empty = await V.testVoice({ apiKey: KEY, voiceId: "x".repeat(12), speak: async () => ({ status: 200, buf: Buffer.alloc(10) }) });
  assert.ok(!empty.ok, "an empty answer is not a pass");
  const down = await V.testVoice({ apiKey: KEY, voiceId: "x".repeat(12), speak: async () => { throw new Error("socket"); } });
  assert.ok(!down.ok && down.code === "unavailable");
});

test("what the browser may see never includes the key", () => {
  const row = { voice_id: "JBFqnCBsd6RMkjVDRZzb", key_enc: V.encryptKey(KEY, { AGENT_MARKETING_VOICE_SECRET: "s" }), key_last4: V.last4(KEY), tested_at: "2026-11-27T00:00:00Z" };
  const pub = JSON.stringify(V.publicState(row));
  assert.ok(!pub.includes("key_enc") && !pub.includes(KEY) && !pub.includes(row.key_enc));
  assert.strictEqual(V.publicState(null).saved, false);
  assert.strictEqual(V.credentialsFrom(row, { AGENT_MARKETING_VOICE_SECRET: "s" }).apiKey, KEY);
  assert.strictEqual(V.credentialsFrom(null), null);
});

test("wiring: the function returns no key, the narration step uses the subscriber's key only for 'custom', and the old test option is gone", () => {
  const fn = fs.readFileSync(__dirname + "/../netlify/functions/agent-marketing-voice.js", "utf8");
  assert.ok(!/key_enc[^,]*\breply\(/.test(fn));
  assert.ok(!/console\.(log|error)\([^)]*(apiKey|key_enc|b\.apiKey)/.test(fn), "the key is never logged");
  const prep = fs.readFileSync(__dirname + "/../netlify/functions/agent-marketing-prepare-background.js", "utf8");
  assert.match(prep, /project\.voice === "custom"/);
  assert.match(prep, /"xi-api-key": apiKey/);
  for (const f of ["agent-marketing.html", "netlify/functions/lib/agent-marketing-lib.js", "netlify/functions/lib/agent-marketing-assets-lib.js"]) assert.ok(!/VOICE_CUSTOM_TEST|My voice \(test\)/.test(fs.readFileSync(__dirname + "/../" + f, "utf8").replace(/\/\/.*$/gm, "")), f);
});
