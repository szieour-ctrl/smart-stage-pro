// netlify/functions/builder-lead-capture.js
//
// Stores leads from the builder-focused compliance landing page
// (builder-compliance.html). Deliberately its own small table, not
// reused/overloaded onto the existing `listings` table — a scan lead
// isn't a listing you're staging, it's a marketing contact captured off
// a public scan of someone else's (or your own) Zillow listing, and
// mixing those concepts would make both harder to reason about later.
//
// REQUIRED SUPABASE TABLE — not created by this function, needs to exist
// before this is live:
//
//   create table builder_leads (
//     id               uuid primary key default gen_random_uuid(),
//     email            text not null,
//     phone            text,
//     listing_url      text,
//     ab723_verdict    text,
//     rule_1210f_verdict text,
//     source           text,
//     created_at       timestamptz default now()
//   );
//
// NEW COLUMNS — SAM NEEDS TO RUN THIS ALTER before deploying (July 12
// session, full 10-question report + PDF/email build):
//
//   alter table builder_leads add column if not exists address text;
//   alter table builder_leads add column if not exists report_json jsonb;
//
// report_json stores the full composed 10-question report (built
// client-side in agent-compliance.html/builder-compliance.html) so a
// PDF can be regenerated later from a stable reportId — the report data
// itself never touches the browser again after this save, and generate-
// compliance-pdf.js re-fetches it fresh each time a PDF is requested.
//
// Matches the exact supabase() request pattern already used throughout
// this codebase (see video-job.js) — same headers, same error handling
// shape — rather than inventing a new one.
//
// EMAIL DELIVERY — posts to a Pabbly webhook (awaited, 5s cap — see the
// note at the call site for why it is no longer fire-and-forget).
// New env var PABBLY_COMPLIANCE_REPORT_WEBHOOK_URL needs a Pabbly scenario
// built on Sam's side: trigger receives {email, phone, address, verdict,
// pdfUrl}, scenario fetches pdfUrl (a generate-compliance-pdf.js link,
// works standalone in a browser too) and emails it. Texting the PDF is
// explicitly NOT wired up yet — phone is captured and stored now so
// nothing needs to change here once Sam sets up Twilio; the SMS step
// would be a second action inside the same Pabbly scenario or a second
// scenario watching the same trigger.

const https = require("https");

