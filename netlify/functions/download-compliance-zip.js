// download-compliance-zip.js — Netlify Function
// Generates a ZIP file containing all images for a project, uploads it to
// S3, and redirects the browser to a short-lived presigned URL.
// Called from the compliance page "Download All Images" button
//
// Input:  ?projectId=proj_xxx
// Output: 302 redirect to a presigned S3 URL for the ZIP
//
// FIX (Sep 2026): Netlify Functions (AWS Lambda under the hood) have a
// hard 6MB response-body ceiling. This used to build the ZIP and return
// it directly in the function's HTTP response — any project with enough
// full-res images blew past that ceiling and the download silently did
// nothing (a plain <a> tap has no error surface to show a failure in).
// Same root cause and same fix shape as compliance-page.js's video
// delivery: build/store the large artifact server-side, then hand the
// browser a redirect to a presigned URL instead of the bytes themselves.

const { getStore } = require("@netlify/blobs");
const https = require("https");
// archiver v8 (current "latest") is ESM-only and exports classes
// ({ ZipArchive, … }) instead of the old archiver("zip", opts) factory —
// requiring it the old way gives "archiver is not a function". This works
// with v5/v6/v7 (factory) and v8 (class), whichever the repo resolves to.
const archiverMod = require("archiver");
function createZipArchive(opts) {
  if (typeof archiverMod === "function") return archiverMod("zip", opts);
  if (typeof archiverMod.default === "function") return archiverMod.default("zip", opts);
  const Zip = archiverMod.ZipArchive || archiverMod.default?.ZipArchive;
  if (Zip) return new Zip(opts);
  throw new Error("Unsupported archiver module shape: " + Object.keys(archiverMod).join(","));
}
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const s3 = new S3Client({
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

function supabaseGet(table, queryParams = "") {
  return new Promise((resolve, reject) => {
    const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/${table}${queryParams}`);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search, method: "GET",
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data || "[]") }); }
        catch { resolve({ status: res.statusCode, data: [] }); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ── 30-day post-cancellation window (ToS §6, Sep 22, 2026) ────────────────
// A compliance page stays live while its owner's subscription is active and
// for 30 days after the paid period ends (users.data_expires_at, stamped by
// stripe-webhook.js). After that the page is taken offline with a 410 notice
// — the underlying records are NOT deleted (3-year private retention), and a
// resubscribe clears data_expires_at, which brings the page straight back.
// Fails OPEN: if the owner lookup errors or the listing/user can't be found,
// the page renders normally. Only a positively confirmed expired
// cancellation takes a page down.
async function isComplianceWindowClosed(projectId) {
  try {
    const l = await supabaseGet("listings", `?project_id=eq.${encodeURIComponent(projectId)}&select=user_id&limit=1`);
    const ownerId = l.data?.[0]?.user_id;
    if (!ownerId) return false;
    const u = await supabaseGet("users", `?id=eq.${ownerId}&select=subscription_status,data_expires_at`);
    const owner = u.data?.[0];
    if (!owner || owner.subscription_status !== "cancelled" || !owner.data_expires_at) return false;
    return new Date(owner.data_expires_at).getTime() < Date.now();
  } catch (e) {
    console.warn("compliance window check failed (failing open):", e.message);
    return false;
  }
}

function getProjectStore() {
  return getStore({
    name: "smart-stage-projects",
    siteID: process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_ACCESS_TOKEN,
  });
}

function fetchImageBuffer(url) {
  return new Promise((resolve, reject) => {
    const follow = (u, hops) => {
      if (hops > 5) { reject(new Error("Too many redirects")); return; }
      https.get(u, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          follow(res.headers.location, hops + 1);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} fetching image`));
          return;
        }
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      }).on("error", reject);
    };
    follow(url, 0);
  });
}

function safeFilename(str) {
  return (str || "room").replace(/[^a-z0-9\-_\.]/gi, "_").slice(0, 50);
}

