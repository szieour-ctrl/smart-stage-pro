// Lip sync wiring: Off by default on the page and on the job; the request is saved only when asked for; clip links reach the renderer.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const read = (p) => fs.readFileSync(__dirname + "/../" + p, "utf8");
const html = read("agent-marketing.html"), render = read("netlify/functions/agent-marketing-render.js"), prep = read("netlify/functions/agent-marketing-prepare-background.js");

test("page: the Lip sync box exists, starts unchecked, and its value is sent with the Reel request", () => {
  const box = html.match(/<input type="checkbox" id="reelLip"[^>]*>/);
  assert.ok(box, "checkbox present");
  assert.ok(!/checked/.test(box[0]), "unchecked by default");
  assert.match(html, /advertisingConfirmed: true, lipSync: !!\$\("reelLip"\)\.checked/);
  assert.match(html, /\$\("reelLip"\)\.disabled = on/);
});
test("render endpoint: the request is saved on the job only when lipSync is exactly true; a retry reuses the same job", () => {
  assert.match(render, /\.\.\.\(b\.lipSync === true \? \{ assets: \{ lipsync: \{ requested: true \} \} \} : \{\}\)/);
});
test("prepare step: Lip sync runs only for a job that asked, never stops the Reel, and clip links go to the renderer", () => {
  assert.match(prep, /if \(!lip\.requested\(job\)\) return \{ manifest, report: null \};/);
  assert.match(prep, /still headshots|using still headshots/);
  const { dispatchKeys } = require("../netlify/functions/agent-marketing-prepare-background.js");
  const m = { audio: { narration_key: "n" }, scenes: [{ visual: { image_keys: { "9x16": "i1" } }, lipsync: { clip_key: "c1" } }, { visual: { image_keys: { "9x16": "i2" } } }] };
  assert.deepStrictEqual([...dispatchKeys(m, "hs")].sort(), ["c1", "hs", "i1", "i2", "n"]);
  assert.deepStrictEqual([...dispatchKeys({ ...m, scenes: [m.scenes[1]] }, "hs")].sort(), ["hs", "i2", "n"]);
});
