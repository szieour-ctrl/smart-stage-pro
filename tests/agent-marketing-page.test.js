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

test("Research: a report with dated rows can be narrowed to a date window, which re-reads the file and is shown in the confirm summary", () => {
  const research = read("agent-marketing-research-ui.js");
  for (const f of ["agent-marketing.html", "agent-marketing-research-test.html"]) {
    const html = read(f);
    for (const id of ["upWindowBox", "upWindow", "upFrom", "upTo", "upWindowGo"]) assert.match(html, new RegExp(`id="${id}"`), `${f} ${id}`);
  }
  assert.match(research, /window: state\.pendingWindow/);
  assert.match(research, /cma_table/);
  assert.match(research, /closed sales limited to/);
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

test("Research: a report with dated rows can be narrowed to a date window, which re-reads the file and is shown in the confirm summary", () => {
  const research = read("agent-marketing-research-ui.js");
  for (const f of ["agent-marketing.html", "agent-marketing-research-test.html"]) {
    const html = read(f);
    for (const id of ["upWindowBox", "upWindow", "upFrom", "upTo", "upWindowGo"]) assert.match(html, new RegExp(`id="${id}"`), `${f} ${id}`);
  }
  assert.match(research, /window: state\.pendingWindow/);
  assert.match(research, /cma_table/);
  assert.match(research, /closed sales limited to/);
});

test("Research: optional data (None / MLS statistics / Recent listings and sales / All) with a period, for market updates only, shown in the confirm summary", () => {
  const research = read("agent-marketing-research-ui.js");
  for (const f of ["agent-marketing.html", "agent-marketing-research-test.html"]) {
    const html = read(f);
    for (const id of ["dataFocusBox", "dataFocus", "periodBox", "period", "periodFrom", "periodTo", "periodDates"]) assert.match(html, new RegExp(`id="${id}"`), `${f} ${id}`);
  }
  assert.match(research, /dataFocus: \$\("dataFocus"\)\.value, period: collectPeriod\(\)/);
  assert.match(research, /"Optional data", focusLabel\(q\)/);
  assert.match(research, /\$\("dataFocusBox"\)\.classList\.toggle\("hidden", events\)/);
});

test("Research: 'Not right' asks what is wrong and sends it before removing; choosing a topic opens the call-to-action dialog that ends in Write my script", () => {
  const research = read("agent-marketing-research-ui.js");
  const html = read("agent-marketing.html");
  for (const f of ["agent-marketing.html", "agent-marketing-research-test.html"]) for (const id of ["upFix", "upFixText", "upFixSend", "upFixCancel"]) assert.match(read(f), new RegExp(`id="${id}"`), `${f} ${id}`);
  assert.match(research, /action: "feedback", uploadId: u\.id, reasons: reasons, message: note/);
  assert.match(html, /<div class="modal-back hidden" id="resNext" role="dialog"/);
  assert.match(html, /id="resContinueBtn">Write my script</);
  assert.match(html, /onSelected: async function \(topic\) \{[\s\S]*?state\.project\.selectedTopic = topic; renderSteps\(2\); openCta\(\);/);
  assert.match(html, /closeCta\(\); go\(3\);/);
});

test("Research is compact: the report check shows its summary first, topic cards never repeat the report's figures, and the form folds into a bar when topics are showing", () => {
  const research = read("agent-marketing-research-ui.js");
  for (const f of ["agent-marketing.html", "agent-marketing-research-test.html"]) for (const id of ["setupBody", "setupBar", "setupEdit", "libBtn2"]) assert.match(read(f), new RegExp(`id="${id}"`), `${f} ${id}`);
  assert.match(research, /See the figures I read/);
  const d = research.slice(research.indexOf("function topicDetails"), research.indexOf("function renderTopic"));
  assert.match(d, /t\.origin === "report" && t\.reportFigures/);   // a web topic never lists the report's figures
  assert.match(d, /<details class="kv"><summary[^>]*>Details/);
  const card = research.slice(research.indexOf("function renderTopic"), research.indexOf("function showResult"));
  assert.doesNotMatch(card, /Required notice:|Report figures:/);   // nothing like that on the card itself
  assert.match(research, /foldSetup\(r\.status === "ready"\)/);
});

test("the Visuals step has the Make your Reel panel, and it only ever starts a render with the advertising confirmation", () => {
  const html = read("agent-marketing.html");
  for (const id of ["reelPanel", "reelFormats", "reelNote", "reelOk", "reelGo", "reelRetry", "reelMsg", "reelOut"]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /advertisingConfirmed: true/);
  assert.match(html, /if \(!\$\("reelOk"\)\.checked\)/);
  assert.match(html, /function go\(step\) \{ stopImgPoll\(\); stopReelPoll\(\);/, "leaving the step stops the progress polling");
  assert.match(html, /"\?projectId=" \+ encodeURIComponent\(state\.project\.id\)/, "reopening the step finds the project's latest render");
  assert.doesNotMatch(html, /innerHTML\s*=\s*[^;]*j\.videos/, "video links are set as attributes, not as markup");
});

test("the Reel reuses only images the agent approved", () => {
  const prep = read("netlify/functions/agent-marketing-prepare-background.js");
  assert.match(prep, /r\.status === "approved" && r\.generation/);
  assert.doesNotMatch(prep, /r\.status !== "rejected" && r\.generation/);
});

test("the image preview has no crop box for Agent Marketing, and the Reel note counts only scenes the Reel makes an image for", () => {
  const html = require("fs").readFileSync(require("path").join(__dirname, "..", "agent-marketing.html"), "utf8");
  assert.match(html, /var vertical = false;/);
  assert.match(html, /s\.kind === "GPT_IMAGE_2_CONCEPT" \|\| s\.kind === "AGENT_SCENE"\) && !seen/);
  assert.match(html, /!picked\[s\.sceneIndex\]/);
});

test("a re-framed copy scene shows the image it is made from, and the Reel panel names the source line for web Reels", () => {
  const html = require("fs").readFileSync(require("path").join(__dirname, "..", "agent-marketing.html"), "utf8");
  assert.match(html, /function reuseSourceImage\(j\)/);
  assert.match(html, /Same image as Scene ' \+ \(sc\.reuseOfScene \+ 1\)/);
  assert.match(html, /MetroList notice \(report data\) or your research source line/);
  assert.match(html, /picked\[j\] && picked\[j\]\.url/);
});
