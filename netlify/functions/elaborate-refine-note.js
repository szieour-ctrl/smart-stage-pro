// elaborate-refine-note.js — "Elaborate with AI" for the Refine lightbox's
// free-revision textarea. Sam's request: replicate what Chrome's native
// "Help me write" was doing on that field (only appears sometimes, isn't
// controlled by this app's code at all) as an actual, owned feature —
// expanding a short revision note into a fuller, specific prompt that pulls
// in this project's real design DNA (style, palette), same round-trip shown
// in the reference screenshots ("add 3 stools" -> full RH Luxury-styled
// paragraph).
//
// Native https.request() only — no SDK — matching this file's established
// pattern (see analyze-room.js).
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
    const { note, roomName, designStyle, colorPalette, furnishingsDNA } = JSON.parse(event.body);
    if (!note || !note.trim()) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing note" }) };
    }

    const claudeKey = process.env.ANTHROPIC_API_KEY;
    if (!claudeKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }) };

    const prompt = `You are helping a real estate agent expand a short virtual-staging revision note into a fuller, specific instruction for an AI staging engine.

Room: ${roomName || "this room"}
Design style: ${designStyle || "Organic Modern"}
Color palette: ${colorPalette || "Warm Neutrals"}
${furnishingsDNA ? `Overall furnishings DNA already established for this project: ${furnishingsDNA}` : ""}

The agent's short note: "${note.trim()}"

Expand this into a clear, specific revision instruction the staging engine can act on directly. Rules:
- Stay strictly within what the agent actually asked for — do not invent additional changes they didn't request.
- Reference the design style and color palette naturally, so the revision stays visually consistent with the rest of the space, the way a stylist would phrase it — not as a checklist.
- Keep it tight — 2-4 sentences, not a full paragraph of filler.
- Write it as an instruction ("Please replace... add... maintain...") not a description of the room as it currently is.
- Return ONLY the expanded instruction text — no markdown, no preamble, no quotation marks around it.`;

    const payload = JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
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
      console.error("elaborate-refine-note Claude error:", JSON.stringify(result.body).slice(0, 200));
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Elaborate failed — try again or edit your note directly." }) };
    }

    const elaborated = (result.body?.content?.[0]?.text || "").trim();
    if (!elaborated) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Elaborate returned nothing — your original note is unchanged." }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ elaborated }) };

  } catch (err) {
    console.error("elaborate-refine-note error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
