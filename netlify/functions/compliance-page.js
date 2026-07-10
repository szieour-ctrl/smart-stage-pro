// compliance-page.js — Netlify Function
// Serves the permanent AB 723 §10140.8 compliance page for a property project
// URL: /compliance/{projectId}

const { getStore } = require("@netlify/blobs");
const https = require("https");

// ── VIDEO TOUR DATA (read-only, server-side, service-role) ──────────────
// Reads video_jobs + video_job_frames directly from Supabase. This is safe
// to do unauthenticated-public, unlike video-job.js's own status/download
// actions, because it only ever surfaces jobs where credits_charged_at is
// already set — i.e. the agent has already paid for and downloaded the
// video via the normal flow. This function never charges anything and
// never exposes a not-yet-paid-for video; it just reflects state that the
// real download flow already legitimately created. Trigger for appearing
// here is "Download Video," same as Generate Final is the trigger for an
// image appearing on this page at all.

function supabaseGet(table, queryParams = "") {
  return new Promise((resolve, reject) => {
    const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/${table}${queryParams}`);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "GET",
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data || "[]") }); }
        catch { resolve({ status: res.statusCode, data: [] }); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// Returns only video jobs for this project that have actually been
// downloaded (credits_charged_at IS NOT NULL) — never a rendered-but-unpaid
// job. Each job's frames come back ordered by sequence_order so the source
// photo grid matches the order the agent actually built the video in.
async function getDisclosedVideoJobs(projectId) {
  const jobsResult = await supabaseGet(
    "video_jobs",
    `?project_id=eq.${projectId}&status=eq.complete&credits_charged_at=not.is.null&select=id,output_16x9_url,output_9x16_url,formats,completed_at&order=completed_at.asc`
  );
  const jobs = jobsResult.data || [];
  if (jobs.length === 0) return [];

  const jobsWithFrames = await Promise.all(
    jobs.map(async (job) => {
      const framesResult = await supabaseGet(
        "video_job_frames",
        `?job_id=eq.${job.id}&select=image_url,before_url,is_before_after,room_type,motion_preset,sequence_order&order=sequence_order.asc`
      );
      return { ...job, frames: framesResult.data || [] };
    })
  );

  return jobsWithFrames;
}

function getProjectStore() {
  return getStore({
    name: "smart-stage-projects",
    siteID: process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_ACCESS_TOKEN,
  });
}

function formatDate(isoString) {
  if (!isoString) return "Unknown date";
  return new Date(isoString).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric"
  });
}

function renderPage(project, projectId, videoJobs) {
  const agentName     = project.agentName     || process.env.AGENT_NAME     || "Smart Stage PRO™";
  const agentBrokerage= project.agentBrokerage|| process.env.AGENT_BROKERAGE|| "";
  const agentDRE       = project.agentDRE      || process.env.AGENT_DRE      || "";
  const agentLogoUrl  = project.agentLogoUrl  || process.env.AGENT_LOGO_URL || "";
  const images        = project.images || [];
  const address       = project.address || "Property Address";
  const compUrl       = project.complianceUrl || `${process.env.URL || "https://smartstagepro.com"}/compliance/${projectId}`;
  const createdAt     = formatDate(project.createdAt);
  const videoJobsList = videoJobs || [];

  const videoTourSections = videoJobsList.map((job, i) => {
    const videoUrl = job.output_16x9_url || job.output_9x16_url;
    if (!videoUrl) return "";

    const sourceThumbs = job.frames.map((f) => {
      // Before/after frames show the "before" as the source-photo thumbnail —
      // that's the genuinely original, unaltered state. Single-image frames
      // (orbit_arc, rack_focus, fireplace_flicker, Ken Burns, exterior, etc.)
      // show image_url, which IS the original/disclosed source for that frame.
      const thumbUrl = f.is_before_after ? (f.before_url || f.image_url) : f.image_url;
      return `<img src="${thumbUrl}" alt="Original photograph used in this AI Motion video" loading="lazy">`;
    }).join("\n        ");

    return `
    <div class="video-tour-section">
      <div class="video-tour-header">
        <span class="video-tour-label">AI Motion Video Tour ${videoJobsList.length > 1 ? `— Video ${i + 1}` : ""}</span>
        <span class="video-tour-date">Generated ${formatDate(job.completed_at)}</span>
      </div>
      <video class="video-tour-player" controls preload="metadata">
        <source src="${videoUrl}" type="video/mp4">
        Your browser does not support embedded video. <a href="${videoUrl}">Download the video directly</a>.
      </video>
      <div style="padding:10px 12px;background:#f7f4ef;border-top:1px solid #e0d8ce;font-size:11px;display:flex;gap:16px;flex-wrap:wrap;">
        ${job.output_16x9_url ? `<a href="${job.output_16x9_url}" download class="dl-link">↓ Download Video (16:9)</a>` : ""}
        ${job.output_9x16_url ? `<a href="${job.output_9x16_url}" download class="dl-link">↓ Download Video (9:16)</a>` : ""}
      </div>
      <div class="video-tour-sources-label">Original, unaltered photographs used to generate this video (${job.frames.length})</div>
      <div class="video-tour-sources-grid">
        ${sourceThumbs}
      </div>
    </div>`;
  }).join("\n");

  const imagePairs = images.map((img, i) => {
    const hasOriginal = !!img.originalUrl;
    const hasStaged   = !!img.stagedUrl;

    // If both images present — render interactive slider
    if (hasOriginal && hasStaged) {
      return `
    <div class="image-pair">
      <div class="pair-header">
        <span class="pair-num">Image Set ${i + 1}</span>
        <span class="pair-room">${img.roomName || "Room"}</span>
        <span class="pair-date">Staged ${formatDate(img.stagedAt)}</span>
      </div>
      <div class="pair-grid">
        <div class="comp-slider" data-slider>
          <img src="${img.stagedUrl}" alt="Virtually staged photo of ${address}" loading="lazy">
          <div class="sl-before-wrap">
            <img src="${img.originalUrl}" alt="Original unaltered photo of ${address}" loading="lazy">
          </div>
          <div class="sl-divider">
            <div class="sl-handle">
              <svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" width="36" height="36"><circle cx="20" cy="20" r="19" fill="#1a1714" stroke="#b8975a" stroke-width="1.5"/><polyline points="15,13 8,20 15,27" fill="none" stroke="#b8975a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><polyline points="25,13 32,20 25,27" fill="none" stroke="#b8975a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </div>
          </div>
          <span class="comp-sl-label comp-sl-label-before">ORIGINAL</span>
          <span class="comp-sl-label comp-sl-label-after">STAGED</span>
        </div>
        ${img.sbsUrl ? `<div style="padding:10px 12px;background:#f7f4ef;border-top:1px solid #e0d8ce;font-size:11px;"><a href="${img.sbsUrl}" download class="dl-link">↓ Download Side-by-Side Disclosure Document</a></div>` : ""}
      </div>
    </div>`;
    }

    // Fallback — only original or only staged available
    const fallbackImg = hasOriginal
      ? `<div style="padding:12px;"><div class="comp-sl-label-before" style="display:inline-block;margin-bottom:8px;padding:4px 10px;border-radius:20px;font-size:10px;font-weight:700;letter-spacing:0.1em;background:rgba(0,0,0,0.08);color:#7a6f63;">ORIGINAL — UNALTERED</div><img src="${img.originalUrl}" alt="Original" style="width:100%;border-radius:4px;" loading="lazy"></div>`
      : `<div style="padding:40px;text-align:center;color:#b0a090;font-size:13px;">Original image not available</div>`;

    return `
    <div class="image-pair">
      <div class="pair-header">
        <span class="pair-num">Image Set ${i + 1}</span>
        <span class="pair-room">${img.roomName || "Room"}</span>
        <span class="pair-date">Staged ${formatDate(img.stagedAt)}</span>
      </div>
      <div class="pair-grid">${fallbackImg}</div>
    </div>`;
  }).join("\n");

  const noImages = images.length === 0
    ? `<div class="no-images"><p>No staged images have been added to this project yet.</p></div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AB 723 Compliance — ${address}</title>
  <meta name="robots" content="noindex, nofollow">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; background: #f5f3f0; color: #1a1a1a; min-height: 100vh; }

    /* ── HEADER ── */
    .site-header { background: #1a1714; padding: 20px 28px; display: flex; align-items: center; justify-content: space-between; }
    .header-brand { display: flex; align-items: center; gap: 18px; }
    /* INCREASED logo height: was 40px, now 72px */
    .header-logo { height: 72px; width: auto; display: block; }
    .header-name { color: #b8975a; font-size: 15px; font-weight: 500; letter-spacing: 0.06em; }
    .header-brokerage { color: #7a6f63; font-size: 12px; margin-top: 3px; letter-spacing: 0.04em; }
    .header-badge { background: #2d6a4f; color: #fff; font-size: 10px; font-weight: 600; padding: 5px 12px; border-radius: 3px; letter-spacing: 0.08em; white-space: nowrap; }

    /* ── COMPLIANCE BANNER ── */
    .compliance-banner { background: #1B3A5C; color: #fff; padding: 14px 24px; }
    .compliance-banner h1 { font-size: 15px; font-weight: 500; margin-bottom: 4px; }
    .compliance-banner p { font-size: 12px; color: #9ab0cc; line-height: 1.6; max-width: 900px; }

    /* ── PROPERTY CARD ── */
    .property-card { background: #fff; border-bottom: 1px solid #e0d8ce; padding: 20px 24px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
    .property-address { font-size: 20px; font-weight: 500; color: #1a1714; }
    .property-meta { font-size: 12px; color: #7a6f63; margin-top: 4px; }
    .property-actions { display: flex; gap: 10px; flex-wrap: wrap; }
    .btn { display: inline-block; padding: 9px 18px; border-radius: 4px; font-size: 12px; font-weight: 500; letter-spacing: 0.04em; text-decoration: none; cursor: pointer; border: none; }
    .btn-primary { background: #b8975a; color: #fff; }
    .btn-outline { background: transparent; color: #1a1714; border: 1px solid #c8bfb4; }
    .btn:hover { opacity: 0.88; }

    /* ── AGENT INFO ── */
    .agent-bar { background: #f0ece4; padding: 10px 24px; font-size: 12px; color: #5a5048; border-bottom: 1px solid #e0d8ce; }
    .agent-bar strong { color: #1a1714; }

    /* ── IMAGE PAIRS ── */
    .images-container { max-width: 1400px; margin: 0 auto; padding: 24px; }
    .image-pair { background: #fff; border-radius: 8px; margin-bottom: 24px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
    .pair-header { background: #1a1714; padding: 10px 16px; display: flex; align-items: center; gap: 12px; }
    .pair-num { color: #b8975a; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; }
    .pair-room { color: #fff; font-size: 13px; font-weight: 500; flex: 1; }
    .pair-date { color: #7a6f63; font-size: 11px; }
    .pair-grid { position: relative; }
    /* ── COMPLIANCE SLIDER ── */
    .comp-slider { position: relative; width: 100%; aspect-ratio: 16/9; overflow: hidden; cursor: ew-resize; user-select: none; -webkit-user-select: none; background: #1a1a1a; }
    .comp-slider img { position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; display: block; pointer-events: none; }
    .comp-slider .sl-before-wrap { position: absolute; inset: 0; width: 50%; overflow: hidden; pointer-events: none; }
    .comp-slider .sl-before-wrap img { width: 100%; height: 100%; object-fit: cover; object-position: left center; position: absolute; top: 0; left: 0; }
    .comp-slider .sl-divider { position: absolute; top: 0; bottom: 0; left: 50%; width: 2px; background: #b8975a; transform: translateX(-50%); pointer-events: none; z-index: 3; }
    .comp-slider .sl-handle { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); width: 36px; height: 36px; filter: drop-shadow(0 2px 8px rgba(0,0,0,0.6)); }
    .comp-sl-label { position: absolute; top: 12px; padding: 4px 10px; border-radius: 20px; font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; pointer-events: none; z-index: 4; }
    .comp-sl-label-before { left: 12px; background: rgba(0,0,0,0.6); color: #e0e0e0; border: 1px solid rgba(255,255,255,0.15); }
    .comp-sl-label-after { right: 12px; background: rgba(184,151,90,0.92); color: #1a1a1a; font-weight: 800; }
    .dl-link { display: inline-block; margin-top: 8px; font-size: 11px; color: #1B3A5C; text-decoration: none; padding: 0 12px; }
    .dl-link:hover { text-decoration: underline; }
    .no-images { text-align: center; padding: 60px 24px; color: #7a6f63; font-size: 14px; }

    /* ── VIDEO TOUR SECTION (separate container — not a slider, holds the
       video plus the full set of source photos used to build it) ── */
    .video-tour-section { max-width: 1400px; margin: 0 auto 24px; padding: 0 24px; }
    .video-tour-header { background: #1a1714; padding: 12px 18px; display: flex; align-items: center; justify-content: space-between; border-radius: 8px 8px 0 0; flex-wrap: wrap; gap: 8px; }
    .video-tour-label { color: #b8975a; font-size: 13px; font-weight: 600; letter-spacing: 0.04em; }
    .video-tour-date { color: #7a6f63; font-size: 11px; }
    .video-tour-player { display: block; width: 100%; max-height: 720px; background: #000; }
    .video-tour-sources-label { background: #fff; padding: 14px 18px 8px; font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: #7a6f63; border-left: 1px solid #e0d8ce; border-right: 1px solid #e0d8ce; }
    .video-tour-sources-grid { background: #fff; display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; padding: 8px 18px 18px; border-radius: 0 0 8px 8px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); border-left: 1px solid #e0d8ce; border-right: 1px solid #e0d8ce; border-bottom: 1px solid #e0d8ce; }
    .video-tour-sources-grid img { width: 100%; aspect-ratio: 4/3; object-fit: cover; border-radius: 4px; display: block; }

    /* ── MLS REMARKS BLOCK ── */
    .remarks-block { background: #1a1a1a; border: 1px solid #b8975a; border-radius: 8px; padding: 20px 24px; margin: 0 24px 28px; max-width: 1400px; margin-left: auto; margin-right: auto; }
    .remarks-block-label { font-size: 11px; font-weight: 700; letter-spacing: 0.12em; color: #b8975a; text-transform: uppercase; margin-bottom: 10px; }
    .remarks-block-text { font-size: 14px; color: #e8e8e8; line-height: 1.6; margin-bottom: 16px; }
    .remarks-copy-btn { display: inline-flex; align-items: center; gap: 8px; background: transparent; border: 1px solid #b8975a; color: #b8975a; font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; padding: 8px 16px; border-radius: 4px; cursor: pointer; transition: background 0.2s, color 0.2s; font-family: Arial, Helvetica, sans-serif; }
    .remarks-copy-btn:hover { background: #b8975a; color: #111; }
    .remarks-copy-btn.copied { background: #1a3a1a; border-color: #5a9a5a; color: #5a9a5a; }

    /* ── LEGAL FOOTER ── */
    .legal-footer { background: #1a1714; color: #f7f4ef; padding: 24px; font-size: 11px; line-height: 1.8; }
    .legal-footer strong { color: #b8975a; }
    .legal-footer a { color: #9ab0cc; }
    .legal-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; max-width: 1000px; }
    @media (max-width: 600px) { .legal-grid { grid-template-columns: 1fr; } }
    .legal-video-disclosure { max-width: 1000px; margin-top: 20px; }
    .legal-divider { border: none; border-top: 1px solid #2d2824; margin: 20px 0; }
    .legal-bottom { font-size: 10px; color: #f7f4ef; max-width: 1000px; }
  </style>
</head>
<body>

<!-- HEADER -->
<header class="site-header">
  <div class="header-brand">
    ${agentLogoUrl ? `<img src="${agentLogoUrl}" alt="Smart Stage PRO™" class="header-logo">` : ""}
    <div>
      <div class="header-name">${agentName}</div>
      ${agentBrokerage ? `<div class="header-brokerage">${agentBrokerage}${agentDRE ? " · DRE #" + agentDRE : ""}</div>` : ""}
    </div>
  </div>
  <div class="header-badge">CA AB 723 COMPLIANT</div>
</header>

<!-- COMPLIANCE BANNER -->
<div class="compliance-banner">
  <h1>Virtual Staging Disclosure — California AB 723 §10140.8</h1>
  <p>
    This page provides the original, unaltered photographs and their corresponding virtually staged versions
    for the property listed below, in compliance with California Business and Professions Code §10140.8
    (Assembly Bill 723, effective January 1, 2026). All staged images have been digitally altered by
    adding virtual furniture and décor for illustrative purposes only. The property is sold as shown
    in the original photographs. This page is maintained by Smart Stage PRO™.
  </p>
</div>

<!-- AGENT BAR -->
<div class="agent-bar">
  Staged by <strong>${agentName}</strong>
  ${agentBrokerage ? ` · <strong>${agentBrokerage}</strong>` : ""}
  ${agentDRE ? ` · DRE #<strong>${agentDRE}</strong>` : ""}
  · Project created ${createdAt}
  · Project ID: <strong>${projectId}</strong>
</div>

<!-- PROPERTY CARD -->
<div class="property-card">
  <div>
    <div class="property-address">${address}</div>
    <div class="property-meta">${images.length} staged image set${images.length !== 1 ? "s" : ""} · Last updated ${formatDate(project.updatedAt || project.createdAt)}</div>
  </div>
  <div class="property-actions">
    <a href="/.netlify/functions/download-compliance-zip?projectId=${projectId}" class="btn btn-primary">↓ Download All Images (ZIP)</a>
  </div>
</div>

<!-- MLS REMARKS DISCLOSURE BLOCK -->
<div class="remarks-block">
  <div class="remarks-block-label">MLS Public Remarks &mdash; Copy &amp; Paste Disclosure</div>
  <div class="remarks-block-text" id="remarks-disclosure-text">One or more photos in this listing have been virtually staged using AI-assisted technology. Staged images are for illustrative purposes only and do not represent the current condition of the property. Address: ${address}. Virtual staging disclosure: ${compUrl}</div>
  <button class="remarks-copy-btn" id="remarks-copy-btn" onclick="copyRemarksText()">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
    Copy for MLS Remarks
  </button>
</div>

<!-- IMAGE PAIRS -->
<div class="images-container">
  ${noImages}
  ${imagePairs}
</div>

${videoTourSections}

<!-- LEGAL FOOTER -->
<footer class="legal-footer">
  <div class="legal-grid">
    <div>
      <strong>California AB 723 Compliance Statement</strong><br>
      The images and any video displayed on this page have been digitally altered using artificial
      intelligence, image editing software, or virtual visualization technology. Alterations may include,
      but are not limited to: virtual furniture and décor, virtual decluttering, image enhancement, virtual
      landscaping, virtual renovations, conceptual improvements, exterior enhancements, and architectural
      visualizations. All alterations are provided solely for illustrative purposes. The property is sold
      in its actual condition as shown in the original photographs.
    </div>
    <div>
      <strong>Record Retention Policy</strong><br>
      This compliance page is maintained by Smart Stage PRO™ for a minimum of 3 years from the date of
      project creation, in accordance with California DRE record retention requirements. If the associated
      subscription is cancelled, this page will remain accessible for 30 days following cancellation,
      after which all project files will be delivered to the agent of record via email archive.
    </div>
  </div>
  <div class="legal-video-disclosure">
    <strong>AI Video Disclosure</strong><br>
    Any videos presented on this page may be generated from original photographs, digitally altered images,
    or both, and may contain simulated camera movement, virtual staging, virtual renovations, conceptual
    improvements, or other AI-generated visualizations. Video content is intended solely to illustrate
    potential use, design concepts, or marketing presentation and should not be interpreted as a
    representation of existing physical conditions unless independently verified. Original photographs and
    corresponding altered images are provided above for reference.
  </div>
  <hr class="legal-divider">
  <div class="legal-bottom">
    Smart Stage PRO™ · Compliance page generated automatically ·
    Page URL: <a href="javascript:void(0)" onclick="navigator.clipboard.writeText(window.location.href)">${process.env.URL || "https://smartstagepro.com"}/compliance/${projectId}</a> ·
    For questions about this disclosure contact ${agentName}${agentDRE ? " (DRE #" + agentDRE + ")" : ""}.
  </div>
</footer>

<script>
(function() {
  // MLS Remarks copy function
  window.copyRemarksText = function() {
    var text = document.getElementById('remarks-disclosure-text').textContent;
    var btn = document.getElementById('remarks-copy-btn');
    function setSuccess() {
      btn.classList.add('copied');
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 16 4 11"/></svg> Copied!';
      setTimeout(function() {
        btn.classList.remove('copied');
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy for MLS Remarks';
      }, 3000);
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(setSuccess).catch(function() {
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy');
        document.body.removeChild(ta); setSuccess();
      });
    } else {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy');
      document.body.removeChild(ta); setSuccess();
    }
  };

  // Slider init
  function initSliders() {
    document.querySelectorAll('[data-slider]').forEach(function(container) {
      var beforeWrap = container.querySelector('.sl-before-wrap');
      var divider    = container.querySelector('.sl-divider');
      if (!beforeWrap || !divider) return;
      var dragging = false;
      function setPos(pct) {
        pct = Math.max(2, Math.min(98, pct));
        beforeWrap.style.width = pct + '%';
        divider.style.left = pct + '%';
      }
      function getPct(clientX) {
        var rect = container.getBoundingClientRect();
        return ((clientX - rect.left) / rect.width) * 100;
      }
      container.addEventListener('mousedown', function(e) { dragging = true; setPos(getPct(e.clientX)); e.preventDefault(); });
      window.addEventListener('mousemove', function(e) { if (dragging) setPos(getPct(e.clientX)); });
      window.addEventListener('mouseup', function() { dragging = false; });
      container.addEventListener('touchstart', function(e) { dragging = true; setPos(getPct(e.touches[0].clientX)); e.preventDefault(); }, { passive: false });
      window.addEventListener('touchmove', function(e) { if (dragging) setPos(getPct(e.touches[0].clientX)); }, { passive: true });
      window.addEventListener('touchend', function() { dragging = false; });
      setPos(50);
    });
  }
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', initSliders); }
  else { initSliders(); }
})();
</script>
</body>
</html>`;
}

function renderNotFound(projectId) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Project Not Found — Smart Stage PRO™</title>
<style>body{font-family:Arial,sans-serif;background:#f5f3f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
.box{background:#fff;padding:40px;border-radius:8px;text-align:center;max-width:400px;}
h2{color:#1a1714;margin-bottom:12px;}p{color:#7a6f63;font-size:14px;line-height:1.6;}</style>
</head><body>
<div class="box">
  <h2>Compliance Page Not Found</h2>
  <p>The project <strong>${projectId}</strong> could not be located. This page may have expired or the project ID may be incorrect.</p>
  <p style="margin-top:16px;font-size:12px;color:#b0a090;">Smart Stage PRO™</p>
</div>
</body></html>`;
}

exports.handler = async (event) => {
  const pathParts = (event.path || "").split("/").filter(Boolean);
  const projectId = pathParts[pathParts.length - 1];

  const htmlHeaders = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache, no-store, must-revalidate",
  };

  if (!projectId || projectId === "compliance") {
    return { statusCode: 400, headers: htmlHeaders, body: renderNotFound("unknown") };
  }

  try {
    const store = getProjectStore();
    const raw = await store.get("pid_" + projectId);

    if (!raw) {
      return { statusCode: 404, headers: htmlHeaders, body: renderNotFound(projectId) };
    }

    const project = JSON.parse(raw);

    // Video data comes from Supabase, a separate system from the Blobs
    // project record. If this fails for any reason (Supabase down, env
    // vars missing), the page should still render normally with images
    // only — a video-fetch failure must never take down the whole
    // compliance page, since the image disclosure is the part that's
    // actually legally required.
    let videoJobs = [];
    try {
      videoJobs = await getDisclosedVideoJobs(projectId);
    } catch (videoErr) {
      console.error("compliance-page video fetch error (non-fatal):", videoErr.message);
    }

    return { statusCode: 200, headers: htmlHeaders, body: renderPage(project, projectId, videoJobs) };

  } catch (err) {
    console.error("compliance-page error:", err.message);
    return { statusCode: 500, headers: htmlHeaders, body: renderNotFound(projectId) };
  }
};
