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
// EMAIL DELIVERY — fires the same fire-and-forget Pabbly webhook pattern
// already established in video-notify.js (PABBLY_VIDEO_DELIVERY_WEBHOOK_URL).
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

  const { email, phone, listingUrl, address, ab723Verdict, rule1210fVerdict, source, reportJson } = body;

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

    // Fire-and-forget email delivery, same non-blocking pattern as
    // video-notify.js's Pabbly hand-off — a Pabbly outage or missing env
    // var should never fail the lead save itself, since the lead is
    // already safely stored by this point.
    if (reportId && process.env.PABBLY_COMPLIANCE_REPORT_WEBHOOK_URL) {
      try {
        const pabblyUrl = new URL(process.env.PABBLY_COMPLIANCE_REPORT_WEBHOOK_URL);
        const siteBase = process.env.URL || `https://${event.headers.host}`;
        const pdfUrl = `${siteBase}/.netlify/functions/generate-compliance-pdf?reportId=${reportId}`;
        const pabblyBody = JSON.stringify({
          reportId, email, phone: phone || null, address: address || null,
          listingUrl: listingUrl || null,
          ab723Verdict: ab723Verdict || null,
          pdfUrl,
        });
        const req = require("https").request({
          hostname: pabblyUrl.hostname, path: pabblyUrl.pathname + pabblyUrl.search, method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(pabblyBody) },
        }, () => {});
        req.on("error", (err) => console.error("Compliance report Pabbly webhook failed (non-fatal):", err.message));
        req.write(pabblyBody);
        req.end();
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
