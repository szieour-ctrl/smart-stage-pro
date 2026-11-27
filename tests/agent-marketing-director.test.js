const test = require("node:test");
const assert = require("node:assert");

// Nov 27, 2026 (Sam's Eskaton Cocoa with Santa reel): the scene 2 card read "30 to / 5" because the clause split broke "3:30 to 5:30 p.m." at its colons.
test("card text keeps times, a.m./p.m. and thousands commas whole", () => {
  const dir = require("../netlify/functions/lib/agent-marketing-director-lib");
  const ex = "Eskaton Village Roseville is hosting Cocoa with Santa on Tuesday, December 8, from 3:30 to 5:30 p.m. at 1650 Eskaton Loop—and admission is free.";
  assert.strictEqual(dir.splitSentences(ex).length, 1);                                   // "p.m. at" is not a sentence end
  assert.strictEqual(dir.splitSentences("Doors open at 3 p.m. Bring a friend.").length, 2); // "p.m. Bring" is
  assert.strictEqual(dir.splitSentences("Doors close at 5 p.m.").length, 1);
  const st = dir.statement({ narrationExcerpt: ex });
  const text = st.headline.join(" ");
  assert.match(text, /3:30 to 5:30 p\.m\./);                                              // the whole time range, not "30 to / 5"
  assert.match(dir.fitWords("Open from 3:30 to 5:30 p.m. today, rain or shine", 9), /3:30 to 5:30 p\.m\./);
  assert.match(dir.fitWords("It costs 1,650 dollars a month, which is a bargain for the area right now", 9), /1,650/);
});
