// Research workspace (Concept A: horizontal stepper + two-column Report Review). These are contract tests on the page and script: the browser
// behaviour is exercised separately with the local harness. They guard what must not regress: one active task, confirm-never-researches,
// the lookback/report-period wording, and that the arrangement kept every id the confirmation flow depends on.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const html = read("agent-marketing.html");
const ui = read("agent-marketing-research-ui.js");
const fn = (name, next) => ui.slice(ui.indexOf(name), ui.indexOf(next, ui.indexOf(name) + name.length));

test("the Research step has three tasks, a stepper, and a persistent action bar; only one task panel is open at a time", () => {
  for (const id of ["rsSteps", "rsMarket", "rsReport", "rsTopics", "rsBar", "rsBarText", "rsBack", "rsNext", "rsRequest", "rsSumReport", "setupBar"]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(ui, /\["market", "Market & Audience"\], \["report", "Report Review"\], \["topics", "Find Topics"\]/);
  const r = fn("function rsRender()", "function setStep(");
  assert.match(r, /classList\.toggle\("hidden", k !== s\.step\)/);   // every panel but the active one is hidden
  // the action bar owns the buttons that move the workflow
  const bar = html.slice(html.indexOf('id="rsBar"'), html.indexOf('id="rsBar"') + 1800);
  for (const id of ["upYes", "upNo", "startBtn", "confirmBtn", "confirmEdit", "libBtn", "rsNext"]) assert.match(bar, new RegExp(`id="${id}"`), `${id} lives in the action bar`);
});

test("only the Research view is widened; the other steps keep the 720px column", () => {
  assert.match(html, /\.stage\{max-width:720px;/);
  assert.match(html, /\.stage\.wide\{max-width:1240px;\}/);
  assert.match(html, /st\.classList\.toggle\("wide", ids\.indexOf\("stepResearch"\) >= 0\)/);
});

test("Confirm Report and Find Topics are separate: moving between tasks never calls the server or starts research", () => {
  for (const [a, b] of [["function rsRender()", "function setStep("], ["function setStep(", "function figuresHtml("], ["function rsSyncBar()", "function rsRender()"], ["function rsStepper()", "function rsSummaries()"]]) {
    const body = fn(a, b);
    assert.doesNotMatch(body, /\bapi\(|\bstart\(|"action": "start"/, a);
  }
  const nextClick = fn("function rsNextClick()", "function wireRS()");
  assert.doesNotMatch(nextClick, /\bapi\(|\bstart\(/);
  // the report confirm handler hands off to Find Topics and says nothing has been researched; it does not start research
  const yes = ui.slice(ui.indexOf('$("upYes").addEventListener("click"'), ui.indexOf('$("libClose")'));
  assert.match(yes, /setStep\("topics", true\)/);
  assert.match(yes, /Nothing has been researched yet/);
  assert.doesNotMatch(yes, /\bstart\(\)|action: "start"|review\(\)/);
  // spending still takes two deliberate actions: Find topics opens the summary, only Confirm and research starts a run
  assert.match(ui, /\$\("startBtn"\)\.addEventListener\("click", review\)/);
  assert.match(ui, /\$\("confirmBtn"\)\.addEventListener\("click", start\)/);
});

test("the action bar names the next action and what is still unresolved, for every task", () => {
  const b = fn("function rsSyncBar()", "function rsRender()");
  assert.match(b, /Still needed/);
  assert.match(b, /Confirm the report\./);
  assert.match(b, /Confirm to research\./);
  assert.match(b, /Continue without a report/);
  assert.match(b, /Upload your report to continue/);
  const un = fn("function unresolvedReport()", "function canGo(");
  for (const k of ["area name", "property types", "data-through date", "acknowledge the header difference", "confirmation box"]) assert.match(un, new RegExp(k));
});

test("Report Review: reported facts (left) and subscriber attestations (right) sit side by side; conflicts and the date field appear only when needed", () => {
  const rb = fn("function renderReadBack(", "function readDraft()");
  assert.match(rb, /rs-grid rv/);
  assert.ok(rb.indexOf("Reported by the document") < rb.indexOf("Confirmed by you"));
  assert.match(rb, /need\.indexOf\("dataThrough"\) >= 0 \|\| \(editing/);                 // date field only when the report needs it
  assert.match(rb, /conflicts\.forEach\(function \(c\) \{ h \+= '<div class="rs-alert bad"/);   // a conflict is shown only if one exists
  assert.match(rb, /need\.indexOf\("conflicts"\) >= 0 \|\| conflicts\.length\) h \+=[^;]*rbAck/);
  // the reader's own text and the attestation note are kept
  assert.match(rb, /esc\(a\.note\)/);
  assert.match(rb, /subscriber_attested/);
});

test("figures: principal statistics first, every extracted figure one click away (nothing is truncated or dropped)", () => {
  const f = fn("function figuresHtml(", "// ── Session line");
  assert.match(f, /PRINCIPAL/);
  assert.match(f, /View all figures \(/);
  assert.match(f, /groups \|\| \[\]\)\.forEach\(function \(g\)[\s\S]*all\.filter\(function \(x\) \{ return x\.g === g; \}\)\.map\(row\)/);   // the expansion walks every group and every figure
  assert.doesNotMatch(f, /\.slice\(0, \d+\)/);
});

test("the research lookback and the report's own period are named apart; the stale 'No report attached' text is gone", () => {
  assert.doesNotMatch(html, /No report attached/);
  assert.match(html, /<label class="lbl" for="period">Web research lookback<\/label>/);
  assert.match(html, /separate from your uploaded report's own reporting period/);
  assert.match(ui, /Report period/);                       // the confirm list names the report's period on its own row
  assert.match(ui, /web lookback/);
  assert.match(ui, /Two different time periods/);
  // the no-report hint is hidden whenever a report is attached, being read, or confirmed
  assert.match(fn("function rsRender()", "function setStep("), /\$\("dataNote"\)\.classList\.toggle\("hidden", reportConfirmed\(\) \|\| hasFile\(\) \|\|/);
});

test("MetroList attribution is available once per view, collapsed, not repeated through intake", () => {
  assert.match(ui, /<details class="rs-attr"><summary>MetroList attribution<\/summary>/);
  const rv = fn("function renderReview(", "// The date window");
  assert.match(rv, /if \(s\.notice && !s\.review\)/);      // the older layouts keep their single notice; the Market Review one lives in the read-back
  assert.doesNotMatch(rv, /Required notice for anything you publish with these figures: <b>' \+ esc\(s\.notice\) \+ "<\/b><\/div>"; *$/m);
});

test("completed tasks collapse to summaries; a confirmed report offers view/replace and remove, and server-side confirmation is untouched", () => {
  const s = fn("function reportSummaryHtml()", "function webLookbackText(");
  assert.match(s, /Report confirmed/);
  assert.match(s, /Edit confirmation[\s\S]*View report/);
  assert.match(s, /rsRepRemove/);
  // confirmation still goes to the server with the attestation payload and acknowledgement flags
  assert.match(ui, /action: "confirm", uploadId: u\.id, correct: true/);
  assert.match(ui, /out\.acknowledgeConflicts = \$\("rbAck"\)\.checked/);
  // a refused confirmation keeps what the agent typed
  assert.match(ui, /renderReadBack\(u, draft\)/);
});

test("a request type that does not use a report skips Report Review; Find Topics needs a done report or an existing result", () => {
  assert.match(fn("function reportMode()", "function reportConfirmed()"), /return "none"/);
  assert.match(fn("function canGo(", "function audLabel("), /reportDone\(\) \|\| !!state\.current/);
  assert.match(fn("function rsRender()", "function setStep("), /s\.step === "report" && mode === "none"\) s\.step = "topics"/);
});

test("responsive: columns stack, the table becomes stacked rows without shrinking text, and the bar stays reachable", () => {
  assert.match(html, /@media\(max-width:860px\)\{\s*\.rs-grid,\.rs-grid\.rv,\.rs-grid\.rt\{grid-template-columns:1fr;/);
  assert.match(html, /@media\(max-width:640px\)[\s\S]*\.fig-t thead\{display:none;\}/);
  assert.match(html, /\.rs-bar\{position:sticky;bottom:0;/);
  const css = html.slice(html.indexOf("/* Research workspace"), html.indexOf("</style>", html.indexOf("/* Research workspace")));
  assert.match(css, /\.fig-t\{[^}]*font-size:0\.86rem/);            // table text stays readable ...
  assert.match(css, /\.fig-t td\.cmp\{[^}]*font-size:0\.84rem/);     // ... and stays so when the rows stack on a phone
});

test("the stepper page keeps working with the older research-test page, which has none of the new markup", () => {
  assert.match(ui, /function RS\(\) \{ return !!\$\("rsSteps"\); \}/);
  for (const g of ["function rsRender()", "function rsSyncBar()", "function setStep("]) assert.match(fn(g, "function "), /if \(!RS\(\)/);
});

// ── Final refinements: editing a confirmed report, and the action bar ──
const fsR = require("fs"), pathR = require("path");
const uiSrc = fsR.readFileSync(pathR.join(__dirname, "..", "agent-marketing-research-ui.js"), "utf8");
const htmlSrc = fsR.readFileSync(pathR.join(__dirname, "..", "agent-marketing.html"), "utf8");

test("Edit confirmation is offered in the confirmed summary and the Report Review bar, with Save and Cancel while editing", () => {
  assert.match(uiSrc, /id="rsRepEdit">Edit confirmation/);
  for (const id of ["rsEdit", "rsSave", "rsCancelEdit"]) assert.match(htmlSrc, new RegExp('id="' + id + '"'));
  assert.match(uiSrc, /vis\.rsSave = true; vis\.rsCancelEdit = true/);
  assert.match(uiSrc, /action: "reattest", uploadId: u\.id/);
});

test("editing never re-uploads a file, never starts research, and requires the attestation to be ticked again", () => {
  const save = uiSrc.slice(uiSrc.indexOf("async function saveEdit"), uiSrc.indexOf("state.enterEdit = enterEdit"));
  assert.doesNotMatch(save, /action: "(upload|start)"/);
  assert.doesNotMatch(save, /setStep\("topics", true\)[\s\S]*start\(\)/);
  assert.match(uiSrc, /editing \|\| !a\.carriedFrom/, "the confirmation box is always shown in edit mode");
  assert.match(uiSrc, /carried = !state\.edit/, "an edit is never treated as carried forward");
  assert.match(save, /Confirmation updated\. Nothing was researched\./);
});

test("downstream: outdated topic sets show a banner, cannot be chosen, and hide 'Choose the call to action'", () => {
  assert.match(uiSrc, /id="odBanner"/);
  assert.match(uiSrc, /disabled aria-disabled="true"/);
  assert.match(uiSrc, /opts\.onContinue && !od/);
  assert.match(uiSrc, /out of date: the report confirmation changed/);
  assert.match(htmlSrc, /onReportChanged: async function/, "the page reloads the project so its topic, script and status match the server");
});

test("action bar: reserves its own height for scrolling and focus, and is compact with short labels on narrow screens", () => {
  assert.match(htmlSrc, /scroll-padding-bottom:calc\(var\(--rs-bar-h,96px\) \+ 20px\)/);
  assert.match(htmlSrc, /--rs-bar-h/);
  assert.match(htmlSrc, /\.rs-bar-btns\{width:100%;flex-wrap:nowrap/);
  assert.match(htmlSrc, /-webkit-line-clamp:2/);
  assert.match(uiSrc, /aria-label|setAttribute\("aria-label", full\[id\]\)/, "short labels keep their full accessible names");
  assert.doesNotMatch(htmlSrc, /\.rs-bar-btns \.btn\.gold\{[^}]*order:-1/, "visual order matches tab order");
});

// ── Review round 2: restoration, cost visibility, out-of-date wording ──
test("a new research session is announced before it is started, in the bar and in the request summary, and the two-step confirmation is unchanged", () => {
  assert.match(uiSrc, /Finding topics again uses a new research session\. You will see that and confirm before anything runs\./);
  assert.match(uiSrc, /A new session will be used<\/b> because your earlier topics are out of date/);
  assert.match(uiSrc, /STALE_COST[\s\S]*This will use one new research session/);
  assert.match(uiSrc, /\$\("startBtn"\)\.addEventListener\("click", review\); \$\("confirmBtn"\)\.addEventListener\("click", start\)/, "Find topics only opens the summary; Confirm and research starts it");
});

test("invalid research is never described as ready or selected, and a restored set is described as available again", () => {
  assert.match(uiSrc, /Earlier topics out of date/);
  assert.match(uiSrc, /Earlier topics \(out of date\)/);
  assert.match(uiSrc, /Earlier topic, no longer selected\./);
  assert.match(uiSrc, /are available again, with no new session needed/);
  assert.match(htmlSrc, /p\.selectedTopic\.reportOutdated \|\| !p\.intake/, "the project's progress does not count an outdated topic as chosen");
});

test("removing or replacing a report clears the old status message (no stale 'Confirmation updated')", () => {
  const m = /function resetReview\(\) \{([^\n]*)\}\n/.exec(uiSrc);
  assert.ok(m, "resetReview exists");
  assert.match(m[1], /say\("startMsg", ""\)/, "the shared reset clears the bar status line");
  // Both removing a report and choosing a different file go through resetReview.
  assert.match(uiSrc, /async function removeUpload\(\)[\s\S]*?resetReview\(\)/);
  assert.match(uiSrc, /\$\("upFile"\)\.addEventListener\("change"[\s\S]*?resetReview\(\)/);
});
