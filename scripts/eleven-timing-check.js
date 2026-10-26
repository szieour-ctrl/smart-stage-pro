#!/usr/bin/env node
// PR 1 check: makes ONE real call to ElevenLabs' with-timestamps endpoint and reports whether the timings are usable.
//   ELEVENLABS_API_KEY=... node scripts/eleven-timing-check.js <voiceId> <outDir> [textFile]
// It writes <outDir>/sample.mp3, sample-response.json (audio removed) and sample-words.json, and prints a findings summary.
// The text defaults to a short tagged sample; pass a text file to try the real script. One call costs the same as the narration itself.
"use strict";
const https = require("https");
const fs = require("fs");
const path = require("path");
const t = require("../netlify/functions/lib/agent-marketing-timing-lib");

const [voiceId, outDir, textFile] = process.argv.slice(2);
const key = process.env.ELEVENLABS_API_KEY;
if (!key || !voiceId || !outDir) { console.error("Usage: ELEVENLABS_API_KEY=... node scripts/eleven-timing-check.js <voiceId> <outDir> [textFile]"); process.exit(2); }
const text = textFile ? fs.readFileSync(textFile, "utf8").trim() : "[warm] Homes in Natomas sold for 99.4% of list price. [confident] Six of 14 listings cut their price, and that matters to you.";
fs.mkdirSync(outDir, { recursive: true });

const body = JSON.stringify(t.buildRequest(text));
const req = https.request({ hostname: "api.elevenlabs.io", path: t.endpointPath(voiceId), method: "POST",
  headers: { "xi-api-key": key, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
  const chunks = [];
  res.on("data", (c) => chunks.push(c));
  res.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    if (res.statusCode !== 200) { console.error(`HTTP ${res.statusCode}: ${raw.slice(0, 400)}`); process.exit(1); }
    const j = JSON.parse(raw);
    const audio = Buffer.from(j.audio_base64 || "", "base64");
    fs.writeFileSync(path.join(outDir, "sample.mp3"), audio);
    const { audio_base64, ...rest } = j;
    fs.writeFileSync(path.join(outDir, "sample-response.json"), JSON.stringify(rest, null, 2));
    const al = j.alignment;
    const lastEnd = al && al.character_end_times_seconds && al.character_end_times_seconds[al.character_end_times_seconds.length - 1];
    const check = t.checkAlignment(al, text, lastEnd);
    const words = al ? t.wordsFromAlignment(al) : [];
    fs.writeFileSync(path.join(outDir, "sample-words.json"), JSON.stringify(words, null, 2));
    console.log(JSON.stringify({
      http: res.statusCode, audioBytes: audio.length, hasAlignment: !!al, hasNormalizedAlignment: !!j.normalized_alignment,
      alignmentUsable: check.ok, problems: check.problems, characterCount: al ? al.characters.length : 0,
      alignmentIncludesAudioTags: al ? /\[[^\]]+\]/.test(al.characters.join("")) : false,
      wordCount: words.length, wordsMatchCaption: t.wordsMatchCaption(words, text), firstWords: words.slice(0, 6), lastEnd,
    }, null, 2));
  });
});
req.on("error", (e) => { console.error(e.message); process.exit(1); });
req.write(body);
req.end();
