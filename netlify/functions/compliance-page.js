// compliance-page.js — Netlify Function
// Serves the permanent AB 723 §10140.8 compliance page for a property project
// URL: /compliance/{projectId}
// Shows: agent branding, property address, all original + staged image pairs,
//        disclosure text, download ZIP link, date staged
//
// This page satisfies AB 723 §10140.8(a)(2) — internet website requirement:
// "include the unaltered version of the images from which the digitally altered
//  images were created in the posting"

const { getStore } = require("@netlify/blobs");

function getProjectStore() {
  return getStore({
    name: "smart-stage-projects",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_ACCESS_TOKEN,
  });
}

function formatDate(isoString) {
  if (!isoString) return "Unknown date";
  return new Date(isoString).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric"
  });
}

function renderPage(project, projectId) {
  const agentName     = project.agentName     || process.env.AGENT_NAME     || "Smart Stage AI™";
  const agentBrokerage= project.agentBrokerage|| process.env.AGENT_BROKERAGE|| "";
  const agentDRE      = project.agentDRE      || process.env.AGENT_DRE      || "";
  const agentLogoUrl  = project.agentLogoUrl  || process.env.AGENT_LOGO_URL || "";
  const images        = project.images || [];
  const address       = project.address || "Property Address";
  const createdAt     = formatDate(project.createdAt);

  const imagePairs = images.map((img, i) => {
    const originalBlock = img.originalUrl
      ? `<div class="img-panel">
          <div class="img-label">ORIGINAL — UNALTERED</div>
          <img src="${img.originalUrl}" alt="Original unaltered photo of ${address}" loading="lazy">
        </div>`
      : `<div class="img-panel img-missing"><div class="img-label">ORIGINAL — UNALTERED</div><p>Original image not available</p></div>`;

    const stagedBlock = img.stagedUrl
      ? `<div class="img-panel">
          <div class="img-label">${img.roomName ? img.roomName.toUpperCase() : "STAGED ROOM"} — VIRTUALLY STAGED</div>
          <img src="${img.stagedUrl}" alt="Virtually staged photo of ${address}" loading="lazy">
          ${img.sbsUrl ? `<a href="${img.sbsUrl}" download class="dl-link">↓ Download Side-by-Side</a>` : ""}
        </div>`
      : "";

    return `
    <div class="image-pair">
      <div class="pair-header">
        <span class="pair-num">Image Set ${i + 1}</span>
        <span class="pair-room">${img.roomName || "Room"}</span>
        <span class="pair-date">Staged ${formatDate(img.stagedAt)}</span>
      </div>
      <div class="pair-grid">
        ${originalBlock}
        ${stagedBlock}
      </div>
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
    .site-header { background: #1a1714; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; }
    .header-brand { display: flex; align-items: center; gap: 14px; }
    .header-logo { height: 40px; width: auto; border-radius: 4px; }
    .header-name { color: #b8975a; font-size: 14px; font-weight: 500; letter-spacing: 0.06em; }
    .header-brokerage { color: #7a6f63; font-size: 11px; margin-top: 2px; letter-spacing: 0.04em; }
    .header-badge { background: #2d6a4f; color: #fff; font-size: 10px; font-weight: 600; padding: 4px 10px; border-radius: 3px; letter-spacing: 0.08em; white-space: nowrap; }

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
    .pair-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
    @media (max-width: 768px) { .pair-grid { grid-template-columns: 1fr; } }
    .img-panel { padding: 12px; }
    .img-panel:first-child { border-right: 1px solid #e0d8ce; }
    .img-label { font-size: 10px; font-weight: 600; letter-spacing: 0.1em; color: #7a6f63; margin-bottom: 8px; }
    .img-panel img { width: 100%; height: auto; border-radius: 4px; display: block; }
    .img-missing { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 200px; color: #b0a090; font-size: 13px; }
    .dl-link { display: inline-block; margin-top: 8px; font-size: 11px; color: #1B3A5C; text-decoration: none; }
    .dl-link:hover { text-decoration: underline; }
    .no-images { text-align: center; padding: 60px 24px; color: #7a6f63; font-size: 14px; }

    /* ── LEGAL FOOTER ── */
    .legal-footer { background: #1a1714; color: #7a6f63; padding: 24px; font-size: 11px; line-height: 1.8; }
    .legal-footer strong { color: #b8975a; }
    .legal-footer a { color: #9ab0cc; }
    .legal-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; max-width: 1000px; }
    @media (max-width: 600px) { .legal-grid { grid-template-columns: 1fr; } }
    .legal-divider { border: none; border-top: 1px solid #2d2824; margin: 20px 0; }
    .legal-bottom { font-size: 10px; color: #4a4038; max-width: 1000px; }
  </style>
</head>
<body>

<!-- HEADER -->
<header class="site-header">
  <div class="header-brand">
    ${agentLogoUrl ? `<img src="${agentLogoUrl}" alt="${agentBrokerage} logo" class="header-logo">` : ""}
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
    (Assembly Bill 723, effective October 10, 2025). All staged images have been digitally altered by
    adding virtual furniture and décor for illustrative purposes only. The property is sold as shown
    in the original photographs. This page is maintained by Smart Stage PRO™ powered by Smart Stage AI™.
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

<!-- IMAGE PAIRS -->
<div class="images-container">
  ${noImages}
  ${imagePairs}
</div>

<!-- LEGAL FOOTER -->
<footer class="legal-footer">
  <div class="legal-grid">
    <div>
      <strong>California AB 723 Compliance Statement</strong><br>
      All virtually staged images on this page were digitally altered through the use of artificial intelligence
      to add virtual furniture, décor, and accessories. No structural elements, fixtures, or architectural
      features have been added, removed, or altered. Images are provided for illustrative purposes only.
      The property is sold in its actual condition as shown in the original photographs.
    </div>
    <div>
      <strong>Record Retention Policy</strong><br>
      This compliance page is maintained by Smart Stage PRO™ for a minimum of 3 years from the date of
      project creation, in accordance with California DRE record retention requirements. If the associated
      subscription is cancelled, this page will remain accessible for 30 days following cancellation,
      after which all project files will be delivered to the agent of record via email archive.
    </div>
  </div>
  <hr class="legal-divider">
  <div class="legal-bottom">
    Smart Stage PRO™ is powered by Smart Stage AI™ · Compliance page generated automatically ·
    Page URL: <a href="javascript:void(0)" onclick="navigator.clipboard.writeText(window.location.href)">${process.env.URL || "https://smart-stage-pro.netlify.app"}/compliance/${projectId}</a> ·
    For questions about this disclosure contact ${agentName}${agentDRE ? " (DRE #" + agentDRE + ")" : ""}.
  </div>
</footer>

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
  <p style="margin-top:16px;font-size:12px;color:#b0a090;">Smart Stage PRO™ · Smart Stage AI™</p>
</div>
</body></html>`;
}

exports.handler = async (event) => {
  // Extract projectId from path: /compliance/{projectId}
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
    return { statusCode: 200, headers: htmlHeaders, body: renderPage(project, projectId) };

  } catch (err) {
    console.error("compliance-page error:", err.message);
    return { statusCode: 500, headers: htmlHeaders, body: renderNotFound(projectId) };
  }
};
