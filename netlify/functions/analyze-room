const https = require("https");

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
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
    const { imageBase64, mimeType, roomName } = JSON.parse(event.body);
    if (!imageBase64) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing imageBase64" }) };

    const claudeKey = process.env.ANTHROPIC_API_KEY;
    if (!claudeKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }) };

    const prompt = `You are analyzing a real estate listing photo for MLS-compliant virtual staging.
Return ONLY valid JSON — no markdown, no explanation, no preamble.

Analyze this photo of a ${roomName || "room"} and return this exact structure:

{
  "layoutType": "single_zone | open_plan",
  "cameraFacing": "brief description of camera position and direction",
  "focalPoint": "primary visual anchor — fireplace, view, feature wall, island",
  "islandSide": "if island visible: which side faces camera (near/camera-facing) vs away (far/back). null if no island.",
  "preserveList": "comprehensive comma-separated list of every permanent element visible — exact colors and materials for each: cabinetry color/style, countertop material, flooring, fireplace surround, ALL ceiling fixtures by location, windows, appliances, island geometry and base color, tile, hardware, doors, trim. Be specific.",
  "zones": [
    {
      "type": "living | dining | kitchen | bedroom | bathroom | office",
      "anchor": "the fixed architectural element that defines this zone — fireplace, chandelier, island, window wall",
      "priority": 1,
      "density": "light | medium | high",
      "rugShape": "rectangular | oval | none — appropriate rug shape for this zone"
    }
  ],
  "trafficFlow": "brief description of primary circulation path",
  "visualWeighting": {
    "primary": "zone type that should dominate visually",
    "secondary": "supporting zone",
    "background": "zone to keep light/understaged"
  },
  "avoidAreas": ["list specific areas where furniture must NOT go"],
  "lightDirection": "where natural light is coming from",
  "spatialNotes": "any critical spatial context — e.g. island blocks certain placements, low ceiling in one zone"
}

RULES:
- layoutType is "open_plan" ONLY if two or more functional zones share visible connected floor space
- zones array must be ordered by priority (1 = most important visually)
- preserveList must be exhaustive — this feeds directly into the MLS PRESERVE block
- If island is visible always end preserveList with "DO NOT remove or relocate the kitchen island"
- Return ONLY the JSON object — nothing else

ZONE PRIORITY RULES — CRITICAL — ALWAYS FOLLOW:
- If a FIREPLACE is visible: its zone is ALWAYS priority 1, zone type "living", anchor "fireplace"
- If a CHANDELIER is visible and separate from the fireplace: it anchors the dining zone at priority 2, anchor "chandelier"
- Kitchen/island is ALWAYS the lowest priority zone and background in visualWeighting
- rugShape for the living zone (fireplace) is ALWAYS "rectangular rug" — NEVER "none"
- rugShape for the dining zone (chandelier) is ALWAYS "oval rug" — NEVER "none"
- "none" is only valid for kitchen zone rugShape
- primaryZone must be "living" if a fireplace is visible — never "kitchen" or "dining"`;

    const payload = JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mimeType || "image/jpeg", data: imageBase64 }
          },
          { type: "text", text: prompt }
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
      console.error("Claude error:", JSON.stringify(result.body).slice(0, 200));
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Claude analysis failed" }) };
    }

    const text = result.body?.content?.[0]?.text || "{}";
    const clean = text.replace(/```json|```/g, "").trim();

    let analysis;
    try {
      analysis = JSON.parse(clean);
    } catch(e) {
      analysis = { layoutType: "single_zone", spatialNotes: clean, zones: [], avoidAreas: [], preserveList: "" };
    }

    console.log("Room analysis:", analysis.layoutType, "| zones:", analysis.zones?.length, "| focal:", analysis.focalPoint);
    return { statusCode: 200, headers, body: JSON.stringify({ analysis }) };

  } catch (err) {
    console.error("analyze-room error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
