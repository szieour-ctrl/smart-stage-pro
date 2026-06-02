// property-search.js — Netlify Function
// Proxies Google Places Autocomplete (New) API
// Keeps GOOGLE_MAPS_API_KEY server-side — never exposed to browser
// Uses session tokens to minimize billing (per-session not per-keystroke)
//
// Input:  { input: "123 Ma", sessionToken: "uuid" }
// Output: { predictions: [{description, placeId}] }

const https = require("https");

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (e) { reject(new Error("Parse error")); }
      });
    }).on("error", reject);
  });
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return {
    statusCode: 500, headers,
    body: JSON.stringify({ error: "GOOGLE_MAPS_API_KEY not configured" })
  };

  try {
    const { input, sessionToken } = JSON.parse(event.body || "{}");
    if (!input || input.length < 3) return {
      statusCode: 200, headers,
      body: JSON.stringify({ predictions: [] })
    };

    // Google Places Autocomplete (New) — address only, US biased
    const params = new URLSearchParams({
      input,
      key: apiKey,
      sessiontoken: sessionToken || "",
      types: "address",
      components: "country:us",
      language: "en",
    });

    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?${params}`;
    const data = await httpsGet(url);

    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      console.error("Google Places error:", data.status, data.error_message);
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ predictions: [], error: data.status })
      };
    }

    const predictions = (data.predictions || []).map(p => ({
      description: p.description,
      placeId: p.place_id,
      // Extract structured address components for display
      mainText: p.structured_formatting?.main_text || p.description,
      secondaryText: p.structured_formatting?.secondary_text || "",
    }));

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ predictions }),
    };

  } catch (err) {
    console.error("property-search error:", err.message);
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
