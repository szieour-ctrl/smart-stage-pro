// admin-migrate-demo-project.js — ONE-OFF Netlify Function
//
// Purpose: migrate the Netlify Blobs project record for the demo project
// from the old address/projectId to the new one. This is scoped to a
// SINGLE hardcoded project — it does not scan, list, or touch any other
// project's Blobs keys.
//
// Old:  pid_szregsolo_3027blackpointct_072726
//       addr_<hash of "3027 Blackpoint Ct, Rocklin, CA">
// New:  pid_szregsolo_1515demost_072726
//       addr_<hash of "1515 Demo St, Rocklin, CA">
//
// USAGE:
//   1. Deploy this file via GitHub web UI (netlify/functions/admin-migrate-demo-project.js)
//   2. Hit it once: GET https://<your-site>.netlify.app/.netlify/functions/admin-migrate-demo-project
//   3. Confirm the JSON response shows "migrated": true
//   4. DELETE this file from the repo (one-off script, not meant to stay deployed)

const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");

// ── Hardcoded, exact values for THIS migration only ─────────────────────────
const OLD_PROJECT_ID = "szregsolo_3027blackpointct_072726";
const NEW_PROJECT_ID = "szregsolo_1515demost_072726";
const OLD_ADDRESS    = "3027 Blackpoint Ct, Rocklin, CA";
const NEW_ADDRESS    = "1515 Demo St, Rocklin, CA";
const SITE_URL       = "https://smartstagepro.com";

function addressHash(address) {
  const normalized = address.toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9\s,]/g, "")
    .trim();
  return crypto.createHash("md5").update(normalized).digest("hex").slice(0, 16);
}

function getProjectStore(env) {
  return getStore({
    name: "smart-stage-projects",
    siteID: env.NETLIFY_SITE_ID,
    token: env.NETLIFY_ACCESS_TOKEN,
  });
}

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json" };
  const store = getProjectStore(process.env);

  const oldPidKey  = "pid_" + OLD_PROJECT_ID;
  const oldAddrKey = "addr_" + addressHash(OLD_ADDRESS);
  const newPidKey  = "pid_" + NEW_PROJECT_ID;
  const newAddrKey = "addr_" + addressHash(NEW_ADDRESS);

  try {
    // 1. Read the single old record — source of truth per pidKey
    const raw = await store.get(oldPidKey);
    if (!raw) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ migrated: false, error: "Old project record not found at " + oldPidKey }),
      };
    }

    const project = JSON.parse(raw);

    // 2. Update only the address/projectId/complianceUrl fields — images array
    //    and everything else carried over untouched.
    project.address = NEW_ADDRESS;
    project.projectId = NEW_PROJECT_ID;
    project.complianceUrl = `${SITE_URL}/compliance/${NEW_PROJECT_ID}`;
    project.updatedAt = new Date().toISOString();

    const updated = JSON.stringify(project);

    // 3. Write to the two NEW keys only
    await store.set(newPidKey, updated);
    await store.set(newAddrKey, updated);

    // 4. Confirm both new writes succeeded before deleting anything old
    const verifyPid = await store.get(newPidKey);
    const verifyAddr = await store.get(newAddrKey);
    if (!verifyPid || !verifyAddr) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ migrated: false, error: "New key write could not be verified — old keys left untouched" }),
      };
    }

    // 5. Only now delete the two OLD keys for this same project
    await store.delete(oldPidKey);
    await store.delete(oldAddrKey);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        migrated: true,
        oldPidKey, oldAddrKey,
        newPidKey, newAddrKey,
        imageCount: (project.images || []).length,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ migrated: false, error: err.message }),
    };
  }
};
