// project-manage.js — Netlify Function
// Handles: project lookup, project creation, image attachment
// Routes via ?action= parameter
//
// action=lookup  — check if project exists for address
// action=create  — create new project for address
// action=add-image — attach a staged image to existing project

const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");

// ── HELPERS ──────────────────────────────────────────────────────────────────

function getProjectStore(env) {
  return getStore({
    name: "smart-stage-projects",
    siteID: env.NETLIFY_SITE_ID,
    token: env.NETLIFY_ACCESS_TOKEN,
  });
}

function addressHash(address) {
  // Normalize address for consistent key generation
  const normalized = address.toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9\s,]/g, "")
    .trim();
  return crypto.createHash("md5").update(normalized).digest("hex").slice(0, 16);
}

function generateProjectId(address) {
  // Format: szreg_[streetaddr]_[MMDDYY]
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const yy = String(now.getFullYear()).slice(2);
  const dateStr = mm + dd + yy;
  const addrSlug = (address || "")
    .toLowerCase()
    .replace(/,.*$/, "")           // remove city/state
    .replace(/[^a-z0-9]+/g, "")   // remove spaces and special chars
    .slice(0, 20);
  return "szreg_" + addrSlug + "_" + dateStr;
}

function complianceUrl(projectId, siteUrl) {
  const base = siteUrl || "https://smart-stage-pro.netlify.app";
  return `${base}/compliance/${projectId}`;
}

// ── LOOKUP ───────────────────────────────────────────────────────────────────

async function lookupProject(address, env) {
  const store = getProjectStore(env);
  const key = "addr_" + addressHash(address);

  try {
    const raw = await store.get(key);
    if (!raw) return { exists: false };
    const project = JSON.parse(raw);
    return {
      exists: true,
      projectId: project.projectId,
      address: project.address,
      imageCount: (project.images || []).length,
      complianceUrl: project.complianceUrl,
      qrCodeTarget: project.complianceUrl,
      createdAt: project.createdAt,
      status: project.status,
    };
  } catch (err) {
    console.error("lookup error:", err.message);
    return { exists: false };
  }
}

// ── CREATE ───────────────────────────────────────────────────────────────────

async function createProject(address, agentInfo, siteUrl, env) {
  const store = getProjectStore(env);
  const addrKey = "addr_" + addressHash(address);

  // Double-check not already created (race condition guard)
  const existing = await store.get(addrKey);
  if (existing) {
    const proj = JSON.parse(existing);
    return { created: false, existing: true, projectId: proj.projectId, complianceUrl: proj.complianceUrl };
  }

  const projectId = generateProjectId(address);
  const cUrl = complianceUrl(projectId, siteUrl);

  const project = {
    projectId,
    address,
    complianceUrl: cUrl,
    agentName: agentInfo.agentName || env.AGENT_NAME || "",
    agentBrokerage: agentInfo.agentBrokerage || env.AGENT_BROKERAGE || "",
    agentDRE: agentInfo.agentDRE || env.AGENT_DRE || "",
    agentLogoUrl: agentInfo.agentLogoUrl || env.AGENT_LOGO_URL || "",
    createdAt: new Date().toISOString(),
    status: "active",
    images: [],
  };

  // Store by address hash (lookup key) and by projectId (compliance page key)
  await store.set(addrKey, JSON.stringify(project));
  await store.set("pid_" + projectId, JSON.stringify(project));

  console.log("Project created:", projectId, "for address:", address);
  return { created: true, projectId, complianceUrl: cUrl };
}

// ── ADD IMAGE ─────────────────────────────────────────────────────────────────

async function addImage(projectId, imageData, env) {
  const store = getProjectStore(env);
  const pidKey = "pid_" + projectId;

  const raw = await store.get(pidKey);
  if (!raw) throw new Error("Project not found: " + projectId);

  const project = JSON.parse(raw);
  const addrKey = "addr_" + addressHash(project.address);

  const imageEntry = {
    imageId: "img_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 5),
    roomName: imageData.roomName || "Room",
    tier: imageData.tier || "final",
    originalUrl: imageData.originalUrl || null,     // Cloudinary URL of original
    stagedUrl: imageData.stagedUrl || null,          // Cloudinary URL of staged Final
    sbsUrl: imageData.sbsUrl || null,                // Cloudinary URL of SBS
    stagedAt: new Date().toISOString(),
    fileName: imageData.fileName || "",
  };

  project.images = project.images || [];
  project.images.push(imageEntry);
  project.updatedAt = new Date().toISOString();

  // Update both keys atomically
  const updated = JSON.stringify(project);
  await store.set(pidKey, updated);
  await store.set(addrKey, updated);

  console.log("Image added to project:", projectId, "room:", imageEntry.roomName);
  return { added: true, imageId: imageEntry.imageId, imageCount: project.images.length };
}

// ── HANDLER ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const action = event.queryStringParameters?.action;

  try {
    const body = JSON.parse(event.body || "{}");

    if (action === "lookup") {
      const { address } = body;
      if (!address) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing address" }) };
      const result = await lookupProject(address, process.env);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    if (action === "create") {
      const { address, agentInfo, siteUrl } = body;
      if (!address) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing address" }) };
      const result = await createProject(address, agentInfo || {}, siteUrl, process.env);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    if (action === "add-image") {
      const { projectId, imageData } = body;
      if (!projectId) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing projectId" }) };
      const result = await addImage(projectId, imageData || {}, process.env);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown action: " + action }) };

  } catch (err) {
    console.error("project-manage error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
