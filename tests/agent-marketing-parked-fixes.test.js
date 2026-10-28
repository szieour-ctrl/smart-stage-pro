// Oct 28, 2026: UTF-8 decoding of API replies, "area" wording, aerial image rule, the page renewing its own login.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

test("every agent-marketing API reply is decoded as UTF-8 (no chunk-by-chunk Buffer concatenation)", () => {
  for (const f of ["netlify/functions/agent-marketing-image-background.js", "netlify/functions/agent-marketing-prepare-background.js", "netlify/functions/agent-marketing-render.js", "netlify/functions/lib/agent-marketing-plan-lib.js", "netlify/functions/lib/agent-marketing-research-run-lib.js"]) {
    const src = read(f);
    const concats = (src.match(/res\.on\("data", \(c\) => \((?:d|data) \+= c\)\)/g) || []).length;
    const sets = (src.match(/res\.setEncoding\("utf8"\)/g) || []).length;
    assert.ok(concats > 0 && sets >= concats, f);
  }
});

test("planner says 'the area', not 'neighborhood'; image brief shows home fronts, never backyards", () => {
  assert.match(require("../netlify/functions/lib/agent-marketing-plan-lib").buildSystemPrompt(), /call the place "the area"/);
  assert.match(require("../netlify/functions/lib/agent-marketing-image-elaborate-lib").buildSystemPrompt(), /FRONTS of homes[\s\S]*Never show a fenced backyard/);
});

test("the page renews its own Supabase session before it expires", () => {
  const html = read("agent-marketing.html");
  assert.match(html, /grant_type=refresh_token/);
  assert.match(html, /await renewSession\(/);
});

test("a lone dollar figure gets a $ prefix on its big-number card, and the value stays the verified number", () => {
  const dir = require("../netlify/functions/lib/agent-marketing-director-lib");
  const figs = dir.figuresFrom([{ ref: "r1.median_close_price", key: "median_close_price", label: "Median sold price", display: "$482,000", text: "Median sold price: $482,000 (Sep 2026)" }]);
  const out = dir.plan({ scenes: [{ narrationExcerpt: "Hook.", }, { narrationExcerpt: "The median sold price was 482,000 dollars." }, { narrationExcerpt: "Close." }], hook: "Hook.", cta: { text: "Call me." } }, { market: "Antelope" }, figs);
  const stat = (out.scenes || []).find((s) => s.composition === "stat_big_number");
  assert.ok(stat, JSON.stringify(out.problems));
  assert.strictEqual(stat.data.value, "482000");
  assert.strictEqual(stat.data.prefix, "$");
});

// ── Length and scene balance (Oct 28): a 45-second Reel ran 57 seconds and one scene got 3 seconds ────────────────────────────────────────
const planLib = require("../netlify/functions/lib/agent-marketing-plan-lib");
const mk = (...texts) => ({ narrationExcerpt: texts.join(" ") });
const words = (n) => Array(n).fill("word").join(" ");
test("lengthProblems: too long, too short, a tiny scene and a dominant scene are named; a good plan has none", () => {
  const ok = { wordCount: 115, scenes: [mk(words(15)), mk(words(25)), mk(words(18)), mk(words(18)), mk(words(14))] };
  assert.deepStrictEqual(planLib.lengthProblems(ok, 45), []);
  assert.match(planLib.lengthProblems({ ...ok, wordCount: 136 }, 45)[0], /136 spoken words.*cut at least 11/);
  assert.match(planLib.lengthProblems({ ...ok, wordCount: 60 }, 45)[0], /add about 45/);
  assert.ok(planLib.lengthProblems({ wordCount: 90, scenes: [mk(words(30)), mk(words(3)), mk(words(57))] }, 45).some((p) => /Scene 2 has only 3/.test(p)));
  assert.ok(planLib.lengthProblems({ wordCount: 90, scenes: [mk(words(10)), mk(words(60)), mk(words(20))] }, 45).some((p) => /Scene 2 holds 60 of 90/.test(p)));
});
