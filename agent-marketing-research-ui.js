// agent-marketing-research-ui.js — the Local Market Insider research step (request form, MLS report upload, five topics, select, library).
// Shared by agent-marketing.html (the subscriber flow) and agent-marketing-research-test.html. The page supplies the markup (same element ids),
// an api(base, method, qs, body) function that adds the login, and a project id; this file does the rest.
//   var ui = AMResearchUI({ api: fn, onSelected: fn(topic) });  await ui.start(projectId, selectedTopicOrNull);
(function (root) {
  "use strict";
  root.AMResearchUI = function (opts) {
    var API = "/.netlify/functions/agent-marketing-research";
    var state = { schema: null, projectId: null, selected: null, poll: null, session: null };
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
    $("modeChoices").addEventListener("change", function () { applyFocus(); applyZip(); }); applyFocus();
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
      dataSource: reportSource().dataSource, uploadIds: reportSource().uploadIds,
    };
  }
  // A report is used only once the agent has confirmed "This report covers\u2026 Correct?". Attached and confirmed = both (report figures win); otherwise web only.
  function reportSource() {
    var u = state.upload;
    if (!u || u.status !== "confirmed" || !u.id) return { dataSource: "web", uploadIds: [] };
    return { dataSource: "both", uploadIds: [u.id] }; // a confirmed report is the choice: its figures win, the web adds the narrative
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
    if (!parts.length) return "";
    return '<details class="kv"><summary style="cursor:pointer">Details</summary>' + parts.map(function (x) { return '<div class="kv">' + x + "</div>"; }).join("") + "</details>";
  }
  function renderTopic(t, pickedId) {
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
      '<div class="actions" style="margin-top:10px"><button class="btn small ' + (t.id === pickedId ? "" : "gold") + '" type="button" data-pick="' + esc(t.id) + '">' + (t.id === pickedId ? "Selected" : "Select this topic") + "</button></div></div>";
  }
  // Results get the screen: the request folds into one line (Change request brings the form back).
  function foldSetup(on) {
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
    $("resTitle").textContent = r.status === "ready" ? "Five topics" + (r.researchDate ? " from " + r.researchDate : "") : r.status === "failed" ? "No topics this time" : "Researching…";
    $("resWait").classList.toggle("hidden", r.status !== "running");
    $("resError").classList.toggle("hidden", r.status !== "failed");
    if (r.status === "failed") $("resError").textContent = (r.error || "The research could not be completed.") + (/did not use a session/.test(r.error || "") ? "" : " This did not use a session.");
    renderFailOptions(r);
    say("resNote", r.status === "ready" ? (r.note || (r.dataSource !== "report" && r.mode !== "local_events" ? "Figures from web research come from public pages. They can differ from your MLS numbers or be preliminary. Upload your MLS report to base your topics on your own data." : "")) : "");
    var pickedId = state.selected && state.selected.researchId === r.id ? state.selected.id : null;
    var chosen = pickedId && r.status === "ready" ? r.topics.filter(function (t) { return t.id === pickedId; })[0] : null;
    var bar = chosen ? '<div id="selBar" style="border:1px solid var(--gold);background:#fdf9f0;border-radius:6px;padding:12px 14px;margin-top:12px;display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap"><div style="font-size:0.88rem"><b style="color:var(--success)">\u2713 Topic selected</b><div>' + esc(chosen.question) + "</div></div>" +
      (opts.onContinue ? '<button class="btn gold small" type="button" id="selContinue">Choose the call to action</button>' : "") + "</div>" : "";
    var hasNotice = r.status === "ready" && r.topics.some(function (t) { return t.reportNotice; });
    var noticeLine = hasNotice ? '<div class="hint" style="margin-top:10px">Topics that use your report carry MetroList\u2019s required notice automatically; you do not need to write it.</div>' : "";
    // A set is usable for 7 days. An older one can be read but not chosen from; a Reel already started from it keeps going, with a warning.
    var stale = "";
    if (r.status === "ready" && r.expired) {
      var kept = !!pickedId;
      stale = '<div id="staleBar" style="border:1px solid #c9a86a;background:#fff7e6;border-radius:6px;padding:12px 14px;margin-top:12px"><div style="font-size:0.92rem;line-height:1.45"><b>This research is ' + esc(r.ageDays) + " days old and may be outdated.</b> " +
        (kept ? "Your Reel keeps the research it was written from, but the market may have moved. Run it again if you want current data."
              : "Market data and comparisons go stale, so research is usable for 7 days. Run the same request again for current data.") + "</div>" +
        '<div class="actions" style="margin-top:8px"><button class="btn gold small" type="button" id="staleRun">Run again</button></div></div>';
    }
    $("resTopics").innerHTML = stale + bar + noticeLine + (r.status === "ready" ? r.topics.map(function (t) { return renderTopic(t, pickedId); }).join("") : "");
    if (r.status === "ready" && r.expired) {
      if (!pickedId) Array.prototype.forEach.call($("resTopics").querySelectorAll("[data-pick]"), function (b) { b.disabled = true; b.textContent = "Outdated: run again"; });
      if ($("staleRun")) $("staleRun").addEventListener("click", function () { runAgain(r); });
    }
    if ($("selContinue")) $("selContinue").addEventListener("click", function () { opts.onContinue(state.selected); });
    renderCost(r);
    foldSetup(r.status === "ready");
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
  // "Run again": the same request is filled back in (no new intake). A set that used a report asks for the newer one (Update report); without it, it runs as web research.
  function runAgain(r) {
    setForm(r); hideConfirm(); $("resultPanel").classList.add("hidden"); foldSetup(false);
    var hadReport = r.dataSource && r.dataSource !== "web";
    say("startMsg", hadReport ? "This research used your report from " + (r.researchDate || "earlier") + ". Attach your newer report below and confirm it (Update report), then research again. Without one it runs as web research only." : "Your request is filled in. Research this market again to refresh it.", "ok");
    var t = hadReport ? $("upFile") : $("startBtn"); if (t && t.scrollIntoView) t.scrollIntoView({ behavior: "smooth", block: "center" });
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
      if (!r.ok && r.json && r.json.code === "research_expired") { say("selMsg", ""); if (r.json.research) { showResult(r.json.research); } return; }
      if (!r.ok && r.json && r.json.code === "report_choice") {
        say("selMsg", "");
        var c = await askReport(researchId, topicId, r.json.reports);
        if (c === "use") return pick(researchId, topicId, "use");
        if (c === "update") {
          // The newer report starts a new request: the form is filled from this set, the agent attaches the report and confirms it, then researches again.
          var set = state.current && state.current.id === researchId ? state.current : null;
          if (set) setForm(set);
          hideConfirm(); $("resultPanel").classList.add("hidden"); foldSetup(false);
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
        '<div class="hint">' + esc(r.status === "ready" ? "Five topics, " + (r.researchDate || "") + (r.expired ? " \u00b7 outdated, run again" : "") : r.status === "failed" ? "Failed, not charged" : "Running") + "</div></div>" +
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
    function resetReview() { state.upload = null; $("upFix").classList.add("hidden"); $("upFixText").value = ""; Array.prototype.forEach.call(document.querySelectorAll('input[name="upWhy"]'), function (c) { c.checked = false; }); $("upReview").classList.add("hidden"); $("upMsg").textContent = ""; $("upGroups").innerHTML = ""; $("upWarn").innerHTML = ""; }
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
    }
    function toBase64(file) {
      return new Promise(function (resolve, reject) {
        var fr = new FileReader();
        fr.onload = function () { resolve(String(fr.result).replace(/^data:[^,]*,/, "")); };
        fr.onerror = function () { reject(new Error("Could not read that file.")); };
        fr.readAsDataURL(file);
      });
    }
    function renderReview(u) {
      var s = u.summary || {};
      $("upScope").textContent = (s.scopeSentence || "") + " Correct?";
      $("upGroups").innerHTML = !(s.groups || []).length ? "" : '<details style="margin-top:10px"><summary class="hint" style="cursor:pointer">See the figures I read</summary>' + (s.groups || []).map(function (g) {
        return '<div style="margin-top:10px"><b>' + esc(g.heading) + "</b>" + (g.window ? '<div class="hint">' + esc(g.window) + "</div>" : "") +
          '<ul style="margin:4px 0 0 18px;padding:0;font-size:0.85rem">' + g.figures.map(function (f) { return "<li>" + esc(f.label) + ": " + esc(f.display) + (f.compare ? ' <span class="hint">(' + esc(f.compare) + ")</span>" : "") + (f.small ? ' <span class="hint">(small sample)</span>' : "") + "</li>"; }).join("") + "</ul></div>";
      }).join("") + "</details>";
      $("upWarn").innerHTML = (s.warnings || []).map(function (w) { return '<div class="hint" style="margin-top:8px">⚠ ' + esc(w) + "</div>"; }).join("");
      if (s.notice) $("upWarn").innerHTML += '<div class="hint" style="margin-top:8px">Required notice for anything you publish with these figures: <b>' + esc(s.notice) + "</b></div>";
      $("upYes").classList.toggle("hidden", u.status === "confirmed");
      $("upNo").textContent = u.status === "confirmed" ? "Remove this report" : "Not right, remove";
      var rows = s.layout === "cma_table" || s.layout === "listing_table";
      $("upWindowBox").classList.toggle("hidden", !rows);
      $("upReview").classList.remove("hidden");
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
      state.upload = { busy: true };
      $("attestMsg").textContent = "Reading your report…";
      try {
        var b64 = await toBase64(file);
        var r = await api(REPORT, "POST", "", { action: "upload", projectId: state.projectId, fileName: file.name, fileBase64: b64, permission: true, window: state.pendingWindow || null });
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
        var r = await api(REPORT, "POST", "", { action: "confirm", uploadId: u.id, correct: true });
        if (!r.ok) { $("upMsg").textContent = (r.json && r.json.error) || "Could not confirm."; return; }
        u.status = "confirmed"; renderReview(u); syncUpload();
        say("upMsg", "Report confirmed.", "ok");
      } catch (e) { $("upMsg").textContent = e.message; }
    });
    $("libClose").addEventListener("click", closeLib);
    $("resX").addEventListener("click", function () { $("resultPanel").classList.add("hidden"); foldSetup(false); });
    $("setupEdit").addEventListener("click", function () { foldSetup(false); $("setupBody").scrollIntoView({ behavior: "smooth", block: "start" }); });
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
    var data = q.dataSource === "both" ? "Your confirmed report (its figures are the source of truth" + (win ? "; closed sales limited to " + win.label : "") + ") plus web research for the story" : "Web research. Each figure names its source, and preliminary figures are flagged";
    var rows = [["Content", mode], ["Area", area], ["Audience", aud], ["Focus", focus || "None"], ["Keywords", (q.keywords || "").trim() || "None"], ["Data", data]];
    if (q.mode !== "local_events") rows.splice(5, 0, ["Optional data", focusLabel(q)]);
    return rows.map(function (r) { return "<div><b>" + esc(r[0]) + ":</b> " + esc(r[1]) + "</div>"; }).join("");
  }
  function focusLabel(q) {
    var d = (state.schema.dataFocus || []).filter(function (x) { return x.key === q.dataFocus; })[0] || { label: "All available market data" };
    if (q.dataFocus === "none" || !q.period) return d.label;
    return d.label + ", " + (q.period.days ? "last " + q.period.days + " days" : q.period.start + " to " + q.period.end);
  }
  function hideConfirm() { $("confirmBox").classList.add("hidden"); $("startBtn").classList.remove("hidden"); }
  function review() {
    if (state.uploadReady && !state.uploadReady()) return;
    var q = collect(); say("startMsg", "");
    if (q.mode !== "local_events" && q.dataFocus !== "none" && q.period && q.period.start !== undefined && (!q.period.start || !q.period.end)) { say("startMsg", "Enter both dates for the period.", "err"); return; }
    if (q.mode !== "local_events" && q.geography.type !== "zip" && !/^\d{5}$/.test(String(q.geography.zip || "").trim())) { say("startMsg", "Enter the 5-digit ZIP code for this market.", "err"); $("geoZip").focus(); return; }
    if (!q.mode || !q.geography.name.trim() || !q.audience) { say("startMsg", !q.audience ? "Choose who this is for." : "Enter the place to research.", "err"); return; }
    $("confirmList").innerHTML = confirmLines(q);
    var x = state.session;
    $("confirmCost").textContent = "Running this uses one research session" + (x ? " (" + x.remaining + " of " + x.allowance + " left this month)" : "") + ", unless you already have this exact set saved, which is simply reopened.";
    $("confirmBox").classList.remove("hidden"); $("startBtn").classList.add("hidden");
    $("confirmBox").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  async function start() {
    if (state.uploadReady && !state.uploadReady()) return;
    hideConfirm();
    $("startBtn").disabled = true; say("startMsg", "");
    try {
      var body = { action: "start", projectId: state.projectId, request: collect(), newTopics: $("newTopics").checked };
      var r = await api(API, "POST", "", body);
      if (r.json && r.json.session) renderSession(r.json.session);
      if (r.status === 202) { showResult(r.json.research); startPoll(r.json.research.id); return; }
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
      if (changed) { hideConfirm(); stopPoll(); state.current = null; if (state.resetUpload) state.resetUpload(); $("resultPanel").classList.add("hidden"); $("startBtn").disabled = false; say("startMsg", ""); }
      if (!state.schema) {
        var s = await api(API, "GET", "?schema=1");
        if (s.status === 404) throw new Error("Agent Marketing isn't available on your account yet.");
        if (!s.ok) throw new Error((s.json && s.json.error) || "Could not load the research step.");
        state.schema = s.json;
      }
      if (!wired) { wired = true; buildForm(); $("startBtn").addEventListener("click", review); $("confirmBtn").addEventListener("click", start); $("confirmEdit").addEventListener("click", hideConfirm);
        // an edit makes the shown summary stale, so it closes
        ["geoType", "geoName", "geoCity", "geoZip", "audience", "f55", "fNew", "keywords", "upFile", "dataFocus", "period", "periodFrom", "periodTo"].forEach(function (id) { $(id).addEventListener("input", hideConfirm); $(id).addEventListener("change", hideConfirm); }); wireIntakeExtras(); }
      $("resultPanel").classList.add("hidden");
      var list = await refreshSaved();
      if (state.restoreUpload) await state.restoreUpload();
      var running = (list || []).filter(function (r) { return r.status === "running"; })[0];
      if (running) { showResult(running); $("startBtn").disabled = true; startPoll(running.id); }
      else if (state.selected && !state.current) {
        var mine = (list || []).filter(function (r) { return r.id === state.selected.researchId; })[0];
        if (mine) showResult(mine);
      }
    }
    return { start: start_, stop: stopPoll, state: state };
  };
})(window);