function generateManifest(project, projectId) {
  const agentName     = project.agentName     || process.env.AGENT_NAME     || "";
  const agentBrokerage= project.agentBrokerage|| process.env.AGENT_BROKERAGE|| "";
  const agentDRE      = project.agentDRE      || process.env.AGENT_DRE      || "";
  // Same filter as the handler below — a hidden image must not appear in
  // the manifest listing either, even though its files are already excluded
  // from the zip itself.
  const images        = (project.images || []).filter(img => !img.hidden);

  const lines = [
    "SMART STAGE PRO™ — COMPLIANCE ARCHIVE",
    "======================================",
    "",
    `Property Address: ${project.address}`,
    `Project ID:       ${projectId}`,
    `Compliance URL:   ${project.complianceUrl}`,
    `Agent:            ${agentName}`,
    agentBrokerage ? `Brokerage:        ${agentBrokerage}` : "",
    agentDRE       ? `DRE License:      ${agentDRE}` : "",
    `Project Created:  ${project.createdAt}`,
    `Archive Date:     ${new Date().toISOString()}`,
    "",
    "CALIFORNIA AB 723 §10140.8 COMPLIANCE",
    "--------------------------------------",
    "All virtually staged images in this archive were digitally altered through",
    "the use of artificial intelligence to add virtual furniture and décor.",
    "No structural elements or architectural features were added or removed.",
    "Original unaltered images are included in this archive alongside each",
    "staged version. This archive satisfies California DRE record retention",
    "requirements for a minimum of 3 years.",
    "",
    "IMAGE MANIFEST",
    "--------------",
    ...images.map((img, i) => [
      `Set ${i + 1}: ${img.roomName || "Room"}`,
      `  Staged:   ${new Date(img.stagedAt).toLocaleDateString()}`,
      `  Original: ${img.originalUrl || "not stored"}`,
      `  Staged:   ${img.stagedUrl || "not stored"}`,
      `  SBS:      ${img.sbsUrl || "not stored"}`,
      "",
    ].join("\n")),
    "Smart Stage PRO™ is powered by Smart Stage AI™",
    "© Smart Stage AI™ — All rights reserved",
  ].filter(l => l !== undefined).join("\n");

  return lines;
}

exports.handler = async (event) => {
  const projectId = event.queryStringParameters?.projectId;

  if (!projectId) {
    return { statusCode: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Missing projectId" }) };
  }

  try {
    const store = getProjectStore();
    const raw = await store.get("pid_" + projectId);
    if (!raw) return { statusCode: 404, body: "Project not found" };

    const project = JSON.parse(raw);

    // Same 30-day rule as the compliance page itself — once the page is
    // offline, its public ZIP download goes with it.
    if (await isComplianceWindowClosed(projectId)) {
      return { statusCode: 410, headers: { "Content-Type": "text/plain" }, body: "This compliance record is no longer publicly available." };
    }
    // Soft-hidden images (see hide-image.js) must never leak through this
    // path either — the compliance page hides them, but this ZIP endpoint
    // iterated project.images directly and had no hidden check at all.
    // Same filter, same rule: nothing hidden reaches an unauthenticated
    // requester through ANY route.
    const images = (project.images || []).filter(img => !img.hidden);
    const addrSlug = safeFilename(project.address);

    // Build ZIP in memory
    const archive = createZipArchive({ zlib: { level: 6 } });
    const chunks = [];

    archive.on("data", chunk => chunks.push(chunk));

    // Add manifest
    archive.append(generateManifest(project, projectId), { name: "MANIFEST.txt" });

    // Add each image pair
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const roomSlug = safeFilename(img.roomName || `room_${i + 1}`);
      const setPrefix = `image_set_${String(i + 1).padStart(2, "0")}_${roomSlug}`;

      if (img.originalUrl) {
        try {
          const buf = await fetchImageBuffer(img.originalUrl);
          archive.append(buf, { name: `${setPrefix}/ORIGINAL_${roomSlug}.jpg` });
        } catch (e) { console.warn("Could not fetch original:", e.message); }
      }

      if (img.stagedUrl) {
        try {
          const buf = await fetchImageBuffer(img.stagedUrl);
          archive.append(buf, { name: `${setPrefix}/STAGED_FINAL_${roomSlug}.jpg` });
        } catch (e) { console.warn("Could not fetch staged:", e.message); }
      }

      if (img.sbsUrl) {
        try {
          const buf = await fetchImageBuffer(img.sbsUrl);
          archive.append(buf, { name: `${setPrefix}/SIDE_BY_SIDE_${roomSlug}.jpg` });
        } catch (e) { console.warn("Could not fetch sbs:", e.message); }
      }
    }

    await archive.finalize();

    const zipBuffer = Buffer.concat(chunks);
    const filename = `SmartStagePRO_Compliance_${addrSlug}_${projectId}.zip`;

    // FIX: upload to S3 instead of returning the bytes in the response.
    // Lives under smart-stage-scratch/ so it rides the existing 1-2 day
    // lifecycle-expiry rule on that prefix rather than needing a new one —
    // this is a disposable, regeneratable artifact, not a permanent asset.
    const s3Key = `smart-stage-scratch/compliance-zips/${projectId}-${Date.now()}.zip`;

    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: s3Key,
      Body: zipBuffer,
      ContentType: "application/zip",
      ContentDisposition: `attachment; filename="${filename}"`,
    }));

    const downloadUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: s3Key }),
      { expiresIn: 60 * 10 } // 10 minutes — plenty for an immediate redirect+download
    );

    return {
      statusCode: 302,
      headers: { Location: downloadUrl },
      body: "",
    };

  } catch (err) {
    console.error("download-compliance-zip error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
