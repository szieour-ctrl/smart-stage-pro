const test = require("node:test");
const assert = require("node:assert/strict");
const cc = require("../netlify/functions/lib/agent-marketing-cardcopy-lib");

// Oct 30, 2026: card text was the main reason Reels fell back to plain narration text. A failed scene is asked again, alone, with the reason.
const narrative = { scenes: [
  { role: "Local hook", narrationExcerpt: "Half of Antelope's active listings have already cut their price." },
  { role: "Tension", narrationExcerpt: "Right now, 28 of the 56 active listings have taken a price reduction." },
  { role: "Insight", narrationExcerpt: "Canceled listings sat a median of 49 days and never found a buyer." },
  { role: "Consequence", narrationExcerpt: "Pricing right the first time is what separates a clean close from a listing that quietly disappears." },
  { role: "Close", narrationExcerpt: "If you'd like a second opinion on pricing, send me a message." },
], hook: "Half of Antelope's active listings have already cut their price" };
const base = { project: { template: "local_market_insider", intake: { market: "Antelope" } }, narrative, intake: { market: "Antelope" }, reportFigures: [] };

test("a scene that is over its cap is asked again alone, with the reason, and the corrected card is kept", async () => {
  const seen = [];
  const callFn = async (sys, user) => {
    const u = JSON.parse(user); seen.push(u);
    if (!u.fix_these) return JSON.stringify({ cards: [
      { index: 1, headline: "Price cuts are the new normal here", statement: "Half the area has trimmed", support: "Start where buyers are" },
      { index: 2, headline: "Waiting longer rarely pays off for sellers", statement: "One two three four five six seven eight", support: "" },
      { index: 3, headline: "Right pricing opens the door", statement: "", support: "" },
    ] });
    return JSON.stringify({ cards: [{ index: 2, headline: "Waiting longer rarely pays off", statement: "Time on market costs sellers", support: "" }] });
  };
  const notes = [];
  const out = await cc.writeCardCopy({ ...base, callFn, log: (m) => notes.push(m) });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1].scenes.map((s) => s.index), [2], "only the failed scene is sent again");
  assert.match(seen[1].fix_these[0].problem, /statement is over 7 words/);
  assert.equal(out[2].statement, "Time on market costs sellers");
  assert.ok(out[1] && out[3], "cards that passed the first time are kept");
  assert.ok(notes.some((n) => /statement is over 7 words.*"Waiting longer/.test(n)), "the rejected text is logged");
});

test("cards numbered differently from the scenes are matched by position when one comes back per scene", async () => {
  const callFn = async () => JSON.stringify({ cards: [
    { index: 10, headline: "Price cuts are the new normal here", statement: "", support: "" },
    { index: 11, headline: "Waiting longer rarely pays off", statement: "", support: "" },
    { index: 12, headline: "Right pricing opens the door", statement: "", support: "" },
  ] });
  const out = await cc.writeCardCopy({ ...base, callFn });
  assert.deepEqual(Object.keys(out).sort(), ["1", "2", "3"]);
  assert.equal(out[1].headline, "Price cuts are the new normal here");
  // Partly matching numbers (0,1,2 against scenes 1,2,3) are never shifted onto the wrong scene.
  const shifted = await cc.writeCardCopy({ ...base, callFn: async () => JSON.stringify({ cards: [{ index: 0, headline: "A" }, { index: 1, headline: "Waiting longer rarely pays off" }, { index: 2, headline: "Right pricing opens the door" }] }) });
  assert.equal(shifted[1] && shifted[1].headline, "Waiting longer rarely pays off", "scene 1 gets the card numbered 1, not a shifted one");
});

test("when every scene fails, there is no extra ask here (the caller already retries) and a model error never throws", async () => {
  let n = 0;
  const out = await cc.writeCardCopy({ ...base, callFn: async () => { n++; return JSON.stringify({ cards: [] }); } });
  assert.deepEqual(out, {}); assert.equal(n, 1);
  assert.deepEqual(await cc.writeCardCopy({ ...base, callFn: async () => { throw new Error("down"); } }), {});
});
