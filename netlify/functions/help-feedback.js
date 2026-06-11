// help-feedback.js
// Smart Stage PRO™ — Help Agent Feedback Logger
// Route: POST /.netlify/functions/help-feedback
// Body: { question: string, answer: string, vote: "up" | "down" }
// Logs to Supabase help_feedback table
//
// Required Supabase table (run once in SQL editor):
// CREATE TABLE IF NOT EXISTS help_feedback (
//   id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//   question text NOT NULL,
//   answer text NOT NULL,
//   vote text NOT NULL CHECK (vote IN ('up', 'down')),
//   created_at timestamptz DEFAULT now()
// );

const https = require("https");

function supabaseRequest(path, method, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const supabaseUrl = new URL(process.env.SUPABASE_URL);

    const options = {
      hostname: supabaseUrl.hostname,
      path: `/rest/v1${path}`,
      method,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: "return=minimal",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

exports.handler = async (event) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let question, answer, vote;
  try {
    const parsed = JSON.parse(event.body || "{}");
    question = (parsed.question || "").slice(0, 2000);
    answer = (parsed.answer || "").slice(0, 4000);
    vote = parsed.vote;
  } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "Invalid body" }) };
  }

  if (!question || !answer || !["up", "down"].includes(vote)) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "Invalid parameters" }) };
  }

  try {
    await supabaseRequest("/help_feedback", "POST", { question, answer, vote });
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error("Feedback log error:", err);
    // Always return 200 — feedback failure should never surface to the user
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ ok: true }) };
  }
};
