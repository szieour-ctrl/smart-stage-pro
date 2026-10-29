const test = require("node:test");
const assert = require("node:assert/strict");
const t = require("../netlify/functions/lib/agent-marketing-timing-lib.js");

const list = [{ written: "Denio's", say: "Duh-NYE-oh's" }];
test("the narrator gets the respelling, the captions keep the written word", () => {
  const tagged = "[warm] Capital City Coffee & Cars rolls into Denio's Market, and Denio’s is a great stop.";
  const sent = t.applyPronunciations(tagged, list);
  assert.match(sent, /Duh-NYE-oh's Market/);
  assert.match(sent, /Duh-NYE-oh's is a great/);
  assert.doesNotMatch(sent, /Denio/);
  const words = sent.replace(/\[[^\]]*\]/g, " ").split(/\s+/).filter(Boolean).map((w, i) => ({ text: w, start: i, end: i + 1 }));
  const back = t.restorePronunciations(words, list);
  assert.ok(t.wordsMatchCaption(back, tagged.replace("’", "'")) || back.map((w) => w.text).join(" ").includes("Denio's Market,"));
  assert.equal(back.filter((w) => /Denio/.test(w.text)).length, 2);
});
test("a respelling is one token and never reaches captions; bad entries are dropped", () => {
  const c = t.cleanPronunciations([{ written: "Denio's", say: "Duh NYE oh's" }, { written: "Two Words", say: "x" }, { written: "[tag]", say: "" }, { written: "Same", say: "same" }]);
  assert.deepEqual(c, [{ written: "Denio's", say: "Duh-NYE-oh's" }]);
});
test("a written name without the possessive still keeps 's", () => {
  const l = [{ written: "Denio", say: "Duh-NYE-oh" }];
  const sent = t.applyPronunciations("Denio's Market", l);
  assert.equal(sent, "Duh-NYE-oh's Market");
  const back = t.restorePronunciations([{ text: "Duh-NYE-oh's", start: 0, end: 1 }, { text: "Market", start: 1, end: 2 }], l);
  assert.equal(back[0].text, "Denio's");
});
test("no entries changes nothing", () => {
  assert.equal(t.applyPronunciations("Hello Denio's", []), "Hello Denio's");
  const w = [{ text: "Hello", start: 0, end: 1 }];
  assert.equal(t.restorePronunciations(w, undefined), w);
});
