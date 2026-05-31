const https = require("https");

// ── HTTPS helper ──────────────────────────────────────────────────────────────
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

// ── Claude vision: analyze floorplan ─────────────────────────────────────────
async function analyzeFloorplan(base64, mimeType, claudeKey) {
  const payload = JSON.stringify({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mimeType || "image/jpeg", data: base64 } },
        { type: "text", text: `Analyze this 2D real estate floor plan. Return ONLY valid JSON, no markdown.
Identify every room. For each provide:
- name: common real estate name (e.g. "Great Room", "Kitchen", "Primary Suite")
- id: slug (e.g. "great-room")
- floor: 1 or 2 (or null)
- adjacentTo: array of room ids sharing a wall or open sightline
Return: {"rooms": [{"id":"...","name":"...","floor":1,"adjacentTo":["..."]}]}` }
      ]
    }]
  });
  const result = await httpsRequest({
    hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
    headers: { "x-api-key": claudeKey, "anthropic-version": "2023-06-01",
      "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
  }, payload);
  if (result.status !== 200) throw new Error("Claude error: " + JSON.stringify(result.body).slice(0, 200));
  const text = result.body?.content?.[0]?.text || "{}";
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

// ── Build multipart for OpenAI ─────────────────────────────────────────────────
function buildMultipart(boundary, imageBuffer, imageMime, prompt, quality) {
  const parts = [];
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-2`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${prompt}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="n"\r\n\r\n1`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\n1024x1024`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="quality"\r\n\r\n${quality || "high"}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="output_format"\r\n\r\npng`);
  const textBuf = Buffer.from(parts.join("\r\n") + "\r\n", "utf8");
  const fileHdr = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="room.jpg"\r\nContent-Type: ${imageMime}\r\n\r\n`, "utf8"
  );
  return Buffer.concat([textBuf, fileHdr, imageBuffer, Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")]);
}

// ── Poll OpenAI generation (async pattern) ────────────────────────────────────
// gpt-image-1 /edits is synchronous — but we wrap it so the Netlify fn
// returns quickly and the client polls a lightweight status endpoint.
// Since /edits has no native async, we run it synchronously but with a
// generous server-side timeout and rely on the client retry for resilience.

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

    // ── Floorplan analysis ──
    if (action === "analyze-floorplan") {
      if (!claudeKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }) };
      const result = await analyzeFloorplan(body.imageBase64, body.mimeType, claudeKey);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // ── Stage image ──
    if (!openaiKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "OPENAI_API_KEY not configured" }) };
    const { imageBase64, mimeType, stagingPrompt, quality } = body;
    if (!imageBase64 || !stagingPrompt) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing required fields" }) };
    }

    // Compress large images before sending to reduce payload and processing time
    const imageBuffer = Buffer.from(imageBase64, "base64");
    const imageMime = mimeType || "image/jpeg";
    const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);
    const formData = buildMultipart(boundary, imageBuffer, imageMime, stagingPrompt, quality || "high");

    console.log(`Staging: quality=${quality||'high'} imageSize=${Math.round(imageBuffer.length/1024)}KB`);

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
      console.error("OpenAI error:", JSON.stringify(result.body).slice(0,300));
      // Check for specific retryable errors
      const errMsg = result.body?.error?.message || "OpenAI API error";
      const isOverload = result.status === 429 || result.status === 503 || errMsg.includes("overloaded");
      return {
        statusCode: result.status,
        headers,
        body: JSON.stringify({
          error: errMsg,
          retryable: isOverload,
          details: result.body
        })
      };
    }

    const stagedBase64 = result.body?.data?.[0]?.b64_json;
    if (!stagedBase64) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "No image data returned" }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ stagedBase64 }) };

  } catch (err) {
    console.error("Function error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
