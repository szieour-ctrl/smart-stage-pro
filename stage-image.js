const https = require("https");

// ── Shared HTTPS helper ──────────────────────────────────────────────────────
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (e) { resolve({ status: res.statusCode, body: { raw } }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Claude vision: analyze floorplan ────────────────────────────────────────
async function analyzeFloorplan(base64, mimeType, claudeKey) {
  const payload = JSON.stringify({
    model: "claude-opus-4-5-20251001",
    max_tokens: 1024,
    messages: [{
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: mimeType || "image/jpeg", data: base64 }
        },
        {
          type: "text",
          text: `You are analyzing a 2D real estate floor plan. Return ONLY valid JSON — no markdown, no explanation.

Identify every room visible. For each room provide:
- name: common real estate name (e.g. "Great Room", "Kitchen", "Primary Suite", "Dining Room", "Office", "Loft", "Garage", "Entry", "Primary Bath", "Bedroom 2", "Bedroom 3", "Laundry", "Covered Patio", "Backyard")
- id: slug version of name (e.g. "great-room", "kitchen")
- floor: 1 or 2 (or null if unclear)
- adjacentTo: array of room ids that share a wall or open sightline

Return this exact shape:
{"rooms": [{"id":"...","name":"...","floor":1,"adjacentTo":["..."]}]}`
        }
      ]
    }]
  });

  const result = await httpsRequest({
    hostname: "api.anthropic.com",
    path: "/v1/messages",
    method: "POST",
    headers: {
      "x-api-key": claudeKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload)
    }
  }, payload);

  if (result.status !== 200) throw new Error("Claude error: " + JSON.stringify(result.body).slice(0, 200));

  const text = result.body?.content?.[0]?.text || "{}";
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ── Build multipart for OpenAI image edits ───────────────────────────────────
function buildMultipart(boundary, imageBuffer, imageMime, prompt, quality) {
  const parts = [];
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-1`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${prompt}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="n"\r\n\r\n1`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\n1024x1024`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="quality"\r\n\r\n${quality || "low"}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="output_format"\r\n\r\npng`);

  const textBuf = Buffer.from(parts.join("\r\n") + "\r\n", "utf8");
  const fileHdr = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="room_${Date.now()}_${Math.random().toString(36).slice(2,6)}.jpg"\r\nContent-Type: ${imageMime}\r\n\r\n`,
    "utf8"
  );
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return Buffer.concat([textBuf, fileHdr, imageBuffer, closing]);
}

// ── Main handler ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const body = JSON.parse(event.body);
    const { action } = body;

    const openaiKey = process.env.OPENAI_API_KEY;
    const claudeKey = process.env.ANTHROPIC_API_KEY;

    // ── ACTION: analyze floorplan ──────────────────────────────────────────
    if (action === "analyze-floorplan") {
      if (!claudeKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }) };
      const { imageBase64, mimeType } = body;
      const result = await analyzeFloorplan(imageBase64, mimeType, claudeKey);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // ── ACTION: stage image ────────────────────────────────────────────────
    if (!openaiKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "OPENAI_API_KEY not configured" }) };

    const { imageBase64, mimeType, stagingPrompt, quality } = body;
    if (!imageBase64 || !stagingPrompt) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing imageBase64 or stagingPrompt" }) };

    const imageBuffer = Buffer.from(imageBase64, "base64");
    const imageMime = mimeType || "image/jpeg";
    const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);
    const formData = buildMultipart(boundary, imageBuffer, imageMime, stagingPrompt, quality || "low");

    const result = await httpsRequest({
      hostname: "api.openai.com",
      path: "/v1/images/edits",
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": formData.length,
      }
    }, formData);

    if (result.status !== 200) {
      console.error("OpenAI error:", JSON.stringify(result.body));
      return { statusCode: result.status, headers, body: JSON.stringify({ error: result.body?.error?.message || "OpenAI API error", details: result.body }) };
    }

    const stagedBase64 = result.body?.data?.[0]?.b64_json;
    if (!stagedBase64) {
      console.error("No b64_json in response:", JSON.stringify(result.body).slice(0, 300));
      return { statusCode: 500, headers, body: JSON.stringify({ error: "No image data returned", shape: JSON.stringify(result.body).slice(0, 200) }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ stagedBase64 }) };

  } catch (err) {
    console.error("Function error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
