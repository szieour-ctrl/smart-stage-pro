// stage-openai-background.js — Netlify Background Function
// Calls GPT Image 2, stores result in Netlify Blobs via SDK
// Client polls check-openai.js every 3 seconds for result

const https = require("https");
const { getStore } = require("@netlify/blobs");

function buildOpenAIMultipart(imageBuffer, imageMime, prompt) {
  const boundary = "----OAIBoundary" + Math.random().toString(36).slice(2);
  const parts = [];
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-2`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${prompt}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="n"\r\n\r\n1`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\n1024x1024`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="quality"\r\n\r\nhigh`);
  const textBuf = Buffer.from(parts.join("\r\n") + "\r\n", "utf8");
  const fileHdr = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="room.jpg"\r\nContent-Type: ${imageMime}\r\n\r\n`,
    "utf8"
  );
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return { body: Buffer.concat([textBuf, fileHdr, imageBuffer, closing]), boundary };
}

async function callOpenAI(imageBase64, mimeType, prompt, apiKey) {
  const imageBuffer = Buffer.from(imageBase64, "base64");
  const { body, boundary } = buildOpenAIMultipart(imageBuffer, mimeType || "image/jpeg", prompt);
  console.log(`OpenAI: prompt ${prompt.length} chars, image ${Math.round(imageBuffer.length/1024)}KB`);
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
          if (res.statusCode !== 200) reject(new Error(`OpenAI error ${res.statusCode}: ${JSON.stringify(parsed).slice(0,300)}`));
          else resolve(parsed);
        } catch(e) { reject(new Error("OpenAI parse error")); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  const openAIKey = process.env.OPENAI_API_KEY;
  const siteID    = process.env.NETLIFY_SITE_ID;
  const token     = process.env.NETLIFY_ACCESS_TOKEN;
  let jobId;
  try {
    const { jobId: jId, imageBase64, mimeType, stagingPrompt } = JSON.parse(event.body);
    jobId = jId;
    console.log(`Job ${jobId} starting...`);

    const store = getStore({ name: "staging-jobs", siteID, token });

    // Call GPT Image 2
    const result = await callOpenAI(imageBase64, mimeType, stagingPrompt, openAIKey);
    const stagedBase64 = result?.data?.[0]?.b64_json;
    if (!stagedBase64) throw new Error("No image data in OpenAI response");
    console.log(`Job ${jobId}: complete ${Math.round(stagedBase64.length/1024)}KB`);

    // Store result via SDK — no presigned URL expiry issues
    await store.setJSON(jobId, { status: "done", stagedBase64 });
    console.log(`Job ${jobId}: stored in Blobs`);

  } catch (err) {
    console.error(`Job ${jobId} error:`, err.message);
    try {
      const store = getStore({ name: "staging-jobs", siteID, token });
      await store.setJSON(jobId, { status: "error", error: err.message });
    } catch(e) {}
  }
};
