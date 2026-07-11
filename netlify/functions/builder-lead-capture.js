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
// Matches the exact supabase() request pattern already used throughout
// this codebase (see video-job.js) — same headers, same error handling
// shape — rather than inventing a new one.

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

  const { email, phone, listingUrl, ab723Verdict, rule1210fVerdict, source } = body;

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
      ab723_verdict: ab723Verdict || null,
      rule_1210f_verdict: rule1210fVerdict || null,
      source: source || null,
    });

    if (result.status >= 400) {
      // Surface the real Supabase response rather than a generic message —
      // this session has hit the same class of silent-failure bug enough
      // times (project-manage.js, video-job.js) that logging the actual
      // error body here from the start is worth the extra line.
      console.error("builder_leads insert failed:", result.status, JSON.stringify(result.data));
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Could not save lead.", detail: result.data }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ saved: true }) };
  } catch (err) {
    console.error("builder-lead-capture error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
