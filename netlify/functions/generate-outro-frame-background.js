// generate-outro-frame-background.js — Netlify Background Function
// "Outro End Frame" — Sam's idea, built July 16, 2026: instead of a generic
// branded card (generate-closing-card.js), let the user pick their OWN
// photo (a hero/exterior shot) as the base for the video's closing frame,
// give it a photographic, cinematic treatment via GPT Image, then stamp
// the real address + CTA on top using the SAME guaranteed-accurate SVG
// compositing technique as generate-closing-card.js.
//
// DELIBERATE SPLIT, not a shortcut: GPT Image is genuinely good at
// photographic treatment (lighting, atmosphere, color grade) but is NOT
// asked to render the address or CTA text itself. Even strong text-
// capable image models aren't 100% reliable at exact, specific text —
// for a generic sign that's a minor cosmetic miss; for a real estate
// video's closing frame, a garbled digit in a published address is a
// real problem, not a cosmetic one. So: AI does the photography, sharp/
// SVG does the (guaranteed-correct) words. Same reasoning, same pattern
// Sam and I agreed on for generate-closing-card.js.
//
// Same background+polling architecture as stage-openai-background.js /
// check-openai.js (referenced read-only, never modified — per the
// existing rule on those files) — GPT Image calls can run long enough to
// need this rather than a synchronous function.
//
// Client polls check-outro-frame.js for the result.

const https = require("https");
const sharp = require("sharp");
const { getStore } = require("@netlify/blobs");

// Deliberately says NOTHING about text/words/signage/lettering being
// ADDED — only that the frame must stay clear of it, so GPT Image never
// attempts to render the address/CTA itself. Also asks for real, honest
// negative space in the lower-center third, since that's exactly where
// the SVG overlay will land the text afterward — keeps the two halves of
// this pipeline visually coordinated even though they run independently.
const OUTRO_TREATMENT_PROMPT = `This is the final, closing shot for a real estate video tour — a cinematic "outro" end frame, not a staging edit.

Apply a warm, atmospheric photographic treatment: soft golden-hour or early-evening lighting, a gentle cinematic color grade, and a subtle vignette toward the edges that draws focus toward the center of the frame.

Do NOT add, remove, or alter any physical structures, landscaping, furniture, or objects in the scene — this must remain a faithful, honest representation of the real property. Only the lighting, atmosphere, and color treatment should change.

CRITICAL: do not render any text, words, letters, numbers, or signage of any kind anywhere in the image. The frame must remain completely free of text — that will be added separately afterward. Leave clear, relatively uncluttered visual space in the lower-center third of the frame for that text to sit on later.`;