function supabase(method, table, body, queryParams = "") {
  return new Promise((resolve, reject) => {
    const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/${table}${queryParams}`);
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data || "[]") }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Report email HTML (built here so Pabbly maps one field) ──────────
// Pabbly's new editor rewrote the pasted template and broke its field
// mappings (Sep 26, 2026). Building the finished email server-side means
// the Pabbly Gmail step just maps `emailHtml` into the Body — no merge
// fields inside HTML attributes to break. Values are HTML-escaped.
function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function buildReportEmailHtml({ address, streetAddress, listingUrl, pdfUrl }) {
  const v = {
    address: escapeHtml(address || "your listing"),
    streetAddress: escapeHtml(streetAddress || address || "your listing"),
    listingUrl: escapeHtml(listingUrl || "https://www.zillow.com"),
    pdfUrl: escapeHtml(pdfUrl),
  };
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Your AB 723 Compliance Report</title>
</head>
<body style="margin:0;padding:0;background-color:#F7F8FA;font-family:Arial,Helvetica,sans-serif;">

<!-- Preheader (hidden, shows in inbox preview) -->
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">
Your AB 723 compliance report for ${v.streetAddress} is ready to view.
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F7F8FA;">
<tr>
<td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#FFFFFF;border-radius:8px;overflow:hidden;">

<!-- Header -->
<tr>
<td style="background-color:#FFFFFF;padding:28px 32px 20px;border-bottom:1px solid #E3E6EC;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td valign="middle">
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
<tr>
<td valign="middle" style="padding-right:10px;">
<div style="width:32px;height:32px;border-radius:8px;background-color:#E8631C;"></div>
</td>
<td valign="middle">
<span style="font-family:Arial,Helvetica,sans-serif;font-weight:800;font-size:17px;color:#151B2C;">Smart Stage <span style="background-color:#0F1E3D;color:#FFFFFF;padding:1px 7px;border-radius:4px;font-size:13px;font-weight:700;">PRO</span></span><br>
<span style="font-family:'Courier New',monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;color:#5B6272;">Stage. Disclose. Stay Compliant.</span>
</td>
</tr>
</table>
</td>
<td valign="middle" align="right">
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
<tr>
<td style="background-color:#0F1E3D;color:#FFFFFF;font-family:'Courier New',monospace;font-size:9px;font-weight:700;text-align:center;padding:6px 8px;border-radius:6px;line-height:1.2;">AB<br>723</td>
</tr>
</table>
</td>
</tr>
</table>
</td>
</tr>

<!-- Navy banner -->
<tr>
<td style="background-color:#0A1530;padding:28px 32px;">
<p style="margin:0 0 6px;font-family:'Courier New',monospace;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#E8631C;font-weight:700;">Compliance Scan Complete</p>
<h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-weight:800;font-size:24px;line-height:1.25;color:#FFFFFF;">Your AB 723 Report Is Ready</h1>
</td>
</tr>

<!-- Body -->
<tr>
<td style="padding:32px;">
<p style="margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#151B2C;">
We ran a full 10-point AB 723 compliance scan on:
</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F7F8FA;border:1px solid #E3E6EC;border-radius:6px;margin:0 0 20px;">
<tr>
<td style="padding:14px 18px;">
<p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#151B2C;">${v.address}</p>
<p style="margin:4px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#5B6272;">
<a href="${v.listingUrl}" style="color:#5B6272;text-decoration:underline;">View original Zillow listing →</a>
</p>
</td>
</tr>
</table>
<p style="margin:0 0 24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#151B2C;">
Your full report covers digital-alteration detection, disclosure placement, original-image availability, and QR/link verification — everything California law requires you to have in place before you market this listing.
</p>

<!-- CTA button -->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 28px;">
<tr>
<td align="center" style="background-color:#E8631C;border-radius:6px;">
<a href="${v.pdfUrl}" target="_blank" style="display:inline-block;padding:14px 32px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#FFFFFF;text-decoration:none;">View Your Full Report (PDF)</a>
</td>
</tr>
</table>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #E3E6EC;padding-top:20px;">
<tr>
<td style="padding-top:20px;">
<p style="margin:0 0 10px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;color:#151B2C;">What's inside your report</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
<tr><td style="padding:3px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#5B6272;">✓  Altered-photo detection across your listing gallery</td></tr>
<tr><td style="padding:3px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#5B6272;">✓  Disclosure and QR/link placement check</td></tr>
<tr><td style="padding:3px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#5B6272;">✓  Original-image availability and syndication check</td></tr>
<tr><td style="padding:3px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#5B6272;">✓  Clear pass/fail scorecard across all 10 checks</td></tr>
</table>
</td>
</tr>
</table>
</td>
</tr>

<!-- Secondary CTA: product tie-in -->
<tr>
<td style="padding:0 32px 32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#FBF0DD;border-radius:6px;">
<tr>
<td style="padding:18px 20px;">
<p style="margin:0 0 4px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;color:#151B2C;">Found gaps in your report?</p>
<p style="margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.55;color:#5B6272;">Smart Stage PRO builds AB 723 disclosure — the compliance page, QR code, and original-image pairing — into every staged image automatically, so this never has to be a manual fix.</p>
<a href="https://smartstagepro.com/?src=virtual_staging_review#pricing" style="font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;color:#0F1E3D;text-decoration:underline;">See how it works →</a>
</td>
</tr>
</table>
</td>
</tr>

<!-- Footer -->
<tr>
<td style="background-color:#0A1530;padding:24px 32px;">
<p style="margin:0 0 8px;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;color:rgba(255,255,255,0.6);">
This report documents observable AB 723 disclosure evidence only. It is a scan, not a legal audit, compliance certification, or legal finding, and is not legal advice.
</p>
<p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:rgba(255,255,255,0.5);">
Smart Stage PRO · <a href="https://smartstagepro.com" style="color:rgba(255,255,255,0.75);text-decoration:underline;">smartstagepro.com</a>
</p>
</td>
</tr>

</table>
</td>
</tr>
</table>

</body>
</html>
`;
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Use POST." }) };
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON body." }) }; }

  const { email, phone, listingUrl, address, streetAddress, ab723Verdict, rule1210fVerdict, source, reportJson } = body;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "A valid email is required." }) };
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Supabase is not configured." }) };
  }

  try {
    const result = await supabase("POST", "builder_leads", {
      email,
      phone: phone || null,
      listing_url: listingUrl || null,
      address: address || null,
      ab723_verdict: ab723Verdict || null,
      rule_1210f_verdict: rule1210fVerdict || null,
      source: source || null,
      report_json: reportJson || null,
    });

    if (result.status >= 400) {
      // Surface the real Supabase response rather than a generic message —
      // this session has hit the same class of silent-failure bug enough
      // times (project-manage.js, video-job.js) that logging the actual
      // error body here from the start is worth the extra line.
      console.error("builder_leads insert failed:", result.status, JSON.stringify(result.data));
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Could not save lead.", detail: result.data }) };
    }

    const savedRow = Array.isArray(result.data) ? result.data[0] : null;
    const reportId = savedRow?.id || null;

    // Email delivery via Pabbly. The webhook call is AWAITED (with a 5s cap)
    // rather than fire-and-forget: Netlify can freeze a function the moment
    // it returns, so an un-awaited request sometimes never leaves at all —
    // the likely cause of report emails silently not sending (Sep 2026).
    // A Pabbly failure or timeout is still non-fatal: the lead is already
    // saved, so this never fails the response to the page.
    if (reportId && process.env.PABBLY_COMPLIANCE_REPORT_WEBHOOK_URL) {
      try {
        const pabblyUrl = new URL(process.env.PABBLY_COMPLIANCE_REPORT_WEBHOOK_URL);
        const siteBase = process.env.URL || `https://${event.headers.host}`;
        const pdfUrl = `${siteBase}/.netlify/functions/generate-compliance-pdf?reportId=${reportId}`;
        const pabblyBody = JSON.stringify({
          reportId, email, phone: phone || null, address: address || null,
          streetAddress: streetAddress || null,
          listingUrl: listingUrl || null,
          ab723Verdict: ab723Verdict || null,
          pdfUrl,
          emailHtml: buildReportEmailHtml({ address, streetAddress, listingUrl, pdfUrl }),
        });
        await new Promise((resolve) => {
          const req = require("https").request({
            hostname: pabblyUrl.hostname, path: pabblyUrl.pathname + pabblyUrl.search, method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(pabblyBody) },
            timeout: 5000,
          }, (res) => {
            res.resume();
            res.on("end", () => {
              if (res.statusCode >= 400) console.error("Compliance report Pabbly webhook returned HTTP", res.statusCode);
              resolve();
            });
          });
          req.on("timeout", () => { console.error("Compliance report Pabbly webhook timed out after 5s (non-fatal)"); req.destroy(); resolve(); });
          req.on("error", (err) => { console.error("Compliance report Pabbly webhook failed (non-fatal):", err.message); resolve(); });
          req.write(pabblyBody);
          req.end();
        });
      } catch (err) {
        console.error("Compliance report Pabbly webhook setup error (non-fatal):", err.message);
      }
    } else if (reportId && !process.env.PABBLY_COMPLIANCE_REPORT_WEBHOOK_URL) {
      console.warn("PABBLY_COMPLIANCE_REPORT_WEBHOOK_URL not set — lead saved but no email will be sent.");
    }

    return { statusCode: 200, headers, body: JSON.stringify({ saved: true, reportId }) };
  } catch (err) {
    console.error("builder-lead-capture error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
