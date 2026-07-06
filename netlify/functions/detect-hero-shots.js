// detect-hero-shots.js — Netlify Function
// Call 2 of the Cinematic Asset Generator workflow: GPT Image 2 → Claude Vision → GPT Image 2.
// Reads the APPROVED staged image and returns structured hero-shot suggestions
// (id, name, confidence, bbox as 0-1 fractions, reason). Netlify does no vision
// work itself — this function is the only place that calls Claude.
//
// FLAG FOR SAM: env var name (ANTHROPIC_API_KEY) and model string
// (claude-haiku-4-5-20251001) are inferred, not confirmed against your existing
// Haiku spatial-read function. If your other Haiku calls use a different env
// var or model string, tell me and I'll match it exactly.

const https = require("https");

function callClaudeVision(imageBase64, mimeType, apiKey) {
  const body = JSON.stringify({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1500,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } },
        { type: "text", text:
          "You are analyzing an already-staged real estate interior photo to identify possible " +
          "hero/detail shot crops for a real estate marketing tool. Look ONLY at what is actually " +
          "visible in this specific photo — do not assume standard kitchen features that aren't shown.\n\n" +
          "Return ONLY valid JSON, no other text, no markdown fences, in exactly this shape:\n" +
          "{\n" +
          '  "room_type": "<short description of the room type as shown>",\n' +
          '  "suggested_hero_shots": [\n' +
          "    {\n" +
          '      "id": <integer, 1-indexed>,\n' +
          '      "name": "<short shot name, e.g. \'Island + Faucet Hero\'>",\n' +
          '      "confidence": "high" | "medium" | "low",\n' +
          '      "bbox": { "x": <0-1>, "y": <0-1>, "w": <0-1>, "h": <0-1> },\n' +
          '      "reason": "<one sentence describing exactly what is visible and readable in this crop \u2014 be specific about the actual materials, colors, and objects you see, not generic style language>"\n' +
          "    }\n" +
          "  ]\n" +
          "}\n\n" +
          "bbox values are fractions of the image width/height (0-1), where x/y is the top-left corner. " +
          "Only suggest crops where the subject is clearly, unambiguously visible and well-composed in " +
          "THIS photo — do not suggest a crop for an asset that is poorly framed, partially cut off, or " +
          "not actually present. Suggest between 3 and 10 hero shots depending on how many distinct, " +
          "well-composed assets this specific photo actually contains."
        }
      ]
    }]
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      }
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (res.statusCode !== 200) {
            reject(new Error(`Claude API error ${res.statusCode}: ${JSON.stringify(parsed).slice(0,300)}`));
          } else {
            resolve(parsed);
          }
        } catch (e) { reject(new Error("Claude API parse error")); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const { imageBase64, mimeType } = JSON.parse(event.body);
    if (!imageBase64) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing imageBase64" }) };

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }) };

    console.log(`detect-hero-shots: image ${Math.round(imageBase64.length/1024)}KB, calling Claude Vision`);
    const result = await callClaudeVision(imageBase64, mimeType || "image/jpeg", apiKey);

    const textBlock = result?.content?.find(b => b.type === "text");
    if (!textBlock) throw new Error("No text content in Claude response");

    // Strip markdown fences defensively, in case the model wraps the JSON anyway
    const cleaned = textBlock.text.trim().replace(/^```json\s*/i, "").replace(/```\s*$/,"");
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      throw new Error("Claude did not return valid JSON: " + cleaned.slice(0, 200));
    }

    if (!Array.isArray(parsed.suggested_hero_shots)) {
      throw new Error("Response missing suggested_hero_shots array");
    }

    console.log(`detect-hero-shots: ${parsed.suggested_hero_shots.length} shots suggested for ${parsed.room_type}`);
    return { statusCode: 200, headers, body: JSON.stringify(parsed) };

  } catch (err) {
    console.error("detect-hero-shots error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