function escSVG(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function splitAddress(address) {
  const parts = (address || "").split(",");
  const street = (parts[0] || "").trim();
  const cityState = parts.slice(1).join(",").replace(/,?\s*USA\s*$/i, "").trim();
  return { street, cityState };
}

// Text overlay sized relative to the actual output dimensions (GPT Image
// returns different sizes depending on input aspect ratio — 1536x1024,
// 1024x1536, or 1024x1024, per the existing size-detection logic in
// stage-openai-background.js), rather than a fixed pixel size that would
// look wrong on a non-landscape result.
function buildTextOverlaySVG(width, height, address, ctaText) {
  const { street, cityState } = splitAddress(address);
  const cx = width / 2;
  const bandY = height * 0.68;
  const bandH = height * 0.32;

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
        <stop offset="100%" stop-color="#000000" stop-opacity="0.6"/>
      </linearGradient>
    </defs>
    <rect x="0" y="${bandY}" width="${width}" height="${bandH}" fill="url(#scrim)"/>

    <text x="${cx}" y="${bandY + bandH * 0.42}"
      font-family="Georgia, 'Times New Roman', serif" font-size="${Math.round(width * 0.032)}" font-weight="500"
      fill="#f5f0e8" text-anchor="middle">
      ${escSVG(street)}
    </text>

    ${cityState ? `<text x="${cx}" y="${bandY + bandH * 0.60}"
      font-family="Georgia, 'Times New Roman', serif" font-size="${Math.round(width * 0.017)}" font-weight="400"
      fill="#c9beb0" text-anchor="middle">
      ${escSVG(cityState)}
    </text>` : ""}

    <text x="${cx}" y="${bandY + bandH * 0.85}"
      font-family="Georgia, 'Times New Roman', serif" font-size="${Math.round(width * 0.019)}" font-weight="400"
      fill="#b8975a" text-anchor="middle" letter-spacing="0.03em">
      ${escSVG(ctaText || "Schedule Your Private Showing")}
    </text>
  </svg>`;
}

function buildOpenAIMultipart(imageBuffer, imageMime, prompt, quality, size) {
  const boundary = "----OAIBoundary" + Math.random().toString(36).slice(2);
  const parts = [];
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-2`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${prompt}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="n"\r\n\r\n1`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\n${size}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="quality"\r\n\r\n${quality || "medium"}`);
  const textBuf = Buffer.from(parts.join("\r\n") + "\r\n", "utf8");
  const fileHdr = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="outro.png"\r\nContent-Type: ${imageMime}\r\n\r\n`,
    "utf8"
  );
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return { body: Buffer.concat([textBuf, fileHdr, imageBuffer, closing]), boundary };
}

async function callOpenAI(imageBase64, apiKey) {
  const rawBuffer = Buffer.from(imageBase64, "base64");
  const imageBuffer = await sharp(rawBuffer).png().toBuffer();
  const meta = await sharp(rawBuffer).metadata();
  const w = meta.width || 1024;
  const h = meta.height || 1024;
  let outputSize;
  if (Math.abs(w - h) < 100) outputSize = "1024x1024";
  else if (w > h) outputSize = "1536x1024";
  else outputSize = "1024x1536";

  console.log(`Outro frame: image ${Math.round(rawBuffer.length / 1024)}KB → PNG, input=${w}x${h}, output=${outputSize}`);

  const { body, boundary } = buildOpenAIMultipart(imageBuffer, "image/png", OUTRO_TREATMENT_PROMPT, "medium", outputSize);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.openai.com",
      path: "/v1/images/edits",
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      }
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (res.statusCode !== 200) reject(new Error(`OpenAI error ${res.statusCode}: ${JSON.stringify(parsed).slice(0, 300)}`));
          else resolve(parsed);
        } catch (e) { reject(new Error("OpenAI parse error")); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  const openAIKey = process.env.OPENAI_API_KEY;
  const siteID    = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
  const token     = process.env.NETLIFY_ACCESS_TOKEN;
  let jobId;
  try {
    const { jobId: jId, imageBase64, address, ctaText } = JSON.parse(event.body);
    jobId = jId;
    console.log(`Outro frame job ${jobId} starting...`);

    if (!siteID) throw new Error("NETLIFY_SITE_ID not configured");
    if (!token)  throw new Error("NETLIFY_ACCESS_TOKEN not configured");
    if (!openAIKey) throw new Error("OPENAI_API_KEY not configured");
    if (!address) throw new Error("Missing address");

    // Separate store from staging-jobs — this is a distinct feature with
    // its own lifecycle, no reason to share a namespace with the staging
    // pipeline's job records.
    const store = getStore({ name: "outro-frame-jobs", siteID, token });

    await store.setJSON(jobId, { status: "processing", startedAt: Date.now() });

    const result = await callOpenAI(imageBase64, openAIKey);
    const treatedBase64 = result?.data?.[0]?.b64_json;
    if (!treatedBase64) throw new Error("No image data in OpenAI response");
    console.log(`Outro frame job ${jobId}: GPT Image treatment complete, ${Math.round(treatedBase64.length / 1024)}KB`);

    // Composite the guaranteed-accurate address/CTA text on top of the
    // AI-treated photo — this is the step that makes the final image
    // trustworthy regardless of how well GPT Image did visually.
    const treatedBuffer = Buffer.from(treatedBase64, "base64");
    const treatedMeta = await sharp(treatedBuffer).metadata();
    const overlaySvg = buildTextOverlaySVG(treatedMeta.width, treatedMeta.height, address, ctaText);

    const finalBuffer = await sharp(treatedBuffer)
      .composite([{ input: Buffer.from(overlaySvg), top: 0, left: 0 }])
      .png({ compressionLevel: 6 })
      .toBuffer();

    const finalBase64 = finalBuffer.toString("base64");
    console.log(`Outro frame job ${jobId}: text composited, final ${Math.round(finalBase64.length / 1024)}KB`);

    await store.setJSON(jobId, { status: "done", outroFrameBase64: finalBase64 });
    console.log(`Outro frame job ${jobId}: stored in Blobs`);

  } catch (err) {
    console.error(`Outro frame job ${jobId} error:`, err.message);
    try {
      const siteID2 = process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID;
      const token2  = process.env.NETLIFY_ACCESS_TOKEN;
      if (siteID2 && token2 && jobId) {
        const store = getStore({ name: "outro-frame-jobs", siteID: siteID2, token: token2 });
        await store.setJSON(jobId, { status: "error", error: err.message });
      }
    } catch (e2) { /* best-effort error recording */ }
  }
};
