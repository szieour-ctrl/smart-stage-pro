"use strict";
// Nov 24, 2026 (Sam): two plain notices around script edits. (1) The script editor says an edit changes the Reel's length and that times are approximate.
// (2) After a script edit, the Visuals step says approved images stay with their scene numbers and how to replace one. No server, Writer, planner or renderer change.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "agent-marketing.html"), "utf8");

test("the page's inline script still parses", () => {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 1);
  blocks.forEach((b) => assert.doesNotThrow(() => new vm.Script(b)));
});

test("the script editor warns that edits change the length and that times are approximate", () => {
  const m = html.match(/<div class="hint" id="editLengthNote">([^<]+)<\/div>/);
  assert.ok(m, "editor note is present");
  assert.match(m[1], /Editing the script changes the Reel's length/);
  assert.match(m[1], /approximate/);
  assert.match(m[1], /after the narration is made/);
  // it sits in the script editor, right after the narration box and its word hint
  assert.ok(html.indexOf('id="narration"') < html.indexOf('id="editLengthNote"'));
  assert.ok(html.indexOf('id="editLengthNote"') < html.indexOf('id="writerBox"'));
});

test("the Visuals step note is hidden by default and says images are kept and how to replace one", () => {
  const m = html.match(/<div class="note hidden" id="imagesKeptNote">([^<]+)<\/div>/);
  assert.ok(m, "kept-images note is present and hidden by default");
  assert.match(m[1], /approved images stay with their scene numbers/);
  assert.match(m[1], /Remove image/);
  assert.ok(html.indexOf('id="stepImages"') < html.indexOf('id="imagesKeptNote"'));
});

test("the kept-images note shows only for an edited script with at least one approved image", () => {
  const line = html.split("\n").find((l) => l.includes('$("imagesKeptNote").classList.toggle'));
  assert.ok(line, "toggle is wired in renderImages");
  assert.match(line, /kn\.source === "edited"/);
  assert.match(line, /im\.slots\.some\(function \(x\) \{ return x\.approved; \}\)/);
  // the note is decided after the images are loaded, so it never reads stale slots
  assert.ok(html.indexOf("await loadImages();\n    // Nov 24, 2026") > -1);
});

test("the \"Remove image\" control the note points to exists on the Visuals step", () => {
  assert.match(html, /actBtn\("reject", "Remove image"/);
});
