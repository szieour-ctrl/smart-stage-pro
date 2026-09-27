// netlify/functions/generate-compliance-pdf.js
//
// Renders the AB 723 Compliance Scan Report as a downloadable PDF, from
// the report_json a lead already saved via builder-lead-capture.js
// (?action reportId). Deliberately re-fetches from Supabase every time
// rather than accepting report data directly in the request — this is
// the one stable URL that both a "Download PDF" button on the landing
// page AND a Pabbly email step can point at, and neither of those
// callers should need to carry the full report payload around with them.
//
// USAGE: GET /.netlify/functions/generate-compliance-pdf?reportId=<uuid>
//
// REQUIRES pdfkit — not yet in package.json, add:
//   "pdfkit": "^0.15.0"
// AND requires this in netlify.toml (pdfkit ships .afm font-metric files
// it reads via a relative fs path at runtime — esbuild's default bundling
// breaks that relative path, so it must ship un-bundled):
//   [functions."generate-compliance-pdf"]
//     timeout = 15
//     external_node_modules = ["pdfkit"]

const https = require("https");
const PDFDocument = require("pdfkit");

function supabaseGet(table, queryParams) {
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

const COLORS = {
  ink: "#23201B",
  dim: "#6a655c",
  flag: "#C43A1B",
  flagBg: "#FCEBE3",
  verified: "#2E5F47",
  verifiedBg: "#E6EFE9",
  amber: "#A9660B",
  amberBg: "#FBF0DD",
  line: "#E4DFD5",
};

function resultColor(result) {
  const r = (result || "").toLowerCase();
  if (r.includes("fail") || r === "red" || r === "deficiency") return COLORS.flag;
  if (r.includes("review") || r === "amber" || r === "partial") return COLORS.amber;
  return COLORS.verified;
}

function fetchImageBuffer(url) {
  return new Promise((resolve) => {
    if (!url) { resolve(null); return; }
    let target;
    try { target = new URL(url); } catch { resolve(null); return; }
    const req = https.request({ hostname: target.hostname, path: target.pathname + target.search, method: "GET", timeout: 8000 }, (res) => {
      if (res.statusCode >= 400) { res.destroy(); resolve(null); return; }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

exports.handler = async (event) => {
  const reportId = event.queryStringParameters?.reportId;
  if (!reportId) {
    return { statusCode: 400, headers: { "Content-Type": "text/plain" }, body: "Missing reportId." };
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { statusCode: 500, headers: { "Content-Type": "text/plain" }, body: "Supabase is not configured." };
  }

  const result = await supabaseGet("builder_leads", `?id=eq.${reportId}&select=address,listing_url,report_json,created_at`);
  const row = Array.isArray(result.data) ? result.data[0] : null;
  if (!row || !row.report_json) {
    return { statusCode: 404, headers: { "Content-Type": "text/plain" }, body: "Report not found." };
  }

  const r = row.report_json;

  const doc = new PDFDocument({ size: "LETTER", margin: 50, bufferPages: true });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));

  const pdfDone = new Promise((resolve) => doc.on("end", resolve));

  // ── Header ────────────────────────────────────────────────────────
  doc.fontSize(9).fillColor(COLORS.dim).font("Helvetica")
    .text("SMART STAGE PRO — AB 723 COMPLIANCE SCAN REPORT", { characterSpacing: 0.5 });
  doc.moveDown(0.6);
  doc.fontSize(18).fillColor(COLORS.ink).font("Helvetica-Bold")
    .text(row.address || r.address || "Property address unavailable");
  doc.fontSize(10).fillColor(COLORS.dim).font("Helvetica")
    .text(`Scan Date: ${r.scanDate || new Date(row.created_at).toLocaleDateString("en-US")}    |    Photos Reviewed: ${r.photosReviewedCount ?? "?"} of ${r.photosTotalCount ?? "?"}    |    Listing Description Reviewed: ${r.listingDescriptionReviewed ? "Yes" : "No"}`);
  doc.moveDown(1);

  // ── Hero photo ───────────────────────────────────────────────────
  // Same photo shown in the live-scan card and report header on the
  // landing page — Sam's ask was to make the PDF visually match the
  // property being scanned, not just list facts about it.
  const heroBuffer = await fetchImageBuffer(r.heroPhotoUrl);
  if (heroBuffer) {
    try {
      const imgY = doc.y;
      doc.image(heroBuffer, 50, imgY, { width: 512, height: 200, fit: [512, 200], align: "center" });
      doc.y = imgY + 200 + 14;
    } catch {
      // Malformed/unsupported image data — skip the photo rather than
      // crash the whole report over a cosmetic addition.
    }
  }

  // ── Overall result banner ────────────────────────────────────────
  const bannerColor = r.overallVerdict === "clean" ? COLORS.verified : (r.overallVerdict === "review" ? COLORS.amber : COLORS.flag);
  const bannerBg = r.overallVerdict === "clean" ? COLORS.verifiedBg : (r.overallVerdict === "review" ? COLORS.amberBg : COLORS.flagBg);
  const bannerIcon = r.overallVerdict === "clean" ? "\u2022 NO GAPS FOUND" : (r.overallVerdict === "review" ? "\u2022 REVIEW RECOMMENDED" : "\u2022 COMPLIANCE GAPS DETECTED");

  const bannerY = doc.y;
  doc.rect(50, bannerY, 512, 46).fill(bannerBg);
  doc.fillColor(bannerColor).font("Helvetica-Bold").fontSize(13).text(bannerIcon, 62, bannerY + 15);
  doc.y = bannerY + 46 + 12;

  doc.fillColor(COLORS.ink).font("Helvetica").fontSize(10.5)
    .text(r.overallSummary || "", { width: 512, lineGap: 3 });
  doc.moveDown(0.8);

  if (r.stats) {
    doc.fontSize(9.5).fillColor(COLORS.dim).font("Helvetica")
      .text(`Verified statutory deficiencies: ${r.stats.deficiencies ?? 0}    Potential issues requiring review: ${r.stats.potentialIssues ?? 0}    Verified requirements satisfied: ${r.stats.satisfied ?? 0}    Overall evidence confidence: ${r.stats.confidencePct ?? "?"}%`);
  }
  doc.moveDown(1);

  // ── Critical findings ─────────────────────────────────────────────
  if (Array.isArray(r.criticalFindings) && r.criticalFindings.length) {
    doc.fontSize(13).fillColor(COLORS.ink).font("Helvetica-Bold").text("Critical Findings");
    doc.moveDown(0.4);
    r.criticalFindings.forEach((f) => {
      const c = f.severity === "amber" ? COLORS.amber : COLORS.flag;
      if (doc.y > 680) doc.addPage();
      doc.fontSize(11).fillColor(c).font("Helvetica-Bold").text((f.severity === "amber" ? "! " : "\u2022 ") + (f.title || ""));
      doc.fontSize(9.5).fillColor(COLORS.ink).font("Helvetica").text(f.detail || "", { lineGap: 2 });
      doc.fontSize(8.5).fillColor(COLORS.dim).font("Helvetica-Oblique")
        .text(`Finding: ${f.finding || ""}    Confidence: ${f.confidence || "?"}    Severity: ${f.severityLabel || (f.severity === "amber" ? "Manual review required" : "Verified statutory deficiency")}`);
      doc.moveDown(0.7);
    });
    doc.moveDown(0.3);
  }

  // ── Compliance scorecard ─────────────────────────────────────────
  if (Array.isArray(r.scorecard) && r.scorecard.length) {
    if (doc.y > 620) doc.addPage();
    doc.fontSize(13).fillColor(COLORS.ink).font("Helvetica-Bold").text("Compliance Scorecard");
    doc.moveDown(0.4);
    const colX = [50, 320, 400];
    const colW = [270, 80, 162];
    doc.fontSize(8.5).fillColor(COLORS.dim).font("Helvetica-Bold");
    doc.text("AB 723 REQUIREMENT", colX[0], doc.y, { width: colW[0], continued: false });
    let headerY = doc.y - 10;
    doc.text("RESULT", colX[1], headerY, { width: colW[1] });
    doc.text("EVIDENCE", colX[2], headerY, { width: colW[2] });
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor(COLORS.line).stroke();
    doc.moveDown(0.3);

    r.scorecard.forEach((row2) => {
      if (doc.y > 700) { doc.addPage(); }
      const rowY = doc.y;
      doc.fontSize(9).fillColor(COLORS.ink).font("Helvetica").text(row2.requirement || "", colX[0], rowY, { width: colW[0] });
      const afterReq = doc.y;
      doc.fillColor(resultColor(row2.result)).font("Helvetica-Bold").text(row2.result || "", colX[1], rowY, { width: colW[1] });
      doc.fillColor(COLORS.dim).font("Helvetica").fontSize(8.5).text(row2.evidence || "", colX[2], rowY, { width: colW[2] });
      doc.y = Math.max(doc.y, afterReq) + 6;
    });
    doc.moveDown(0.6);
  }

  // ── Per-photo findings ────────────────────────────────────────────
  // Tables above/below position text in columns (x=320, 400, 450...), and
  // pdfkit keeps the last x as the cursor. Every section after a table must
  // reset x to the left margin or it renders squeezed into the last column
  // (the Sep 26, 2026 "Final Finding" layout bug).
  doc.x = 50;
  if (Array.isArray(r.perPhoto) && r.perPhoto.length) {
    if (doc.y > 600) doc.addPage();
    doc.fontSize(13).fillColor(COLORS.ink).font("Helvetica-Bold").text("Per-Photo Findings");
    doc.moveDown(0.4);
    // Each header is placed at the same y (not chained with continued:true,
    // which staggered them down the page).
    doc.fontSize(8.5).fillColor(COLORS.dim).font("Helvetica-Bold");
    const photoHeadY = doc.y;
    doc.text("PHOTO", 50, photoHeadY, { width: 50, lineBreak: false });
    doc.text("ALTERATION STATUS", 100, photoHeadY, { width: 180, lineBreak: false });
    doc.text("DISCLOSURE", 280, photoHeadY, { width: 90, lineBreak: false });
    doc.text("ORIGINAL", 370, photoHeadY, { width: 80, lineBreak: false });
    doc.text("RESULT", 450, photoHeadY, { width: 100, lineBreak: false });
    doc.x = 50;
    doc.y = photoHeadY + 12;
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor(COLORS.line).stroke();
    doc.moveDown(0.3);
    r.perPhoto.forEach((p) => {
      if (doc.y > 730) doc.addPage();
      const rowY = doc.y;
      doc.fontSize(9).fillColor(COLORS.ink).font("Helvetica").text(String(p.photoNumber ?? "?"), 50, rowY, { width: 50 });
      doc.text(p.alterationStatus || "", 100, rowY, { width: 180 });
      doc.text(p.disclosureVisible ? "Yes" : "No", 280, rowY, { width: 90 });
      doc.text(p.originalAvailable ? "Yes" : "No", 370, rowY, { width: 80 });
      doc.fillColor(resultColor(p.result)).font("Helvetica-Bold").text(p.result || "", 450, rowY, { width: 100 });
      doc.moveDown(0.5);
    });
    doc.moveDown(0.6);
  }

  // ── Final finding ─────────────────────────────────────────────────
  doc.x = 50;
  if (r.finalFinding) {
    if (doc.y > 640) doc.addPage();
    doc.x = 50;
    doc.fontSize(13).fillColor(COLORS.ink).font("Helvetica-Bold").text("Final Finding", 50, doc.y, { width: 512 });
    doc.moveDown(0.4);
    // Tinted panel with a colored left rule, sized to the text it holds.
    const panelTop = doc.y;
    const innerX = 66, innerW = 484;
    doc.fontSize(11).font("Helvetica-Bold");
    const headH = doc.heightOfString(r.finalFinding.headline || "", { width: innerW });
    doc.fontSize(9.5).font("Helvetica");
    const bodyH = doc.heightOfString(r.finalFinding.body || "", { width: innerW, lineGap: 2 });
    const panelH = 14 + headH + 5 + bodyH + 14;
    doc.rect(50, panelTop, 512, panelH).fill("#F6F3EE");
    doc.rect(50, panelTop, 4, panelH).fill(bannerColor);
    doc.fontSize(11).fillColor(bannerColor).font("Helvetica-Bold").text(r.finalFinding.headline || "", innerX, panelTop + 14, { width: innerW });
    doc.moveDown(0.25);
    doc.fontSize(9.5).fillColor(COLORS.ink).font("Helvetica").text(r.finalFinding.body || "", innerX, doc.y, { width: innerW, lineGap: 2 });
    doc.x = 50;
    doc.y = panelTop + panelH + 18;
  }

  // ── Recommended corrective action ────────────────────────────────
  // Items arrive from the page as "Address: <requirement> — <evidence>" or
  // "Review: <requirement> — <evidence>". Split them so the requirement
  // reads as a bold line with the evidence under it, instead of one long
  // run-on bullet. Works for reports already saved, too.
  function splitAction(a) {
    const text = String(a || "").replace(/^(Address|Review):\s*/, "");
    const i = text.indexOf(" \u2014 ");
    return i === -1 ? { title: text, detail: "" } : { title: text.slice(0, i), detail: text.slice(i + 3) };
  }
  function actionGroup(label, color, items) {
    if (doc.y > 700) doc.addPage();
    doc.fontSize(10.5).fillColor(color).font("Helvetica-Bold").text(label, 50, doc.y, { width: 512 });
    doc.moveDown(0.35);
    items.forEach((a) => {
      const { title, detail } = splitAction(a);
      if (doc.y > 720) doc.addPage();
      const top = doc.y;
      doc.rect(50, top + 3, 5, 5).fill(color);
      doc.fontSize(9.5).fillColor(COLORS.ink).font("Helvetica-Bold").text(title, 64, top, { width: 498 });
      if (detail) {
        doc.moveDown(0.1);
        doc.fontSize(9).fillColor(COLORS.dim).font("Helvetica").text(detail, 64, doc.y, { width: 498, lineGap: 1.5 });
      }
      doc.moveDown(0.55);
    });
    doc.x = 50;
  }
  if (r.recommendedActions && ((r.recommendedActions.immediate || []).length || (r.recommendedActions.manualReview || []).length)) {
    if (doc.y > 620) doc.addPage();
    doc.fontSize(13).fillColor(COLORS.ink).font("Helvetica-Bold").text("Recommended Corrective Action", 50, doc.y, { width: 512 });
    doc.moveDown(0.5);
    if ((r.recommendedActions.immediate || []).length) {
      actionGroup("Immediate correction required", COLORS.flag, r.recommendedActions.immediate);
      doc.moveDown(0.3);
    }
    if ((r.recommendedActions.manualReview || []).length) {
      actionGroup("Manual review required", COLORS.amber, r.recommendedActions.manualReview);
    }
    doc.moveDown(0.5);
  }

  // ── CTA ───────────────────────────────────────────────────────────
  doc.x = 50;
  const ctaLine = "Smart Stage PRO builds the disclosure and original-image link automatically for every photo it stages.";
  doc.font("Helvetica-Bold").fontSize(10.5);
  const ctaTextH = doc.heightOfString(ctaLine, { width: 488 });
  const ctaH = 12 + ctaTextH + 6 + 12 + 12; // padding + text + gap + link line + padding
  if (doc.y + ctaH > 740) doc.addPage();
  const ctaY = doc.y;
  doc.rect(50, ctaY, 512, ctaH).fill(COLORS.verifiedBg);
  doc.fillColor(COLORS.ink).font("Helvetica-Bold").fontSize(10.5)
    .text(ctaLine, 62, ctaY + 12, { width: 488 });
  doc.fillColor(COLORS.verified).font("Helvetica").fontSize(9.5)
    .text("See how it works: smartstagepro.com", 62, ctaY + 12 + ctaTextH + 6, { link: "https://smartstagepro.com", underline: true });
  doc.x = 50;
  doc.y = ctaY + ctaH + 16;

  // ── Footer / limitation ──────────────────────────────────────────
  doc.x = 50;
  doc.fontSize(8).fillColor(COLORS.dim).font("Helvetica")
    .text((r.limitation || "") + "\n\nThis report documents observable AB 723 disclosure evidence on the Zillow advertisement as scanned. It is a scan, not a legal audit or finding, and does not constitute legal advice or a court determination.", { lineGap: 2 });

  doc.end();
  const pdfBuffer = await pdfDone.then(() => Buffer.concat(chunks));

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="AB723-Compliance-Report-${reportId}.pdf"`,
      "Access-Control-Allow-Origin": "*",
    },
    body: pdfBuffer.toString("base64"),
    isBase64Encoded: true,
  };
};
