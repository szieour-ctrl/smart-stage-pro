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
  }
  function applyGeo() {
    var t = $("geoType").value;
    $("cityWrap").classList.toggle("hidden", t !== "neighborhood");
    $("geoNameLbl").textContent = t === "zip" ? "ZIP code" : t === "neighborhood" ? "Neighborhood" : t === "county" ? "County" : t === "metro" ? "Metro area" : "City";
    $("geoName").placeholder = t === "zip" ? "e.g. 95678" : t === "neighborhood" ? "e.g. Crocker Ranch" : t === "county" ? "e.g. Placer" : t === "metro" ? "e.g. Sacramento" : "e.g. Roseville";
  }
  function collect() {
    var type = $("geoType").value;
    return {
      mode: picked("mode"), audience: $("audience").value,
      geography: { type: type, name: $("geoName").value, city: type === "neighborhood" ? $("geoCity").value : "" },
      focus: { active_adult_55: $("f55").checked, new_construction: $("fNew").checked }, keywords: $("keywords").value,
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
    $("resCost").innerHTML = '<div class="cost ' + cls + '"><div class="eyebrow">What this run cost</div><div class="big">' + money(u.costUsd) + "</div>" +
      "<div>" + (u.costEstimated ? "Estimated from tokens (Perplexity did not report a cost). " : "Reported by Perplexity. ") +
      "Target " + money(u.targetUsd) + (u.withinTarget === true ? " · <b>within target</b>" : u.withinTarget === false ? " · <b>over target</b>" : "") + "</div>" +
      '<div class="hint">Model ' + esc(r.model || "?") + " · attempts " + esc(u.attempts) + " · tokens in " + esc(u.promptTokens) + " / out " + esc(u.completionTokens) +
      (u.searchQueries != null ? " · searches " + esc(u.searchQueries) : "") + " · sources checked against the provider: " + (u.grounded === true ? "yes" : u.grounded === false ? "no (provider sent none)" : "n/a") + "</div></div>";
  }
  function srcLine(s) {
    if (s.type === "report") return '<div class="src"><b>Your MLS report</b>' + (s.published ? " <span>\u00b7 through " + esc(s.published) + "</span>" : "") + "</div>";
    return '<div class="src"><a href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer">' + esc(s.title) + '</a> <span>· ' + esc(s.domain) + (s.published ? " · " + esc(s.published) : "") + "</span></div>";
  }
  function renderTopic(t, pickedId) {
    var ev = t.event;
    return '<div class="topic' + (t.id === pickedId ? " picked" : "") + '"><div class="tags"><span class="tag">' + esc(t.id.toUpperCase()) + "</span>" +
      '<span class="tag ' + (t.scope === "selected" ? "ok" : "warn") + '">' + (t.scope === "selected" ? "Your exact market" : "Broader context") + "</span>" +
      '<span class="tag ' + (t.origin === "report" ? "ok" : "") + '">' + (t.origin === "report" ? "From your report" : "From web research") + "</span>" +
      (t.smallSample ? '<span class="tag warn">Small sample</span>' : "") +
      (t.localIntent ? '<span class="tag ok">Local intent</span>' : "") + "</div><h3>" + esc(t.question) + '</h3><div class="why">' + esc(t.whyItMatters) + "</div>" +
      (t.scope !== "selected" || (t.origin === "report" && t.scopeNote) ? '<div class="kv"><b>' + (t.scope !== "selected" ? "Data covers" : "Note") + ":</b> " + esc(t.scopeNote) + "</div>" : "") +
      (t.reportFigures && t.reportFigures.length ? '<div class="kv"><b>Report figures:</b> ' + t.reportFigures.map(function (f) { return esc(f.text); }).join(" \u00b7 ") + "</div>" : "") +
      (t.reportNotice ? '<div class="kv"><b>Required notice:</b> ' + esc(t.reportNotice) + "</div>" : "") +
      (t.trendSignals && t.trendSignals.length ? '<div class="kv"><b>Trend signals:</b> ' + t.trendSignals.map(esc).join(" · ") + "</div>" : "") +
      (ev ? '<div class="kv"><b>' + esc(ev.name) + "</b> · " + esc(ev.date) + (ev.endDate ? " to " + esc(ev.endDate) : "") + " · " + esc(ev.time) + "</div>" +
        '<div class="kv"><b>Where:</b> ' + esc(ev.location) + " · <b>Organizer:</b> " + esc(ev.organizer) + " · <b>Status:</b> " + esc(ev.status) + "</div>" : "") +
      "<div style=\"margin-top:6px\">" + (t.sources || []).map(srcLine).join("") + "</div>" +
      '<div class="actions" style="margin-top:10px"><button class="btn small ' + (t.id === pickedId ? "" : "gold") + '" type="button" data-pick="' + esc(t.id) + '">' + (t.id === pickedId ? "Selected" : "Select this topic") + "</button></div></div>";
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
    say("resNote", r.status === "ready" ? (r.note || (r.dataSource !== "report" && r.mode !== "local_events" ? "Figures from web research come from public pages. They can differ from your MLS numbers or be preliminary. Upload your MLS report to base your topics on your own data." : "")) : "");
    var pickedId = state.selected && state.selected.researchId === r.id ? state.selected.id : null;
    var chosen = pickedId && r.status === "ready" ? r.topics.filter(function (t) { return t.id === pickedId; })[0] : null;
    var bar = chosen ? '<div id="selBar" style="border:1px solid var(--gold);background:#fdf9f0;border-radius:6px;padding:12px 14px;margin-top:12px;display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap"><div style="font-size:0.88rem"><b style="color:var(--success)">\u2713 Topic selected</b><div>' + esc(chosen.question) + "</div></div>" +
      (opts.onContinue ? '<button class="btn gold small" type="button" id="selContinue">Continue with this topic</button>' : "") + "</div>" : "";
    $("resTopics").innerHTML = bar + (r.status === "ready" ? r.topics.map(function (t) { return renderTopic(t, pickedId); }).join("") : "");
    if ($("selContinue")) $("selContinue").addEventListener("click", function () { opts.onContinue(state.selected); });
    renderCost(r);
    say("selMsg", "");
    Array.prototype.forEach.call($("resTopics").querySelectorAll("[data-pick]"), function (b) { b.addEventListener("click", function () { pick(r.id, b.getAttribute("data-pick")); }); });
    if (!opts.__pickedNow) $("resultPanel").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  async function pick(researchId, topicId) {
    say("selMsg", "Saving your choice…");
    try {
      var r = await api(API, "POST", "", { action: "select", projectId: state.projectId, researchId: researchId, topicId: topicId });
      if (!r.ok) return say("selMsg", r.json.error || "Could not save your choice.", "err");
      state.selected = r.json.selectedTopic;
      if (opts.onSelected) opts.onSelected(state.selected);
      opts.__pickedNow = true; showResult(state.current); opts.__pickedNow = false;
      say("selMsg", "Saved. Resuming this project later restores this topic without a new research call.", "ok");
      var b = $("selBar"); if (b) b.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (e) { say("selMsg", e.message, "err"); }
  }
  function renderSaved(list) {
    $("savedList").innerHTML = !list.length ? '<div class="hint" style="padding:14px 0">No saved research yet. Run a request and it will appear here.</div>' : list.map(function (r) {
      return '<div class="saved"><div><b>' + esc(r.mode === "local_events" ? "Local Events" : "Market Update") + "</b> · " + esc(r.geography && r.geography.label) + " · " + esc(r.audience) +
        '<div class="hint">' + esc(r.status === "ready" ? "Five topics, " + (r.researchDate || "") : r.status === "failed" ? "Failed, not charged" : "Running") + "</div></div>" +
        '<button class="btn ghost small" type="button" data-open="' + esc(r.id) + '">Open</button></div>';
    }).join("");
    Array.prototype.forEach.call($("savedList").querySelectorAll("[data-open]"), function (b) {
      b.addEventListener("click", function () { var r = list.filter(function (x) { return x.id === b.getAttribute("data-open"); })[0]; if (r) { closeLib(); showResult(r); if (r.status === "running") startPoll(r.id); } });
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
    function resetReview() { state.upload = null; $("upReview").classList.add("hidden"); $("upMsg").textContent = ""; $("upGroups").innerHTML = ""; $("upWarn").innerHTML = ""; }
    function syncUpload() {
      var has = !!($("upFile").files && $("upFile").files.length > 0);
      var ok = has && $("upOk").checked;
      var confirmed = !!(state.upload && state.upload.status === "confirmed");
      $("upRow").classList.toggle("hidden", !has);
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
      $("upGroups").innerHTML = (s.groups || []).map(function (g) {
        return '<div style="margin-top:10px"><b>' + esc(g.heading) + "</b>" + (g.window ? '<div class="hint">' + esc(g.window) + "</div>" : "") +
          '<ul style="margin:4px 0 0 18px;padding:0;font-size:0.85rem">' + g.figures.map(function (f) { return "<li>" + esc(f.label) + ": " + esc(f.display) + (f.compare ? ' <span class="hint">(' + esc(f.compare) + ")</span>" : "") + (f.small ? ' <span class="hint">(small sample)</span>' : "") + "</li>"; }).join("") + "</ul></div>";
      }).join("");
      $("upWarn").innerHTML = (s.warnings || []).map(function (w) { return '<div class="hint" style="margin-top:8px">⚠ ' + esc(w) + "</div>"; }).join("");
      if (s.notice) $("upWarn").innerHTML += '<div class="hint" style="margin-top:8px">Required notice for anything you publish with these figures: <b>' + esc(s.notice) + "</b></div>";
      $("upYes").classList.toggle("hidden", u.status === "confirmed");
      $("upNo").textContent = u.status === "confirmed" ? "Remove this report" : "Not right, remove";
      $("upReview").classList.remove("hidden");
    }
    async function sendUpload() {
      var file = $("upFile").files[0];
      if (!file) return;
      if (file.size > MAX_BYTES) { $("attestMsg").textContent = "That file is larger than 4 MB. Try one property type or a shorter date range."; $("upOk").checked = false; return; }
      state.upload = { busy: true };
      $("attestMsg").textContent = "Reading your report…";
      try {
        var b64 = await toBase64(file);
        var r = await api(REPORT, "POST", "", { action: "upload", projectId: state.projectId, fileName: file.name, fileBase64: b64, permission: true });
        if (!r.ok) { state.upload = null; $("upOk").checked = false; $("attestMsg").textContent = (r.json && r.json.error) || "Could not read that file."; return; }
        state.upload = { id: r.json.upload.id, status: r.json.upload.status, summary: r.json.upload.summary };
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
      $("upFile").value = ""; $("upOk").checked = false; resetReview(); syncUpload();
    }
    $("upOk").addEventListener("change", function () { syncUpload(); if ($("upOk").checked && !state.upload) sendUpload(); });
    $("upFile").addEventListener("change", function () {
      if (state.upload && state.upload.id) removeUpload(); // choosing a different file replaces the old report
      $("upOk").checked = false; resetReview(); syncUpload();
      if ($("upFile").files.length) $("attestBox").scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    $("upX").addEventListener("click", removeUpload);
    $("upNo").addEventListener("click", removeUpload);
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
    $("resX").addEventListener("click", function () { $("resultPanel").classList.add("hidden"); });
    state.resetUpload = function () { $("upFile").value = ""; $("upOk").checked = false; resetReview(); syncUpload(); };
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
    renderSaved(g.json.research || []);
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
    var area = g.name ? (g.type === "neighborhood" && g.city ? g.name + ", " + g.city : g.name) + " (" + (s.geoTypes.filter(function (x) { return x.key === g.type; })[0] || {}).label + ")" : "";
    var aud = (s.audiences.filter(function (a) { return a.key === q.audience; })[0] || {}).label || "";
    var mode = (s.modes.filter(function (m) { return m.key === q.mode; })[0] || {}).label || "";
    var focus = [q.focus.active_adult_55 ? "55+ Active Adult" : "", q.focus.new_construction ? "New Construction" : ""].filter(Boolean).join(", ");
    var data = q.dataSource === "both" ? "Your confirmed report (its figures are the source of truth) plus web research for the story" : "Web research. Each figure names its source, and preliminary figures are flagged";
    var rows = [["Content", mode], ["Area", area], ["Audience", aud], ["Focus", focus || "None"], ["Keywords", (q.keywords || "").trim() || "None"], ["Data", data]];
    return rows.map(function (r) { return "<div><b>" + esc(r[0]) + ":</b> " + esc(r[1]) + "</div>"; }).join("");
  }
  function hideConfirm() { $("confirmBox").classList.add("hidden"); $("startBtn").classList.remove("hidden"); }
  function review() {
    if (state.uploadReady && !state.uploadReady()) return;
    var q = collect(); say("startMsg", "");
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
        ["geoType", "geoName", "geoCity", "audience", "f55", "fNew", "keywords", "upFile"].forEach(function (id) { $(id).addEventListener("input", hideConfirm); $(id).addEventListener("change", hideConfirm); }); wireIntakeExtras(); }
      $("resultPanel").classList.add("hidden");
      var list = await refreshSaved();
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
