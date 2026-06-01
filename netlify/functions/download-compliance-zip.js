// download-compliance-zip.js — Netlify Function
// Generates and streams a ZIP file containing all images for a project
// Called from the compliance page "Download All Images" button
//
// Input:  ?projectId=proj_xxx
// Output: ZIP file download containing originals + staged finals + manifest

const { getStore } = require("@netlify/blobs");
const https = require("https");
const archiver = require("archiver");
const { PassThrough } = require("stream");

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
  const images        = project.images || [];

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
    const images = project.images || [];
    const addrSlug = safeFilename(project.address);

    // Build ZIP in memory
    const archive = archiver("zip", { zlib: { level: 6 } });
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

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": zipBuffer.length.toString(),
      },
      body: zipBuffer.toString("base64"),
      isBase64Encoded: true,
    };

  } catch (err) {
    console.error("download-compliance-zip error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
