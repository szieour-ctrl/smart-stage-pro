// lib/agent-marketing-timing-lib.js — Netlify (shared). Word timings and caption lines for Agent Marketing narration (Oct 26, 2026).
//
// ElevenLabs' POST /v1/text-to-speech/{voice_id}/with-timestamps returns the audio (audio_base64) and, per CHARACTER, the start and end
// time in seconds: `alignment` for the text exactly as sent and `normalized_alignment` for the text after ElevenLabs expands numbers
// and symbols. We use `alignment`, so the caption words are the words the agent approved ("99.4%", "41"), not their spoken expansion.
//
// Pure functions only: no network. The script scripts/eleven-timing-check.js makes the real call and feeds the response in here.
"use strict";

const TAG_RE = /\[[^\]\n]{1,40}\]/g;

/** The body for the with-timestamps endpoint. The tagged narration is sent as written; tags are not spoken. */
function buildRequest(taggedText, { modelId = "eleven_v3", speed } = {}) {
  const body = { text: String(taggedText || ""), model_id: modelId };
  if (speed) body.voice_settings = { speed };
  return body;
}

/** The endpoint path for a voice. */
function endpointPath(voiceId) {
  return `/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps`;
}

/** Checks the shape of an alignment object. Returns { ok, problems[] }. Never throws. */
function checkAlignment(al, sentText, audioSeconds) {
  const problems = [];
  if (!al || typeof al !== "object") return { ok: false, problems: ["The response has no alignment."] };
  const { characters: ch, character_start_times_seconds: st, character_end_times_seconds: en } = al;
  if (!Array.isArray(ch) || !Array.isArray(st) || !Array.isArray(en)) return { ok: false, problems: ["The alignment is missing one of its three arrays."] };
  if (ch.length !== st.length || ch.length !== en.length) problems.push("The three alignment arrays differ in length.");
  if (!ch.length) problems.push("The alignment is empty.");
  let prev = -Infinity;
  for (let i = 0; i < Math.min(st.length, en.length); i++) {
    if (!Number.isFinite(st[i]) || !Number.isFinite(en[i])) { problems.push(`Character ${i} has a non-numeric time.`); break; }
    if (en[i] < st[i]) { problems.push(`Character ${i} ends before it starts.`); break; }
    if (st[i] + 0.02 < prev) { problems.push(`Character ${i} starts before the previous one.`); break; }
    prev = st[i];
  }
  // Whether v3 returns the [audio tags] in the alignment is one of the things the check script reports, so compare the spoken words only.
  const spoken = (x) => String(x).replace(TAG_RE, " ").replace(/\s+/g, " ").trim();
  if (sentText != null && spoken(ch.join("")) !== spoken(sentText)) problems.push("The alignment characters do not spell the text that was sent.");
  if (Number.isFinite(audioSeconds) && en.length && en[en.length - 1] > audioSeconds + 0.5) problems.push("The last character ends after the audio does.");
  return { ok: problems.length === 0, problems };
}

/**
 * Words with start and end seconds, from the character alignment. A word is a run of non-space characters outside [audio tags].
 * Returns [{ text, start, end }] in spoken order.
 */
function wordsFromAlignment(al) {
  const ch = (al && al.characters) || [], st = (al && al.character_start_times_seconds) || [], en = (al && al.character_end_times_seconds) || [];
  const text = ch.join("");
  const inTag = new Array(ch.length).fill(false);
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(text))) for (let i = m.index; i < m.index + m[0].length; i++) inTag[i] = true;
  const words = [];
  let cur = null;
  for (let i = 0; i < ch.length; i++) {
    const isSpace = /\s/.test(ch[i]);
    if (inTag[i] || isSpace) { if (cur) { words.push(cur); cur = null; } continue; }
    if (!cur) cur = { text: "", start: st[i], end: en[i] };
    cur.text += ch[i];
    cur.end = en[i];
  }
  if (cur) words.push(cur);
  return words;
}

/** The caption words: the narration with audio tags removed, split on whitespace. */
function captionWords(taggedText) {
  return String(taggedText || "").replace(TAG_RE, " ").split(/\s+/).filter(Boolean);
}

/** True when the timed words are exactly the caption words, in order. */
function wordsMatchCaption(words, taggedText) {
  const want = captionWords(taggedText);
  return want.length === words.length && want.every((w, i) => w === words[i].text);
}

/**
 * Group timed words into caption lines. A line breaks at a sentence end, or when it is full (characters or words) or runs too long.
 * Each line shows from its first word's start to its last word's end (held a little so it can be read), never past the next line.
 */
function groupCaptionLines(words, { maxChars = 34, maxWords = 6, maxSeconds = 2.8, minHold = 0.7 } = {}) {
  const lines = [];
  let cur = [];
  const flush = () => { if (cur.length) { lines.push({ text: cur.map((w) => w.text).join(" "), start: cur[0].start, end: cur[cur.length - 1].end }); cur = []; } };
  for (const w of words) {
    const next = cur.concat(w);
    const chars = next.map((x) => x.text).join(" ").length;
    if (cur.length && (chars > maxChars || next.length > maxWords || w.end - cur[0].start > maxSeconds)) flush();
    cur.push(w);
    if (/[.!?]["')\]]*$/.test(w.text)) flush();
  }
  flush();
  for (let i = 0; i < lines.length; i++) {
    const limit = i + 1 < lines.length ? lines[i + 1].start : Infinity;
    lines[i].end = Math.min(Math.max(lines[i].end, lines[i].start + minHold), limit);
  }
  return lines;
}

/**
 * Where each scene starts and ends in the audio. `excerpts` are the scenes' narration_excerpt strings, which together are the narration in order.
 * Scenes take consecutive runs of words; a scene starts where its first word starts and ends where the next scene starts (the last, where the audio ends).
 */
function sceneWindows(words, excerpts, audioSeconds) {
  const counts = excerpts.map((e) => captionWords(e).length);
  const total = counts.reduce((a, b) => a + b, 0);
  if (total !== words.length) return { error: `The scene excerpts have ${total} words but the narration has ${words.length}.` };
  const out = [];
  let at = 0;
  for (let i = 0; i < counts.length; i++) {
    const first = words[at], last = words[at + counts[i] - 1];
    if (!first) return { error: `Scene ${i + 1} has no words.` };
    out.push({ start: first.start, firstWordEnd: first.end, lastWordEnd: last.end });
    at += counts[i];
  }
  const windows = out.map((w, i) => ({ start: i === 0 ? 0 : w.start, end: i + 1 < out.length ? out[i + 1].start : Number.isFinite(audioSeconds) ? Math.max(audioSeconds, w.lastWordEnd) : w.lastWordEnd }));
  return { windows };
}

module.exports = { buildRequest, endpointPath, checkAlignment, wordsFromAlignment, captionWords, wordsMatchCaption, groupCaptionLines, sceneWindows };
