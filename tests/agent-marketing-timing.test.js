"use strict";
const test = require("node:test");
const assert = require("node:assert");
const t = require("../netlify/functions/lib/agent-marketing-timing-lib");

// A synthetic alignment: every character takes 0.05 s, spaces included, tags included (ElevenLabs aligns the text it was sent).
function fake(text, per = 0.05) {
  const characters = [...text];
  return { characters, character_start_times_seconds: characters.map((_, i) => +(i * per).toFixed(3)), character_end_times_seconds: characters.map((_, i) => +((i + 1) * per).toFixed(3)) };
}
const TEXT = "[warm] Homes sold for 99.4% of list price. [confident] Six of 14 cut their price, which matters.";

test("request and endpoint", () => {
  assert.deepStrictEqual(t.buildRequest("hi"), { text: "hi", model_id: "eleven_v3" });
  assert.deepStrictEqual(t.buildRequest("hi", { speed: 0.95 }).voice_settings, { speed: 0.95 });
  assert.strictEqual(t.endpointPath("abc"), "/v1/text-to-speech/abc/with-timestamps");
});

test("checkAlignment accepts a good alignment and names each problem", () => {
  const al = fake(TEXT);
  assert.ok(t.checkAlignment(al, TEXT, 6).ok);
  assert.ok(!t.checkAlignment(null).ok);
  assert.ok(!t.checkAlignment({ ...al, character_end_times_seconds: al.character_end_times_seconds.slice(1) }).ok);
  assert.ok(t.checkAlignment(al, TEXT + "x").problems.some((p) => /do not spell/.test(p)));
  const back = { ...al, character_start_times_seconds: al.character_start_times_seconds.slice() };
  back.character_start_times_seconds[10] = 0;
  assert.ok(!t.checkAlignment(back).ok);
  assert.ok(t.checkAlignment(al, TEXT, 1).problems.some((p) => /after the audio/.test(p)));
});

test("words skip audio tags and keep the punctuation the agent approved", () => {
  const words = t.wordsFromAlignment(fake(TEXT));
  assert.deepStrictEqual(words.map((w) => w.text), "Homes sold for 99.4% of list price. Six of 14 cut their price, which matters.".split(" "));
  assert.ok(words.every((w) => w.end > w.start));
  assert.ok(t.wordsMatchCaption(words, TEXT));
  assert.ok(!t.wordsMatchCaption(words.slice(1), TEXT));
});

test("caption lines break at sentence ends and size limits, and never overlap", () => {
  const lines = t.groupCaptionLines(t.wordsFromAlignment(fake(TEXT)));
  assert.ok(lines.length >= 3);
  assert.ok(lines.every((l) => l.text.length <= 40));
  assert.ok(lines.some((l) => /price\.$/.test(l.text)));
  for (let i = 1; i < lines.length; i++) assert.ok(lines[i].start >= lines[i - 1].end - 1e-9);
});

test("scene windows follow the excerpts and cover the audio", () => {
  const words = t.wordsFromAlignment(fake(TEXT));
  const r = t.sceneWindows(words, ["Homes sold for 99.4% of list price.", "Six of 14 cut their price, which matters."], 5);
  assert.strictEqual(r.windows.length, 2);
  assert.strictEqual(r.windows[0].start, 0);
  assert.strictEqual(r.windows[0].end, r.windows[1].start);
  assert.ok(r.windows[1].end >= 5);
  assert.ok(t.sceneWindows(words, ["Homes sold"], 5).error);
});
