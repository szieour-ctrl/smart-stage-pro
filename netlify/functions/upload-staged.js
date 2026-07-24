// upload-staged.js — Netlify Function
// Issues a signed Cloudinary upload signature for a staged Final image.
// Called after generateFinal completes, before project-manage add-image.
//
// ARCHITECTURE CHANGE (this session — real production failure, not a
// hypothesis): this function used to receive the full image (imageBase64)
// and upload it to Cloudinary itself. That put the image through TWO
// Lambda payload hops — browser → this function (JSON body), then this
// function → Cloudinary (multipart body) — and a prior fix only addressed
// the second hop. The actual failure was the FIRST hop: a large final
// image in the incoming request body can exceed the platform's payload
// ceiling before this function's own code ever runs at all — confirmed by
// a real invocation ID from a genuine failure that produced zero matching
// log output anywhere, consistent with a gateway-level rejection prior to
// Lambda invocation, not a caught or uncaught error inside our code.
//
// Fix: the image never passes through this function, or any of our own
// infrastructure, at all. This function only signs a short-lived Cloudinary
// upload request; the browser uploads the actual image bytes DIRECTLY to
// Cloudinary's own endpoint (which accepts far larger payloads than our
// Lambda ever will). This is Cloudinary's own documented pattern for
// exactly this situation, not a workaround specific to this codebase.
//
// Input:  { projectId, roomName, tier }  — NO image data
// Output: { cloudName, apiKey, timestamp, signature, folder }

const crypto = require("crypto");

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: "Method Not Allowed" };

  try {
    const { projectId } = JSON.parse(event.body || "{}");

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey    = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName) return { statusCode: 500, headers, body: JSON.stringify({ error: "CLOUDINARY_CLOUD_NAME not configured" }) };
    if (!apiKey || !apiSecret) return { statusCode: 500, headers, body: JSON.stringify({ error: "CLOUDINARY_API_KEY/SECRET not configured — signed upload requires both" }) };

    const folder    = projectId ? `smart-stage-finals/${projectId}` : "smart-stage-finals";
    const timestamp = Math.floor(Date.now() / 1000).toString();

    // Signature covers exactly the non-file params the browser will send,
    // alphabetical order, same rule as Cloudinary always requires.
    const paramsToSign = `folder=${folder}&timestamp=${timestamp}`;
    const signature = crypto.createHash("sha1").update(paramsToSign + apiSecret).digest("hex");

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ cloudName, apiKey, timestamp, signature, folder }),
    };
  } catch (err) {
    console.error("upload-staged (signature) error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
