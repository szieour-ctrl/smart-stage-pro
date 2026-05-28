const https = require("https");

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

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const { stagedBase64, mimeType } = JSON.parse(event.body);
    if (!stagedBase64) return { statusCode: 400, headers, body: JSON.stringify({ error: "stagedBase64 required" }) };

    const claudeKey = process.env.ANTHROPIC_API_KEY;
    if (!claudeKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }) };

    const systemPrompt = `You are a professional interior design analyst extracting design specifications from a virtually staged room photo.
Return ONLY valid JSON — no explanation, no markdown, no preamble. The JSON must be parseable by JSON.parse() with no cleanup required.`;

    const userPrompt = `Analyze this virtually staged open plan living space and extract two types of DNA:

1. DESIGN DNA — aesthetic continuity data for all other rooms in the same home
2. SPATIAL DNA — zone orchestration data for internal use only (never sent to Decor8 directly)

Return a single JSON object with exactly these fields:

{
  "overallStyle": "One phrase: e.g. Organic Modern, Transitional Coastal, RH Luxury",
  "sofa": "fabric type, color, profile, leg style",
  "diningTable": "material, finish, shape",
  "diningChairs": "material, color, style",
  "barStools": "seat material, frame material, style — or null if not visible",
  "areaRug": "texture, color, pattern",
  "coffeeTable": "material, shape, finish",
  "accentChairs": "fabric, color, style — or null if not visible",
  "woodTones": "dominant wood tone across all furniture",
  "metalFinishes": "dominant metal finish",
  "colorPalette": ["primary color", "secondary color", "accent color"],
  "artStyle": "wall art style and colors if visible",
  "stagingDensity": "light | moderate | full",
  "continuityPrompt": "2-3 sentences describing the established aesthetic for other rooms to match. Reference specific materials, palette, style. Do NOT repeat furniture that belongs only in this room.",
  "spatialDNA": {
    "layoutType": "open_plan",
    "primaryZone": "living | dining | kitchen",
    "secondaryZone": "living | dining | kitchen",
    "tertiaryZone": "living | dining | kitchen | null",
    "zoneRelationships": [
      {
        "zone": "living",
        "anchor": "fireplace",
        "boundary": "rectangular rug",
        "density": "high"
      },
      {
        "zone": "dining",
        "anchor": "chandelier",
        "boundary": "oval rug",
        "density": "medium"
      }
    ],
    "trafficFlow": "open_central | perimeter | diagonal"
  }
}

IMPORTANT: spatialDNA is for internal orchestration only — it will never be sent to Decor8.
Design DNA fields (overallStyle through continuityPrompt) are injected into staging prompts for other rooms.`;

    const payload = JSON.stringify({
      model: "claude-opus-4-5",
      max_tokens: 1200,
      system: systemPrompt,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mimeType || "image/jpeg", data: stagedBase64 }
          },
          { type: "text", text: userPrompt }
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

    if (result.status !== 200) {
      console.error("Claude DNA extraction error:", JSON.stringify(result.body).slice(0, 300));
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Claude DNA extraction failed" }) };
    }

    const raw = result.body?.content?.[0]?.text?.trim();
    if (!raw) return { statusCode: 500, headers, body: JSON.stringify({ error: "No response from Claude" }) };

    const clean = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();

    let dna;
    try {
      dna = JSON.parse(clean);
    } catch (e) {
      console.error("DNA JSON parse failed:", clean.slice(0, 300));
      return { statusCode: 500, headers, body: JSON.stringify({ error: "DNA parse failed — invalid JSON returned" }) };
    }

    const required = ["overallStyle", "woodTones", "metalFinishes", "colorPalette", "continuityPrompt"];
    const missing = required.filter(k => !dna[k]);
    if (missing.length) console.warn("DNA missing fields:", missing);

    if (typeof dna.colorPalette === "string") {
      dna.colorPalette = dna.colorPalette.split(",").map(s => s.trim());
    }

    console.log("DNA extracted:", dna.overallStyle, "| wood:", dna.woodTones, "| spatial zones:", dna.spatialDNA?.zoneRelationships?.length);
    return { statusCode: 200, headers, body: JSON.stringify({ dna }) };

  } catch (err) {
    console.error("extract-staging-dna error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
