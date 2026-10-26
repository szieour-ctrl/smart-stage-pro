// Run with: node --test tests/
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

// Two scripts share one page. When two elements share an id, $("id") returns the first one in the page, so one script silently fills or
// reads the other's field (the Research "Who is this for?" list was overwritten by the Your Insight list, Oct 25, 2026).
test("agent-marketing.html: every id is unique, including inputs the page's own scripts create", () => {
  const html = read("agent-marketing.html");
  const ids = [...html.matchAll(/\bid=\\?"([A-Za-z][\w-]*)\\?"/g)].map((m) => m[1]);
  const seen = new Set(), dupes = new Set();
  ids.forEach((id) => (seen.has(id) ? dupes.add(id) : seen.add(id)));
  assert.deepStrictEqual([...dupes], []);
});

test("the Research step owns the audience list; the page's own script never touches it", () => {
  const html = read("agent-marketing.html");
  const research = read("agent-marketing-research-ui.js");
  assert.match(html, /id="audience"/);
  assert.match(research, /\$\("audience"\)\.value/);
  assert.doesNotMatch(html, /\$\("audience"\)/);
});

test("Local Market Insider has no separate insight step: Research leads straight to Script, and the call to action is chosen with the topic", () => {
  const html = read("agent-marketing.html");
  assert.doesNotMatch(html, /stepIntake|Your insight|saveIntake|fillIntake/);
  assert.match(html, /STEP_NAMES = \["Setup", "Research", "Script", "Storyboard", "Visuals"\]/);
  assert.match(html, /id="resAction"/);
  assert.match(html, /action: "save_intake"[^}]*action: action/);
});

test("Research: no data-source picker (a confirmed report is the choice); keywords field; a summary must be confirmed before anything is run", () => {
  const research = read("agent-marketing-research-ui.js");
  for (const f of ["agent-marketing.html", "agent-marketing-research-test.html"]) {
    const html = read(f);
    assert.doesNotMatch(html, /dataSrc|dataChoice|Select what data you want to use/, f);
    for (const id of ["keywords", "confirmBox", "confirmList", "confirmBtn", "confirmEdit", "startBtn"]) assert.match(html, new RegExp(`id="${id}"`), `${f} ${id}`);
  }
  assert.doesNotMatch(research, /dataSrc/);
  assert.match(research, /\$\("startBtn"\)\.addEventListener\("click", review\)/);   // the main button only opens the summary
  assert.match(research, /\$\("confirmBtn"\)\.addEventListener\("click", start\)/);  // only Confirm spends a session
  assert.match(research, /keywords: \$\("keywords"\)\.value/);
  const review = research.slice(research.indexOf("function review()"), research.indexOf("async function start()"));
  assert.doesNotMatch(review, /api\(/); // reviewing never calls the server
});

test("the Research script and every inline script on the page parse (a syntax slip would blank the whole step)", () => {
  const scripts = [read("agent-marketing-research-ui.js")];
  for (const f of ["agent-marketing.html", "agent-marketing-research-test.html"]) {
    for (const m of read(f).matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) scripts.push(m[1]);
  }
  scripts.forEach((code, i) => assert.doesNotThrow(() => new Function(code), `script ${i}`));
});

test("Research: a failed run offers retry / widen / change, never widens on its own; the recommended topic shows its reason", () => {
  const research = read("agent-marketing-research-ui.js");
  for (const f of ["agent-marketing.html", "agent-marketing-research-test.html"]) assert.match(read(f), /id="resFailOptions"/, f);
  assert.match(research, /Widen to /);
  assert.match(research, /Your area was not widened/);
  const fail = research.slice(research.indexOf("function renderFailOptions"), research.indexOf("async function pick("));
  assert.match(fail, /review\(\)/);          // every option ends at the summary the agent must confirm
  assert.doesNotMatch(fail, /api\(/);        // choosing an option never calls the server by itself
  assert.match(research, /Recommended/);
  assert.match(research, /Why this one:/);
});
