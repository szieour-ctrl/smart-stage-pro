// agent-marketing-research-ui.js — the Local Market Insider research step (request form, MLS report upload, five topics, select, library).
// Shared by agent-marketing.html (the subscriber flow) and agent-marketing-research-test.html. The page supplies the markup (same element ids),
// an api(base, method, qs, body) function that adds the login, and a project id; this file does the rest.
//   var ui = AMResearchUI({ api: fn, onSelected: fn(topic) });  await ui.start(projectId, selectedTopicOrNull);
(function (root) {
  "use strict";
  root.AMResearchUI = function (opts) {
    var API = "/.netlify/functions/agent-marketing-research";
    var state = { schema: null, projectId: null, selected: null, poll: null, session: null, rs: { step: "market", marketDone: false, reportSkipped: false } };
    var $ = function (id) { return document.getElementById(id); };
    function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
    function say(id, text, kind) { var el = $(id); el.textContent = text || ""; el.className = "msg" + (kind ? " " + kind : ""); }
    var api = opts.api;
  // ── Form ──
  function radios(el, name, items, checked) {
    el.innerHTML = items.map(function (it) { return '<label class="choice"><input type="radio" name="' + name + '" value="' + esc(it.key) + '"' + (it.key === checked ? " checked" : "") + "><span>" + esc(it.label) + "</span></label>"; }).join("");
  }
  function picked(name) { var el = document.querySelector('input[name="' + name + '"]:checked'); return el ? el.value : null; }
  function buildForm() {
    var s = state.schema;
    radios($("modeChoices"), "mode", s.modes, "market_update");
    $("geoType").innerHTML = s.geoTypes.map(function (g) { return '<option value="' + esc(g.key) + '"' + (g.key === "city" ? " selected" : "") + ">" + esc(g.label) + "</option>"; }).join("");
    $("audience").innerHTML = s.audiences.map(function (a) { return '<option value="' + esc(a.key) + '">' + esc(a.label) + "</option>"; }).join("");
    $("geoType").addEventListener("change", applyGeo); applyGeo();
    $("dataFocus").innerHTML = (s.dataFocus || []).map(function (d) { return '<option value="' + esc(d.key) + '"' + (d.key === "all" ? " selected" : "") + ">" + esc(d.label) + "</option>"; }).join("");
    $("dataFocus").addEventListener("change", applyFocus);
    $("period").addEventListener("change", applyFocus);
    $("modeChoices").addEventListener("change", function () { applyFocus(); applyZip(); applyMuMode(); }); applyFocus();
    if (s.marketUpdateModes && $("muModeChoices")) {
      $("muModeChoices").innerHTML = s.marketUpdateModes.map(function (m) { return '<label class="choice" style="display:flex;align-items:flex-start;gap:8px"><input type="radio" name="muMode" value="' + esc(m.key) + '"><span><b>' + esc(m.label) + '</b><br><span class="hint" style="margin:0">' + esc(m.hint) + "</span></span></label>"; }).join("");
      $("muModeChoices").addEventListener("change", function () { applyMuMode(); saveMuMode(); hideConfirm(); });
    }
    applyMuMode();
  }
  // ── Market Update type (Nov 8, 2026): three explicit choices, kept with the project ──
  function muModeDef(key) { return ((state.schema && state.schema.marketUpdateModes) || []).filter(function (m) { return m.key === key; })[0] || null; }
  function setMuMode(key) { var el = document.querySelector('input[name="muMode"][value="' + key + '"]'); if (el) el.checked = true; applyMuMode(); }
  function applyMuMode() {
    var box = $("muModeBox"); if (!box) return;
    var market = picked("mode") !== "local_events";
    box.classList.toggle("hidden", !market || !(state.schema && state.schema.marketUpdateModes));
    var m = market ? muModeDef(picked("muMode")) : null;
    var lbl = $("upLabelNote");
    if (lbl) lbl.textContent = !market ? "(not used for Local Events)" : !m ? "(choose a Market Update type above)" : m.reportRequired ? "(required)" : "(not used: the article is the source)";
    var up = $("uploadBox"); if (up) up.classList.toggle("hidden", market && !!m && !m.reportRequired);
    // Option 1 (Agent Market Update): one button, no choice between new research and the library. Saved analyses stay under "Saved research".
    var opt1 = option1On();
    var sb = $("startBtn"); if (sb) sb.textContent = opt1 ? "Analyze My Market Report" : (RS() ? "Find topics" : "Research this market");
    var lb = $("libBtn"); if (lb) lb.classList.toggle("hidden", opt1);
    var nt = $("newTopics"); if (nt && nt.closest("label")) nt.closest("label").classList.toggle("hidden", opt1);
    rsRender();
  }
  function option1On() { return !!(state.schema && state.schema.reportAnalysis && picked("mode") !== "local_events" && picked("muMode") === "trend_report"); }
  async function saveMuMode() {
    var m = picked("muMode"); if (!m || !state.projectId) return;
    try { await api(API, "POST", "", { action: "set_mode", projectId: state.projectId, marketUpdateMode: m }); } catch (e) { /* the choice is sent again with the research request */ }
  }
  // Optional data applies to Local Market Update only; a period is needed for anything but "None".
  function applyFocus() {
    var events = picked("mode") === "local_events";
    $("dataFocusBox").classList.toggle("hidden", events);
    // Event keywords are event words, not market words.
    $("keywordsLblText").textContent = events ? "Event types or names to look for" : "Keywords or brand names to look for";
    $("keywords").placeholder = events ? "e.g. car show, holiday market, farmers market, concert" : "e.g. 55+, Four Seasons, Heritage, mortgage rates";
    $("keywordsHint").textContent = events ? "Separate with commas. The research looks for upcoming events that match. The place itself is never widened." : "Separate with commas. The research looks for local news and data that mention them. The market itself is never widened.";
    $("periodBox").classList.toggle("hidden", $("dataFocus").value === "none");
    $("periodDates").classList.toggle("hidden", $("period").value !== "custom" || $("dataFocus").value === "none");
  }
  function collectPeriod() {
    if ($("dataFocus").value === "none") return null;
    var v = $("period").value;
    return v === "custom" ? { start: $("periodFrom").value, end: $("periodTo").value } : { days: Number(v) };
  }
  function applyGeo() {
    var t = $("geoType").value;
    $("cityWrap").classList.toggle("hidden", t !== "neighborhood");
    applyZip();
    $("geoNameLbl").textContent = t === "zip" ? "ZIP code" : t === "neighborhood" ? "Neighborhood" : t === "county" ? "County" : t === "metro" ? "Metro area" : "City";
    $("geoName").placeholder = t === "zip" ? "e.g. 95678" : t === "neighborhood" ? "e.g. Crocker Ranch" : t === "county" ? "e.g. Placer" : t === "metro" ? "e.g. Sacramento" : "e.g. Roseville";
  }
  // A Local Market Update needs the 5-digit ZIP (the market is pinned to it). A ZIP market already is its ZIP; Local Events does not need one.
  function applyZip() {
    var need = picked("mode") !== "local_events" && $("geoType").value !== "zip";
    $("zipWrap").classList.toggle("hidden", !need);
  }
  function collect() {
    var type = $("geoType").value;
    return {
      mode: picked("mode"), audience: $("audience").value,
      geography: { type: type, name: $("geoName").value, city: type === "neighborhood" ? $("geoCity").value : "", zip: type === "zip" ? "" : $("geoZip").value },
      focus: { active_adult_55: $("f55").checked, new_construction: $("fNew").checked }, keywords: $("keywords").value, dataFocus: $("dataFocus").value, period: collectPeriod(),
      dataSource: state.mlsTrend ? "upload" : reportSource().dataSource, uploadIds: reportSource().uploadIds,
      marketUpdateMode: picked("mode") !== "local_events" ? (state.mlsTrend ? "trend_report" : picked("muMode")) || undefined : undefined,
    };
  }
  // A report is used only once the agent has confirmed "This report covers\u2026 Correct?". Attached and confirmed = both (report figures win); otherwise web only.
  function reportSource() {
    var u = state.upload;
    if (!u || u.status !== "confirmed" || !u.id) return { dataSource: "web", uploadIds: [] };
    return { dataSource: "both", uploadIds: [u.id] }; // a confirmed report is the choice: its figures win, the web adds the narrative
  }

  // ── Research tasks: Market & Audience → Report Review → Find Topics ──
  // One task is open at a time; finished tasks fold into a one-line summary the agent can reopen. This only arranges the page: every confirmation,
  // attestation and server rule below is unchanged, and nothing here calls the server or starts research.
  var STEPS = [["market", "Market & Audience"], ["report", "Report Review"], ["topics", "Find Topics"]];
  var PANEL = { market: "rsMarket", report: "rsReport", topics: "rsTopics" }, HEAD = { market: "rsMarketH", report: "rsReportH", topics: "rsTopicsH" };
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var REPORT_TYPES = { week: "Weekly", month: "Monthly", quarter: "Quarterly", ytd: "Year to date", year: "Yearly" };
  var PRINCIPAL = [/^median sold price$/i, /^closed sales$/i, /^median days on market$/i, /^months of inventory$/i, /^active listings$/i, /^new listings$/i];
  function RS() { return !!$("rsSteps"); }
  function fmtDate(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "")); return m ? MONTHS[Number(m[2]) - 1] + " " + Number(m[3]) + ", " + m[1] : String(iso || ""); }
  function hasFile() { return !!($("upFile") && $("upFile").files && $("upFile").files.length > 0); }
  function reportMode() {   // "none" (this request does not use a report) | "optional" | "required"
    if (picked("mode") === "local_events") return "none";
    var m = muModeDef(picked("muMode")); if (m) return m.reportRequired ? "required" : "none";
    return "optional";
  }
  function reportConfirmed() { return !!(state.upload && state.upload.status === "confirmed" && state.upload.id); }
  function reportDone() { var m = reportMode(); return m === "none" || reportConfirmed() || (m === "optional" && state.rs.reportSkipped); }
  function reviewOf(u) { return u && u.summary && u.summary.review; }
  function marketMissing() {
    var q; try { q = collect(); } catch (e) { return []; }
    var out = [], g = q.geography, market = q.mode !== "local_events";
    if (!q.mode) out.push("content type");
    if (market && state.schema && state.schema.marketUpdateModes && !q.marketUpdateMode) out.push("Market Update type");
    if (!String(g.name || "").trim()) out.push("place");
    if (market && g.type !== "zip" && !/^\d{5}$/.test(String(g.zip || "").trim())) out.push("5-digit ZIP code");
    if (!q.audience) out.push("audience");
    if (market && q.dataFocus !== "none" && q.period && q.period.start !== undefined && (!q.period.start || !q.period.end)) out.push("lookback dates");
    return out;
  }
  function firstMissingField() {
    var q = collect(), g = q.geography;
    if (q.mode !== "local_events" && state.schema && state.schema.marketUpdateModes && !q.marketUpdateMode) return document.querySelector('input[name="muMode"]');
    if (!String(g.name || "").trim()) return $("geoName");
    if (q.mode !== "local_events" && g.type !== "zip" && !/^\d{5}$/.test(String(g.zip || "").trim())) return $("geoZip");
    return $("audience");
  }
  function unresolvedReport() {   // what still stands between the agent and "Confirm report"
    var u = state.upload; if (!u || !u.id || (u.status === "confirmed" && !state.edit) || !reviewOf(u)) return [];
    var out = [];
    if ($("rbNames") && !$("rbNames").value.trim()) out.push("area name");
    if ($("rbTypes") && !$("rbTypes").value.trim()) out.push("property types");
    if ($("rbThrough") && !$("rbThrough").value) out.push("data-through date");
    if ($("rbAck") && !$("rbAck").checked) out.push("acknowledge the header difference");
    if ($("rbAttest") && !$("rbAttest").checked) out.push("tick the confirmation box");
    return out;
  }
  function canGo(k) {
    var s = state.rs;
    if (k === "market") return true;
    if (!s.marketDone || marketMissing().length) return false;
    if (k === "report") return reportMode() !== "none";
    return reportDone() || !!state.current;
  }
  function audLabel(key) { return ((state.schema.audiences || []).filter(function (a) { return a.key === key; })[0] || {}).label || ""; }
  function marketSummaryHtml() {
    var q = collect(), g = q.geography, s = state.schema, mdl = muModeDef(q.marketUpdateMode);
    var place = g.name ? (g.type === "neighborhood" && g.city ? g.name + ", " + g.city : g.name) : "";
    var mode = (s.modes.filter(function (m) { return m.key === q.mode; })[0] || {}).label || "";
    var focus = [q.focus.active_adult_55 ? "55+ Active Adult" : "", q.focus.new_construction ? "New Construction" : ""].filter(Boolean).join(", ");
    var bits = ["<b>" + esc(place) + "</b>" + (g.zip && g.type !== "zip" ? " · ZIP " + esc(g.zip) : ""), esc(audLabel(q.audience)), esc(mode + (mdl ? ": " + mdl.label : ""))];
    if (focus) bits.push(esc(focus));
    if ((q.keywords || "").trim()) bits.push("keywords: " + esc(q.keywords.trim()));
    return bits.filter(Boolean).join(" · ");
  }
  function reportPeriodText(u) {
    var rv = reviewOf(u); if (!rv) return "";
    var r = rv.reported, a = rv.attested, t = r.period.label + (r.period.partial ? " (part of a year)" : "");
    if (a.dataThrough) t += ", data through " + fmtDate(a.dataThrough.date);
    return t;
  }
  function attrHtml(u) {
    var n = u && u.summary && u.summary.notice; if (!n) return "";
    return '<details class="rs-attr"><summary>MetroList attribution</summary><div>Required notice for anything you publish with these figures: <b>' + esc(n) + "</b></div></details>";
  }
  function changeText(o) {   // "was Roseville, now Roseville and Rocklin combined" from what the server recorded
    var w = (o && o.was) || {}, n = (o && o.now) || {}, bits = [];
    if (w.area !== n.area) bits.push("area was " + (w.area || "not set") + ", now " + (n.area || "not set"));
    if ((w.propertyTypes || []).join(", ") !== (n.propertyTypes || []).join(", ")) bits.push("property types were " + ((w.propertyTypes || []).join(", ") || "not set") + ", now " + ((n.propertyTypes || []).join(", ") || "not set"));
    if (w.dataThrough !== n.dataThrough) bits.push("data-through date was " + (w.dataThrough ? fmtDate(w.dataThrough) : "not set") + ", now " + (n.dataThrough ? fmtDate(n.dataThrough) : "not set"));
    return bits.join("; ");
  }
  function outdatedFor(r) { return (r && r.reportOutdated) || (r && state.selected && state.selected.researchId === r.id && state.selected.reportOutdated) || null; }
  function reportSummaryHtml() {
    if (!reportConfirmed()) return '<div><b>No report.</b> Topics come from web research, and each figure names its source.</div><div class="rs-sum-btns"><button type="button" class="btn ghost small" data-rs-go="report">Add a report</button></div>';
    var u = state.upload, rv = reviewOf(u), bits = [];
    if (rv) {
      var a = rv.attested, pt = (a.propertyTypes.selected || {}).names || [];
      bits = [REPORT_TYPES[rv.reported.reportType] ? REPORT_TYPES[rv.reported.reportType] + " report" : "", rv.reported.period.label + (rv.reported.period.partial ? " (part of a year)" : ""),
        (a.geography.areaLabel || "") + (a.geography.scopeKind === "combined" ? " (combined market)" : ""), pt.join(", "), a.dataThrough ? "data through " + fmtDate(a.dataThrough.date) : ""];
    } else bits = [(u.summary || {}).scopeSentence || "Report attached"];
    return '<div><span class="rs-tag ok">Report confirmed</span> ' + bits.filter(Boolean).map(esc).join(" · ") + attrHtml(u) + '</div><div class="rs-sum-btns"><button type="button" class="btn ghost small" id="rsRepEdit">Edit confirmation</button><button type="button" class="btn ghost small" data-rs-go="report">View report</button><button type="button" class="btn ghost small" id="rsRepRemove">Remove report</button></div>';
  }
  function webLookbackText(q) {
    if (q.mode === "local_events" || q.dataFocus === "none" || !q.period) return "";
    return q.period.days ? "last " + q.period.days + " days" : q.period.start + " to " + q.period.end;
  }
  // Find Topics: the two time periods that are easy to confuse, stated side by side. Everything else about the request is in the summaries above.
  function requestCardHtml() {
    var q = collect(), u = state.upload, lb = webLookbackText(q);
    var row = function (k, v, note, go) { return '<div style="padding:7px 0;border-top:1px solid #eee7dc"><div style="display:flex;gap:8px;justify-content:space-between"><span><b>' + esc(k) + ":</b> " + esc(v) + '</span><button type="button" class="rs-link" data-rs-go="' + go + '" aria-label="Edit ' + esc(k) + '">Edit</button></div><div class="hint" style="margin-top:2px">' + esc(note) + "</div></div>"; };
    var h = '<div class="ch">Two different time periods</div>';
    if (reportMode() !== "none") h += row("Report period", reportConfirmed() ? (reportPeriodText(u) || "Confirmed") : "None: web research only", reportConfirmed() ? "The period your uploaded report covers. Its figures come first." : "No report is attached, so every figure comes from a web source that names itself.", "report");
    if (lb) h += row("Web lookback", lb, "How far back news and web sources are searched. It does not change your report's figures.", "market");
    else if (reportMode() === "none") h += '<div class="hint">This request does not use a report.</div>';
    return h;
  }
  function rsStepper() {
    var s = state.rs, mode = reportMode();
    var done = { market: s.marketDone, report: mode !== "none" && reportDone(), topics: !!(state.current && state.current.status === "ready") };
    var note = {
      market: s.marketDone && !marketMissing().length ? marketSummaryHtml().replace(/<[^>]+>/g, "").split(" · ").slice(0, 2).join(" · ") : "Place, audience, focus",
      report: mode === "none" ? "Not used for this request" : reportConfirmed() ? "Confirmed" + (reviewOf(state.upload) ? " · " + reviewOf(state.upload).reported.period.label : "") : s.reportSkipped && mode === "optional" ? "Skipped" : mode === "required" ? "Required" : "Optional",
      topics: done.topics ? "Topics ready" : state.current && state.current.status === "running" ? "Researching…" : "Five sourced topics",
    };
    $("rsSteps").innerHTML = STEPS.map(function (st, i) {
      var k = st[0], on = s.step === k, ok = canGo(k) && !(k === "report" && mode === "none");
      return '<li><button type="button" class="rs-step' + (on ? " active" : "") + (done[k] ? " done" : "") + '" data-rs="' + k + '"' + (on ? ' aria-current="step"' : "") + (ok ? "" : " disabled") + '><span class="n" aria-hidden="true">' + (done[k] ? "✓" : i + 1) + "</span><span><b>" + st[1] + "</b><small>" + esc(note[k]) + "</small></span></button></li>";
    }).join("");
  }
  function rsSummaries() {
    var s = state.rs, on = s.step, mode = reportMode();
    var showMarket = s.marketDone && on !== "market" && !marketMissing().length;
    $("setupBar").classList.toggle("hidden", !showMarket);
    if (showMarket) $("setupBarText").innerHTML = marketSummaryHtml();
    var showReport = on !== "report" && mode !== "none" && s.marketDone && (reportConfirmed() || (s.reportSkipped && mode === "optional"));
    $("rsSumReport").classList.toggle("hidden", !showReport);
    if (showReport) $("rsSumReport").innerHTML = reportSummaryHtml();
  }
  function rsSyncBar() {
    if (!RS() || !state.schema) return;
    var s = state.rs, step = s.step, mode = reportMode(), u = state.upload, vis = {}, text = "", next = "Continue";
    var confirmOpen = !$("confirmBox").classList.contains("hidden");
    var need = function (list) { return list.length ? ' <span class="need">Still needed: ' + esc(list.join(", ")) + ".</span>" : ""; };
    if (step === "market") {
      var miss = marketMissing();
      text = miss.length ? "<b>Describe your market.</b>" + need(miss) : "<b>Next: " + (mode === "none" ? "Find Topics" : "Report Review") + ".</b> This task is complete.";
      vis.rsNext = true; next = mode === "none" ? "Continue to Find Topics" : "Continue to Report Review";
    } else if (step === "report") {
      vis.rsBack = true;
      if (state.edit && reportConfirmed()) { text = "<b>Editing your confirmation.</b> The figures stay as read; only your statements change." + need(unresolvedReport()) + " Saving does not start research."; vis.rsSave = true; vis.rsCancelEdit = true; vis.rsBack = false; }
      else if (reportConfirmed()) { text = "<b>Report confirmed.</b> Nothing has been researched yet. Next: Find Topics."; vis.rsNext = true; next = "Continue to Find Topics"; vis.rsEdit = true; vis.upNo = true; }
      else if (u && u.busy) text = "<b>Reading your report…</b>";
      else if (u && u.id) {
        var un = unresolvedReport();
        text = "<b>Confirm the report.</b>" + (un.length ? need(un) : " Everything is filled in. Confirming does not start research."); vis.upYes = true; vis.upNo = true;
      } else if (hasFile()) text = "<b>Tick the permission box</b> to read your file, or remove the file.";
      else if (mode === "required") text = "<b>Upload your report to continue.</b> This Market Update type uses it.";
      else { text = "<b>Add a report, or continue without one.</b> Without a report, web research sources its own figures."; vis.rsNext = true; next = "Continue without a report"; }
    } else {
      vis.rsBack = true;
      var cur = state.current;
      if (confirmOpen) { text = "<b>Confirm to research.</b> This is the only action that uses a research session."; vis.confirmBtn = true; vis.confirmEdit = true; }
      else {
        vis.startBtn = true; vis.libBtn = !option1On();
        text = cur && cur.status === "running" ? "<b>Researching…</b> This usually takes under a minute." : cur && cur.status === "ready" ? "<b>Topics ready.</b> Choose one below, or run a new request." : "<b>Next: find topics.</b> " + (reportConfirmed() ? "Your confirmed report's figures come first. " : "") + "You will review the request before anything is researched.";
      }
    }
    ["rsBack", "libBtn", "upNo", "rsEdit", "rsSave", "rsCancelEdit", "confirmEdit", "rsNext", "upYes", "startBtn", "confirmBtn"].forEach(function (id) { if ($(id)) $(id).classList.toggle("hidden", !vis[id]); });
    // Narrow screens: short visible labels keep the bar to one row; the full wording stays available to assistive technology.
    var mob = !!(window.matchMedia && window.matchMedia("(max-width: 640px)").matches), full = { rsEdit: "Edit confirmation", upNo: u && u.status === "confirmed" ? "Remove this report" : "Not right, remove" }, short = { rsEdit: "Edit", upNo: u && u.status === "confirmed" ? "Remove" : "Not right" };
    ["rsEdit", "upNo"].forEach(function (id) { var el = $(id); if (!el) return; el.textContent = mob ? short[id] : full[id]; el.setAttribute("aria-label", full[id]); });
    $("rsNext").textContent = mob ? next.replace(/^Continue to .*/, "Continue").replace(/^Continue without a report$/, "Skip report") : next; $("rsNext").setAttribute("aria-label", next);
    $("rsBarText").innerHTML = text;
  }
  function rsRender() {
    if (!RS() || !state.schema) return;
    var s = state.rs, mode = reportMode();
    if (s.step === "report" && mode === "none") s.step = "topics";
    if (s.step !== "market" && !canGo(s.step)) s.step = s.step === "topics" && canGo("report") ? "report" : "market";
    Object.keys(PANEL).forEach(function (k) { $(PANEL[k]).classList.toggle("hidden", k !== s.step); });
    var confirmOpen = !$("confirmBox").classList.contains("hidden");
    if (s.step === "topics") { $("rsRequest").innerHTML = requestCardHtml(); }
    $("rsRequest").classList.toggle("hidden", confirmOpen);
    $("rsTopics").querySelector(".rs-grid").classList.toggle("one", $("resultPanel").classList.contains("hidden"));
    var ut = document.querySelector("#uploadBox .ut"); if (ut) ut.textContent = reportConfirmed() ? "Replace this report with a different file" : "Upload MLS Report or CMA";
    $("dataNote").classList.toggle("hidden", reportConfirmed() || hasFile() || !!(state.upload && state.upload.id));
    rsSummaries(); rsStepper(); rsSyncBar();
  }
  function setStep(step, focus) {
    if (!RS()) return;
    state.rs.step = step; rsRender();
    if (focus && $(HEAD[state.rs.step])) { var h = $(HEAD[state.rs.step]); h.focus(); try { h.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (e) { /* older browsers */ } }
  }
  function figuresHtml(groups) {
    var all = []; (groups || []).forEach(function (g) { (g.figures || []).forEach(function (f) { all.push({ g: g, f: f }); }); });
    if (!all.length) return "";
    var prin = [];
    PRINCIPAL.forEach(function (re) { all.forEach(function (x) { if (re.test(x.f.label) && prin.indexOf(x) < 0) prin.push(x); }); });
    if (prin.length < 3) all.forEach(function (x) { if (prin.length < 6 && prin.indexOf(x) < 0) prin.push(x); });
    var row = function (x) { return "<tr><td>" + esc(x.f.label) + '</td><td class="v">' + esc(x.f.display) + (x.f.small ? ' <span class="hint">(small sample)</span>' : "") + '</td><td class="cmp">' + esc(x.f.compare || "").split("; ").join("<br>") + "</td></tr>"; };
    var head = '<thead><tr><th scope="col">Measure</th><th scope="col">Reported</th><th scope="col">Compared with</th></tr></thead>';
    var h = '<table class="fig-t" aria-label="Principal market statistics">' + head + "<tbody>" + prin.map(row).join("") + "</tbody></table>";
    if (all.length > prin.length) {
      h += '<details class="rs-more"><summary>View all figures (' + all.length + ')</summary><table class="fig-t" aria-label="All figures read from the report">' + head + "<tbody>";
      (groups || []).forEach(function (g) { h += '<tr class="sh"><td colspan="3">' + esc(g.heading) + (g.window ? " · " + esc(g.window) : "") + "</td></tr>" + all.filter(function (x) { return x.g === g; }).map(row).join(""); });
      h += "</tbody></table></details>";
    }
    return h;
  }

  // ── Session line ──
  function renderSession(s) {
    state.session = s || state.session;
    var x = state.session;
    if (!x) { $("sessionLine").textContent = ""; return; }
    var who = x.pool === "team" ? "Your team has" : x.pool === "brokerage" ? "Your brokerage has" : "You have";
    $("sessionLine").textContent = who + " " + x.remaining + " of " + x.allowance + " included research sessions left this month" + (x.shared ? " (shared)." : ".") + " A session is used only when five sourced topics are delivered.";
  }

  // ── Results ──
  function money(n) { return n == null ? "n/a" : "$" + Number(n).toFixed(4); }
  function renderCost(r) {
    var u = r.usage;
    if (!u) { $("resCost").innerHTML = '<div class="hint" style="margin-top:12px">Cost is hidden. To see it here while testing, set <b>AGENT_MARKETING_RESEARCH_DEBUG</b> to <b>true</b> in Netlify and redeploy.</div>'; return; }
    if (!u.providerError && r.status === "failed" && u.problems && u.problems.length) { $("resCost").innerHTML = '<div class="cost over"><div class="eyebrow">Why it failed</div><div><b>The answer was rejected for:</b><ul style="margin:6px 0 0 18px">' + u.problems.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + '</ul></div><div class="hint">Model ' + esc(r.model || "?") + " · attempts " + esc(u.attempts) + ". No session was used and nothing was charged.</div></div>"; return; }
    if (u.providerError) { $("resCost").innerHTML = '<div class="cost over"><div class="eyebrow">Why it failed</div><div><b>Perplexity said:</b> ' + esc(u.providerError) + '</div><div class="hint">Model ' + esc(r.model || "?") + " · attempts " + esc(u.attempts) + ". No session was used and nothing was charged.</div></div>"; return; }
    var cls = u.withinTarget === true ? "under" : u.withinTarget === false ? "over" : "";
    $("resCost").innerHTML = '<details class="cost ' + cls + '"><summary style="cursor:pointer"><span class="eyebrow">What this run cost</span> <b>' + money(u.costUsd) + "</b></summary>" +
      "<div>" + (u.costEstimated ? "Estimated from tokens (Perplexity did not report a cost). " : "Reported by Perplexity. ") +
      "Target " + money(u.targetUsd) + (u.withinTarget === true ? " · <b>within target</b>" : u.withinTarget === false ? " · <b>over target</b>" : "") + "</div>" +
      '<div class="hint">Model ' + esc(r.model || "?") + " · attempts " + esc(u.attempts) + " · tokens in " + esc(u.promptTokens) + " / out " + esc(u.completionTokens) +
      (u.searchQueries != null ? " · searches " + esc(u.searchQueries) : "") + " · sources checked against the provider: " + (u.grounded === true ? "yes" : u.grounded === false ? "no (provider sent none)" : "n/a") + "</div></details>";
  }
  function srcLine(s) {
    if (s.type === "report") return '<div class="src"><b>Your MLS report</b>' + (s.published ? " <span>\u00b7 through " + esc(s.published) + "</span>" : "") + "</div>";
    return '<div class="src"><a href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer">' + esc(s.title) + '</a> <span>· ' + esc(s.domain) + (s.published ? " · " + esc(s.published) : "") + "</span></div>";
  }
  // Everything beyond the hook, the reason and the sources sits behind one closed "Details". Figures from the agent's report are listed only
  // for a topic written from the report; a web topic never repeats the whole report.
  function topicDetails(t) {
    var parts = [];
    if (t.scope !== "selected" || (t.origin === "report" && t.scopeNote)) parts.push("<b>" + (t.scope !== "selected" ? "Data covers" : "Note") + ":</b> " + esc(t.scopeNote));
    if (t.origin === "report" && t.reportFigures && t.reportFigures.length) parts.push("<b>Report figures:</b> " + t.reportFigures.map(function (f) { return esc(f.text); }).join(" \u00b7 "));
    if (t.reframed && t.areaContext && t.areaContext.length) parts.push("<b>Article context:</b> " + t.areaContext.map(function (c) { return esc(c.text); }).join(" \u00b7 "));
    if (t.trendSignals && t.trendSignals.length) parts.push("<b>Trend signals:</b> " + t.trendSignals.map(esc).join(" \u00b7 "));
    if (t.recommended && (t.recommended.evidence || []).length) parts.push("<b>Evidence:</b> " + t.recommended.evidence.map(esc).join(" \u00b7 "));
    // B2 (Nov 8, 2026): the Realtor editorial direction and the article statements it rests on (B1 validated findings).
    if (t.b2 && t.b2.mode === "trend_report") {
      if (t.b2.relationship) parts.push("<b>What the report shows:</b> " + esc(t.b2.relationship));
      if (t.b2.realtorInterpretation) parts.push("<b>Realtor interpretation:</b> " + esc(t.b2.realtorInterpretation));
      if (t.b2.homeownerImplication) parts.push("<b>For homeowners:</b> " + esc(t.b2.homeownerImplication));
      if (t.b2.audienceJourney) parts.push("<b>Across the decision journey:</b> " + esc(t.b2.audienceJourney));
      if (t.b2.editorialAngle) parts.push("<b>Editorial angle:</b> " + esc(t.b2.editorialAngle));
    } else if (t.b2) {
      if (t.b2.editorialAngle) parts.push("<b>Editorial angle:</b> " + esc(t.b2.editorialAngle));
      if (t.b2.mechanism) parts.push("<b>From the article:</b> " + esc(t.b2.mechanism));
      if (t.b2.homeownerImplication) parts.push("<b>For homeowners:</b> " + esc(t.b2.homeownerImplication));
      var refs = (t.b2.sourceRefs || []).filter(function (r) { return r && r.quote; });
      if (refs.length) parts.push("<b>Article sources:</b> " + refs.map(function (r) { return "\u201c" + esc(r.quote) + "\u201d" + (r.attribution ? " (" + esc(r.attribution) + ")" : ""); }).join(" \u00b7 "));
      if (t.b1 && t.b1.completeness && t.b1.completeness !== "COMPLETE") parts.push("<b>Note:</b> some statements in this article were held back as unverified and are not used.");
    }
    if (t.reportFigures && t.reportFigures.length && t.origin !== "report" && t.b2) parts.push("<b>Market figures from your report:</b> " + t.reportFigures.slice(0, 6).map(function (f) { return esc(f.text); }).join(" \u00b7 "));
    if (!parts.length) return "";
    return '<details class="kv"><summary style="cursor:pointer">Details</summary>' + parts.map(function (x) { return '<div class="kv">' + x + "</div>"; }).join("") + "</details>";
  }
  function renderTopic(t, pickedId, outdated) {
    var ev = t.event;
    return '<div class="topic' + (t.id === pickedId ? " picked" : "") + '"><div class="tags"><span class="tag">' + esc(t.id.toUpperCase()) + "</span>" +
      '<span class="tag ' + (t.scope === "selected" ? "ok" : "warn") + '">' + (t.scope === "selected" ? "Your exact market" : "Broader context") + "</span>" +
      '<span class="tag ' + (t.origin === "report" ? "ok" : "") + '">' + (t.origin === "report" ? "From your report" : "From web research") + "</span>" +
      (t.recommended ? '<span class="tag ok">Recommended</span>' : "") +
      (t.smallSample ? '<span class="tag warn">Small sample</span>' : "") +
      (t.localIntent ? '<span class="tag ok">Local intent</span>' : "") + "</div><h3>" + esc(t.question) + '</h3>' +
      (t.reframed && t.articleQuestion ? '<div class="kv"><b>From the article:</b> ' + esc(t.articleQuestion) + "</div>" : "") +
      '<div class="why">' + esc(t.whyItMatters) + "</div>" +
      (t.reframed && t.answeredBy && t.answeredBy.length ? '<div class="kv"><b>Answered by:</b> ' + t.answeredBy.map(function (f) { return esc(f.text); }).join(" \u00b7 ") + "</div>" : "") +
      (t.recommended ? '<div class="kv"><b>Why this one:</b> ' + esc(t.recommended.reason) + "</div>" : "") +
      topicDetails(t) +
      (ev ? '<div class="kv"><b>' + esc(ev.name) + "</b> · " + esc(ev.date) + (ev.endDate ? " to " + esc(ev.endDate) : "") + " · " + esc(ev.time) + "</div>" +
        '<div class="kv"><b>Where:</b> ' + esc(ev.location) + " · <b>Organizer:</b> " + esc(ev.organizer) + " · <b>Status:</b> " + esc(ev.status) + "</div>" : "") +
      "<div style=\"margin-top:6px\">" + (t.sources || []).map(srcLine).join("") + "</div>" +
      '<div class="actions" style="margin-top:10px"><button class="btn small ' + (t.id === pickedId ? "" : "gold") + '" type="button" data-pick="' + esc(t.id) + '"' + (outdated ? ' disabled aria-disabled="true" title="Out of date: find topics again"' : "") + ">" + (outdated ? "Out of date" : t.id === pickedId ? "Selected" : (t.b2 && t.b2.mode === "trend_report" ? "Choose this perspective" : "Select this topic")) + "</button></div></div>";
  }
  // Results get the screen: the request folds into one line (Change request brings the form back).
  // The research request folds into a summary once results are showing. On the stepper page this opens the Find Topics task (or the task named in target).
  function foldSetup(on, target) {
    if (RS()) {
      if (on) { state.rs.marketDone = true; if (!reportConfirmed() && reportMode() === "optional") state.rs.reportSkipped = true; }
      setStep(on ? "topics" : (target || "market"));
      return;
    }
    $("setupBody").classList.toggle("hidden", on);
    $("setupBar").classList.toggle("hidden", !on);
    if (on && state.current) {
      var g = state.current.geography || {}, a = (state.schema.audiences.filter(function (x) { return x.key === state.current.audience; })[0] || {}).label || "";
      var f = state.current.focus || {}, kw = f.keywords ? " · " + f.keywords : "";
      $("setupBarText").innerHTML = "<b>" + esc((g.label || g.name || "")) + "</b> · " + esc(a) + esc(kw);
    }
  }
  function showResult(r) {
    stopPoll();
    $("resultPanel").classList.remove("hidden");
    state.current = r;
    $("resEyebrow").textContent = (r.mode === "local_events" ? "Local Events" : "Local Market Update") + " · " + (r.geography && r.geography.label || "");
    $("resTitle").textContent = r.status === "ready" ? (r.pathway === "article_led" && r.delivered < 5 ? r.delivered + " of 5 opportunities" : r.marketUpdateMode === "trend_report" && (r.topics || []).some(function (t) { return t.b2 && t.b2.mode === "trend_report"; }) ? r.topics.length + " perspectives from your report" : "Five topics") + (r.researchDate ? " from " + r.researchDate : "") : r.status === "failed" ? "No topics this time" : "Researching…";
    $("resWait").classList.toggle("hidden", r.status !== "running");
    $("resError").classList.toggle("hidden", r.status !== "failed");
    if (r.status === "failed") $("resError").textContent = (r.error || "The research could not be completed.") + (/did not use a session/.test(r.error || "") ? "" : " This did not use a session.");
    renderFailOptions(r);
    say("resNote", r.status === "ready" ? (r.note || (r.marketUpdateMode === "article_editorial" || r.marketUpdateMode === "article_report" ? "Each topic was written from a local article the system read; open Details for the article's own words and the editorial angle." : r.dataSource !== "report" && r.mode !== "local_events" ? "Figures from web research come from public pages. They can differ from your MLS numbers or be preliminary. Upload your MLS report to base your topics on your own data." : "")) : "");
    renderMlsOption(r);
    var od = outdatedFor(r);
    var banner = od && r.status === "ready" ? '<div class="rs-alert bad" id="odBanner" role="alert"><b>These topics are out of date.</b> You changed this report\u2019s confirmation after they were made' + (changeText(od) ? " (" + esc(changeText(od)) + ")" : "") + ". They are kept for reference and cannot be chosen. Find topics again to get a set that matches your confirmation.</div>" : "";
    var pickedId = state.selected && state.selected.researchId === r.id ? state.selected.id : null;
    var chosen = pickedId && r.status === "ready" ? r.topics.filter(function (t) { return t.id === pickedId; })[0] : null;
    var bar = chosen ? '<div id="selBar" style="border:1px solid var(--gold);background:#fdf9f0;border-radius:6px;padding:12px 14px;margin-top:12px;display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap"><div style="font-size:0.88rem"><b style="color:var(--success)">\u2713 Topic selected</b><div>' + esc(chosen.question) + "</div></div>" +
      (opts.onContinue && !od ? '<button class="btn gold small" type="button" id="selContinue">Choose the call to action</button>' : "") + "</div>" : "";
    var hasNotice = r.status === "ready" && r.topics.some(function (t) { return t.reportNotice; });
    var noticeLine = hasNotice ? '<div class="hint" style="margin-top:10px">Topics that use your report carry MetroList\u2019s required notice automatically; you do not need to write it.</div>' : "";
    $("resTopics").innerHTML = banner + bar + noticeLine + (r.status === "ready" ? r.topics.map(function (t) { return renderTopic(t, pickedId, !!od); }).join("") : "");
    if ($("selContinue")) $("selContinue").addEventListener("click", function () { opts.onContinue(state.selected); });
    renderCost(r);
    if (RS()) { state.rs.marketDone = true; if (!reportConfirmed() && reportMode() === "optional") state.rs.reportSkipped = true; setStep("topics"); } else foldSetup(r.status === "ready");
    say("selMsg", "");
    Array.prototype.forEach.call($("resTopics").querySelectorAll("[data-pick]"), function (b) { b.addEventListener("click", function () { pick(r.id, b.getAttribute("data-pick")); }); });
    if (!opts.__pickedNow) $("resultPanel").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  // When research fails or comes back thin, the agent chooses what happens next. The area is never widened on its own.
  function setForm(r) {
    var g = r.geography || {}, f = r.focus || {};
    var m = document.querySelector('input[name="mode"][value="' + r.mode + '"]'); if (m) m.checked = true;
    $("geoType").value = g.type || "city"; applyGeo();
    $("geoName").value = g.name || ""; $("geoCity").value = g.city || ""; $("geoZip").value = g.zip || ""; applyZip();
    $("audience").value = r.audience || $("audience").value;
    $("f55").checked = !!f.active_adult_55; $("fNew").checked = !!f.new_construction; $("keywords").value = f.keywords || "";
    $("dataFocus").value = f.dataFocus || "all";
    var p = f.period || { days: 30 };
    if (p.start) { $("period").value = "custom"; $("periodFrom").value = p.start; $("periodTo").value = p.end; } else { $("period").value = String(p.days || 30); $("periodFrom").value = ""; $("periodTo").value = ""; }
    applyFocus();
  }
  // Article-Led research can come back with fewer than five opportunities. The MLS Market Trend Reel is a separate, deliberate workflow: it builds the topics
  // from the agent's confirmed report only. It never replaces or fills the Article-Led topics automatically; the agent chooses it and confirms it.
  function renderMlsOption(r) {
    var box = $("resMlsOption"); if (!box) return;
    if (!(state.schema && state.schema.articleLed) || r.pathway !== "article_led" || (r.status !== "ready" && r.status !== "failed")) { box.classList.add("hidden"); box.innerHTML = ""; return; }
    box.innerHTML = '<div class="hint" style="margin:10px 0 8px">Separate option: build Reel topics from your confirmed MLS report only, with no web research.</div>' +
      '<div class="actions"><button type="button" class="btn ghost small" id="mlsTrendBtn">Create an MLS Market Trend Reel</button></div><div class="msg" id="mlsTrendMsg"></div>';
    box.classList.remove("hidden");
    $("mlsTrendBtn").addEventListener("click", function () {
      var u = state.upload;
      if (!u || u.status !== "confirmed" || !u.id) { say("mlsTrendMsg", "Attach your MLS report above and confirm it, then choose this again.", "err"); return; }
      say("mlsTrendMsg", ""); setForm(r); state.mlsTrend = true; $("resultPanel").classList.add("hidden"); review();
    });
  }
  function renderFailOptions(r) {
    var box = $("resFailOptions"); if (!box) return;
    if (r.status !== "failed") { box.classList.add("hidden"); box.innerHTML = ""; return; }
    var g = r.geography || {}, btns = [{ k: "retry", t: "Try again" }];
    if (g.type === "neighborhood" && g.city) btns.push({ k: "city", t: "Widen to " + g.city });
    else if (g.type === "city" || g.type === "zip") btns.push({ k: "county", t: "Widen to the county" });
    btns.push({ k: "edit", t: "Change my request" });
    box.innerHTML = '<div class="hint" style="margin-bottom:8px">Your area was not widened. Choose what to do next; you will see a summary and confirm before anything runs.</div><div class="actions">' +
      btns.map(function (b) { return '<button type="button" class="btn ' + (b.k === "retry" ? "gold" : "ghost") + ' small" data-fail="' + b.k + '">' + esc(b.t) + "</button>"; }).join("") + "</div>";
    box.classList.remove("hidden");
    Array.prototype.forEach.call(box.querySelectorAll("[data-fail]"), function (b) {
      b.addEventListener("click", function () {
        var k = b.getAttribute("data-fail");
        setForm(r); hideConfirm();
        if (k === "city") { $("geoType").value = "city"; applyGeo(); $("geoName").value = g.city; $("geoCity").value = ""; }
        if (k === "county") { $("geoType").value = "county"; applyGeo(); $("geoName").value = ""; }
        $("resultPanel").classList.add("hidden");
        if (k === "retry" || k === "city") { $("startBtn").scrollIntoView({ block: "center" }); review(); }
        else { $("geoName").focus(); $("geoName").scrollIntoView({ block: "center" }); }
      });
    });
  }
  // A saved set built from a report asks first: use that report as it is, or update it. The server will not select the topic until the agent answers.
  function askReport(researchId, topicId, reports) {
    return new Promise(function (resolve) {
      var m = $("rcModal");
      $("rcList").innerHTML = (reports || []).map(function (x) { return '<div class="saved"><div><b>' + esc(x.scopeNote || "Your MLS report") + '</b>' + (x.uploadedAt ? '<div class="hint">Attached ' + esc(String(x.uploadedAt).slice(0, 10)) + "</div>" : "") + "</div></div>"; }).join("");
      var done = function (v) { m.classList.add("hidden"); $("rcUse").onclick = $("rcUpdate").onclick = $("rcX").onclick = null; resolve(v); };
      $("rcUse").onclick = function () { done("use"); };
      $("rcUpdate").onclick = function () { done("update"); };
      $("rcX").onclick = function () { done("cancel"); };
      m.classList.remove("hidden");
    });
  }
  async function pick(researchId, topicId, reportChoice) {
    say("selMsg", "Saving your choice…");
    try {
      var r = await api(API, "POST", "", { action: "select", projectId: state.projectId, researchId: researchId, topicId: topicId, reportChoice: reportChoice });
      if (!r.ok && r.json && r.json.code === "report_choice") {
        say("selMsg", "");
        var c = await askReport(researchId, topicId, r.json.reports);
        if (c === "use") return pick(researchId, topicId, "use");
        if (c === "update") {
          // The newer report starts a new request: the form is filled from this set, the agent attaches the report and confirms it, then researches again.
          var set = state.current && state.current.id === researchId ? state.current : null;
          if (set) setForm(set);
          hideConfirm(); $("resultPanel").classList.add("hidden"); foldSetup(false, "report");
          say("startMsg", "Attach your newer report below and confirm it, then research this market again. Your saved research stays in the library.", "ok");
          var f = $("upFile"); if (f) f.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        return;
      }
      if (!r.ok) return say("selMsg", r.json.error || "Could not save your choice.", "err");
      state.selected = r.json.selectedTopic;
      if (r.json.reportAttached && state.restoreUpload) await state.restoreUpload(); // a saved set brings its report along
      if (opts.onSelected) opts.onSelected(state.selected);
      opts.__pickedNow = true; showResult(state.current); opts.__pickedNow = false;
      say("selMsg", "Saved. Resuming this project later restores this topic without a new research call.", "ok");
      var b = $("selBar"); if (b) b.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (e) { say("selMsg", e.message, "err"); }
  }
  function renderSaved(list, earlier) {
    earlier = earlier || [];
    var all = list.concat(earlier);
    var rowHtml = function (r) {
      return '<div class="saved"><div><b>' + esc(r.mode === "local_events" ? "Local Events" : "Market Update") + "</b> · " + esc(r.geography && r.geography.label) + " · " + esc(r.audience) +
        '<div class="hint">' + esc(r.status === "ready" ? "Five topics, " + (r.researchDate || "") + (r.reportOutdated ? " \u00b7 out of date: the report confirmation changed" : "") : r.status === "failed" ? "Failed, not charged" : "Running") + "</div></div>" +
        '<button class="btn ghost small" type="button" data-open="' + esc(r.id) + '">Open</button></div>';
    };
    $("savedList").innerHTML = !all.length ? '<div class="hint" style="padding:14px 0">No saved research yet. Run a request and it will appear here.</div>'
      : (list.length ? list.map(rowHtml).join("") : "") + (earlier.length ? '<div class="hint" style="padding:10px 0 4px">' + (list.length ? "From your earlier projects" : "Your saved research from earlier projects") + "</div>" + earlier.map(rowHtml).join("") : "");
    Array.prototype.forEach.call($("savedList").querySelectorAll("[data-open]"), function (b) {
      b.addEventListener("click", function () { var r = all.filter(function (x) { return x.id === b.getAttribute("data-open"); })[0]; if (r) { closeLib(); showResult(r); if (r.status === "running") startPoll(r.id); } });
    });
  }
  function openLib() { $("libModal").classList.remove("hidden"); $("libX").focus(); }
  function closeLib() { $("libModal").classList.add("hidden"); $("libBtn").focus(); }
  function wireIntakeExtras() {
    $("libBtn").addEventListener("click", openLib);
    $("libX").addEventListener("click", closeLib);
    $("libModal").addEventListener("click", function (e) { if (e.target === $("libModal")) closeLib(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !$("libModal").classList.contains("hidden")) closeLib(); });
    var REPORT = "/.netlify/functions/agent-marketing-report";
    var MAX_BYTES = 4 * 1024 * 1024;
    // state.upload: null | { busy, id, status: "pending" | "confirmed", summary }
    function resetReview() { state.upload = null; state.edit = null; $("upFix").classList.add("hidden"); $("upFixText").value = ""; Array.prototype.forEach.call(document.querySelectorAll('input[name="upWhy"]'), function (c) { c.checked = false; }); $("upReview").classList.add("hidden"); $("upMsg").textContent = ""; $("upGroups").innerHTML = ""; $("upWarn").innerHTML = ""; }
    function syncUpload() {
      var has = !!($("upFile").files && $("upFile").files.length > 0);
      var ok = has && $("upOk").checked;
      var confirmed = !!(state.upload && state.upload.status === "confirmed");
      $("upRow").classList.toggle("hidden", !has);
      $("upFile").style.display = has ? "none" : "";
      if (has) $("upName").textContent = $("upFile").files[0].name;
      $("attestBox").classList.toggle("hidden", !has || !!state.upload);
      if (!has) { $("upOk").checked = false; $("attestMsg").textContent = ""; }
      if (ok) $("attestMsg").textContent = "";
      $("uploadBox").classList.toggle("has", has);
      rsRender();
    }
    function toBase64(file) {
      return new Promise(function (resolve, reject) {
        var fr = new FileReader();
        fr.onload = function () { resolve(String(fr.result).replace(/^data:[^,]*,/, "")); };
        fr.onerror = function () { reject(new Error("Could not read that file.")); };
        fr.readAsDataURL(file);
      });
    }
    // The project's chosen place, sent only so the read-back form can PRE-FILL a suggestion. It is never an attestation: the agent must still confirm.
    function uploadGeography() {
      try { var q = collect().geography; return q && q.name ? q : undefined; } catch (e) { return undefined; }
    }
    var SCOPE_TYPES = [["city", "One city"], ["cities", "Several cities combined"], ["county", "A county"], ["zips", "ZIP code(s)"], ["custom", "Another area"]];
    function listIn(a) { return (a || []).map(esc).join(", "); }
    // Two zones, side by side: what the DOCUMENT reported (left) and what the AGENT attests (right). The second zone is never filled in silently.
    function renderReadBack(u, draft) {
      var box = $("upReadBack"), rv = (u.summary || {}).review;
      if (!box && $("upWarn")) { box = document.createElement("div"); box.id = "upReadBack"; box.className = "hidden"; $("upWarn").parentNode.insertBefore(box, $("upWarn").nextSibling); }   // pages that predate the markup
      if (!box) return;
      if (!rv) { box.classList.add("hidden"); box.innerHTML = ""; return; }
      var editing = !!state.edit && u.status === "confirmed", r = rv.reported, a = rv.attested, done = u.status === "confirmed" && !editing, need = rv.needed || [], conflicts = a.conflicts || [];
      var sel = a.geography.selected, sug = (!sel && a.geography.suggested) || null, pts = a.propertyTypes.selected, psug = (!pts && a.propertyTypes.suggested) || null;
      var type = (sel || sug || {}).type || "city", names = (sel || sug || {}).names || [];
      var h = '<div class="rs-grid rv"><div class="rs-col"><div class="rs-card"><div class="ch">Reported by the document <span class="rs-tag">as printed</span></div>';
      h += '<div class="rs-chips"><span class="rs-chip"><b>' + esc(REPORT_TYPES[r.reportType] || "Report") + "</b></span><span class=\"rs-chip\">" + esc(r.period.label) + "</span>" +
        (r.period.partial ? '<span class="rs-chip hl">part of a year</span>' : "") +
        (r.comparisons || []).map(function (c) { return '<span class="rs-chip" title="' + esc(c.meaning) + '">' + esc(c.printed) + "</span>"; }).join("") + "</div>";
      (r.comparisons || []).forEach(function (c) { if (c.eligibility && c.eligibility.note) h += '<div class="hint">' + esc(c.printed) + ": " + esc(c.eligibility.note) + "</div>"; });
      if (r.header && r.header.geography) h += '<div class="hint">Header: <span' + (conflicts.length ? ' class="rs-chip hl"' : "") + ">“" + esc(r.header.geography) + "”</span>" + (r.header.geographyUnreliable ? " (printed the same on every export, so it is not used for the area)" : "") + "</div>";
      h += figuresHtml((u.summary || {}).groups);
      if ((r.notPrinted || []).length) h += '<div class="hint">Not printed in this report: ' + r.notPrinted.map(function (n) { return esc(n.label || n.key); }).join(", ") + "</div>";
      if ((r.unread || []).length) h += '<div class="hint">Could not read: ' + r.unread.map(function (n) { return esc(n.label || n); }).join(", ") + "</div>";
      h += attrHtml(u) + "</div></div>";
      h += '<div class="rs-col"><div class="rs-card you"><div class="ch">Confirmed by you <span class="rs-tag ' + (done ? "ok" : "wait") + '">' + (done ? "confirmed" : editing ? "editing" : "to confirm") + '</span></div><div class="hint" style="margin-top:0">' + esc(a.note) + "</div>";
      if (done) {
        h += '<div style="margin-top:8px;font-size:0.88rem">Area: <b>' + esc(a.geography.areaLabel || "") + "</b>" + (a.geography.scopeKind === "combined" ? " (combined market: never stated for one place alone)" : "") + "<br>Property types: <b>" + listIn(pts && pts.names) + "</b>" + (a.dataThrough ? "<br>Data through: <b>" + esc(fmtDate(a.dataThrough.date)) + "</b> " + (a.dataThrough.provenance === "subscriber_attested" ? '<span class="hint">(your date; not independently verified)</span>' : '<span class="hint">(' + (a.dataThrough.provenance === "cross_report" ? "supported by your year-to-date report" : "printed in the report") + ")</span>") : "") + "</div>";
      } else {
        if (editing) h += '<div class="hint" style="margin-top:6px">You are editing this confirmation. Tick the box again to save. Topics already made with the old confirmation will be marked out of date.</div>';
        else if (a.carriedFrom) h += '<div class="hint" style="margin-top:6px">Carried forward from ' + esc(a.carriedFrom) + ". Change it below if this report is different.</div>";
        else if (sug || psug) h += '<div class="hint" style="margin-top:6px">Suggested from your project. Check it, change it if needed, then confirm.</div>';
        h += '<div class="row2"><div><label class="lbl" for="rbType">Area this report covers</label><select id="rbType">' + SCOPE_TYPES.map(function (t) { return '<option value="' + t[0] + '"' + (t[0] === type ? " selected" : "") + ">" + t[1] + "</option>"; }).join("") + '</select></div>';
        h += '<div><label class="lbl" for="rbNames">Place name(s)</label><input type="text" id="rbNames" maxlength="200" placeholder="Separated by commas" value="' + esc(names.join(", ")) + '"></div></div>';
        h += '<label class="lbl" for="rbTypes">Property types this report covers</label><input type="text" id="rbTypes" maxlength="200" placeholder="For example: Single Family, Condo" value="' + esc(((pts && pts.names) || psug || []).join(", ")) + '">';
        if (need.indexOf("dataThrough") >= 0 || (editing && a.dataThrough && a.dataThrough.provenance === "subscriber_attested")) h += '<label class="lbl" for="rbThrough">Last date this report\'s data covers (required)</label><input type="date" id="rbThrough" value="' + esc(a.dataThrough ? a.dataThrough.date : "") + '"><div class="hint">The report does not say. A date you enter is recorded as yours, not verified.</div>';
        conflicts.forEach(function (c) { h += '<div class="rs-alert bad" role="alert">' + esc(c.message) + "</div>"; });
        if (need.indexOf("conflicts") >= 0 || conflicts.length) h += '<label class="choice" style="margin-top:8px"><input type="checkbox" id="rbAck"><span>I have read the differences noted above and my selection is right.</span></label>';
        if (editing || !a.carriedFrom || a.geography.status !== "ok") h += '<label class="choice" style="margin-top:8px"><input type="checkbox" id="rbAttest"><span>I confirm these describe this report. I understand they are my statements and are not checked against the file.</span></label>';
      }
      h += "</div></div></div>";
      box.innerHTML = h; box.classList.remove("hidden");
      if (draft && $("rbType")) {   // after a refused confirmation keep what the agent typed and ticked
        ["rbType", "rbNames", "rbTypes", "rbThrough"].forEach(function (id) { if ($(id) && draft[id] != null) $(id).value = draft[id]; });
        ["rbAck", "rbAttest"].forEach(function (id) { if ($(id) && draft[id]) $(id).checked = true; });
      }
    }
    function readDraft() {
      var d = {}; ["rbType", "rbNames", "rbTypes", "rbThrough"].forEach(function (id) { if ($(id)) d[id] = $(id).value; });
      ["rbAck", "rbAttest"].forEach(function (id) { if ($(id)) d[id] = $(id).checked; });
      return d;
    }
    function readBackPayload(u) {
      var rv = (u.summary || {}).review;
      if (!rv || (u.status === "confirmed" && !state.edit)) return {};
      var carried = !state.edit && !!(rv.attested && rv.attested.carriedFrom), out = {};
      if ($("rbType")) {
        if (!carried && $("rbAttest") && !$("rbAttest").checked) return { error: "Tick the box to confirm the area and property types are yours." };
        out.scope = { type: $("rbType").value, names: $("rbNames").value.split(",").map(function (x) { return x.trim(); }).filter(Boolean) };
        out.propertyTypes = $("rbTypes").value.split(",").map(function (x) { return x.trim(); }).filter(Boolean);
        if ($("rbThrough") && $("rbThrough").value) out.dataThrough = $("rbThrough").value;
        if ($("rbAck")) out.acknowledgeConflicts = $("rbAck").checked;
      }
      return out;
    }
    function renderReview(u) {
      var s = u.summary || {};
      $("upScope").textContent = (s.scopeSentence || "") + (s.review ? (u.status === "confirmed" ? "" : " Check the details under “Confirmed by you”.") : " Correct?");
      // A report read by the Market Review reader shows its figures inside the two-column read-back; any other layout keeps the figures here.
      $("upGroups").innerHTML = s.review ? "" : figuresHtml(s.groups);
      $("upWarn").innerHTML = (s.warnings || []).map(function (w) { return '<div class="rs-alert" role="status">' + esc(w) + "</div>"; }).join("");
      if (s.notice && !s.review) $("upWarn").innerHTML += '<div class="rs-attr"><details><summary>MetroList attribution</summary><div>Required notice for anything you publish with these figures: <b>' + esc(s.notice) + "</b></div></details></div>";
      $("upYes").classList.toggle("hidden", u.status === "confirmed");
      if (u.status !== "confirmed") state.edit = null;
      $("upNo").textContent = u.status === "confirmed" ? "Remove this report" : "Not right, remove";
      if ($("upSourceNote")) $("upSourceNote").classList.toggle("hidden", u.status === "confirmed");
      var rows = s.layout === "cma_table" || s.layout === "listing_table";
      $("upWindowBox").classList.toggle("hidden", !rows);
      renderReadBack(u);
      $("upReview").classList.remove("hidden");
      rsRender();
    }
    // The date window for a report that has dated rows (a CMA or an MLS export). Trend reports are monthly figures and have none.
    function chosenWindow() {
      var v = $("upWindow").value;
      if (v === "all") return null;
      if (v === "custom") return { start: $("upFrom").value, end: $("upTo").value };
      return { days: Number(v) };
    }
    function resetWindow() { $("upWindow").value = "all"; $("upFrom").value = ""; $("upTo").value = ""; $("upDates").classList.add("hidden"); }
    async function reread() {
      var u = state.upload;
      if ($("upWindow").value === "custom" && (!$("upFrom").value || !$("upTo").value)) { $("upMsg").textContent = "Enter both dates."; return; }
      if (u && u.id) { try { await api(REPORT, "POST", "", { action: u.status === "confirmed" ? "remove" : "confirm", uploadId: u.id, correct: false }); } catch (e) { /* replaced below */ } }
      var keep = chosenWindow(); resetReview(); syncUpload(); state.pendingWindow = keep;
      await sendUpload();
    }
    async function sendUpload() {
      var file = $("upFile").files[0];
      if (!file) return;
      if (file.size > MAX_BYTES) { $("attestMsg").textContent = "That file is larger than 4 MB. Try one property type or a shorter date range."; $("upOk").checked = false; return; }
      state.upload = { busy: true }; state.rs.reportSkipped = false;
      $("attestMsg").textContent = "Reading your report…"; rsRender();
      try {
        var b64 = await toBase64(file);
        var r = await api(REPORT, "POST", "", { action: "upload", projectId: state.projectId, fileName: file.name, fileBase64: b64, permission: true, window: state.pendingWindow || null, geography: uploadGeography() });
        if (!r.ok) { state.upload = null; $("upOk").checked = false; $("attestMsg").textContent = (r.json && r.json.error) || "Could not read that file."; return; }
        state.upload = { id: r.json.upload.id, status: r.json.upload.status, summary: r.json.upload.summary };
        state.pendingWindow = null;
        $("attestMsg").textContent = "";
        renderReview(state.upload); syncUpload();
        $("upReview").scrollIntoView({ behavior: "smooth", block: "nearest" });
      } catch (e) { state.upload = null; $("upOk").checked = false; $("attestMsg").textContent = e.message; }
    }
    async function removeUpload() {
      var u = state.upload;
      if (u && u.id) {
        try { await api(REPORT, "POST", "", { action: u.status === "confirmed" ? "remove" : "confirm", uploadId: u.id, correct: false }); } catch (e) { /* the file is gone from the page either way */ }
      }
      $("upFile").value = ""; $("upOk").checked = false; resetReview(); resetWindow(); syncUpload();
    }
    state.removeUpload = removeUpload;
    $("upOk").addEventListener("change", function () { syncUpload(); if ($("upOk").checked && !state.upload) sendUpload(); });
    $("upFile").addEventListener("change", function () {
      if (state.upload && state.upload.id) removeUpload(); // choosing a different file replaces the old report
      $("upOk").checked = false; resetReview(); resetWindow(); syncUpload();
      if ($("upFile").files.length) $("attestBox").scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    $("upWindow").addEventListener("change", function () { $("upDates").classList.toggle("hidden", $("upWindow").value !== "custom"); });
    $("upWindowGo").addEventListener("click", reread);
    $("upX").addEventListener("click", removeUpload);
    // "Not right": say what is wrong first (kept for us), then the report is removed. A confirmed report is removed straight away.
    $("upNo").addEventListener("click", function () {
      if (state.upload && state.upload.status === "confirmed") return removeUpload();
      $("upFix").classList.remove("hidden"); $("upFix").scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    $("upFixCancel").addEventListener("click", function () { $("upFix").classList.add("hidden"); });
    $("upFixSend").addEventListener("click", async function () {
      var u = state.upload; if (!u || !u.id) return;
      var reasons = Array.prototype.map.call(document.querySelectorAll('input[name="upWhy"]:checked'), function (c) { return c.value; });
      var note = $("upFixText").value.trim();
      if (!reasons.length && !note) { $("upMsg").textContent = "Tick what is wrong or write a short note."; return; }
      $("upFixSend").disabled = true;
      try {
        var r = await api(REPORT, "POST", "", { action: "feedback", uploadId: u.id, reasons: reasons, message: note });
        if (!r.ok) { $("upMsg").textContent = (r.json && r.json.error) || "Could not send that."; return; }
        $("upFile").value = ""; $("upOk").checked = false; resetReview(); resetWindow(); syncUpload();
        say("startMsg", "Thanks, I have your note and removed that report. Try another file, or an export filtered to your area.", "ok");
      } catch (e) { $("upMsg").textContent = e.message; }
      finally { $("upFixSend").disabled = false; }
    });
    $("upYes").addEventListener("click", async function () {
      var u = state.upload; if (!u || !u.id) return;
      $("upMsg").textContent = "";
      try {
        var draft = readDraft(), extra = readBackPayload(u);
        if (extra.error) { say("startMsg", extra.error, "err"); $("upMsg").textContent = extra.error; var f1 = $("rbAttest") && !$("rbAttest").checked ? $("rbAttest") : null; if (f1) f1.focus(); return; }
        var un = unresolvedReport();
        if (un.length) { say("startMsg", "Still needed: " + un.join(", ") + ".", "err"); var f2 = [$("rbNames"), $("rbTypes"), $("rbThrough"), $("rbAck"), $("rbAttest")].filter(function (x) { return x && ((x.type === "checkbox" && !x.checked) || (x.type !== "checkbox" && !x.value.trim())); })[0]; if (f2) f2.focus(); return; }
        var r = await api(REPORT, "POST", "", Object.assign({ action: "confirm", uploadId: u.id, correct: true }, extra));
        if (!r.ok) {
          $("upMsg").textContent = (r.json && r.json.error) || "Could not confirm.";
          var rvNeed = (r.json && r.json.review && r.json.review.needed) || [];
          say("startMsg", rvNeed.indexOf("conflicts") >= 0 ? "The report header differs from your selection. Read the note under \u201cConfirmed by you\u201d, then tick the acknowledgement or change your selection." : $("upMsg").textContent, "err");
          if (r.json && r.json.review) { u.summary = Object.assign({}, u.summary, { review: r.json.review }); renderReadBack(u, draft); rsSyncBar(); }
          return;
        }
        u.status = "confirmed"; if (r.json && r.json.upload) { u.summary = r.json.upload.summary; } renderReview(u); syncUpload();
        say("upMsg", "Report confirmed.", "ok");
        // Confirming a report never starts research: the agent moves on to Find Topics and presses the button there.
        if (RS()) { state.rs.reportSkipped = false; setStep("topics", true); say("startMsg", "Report confirmed. Nothing has been researched yet.", "ok"); }
      } catch (e) { $("upMsg").textContent = e.message; }
    });
    function enterEdit() {
      var u = state.upload; if (!u || !u.id || u.status !== "confirmed" || !reviewOf(u)) return;
      state.edit = { draft: null }; say("startMsg", ""); $("upMsg").textContent = "";
      renderReview(u); setStep("report", true);
      var f = $("rbNames"); if (f) { try { f.scrollIntoView({ block: "center" }); } catch (e) { /* older browsers */ } f.focus(); }
    }
    function cancelEdit() {
      var u = state.upload; state.edit = null; $("upMsg").textContent = "";
      if (u) renderReview(u);
      say("startMsg", "No change was made to your confirmation.", "ok");
      var b = $("rsEdit"); if (b) b.focus();
    }
    async function saveEdit() {
      var u = state.upload; if (!u || !u.id || !state.edit) return;
      $("upMsg").textContent = "";
      var draft = readDraft(), extra = readBackPayload(u);
      if (extra.error) { say("startMsg", extra.error, "err"); $("upMsg").textContent = extra.error; if ($("rbAttest")) $("rbAttest").focus(); return; }
      var un = unresolvedReport();
      if (un.length) { say("startMsg", "Still needed: " + un.join(", ") + ".", "err"); var f2 = [$("rbNames"), $("rbTypes"), $("rbThrough"), $("rbAck"), $("rbAttest")].filter(function (x) { return x && ((x.type === "checkbox" && !x.checked) || (x.type !== "checkbox" && !x.value.trim())); })[0]; if (f2) f2.focus(); return; }
      $("rsSave").disabled = true;
      try {
        var r = await api(REPORT, "POST", "", Object.assign({ action: "reattest", uploadId: u.id }, extra));
        if (!r.ok) {
          $("upMsg").textContent = (r.json && r.json.error) || "Could not save the change.";
          var rvNeed = (r.json && r.json.review && r.json.review.needed) || [];
          say("startMsg", rvNeed.indexOf("conflicts") >= 0 ? "The report header differs from your selection. Read the note under \u201cConfirmed by you\u201d, then tick the acknowledgement or change your selection." : $("upMsg").textContent, "err");
          if (r.json && r.json.review) { u.summary = Object.assign({}, u.summary, { review: r.json.review }); renderReadBack(u, draft); rsSyncBar(); }
          return;
        }
        state.edit = null;
        if (r.json && r.json.upload) u.summary = r.json.upload.summary;
        renderReview(u); syncUpload();
        var rv = (r.json && r.json.revalidation) || {}, parts = [];
        if (r.json && r.json.unchanged) { say("startMsg", "Nothing changed, so nothing needs to be redone.", "ok"); return; }
        if (rv.researchSets) parts.push(rv.researchSets + " saved topic set" + (rv.researchSets === 1 ? " was" : "s were") + " marked out of date");
        if (rv.topicSelected) parts.push("your chosen topic needs to be chosen again");
        if (rv.scriptMarked || rv.scriptReopened) parts.push("your script needs to be written again");
        var msg = "Confirmation updated. Nothing was researched." + (parts.length ? " " + parts.join("; ") + "." : " Nothing you made depends on the old confirmation.");
        var list = await refreshSaved();
        if (opts.onReportChanged) { try { await opts.onReportChanged(rv); } catch (e) { /* the page keeps its copy */ } }
        var cur = state.current && (list || []).filter(function (x) { return x.id === state.current.id; })[0];
        if (cur) { opts.__pickedNow = true; showResult(cur); opts.__pickedNow = false; } else setStep("topics", true);
        say("startMsg", msg, "ok");
      } catch (e) { $("upMsg").textContent = e.message; say("startMsg", e.message, "err"); }
      finally { $("rsSave").disabled = false; }
    }
    state.enterEdit = enterEdit;
    $("rsEdit").addEventListener("click", enterEdit);
    $("rsCancelEdit").addEventListener("click", cancelEdit);
    $("rsSave").addEventListener("click", saveEdit);
    $("libClose").addEventListener("click", closeLib);
    $("resX").addEventListener("click", function () { $("resultPanel").classList.add("hidden"); state.current = null; foldSetup(false, "topics"); });
    $("setupEdit").addEventListener("click", function () { foldSetup(false, "market"); if (RS()) { $("rsMarketH").focus(); } else $("setupBody").scrollIntoView({ behavior: "smooth", block: "start" }); });
    $("libBtn2").addEventListener("click", openLib);
    // The page used to know a report only from the file chosen in this visit, so a report already on the project (opened later, or copied in with a
    // saved set) showed nothing and could not be replaced. This reads the project's confirmed report back into the page.
    state.restoreUpload = async function () {
      if (!state.projectId || (state.upload && (state.upload.busy || state.upload.id))) return;
      try {
        var r = await api(REPORT, "GET", "?projectId=" + encodeURIComponent(state.projectId));
        var u = ((r.ok && r.json && r.json.uploads) || []).filter(function (x) { return x.status === "confirmed"; })[0];
        if (!u) return;
        state.upload = { id: u.id, status: u.status, summary: u.summary };
        renderReview(state.upload); syncUpload();
      } catch (e) { /* the research step still works without it */ }
    };
    state.resetUpload = function () { $("upFile").value = ""; $("upOk").checked = false; resetReview(); resetWindow(); syncUpload(); };
    state.uploadReady = function () {
      var has = $("upFile").files && $("upFile").files.length > 0;
      if (state.upload && state.upload.busy) { $("attestMsg").textContent = "Still reading your report. One moment."; return false; }
      if (has && !$("upOk").checked) { $("attestMsg").textContent = "Tick the box to use this file, or remove it with the \u00d7."; $("attestBox").scrollIntoView({ behavior: "smooth", block: "center" }); return false; }
      if (has && state.upload && state.upload.status !== "confirmed") { $("upMsg").textContent = "Confirm that the report is read correctly, or remove it."; $("upReview").scrollIntoView({ behavior: "smooth", block: "center" }); return false; }
      return true;
    };
  }
  async function refreshSaved() {
    var g = await api(API, "GET", "?projectId=" + encodeURIComponent(state.projectId));
    if (!g.ok) return;
    state.selected = g.json.selectedTopic || null;
    if (g.json.marketUpdateMode) setMuMode(g.json.marketUpdateMode);
    renderSession(g.json.session);
    renderSaved(g.json.research || [], g.json.earlier || []);
    return g.json.research || [];
  }

  // ── Running a request ──
  function stopPoll() { if (state.poll) { clearInterval(state.poll); state.poll = null; } }
  function startPoll(id) {
    stopPoll();
    var tries = 0;
    state.poll = setInterval(async function () {
      tries++;
      try {
        var g = await api(API, "GET", "?id=" + encodeURIComponent(id));
        if (g.ok && g.json.research && g.json.research.status !== "running") { showResult(g.json.research); $("startBtn").disabled = false; await refreshSaved(); }
        else if (tries > 100) { stopPoll(); $("startBtn").disabled = false; say("startMsg", "Still waiting. Check the Research Library in a minute.", "err"); }
      } catch (e) { /* keep polling */ }
    }, 4000);
  }
  // The agent confirms audience, area, keywords and data before anything is bought. "Research this market" opens this summary; only "Confirm and research" spends a session.
  function confirmLines(q) {
    var s = state.schema, g = q.geography || {};
    var area = g.name ? (g.type === "neighborhood" && g.city ? g.name + ", " + g.city : g.name) + " (" + (s.geoTypes.filter(function (x) { return x.key === g.type; })[0] || {}).label + (g.zip && g.type !== "zip" ? ", ZIP " + g.zip : "") + ")" : "";
    var aud = (s.audiences.filter(function (a) { return a.key === q.audience; })[0] || {}).label || "";
    var mode = (s.modes.filter(function (m) { return m.key === q.mode; })[0] || {}).label || "";
    var focus = [q.focus.active_adult_55 ? "55+ Active Adult" : "", q.focus.new_construction ? "New Construction" : ""].filter(Boolean).join(", ");
    var win = state.upload && state.upload.summary && state.upload.summary.window;
    var data = q.dataSource === "upload" ? "Your confirmed MLS report only (no web research): five MLS Market Trend topics built from its figures" : q.dataSource === "both" ? "Your confirmed report (its figures are the source of truth" + (win ? "; closed sales limited to " + win.label : "") + ") plus web research for the story" : "Web research. Each figure names its source, and preliminary figures are flagged";
    var mdl = muModeDef(q.marketUpdateMode);
    if (mdl) data = mdl.key === "trend_report" ? "Your confirmed Trend/CMA report only: topics and script from its figures" : mdl.key === "article_report" ? "Local articles for the story; your confirmed report (" + (win ? "closed sales limited to " + win.label + "; " : "") + "its figures are the only market statistics)" : "Local articles and your perspective; the article's figures are attributed to it. No report";
    var rows = [["Content", mode + (mdl ? ": " + mdl.label : "")], ["Area", area], ["Audience", aud], ["Focus", focus || "None"], ["Keywords", (q.keywords || "").trim() || "None"], ["Data", data]];
    if (reportConfirmed() && reportPeriodText(state.upload)) rows.push(["Report period", reportPeriodText(state.upload) + " (from your report; separate from the web lookback)"]);
    if (q.mode !== "local_events") rows.splice(5, 0, ["Optional data", focusLabel(q)]);
    return rows.map(function (r) { return "<div><b>" + esc(r[0]) + ":</b> " + esc(r[1]) + "</div>"; }).join("");
  }
  function focusLabel(q) {
    var d = (state.schema.dataFocus || []).filter(function (x) { return x.key === q.dataFocus; })[0] || { label: "All available market data" };
    if (q.dataFocus === "none" || !q.period) return d.label;
    return d.label + ", web lookback " + (q.period.days ? "last " + q.period.days + " days" : q.period.start + " to " + q.period.end);
  }
  function hideConfirm(keepMls) { if (keepMls !== true) state.mlsTrend = false; $("confirmBox").classList.add("hidden"); $("startBtn").classList.remove("hidden"); rsRender(); }
  function review() {
    if (state.uploadReady && !state.uploadReady()) return;
    var q = collect(); say("startMsg", "");
    if (q.mode !== "local_events" && q.dataFocus !== "none" && q.period && q.period.start !== undefined && (!q.period.start || !q.period.end)) { say("startMsg", "Enter both dates for the period.", "err"); return; }
    if (q.mode !== "local_events" && q.geography.type !== "zip" && !/^\d{5}$/.test(String(q.geography.zip || "").trim())) { say("startMsg", "Enter the 5-digit ZIP code for this market.", "err"); $("geoZip").focus(); return; }
    if (q.mode !== "local_events" && state.schema.marketUpdateModes && !q.marketUpdateMode) { say("startMsg", "Choose the type of Market Update first.", "err"); $("muModeBox").scrollIntoView({ block: "center" }); return; }
    var mdef = muModeDef(q.marketUpdateMode);
    if (mdef && mdef.reportRequired && !(q.uploadIds && q.uploadIds.length)) { say("startMsg", "This Market Update type uses your Trend or CMA report. Upload it and confirm it, then research.", "err"); $("uploadBox").scrollIntoView({ block: "center" }); return; }
    if (!q.mode || !q.geography.name.trim() || !q.audience) { say("startMsg", !q.audience ? "Choose who this is for." : "Enter the place to research.", "err"); return; }
    if (option1On() && q.marketUpdateMode === "trend_report") { start(); return; }   // the report was already confirmed ("This report covers… Correct?"); nothing else to confirm
    $("confirmList").innerHTML = confirmLines(q);
    var x = state.session;
    $("confirmCost").textContent = state.schema.articleLed && q.mode === "market_update" && q.dataSource !== "upload" ? "A research session is used only when five opportunities are delivered. A result with fewer is kept and does not use a session." : "Running this uses one research session" + (x ? " (" + x.remaining + " of " + x.allowance + " left this month)" : "") + ", unless you already have this exact set saved, which is simply reopened.";
    $("confirmBox").classList.remove("hidden"); $("startBtn").classList.add("hidden"); rsRender();
    $("confirmBox").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function rsNextClick() {
    var s = state.rs;
    if (s.step === "market") {
      var miss = marketMissing();
      if (miss.length) { say("startMsg", "Still needed: " + miss.join(", ") + ".", "err"); var f = firstMissingField(); if (f) f.focus(); return; }
      say("startMsg", ""); s.marketDone = true; setStep(reportMode() === "none" ? "topics" : "report", true); return;
    }
    if (s.step === "report") {
      if (reportConfirmed()) { say("startMsg", ""); setStep("topics", true); return; }
      if (reportMode() === "optional" && !state.upload && !hasFile()) { say("startMsg", ""); s.reportSkipped = true; setStep("topics", true); }
    }
  }
  function wireRS() {
    $("rsSteps").addEventListener("click", function (e) { var b = e.target.closest("[data-rs]"); if (b && !b.disabled) { say("startMsg", ""); setStep(b.getAttribute("data-rs"), true); } });
    $("stepResearch").addEventListener("click", function (e) {
      var g = e.target.closest("[data-rs-go]"); if (g) { say("startMsg", ""); setStep(g.getAttribute("data-rs-go"), true); return; }
      if (e.target.id === "rsRepRemove" && state.removeUpload) state.removeUpload();
      if (e.target.id === "rsRepEdit" && state.enterEdit) state.enterEdit();
    });
    $("rsBack").addEventListener("click", function () { say("startMsg", ""); setStep(state.rs.step === "topics" && reportMode() !== "none" ? "report" : "market", true); });
    $("rsNext").addEventListener("click", rsNextClick);
    if (window.matchMedia) { var mq = window.matchMedia("(max-width: 640px)"); (mq.addEventListener ? mq.addEventListener.bind(mq, "change") : mq.addListener.bind(mq))(rsSyncBar); }
    ["input", "change"].forEach(function (ev) { $("upReadBack").addEventListener(ev, rsSyncBar); $("rsMarket").addEventListener(ev, rsRender); });
  }
  async function start() {
    if (state.uploadReady && !state.uploadReady()) return;
    hideConfirm(true);
    $("startBtn").disabled = true; say("startMsg", "");
    try {
      var body = { action: "start", projectId: state.projectId, request: collect(), newTopics: $("newTopics").checked };
      state.mlsTrend = false;
      var r = await api(API, "POST", "", body);
      if (r.json && r.json.session) renderSession(r.json.session);
      if (r.status === 202) {
        // Development deploys: the page starts the research job itself, with its own login (the server cannot call its own functions there).
        if (r.json.dispatch) {
          var bg = await api("/.netlify/functions/agent-marketing-research-background", "POST", "", { researchId: r.json.research.id });
          if (bg.status !== 202 && !bg.ok) { $("startBtn").disabled = false; say("startMsg", "The research could not start. This did not use a session.", "err"); return; }
        }
        showResult(r.json.research); startPoll(r.json.research.id); return;
      }
      $("startBtn").disabled = false;
      if (r.status === 200) { showResult(r.json.research); say("startMsg", r.json.reused ? "You already had this set, so it was reopened and no session was used." : "", "ok"); return; }
      say("startMsg", (r.json && r.json.error) || "Something went wrong.", "err");
    } catch (e) { $("startBtn").disabled = false; say("startMsg", e.message, "err"); }
  }
    var wired = false;
    /** Load the schema once, build the form, and show this project's saved research (and any set that is still running). */
    async function start_(projectId, selected) {
      var changed = state.projectId && state.projectId !== projectId;
      state.projectId = projectId; state.selected = selected || null;
      if (changed) { state.rs = { step: "market", marketDone: false, reportSkipped: false }; hideConfirm(); stopPoll(); state.current = null; if (state.resetUpload) state.resetUpload(); $("resultPanel").classList.add("hidden"); $("startBtn").disabled = false; say("startMsg", ""); }
      if (!state.schema) {
        var s = await api(API, "GET", "?schema=1");
        if (s.status === 404) throw new Error("Agent Marketing isn't available on your account yet.");
        if (!s.ok) throw new Error((s.json && s.json.error) || "Could not load the research step.");
        state.schema = s.json;
      }
      if (!wired) { wired = true; buildForm(); $("startBtn").addEventListener("click", review); $("confirmBtn").addEventListener("click", start); $("confirmEdit").addEventListener("click", hideConfirm);
        // an edit makes the shown summary stale, so it closes
        ["geoType", "geoName", "geoCity", "geoZip", "audience", "f55", "fNew", "keywords", "upFile", "dataFocus", "period", "periodFrom", "periodTo"].forEach(function (id) { $(id).addEventListener("input", hideConfirm); $(id).addEventListener("change", hideConfirm); }); wireIntakeExtras(); if (RS()) wireRS(); }
      $("resultPanel").classList.add("hidden");
      var list = await refreshSaved();
      if (state.restoreUpload) await state.restoreUpload();
      var running = (list || []).filter(function (r) { return r.status === "running"; })[0];
      if (running) { showResult(running); $("startBtn").disabled = true; startPoll(running.id); }
      else if (state.selected && !state.current) {
        var mine = (list || []).filter(function (r) { return r.id === state.selected.researchId; })[0];
        if (mine) showResult(mine);
      }
      rsRender();
    }
    return { start: start_, stop: stopPoll, state: state };
  };
})(window);
