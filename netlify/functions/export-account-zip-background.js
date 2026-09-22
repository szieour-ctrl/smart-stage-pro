// export-account-zip-background.js — Netlify BACKGROUND Function
// Smart Stage PRO™  |  "Download all my listing images" account export
//
// Called from the Billing modal and the account-closed screen (index.html,
// startAccountExport). Because the file name ends in "-background", Netlify
// answers the browser with 202 immediately and keeps this running for up to
// 15 minutes. Progress/result is written to a private Netlify Blobs record
// that export-account-status.js reads for the browser's polling.
//
// Scope (decided Sep 22, 2026): REAL LISTINGS ONLY — never prospecting.
// Source of truth for images is the same Blobs project record the compliance
// page and download-compliance-zip.js use (pid_<project_id>), because the
// media_assets catalog only covers listings created after the naming
// migration and staged_images still holds legacy Cloudinary URLs.
// Soft-hidden images are excluded, same rule as the compliance page.
//
// Access: any signed-in user, EXCEPT a cancelled account whose 30-day window
// (users.data_expires_at, ToS §6) has passed.
//
// Memory: a whole account can be well over 1GB of full-res photos, so the
// ZIP is never held in memory. archiver streams into an S3 multipart upload
// (8MB parts), one image at a time. Photos are stored uncompressed in the
// ZIP (JPEGs don't shrink further), which keeps it fast.
//
// Output: smart-stage-scratch/account-exports/<userId>/<jobId>.zip — rides
// the existing 1–2 day lifecycle expiry on smart-stage-scratch/, same as the
// per-listing compliance ZIPs. The user can rebuild any time.

const https    = require("https");
const archiver = require("archiver");
const { getStore } = require("@netlify/blobs");
const {
  S3Client, CreateMultipartUploadCommand, UploadPartCommand,
  CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
} = require("@aws-sdk/client-s3");

const s3 = new S3Client({
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});
const BUCKET = process.env.S3_BUCKET_NAME;
const PART_SIZE = 8 * 1024 * 1024; // S3 multipart minimum is 5MB (except last part)

// ── Stores ────────────────────────────────────────────────
function getProjectStore() {
  return getStore({
    name: "smart-stage-projects",
    siteID: process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_ACCESS_TOKEN,
  });
}
function getExportStore() {
  return getStore({
    name: "smart-stage-account-exports",
    siteID: process.env.SZREG_SITE_ID || process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_ACCESS_TOKEN,
    consistency: "strong",
  });
}

// ── Supabase helpers (native https) ───────────────────────
function verifyJWT(authHeader) {
  return new Promise((resolve) => {
    if (!authHeader || !authHeader.startsWith("Bearer ")) { resolve(null); return; }
    const jwt = authHeader.split(" ")[1];
    const url = new URL(`${process.env.SUPABASE_URL}/auth/v1/user`);
    const req = https.request({
      hostname: url.hostname, path: url.pathname, method: "GET",
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${jwt}` },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { const p = JSON.parse(data); resolve(res.statusCode === 200 && p.id ? p : null); }
        catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

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

// ── Image fetch (same behavior as download-compliance-zip.js) ──
function fetchImageBuffer(url) {
  return new Promise((resolve, reject) => {
    const follow = (u, hops) => {
      if (hops > 5) { reject(new Error("Too many redirects")); return; }
      const req = https.get(u, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          follow(new URL(res.headers.location, u).toString(), hops + 1);
          return;
        }
        if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      });
      req.setTimeout(60000, () => req.destroy(new Error("Image fetch timed out")));
      req.on("error", reject);
    };
    follow(url, 0);
  });
}

function safeName(str, max = 50) {
  return (str || "item").replace(/[^a-z0-9\-_]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, max) || "item";
}
function extFromUrl(url) {
  try {
    const m = new URL(url).pathname.toLowerCase().match(/\.(jpe?g|png|webp)$/);
    return m ? (m[1] === "jpeg" ? "jpg" : m[1]) : "jpg";
  } catch { return "jpg"; }
}

// ── Streaming ZIP → S3 multipart ─────────────────────────
async function buildZipToS3({ key, filename, produce }) {
  const { UploadId } = await s3.send(new CreateMultipartUploadCommand({
    Bucket: BUCKET, Key: key,
    ContentType: "application/zip",
    ContentDisposition: `attachment; filename="${filename}"`,
  }));

  const archive = archiver("zip", { store: true });
  const parts = [];
  let partNumber = 1;
  let pending = [];
  let pendingLen = 0;

  const flush = async () => {
    const body = Buffer.concat(pending);
    pending = []; pendingLen = 0;
    const r = await s3.send(new UploadPartCommand({ Bucket: BUCKET, Key: key, UploadId, PartNumber: partNumber, Body: body }));
    parts.push({ ETag: r.ETag, PartNumber: partNumber });
    partNumber++;
  };

  // Consumer: pulls ZIP bytes as they're produced (async iteration applies
  // backpressure, so archiver never runs ahead of the uploads).
  const consumer = (async () => {
    for await (const chunk of archive) {
      pending.push(chunk);
      pendingLen += chunk.length;
      if (pendingLen >= PART_SIZE) await flush();
    }
    if (pendingLen > 0 || parts.length === 0) await flush();
  })();
  const consumerEndedEarly = consumer.then(() => { throw new Error("ZIP stream ended unexpectedly"); });
  consumerEndedEarly.catch(() => {}); // observed via race below

  // Append one entry and wait until archiver has fully written it, so only
  // one image is ever held in memory at a time.
  const addEntry = (data, name) => Promise.race([
    new Promise((resolve, reject) => {
      const onEntry = (e) => { if (e.name === name) { cleanup(); resolve(); } };
      const onErr = (err) => { cleanup(); reject(err); };
      const cleanup = () => { archive.off("entry", onEntry); archive.off("error", onErr); };
      archive.on("entry", onEntry);
      archive.on("error", onErr);
      archive.append(data, { name });
    }),
    consumerEndedEarly,
  ]);

  try {
    await produce(addEntry);
    await archive.finalize();
    await consumer;
    await s3.send(new CompleteMultipartUploadCommand({
      Bucket: BUCKET, Key: key, UploadId, MultipartUpload: { Parts: parts },
    }));
  } catch (err) {
    try { archive.abort(); } catch {}
    await s3.send(new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: key, UploadId })).catch(() => {});
    throw err;
  }
}

// ── Handler ───────────────────────────────────────────────
exports.handler = async (event) => {
  const authUser = await verifyJWT(event.headers.authorization || event.headers.Authorization);
  if (!authUser) { console.log("export-account-zip: unauthorized"); return; }
  const userId = authUser.id;

  let jobId = "";
  try { jobId = String(JSON.parse(event.body || "{}").jobId || ""); } catch {}
  if (!/^[A-Za-z0-9-]{8,64}$/.test(jobId)) { console.log("export-account-zip: bad jobId"); return; }

  const exportStore = getExportStore();
  const statusKey = `user_${userId}`;
  const writeStatus = (obj) =>
    exportStore.set(statusKey, JSON.stringify({ jobId, updatedAt: new Date().toISOString(), ...obj }))
      .catch((e) => console.warn("export-account-zip: status write failed:", e.message));

  await writeStatus({ status: "building", progress: { done: 0, total: 0 } });

  try {
    // 1. Access window
    const u = await supabaseGet("users", `?id=eq.${userId}&select=subscription_status,data_expires_at`);
    const rec = u.data?.[0];
    if (!rec) throw new Error("User record not found");
    if (rec.subscription_status === "cancelled" &&
        (!rec.data_expires_at || new Date(rec.data_expires_at) < new Date())) {
      await writeStatus({ status: "failed", error: "export_window_closed" });
      return;
    }

    // 2. Real listings only (prospecting excluded; hidden/archived listings included)
    const l = await supabaseGet("listings",
      `?user_id=eq.${userId}&project_id=not.is.null&or=(is_prospecting.is.null,is_prospecting.eq.false)` +
      `&select=address,project_id,status,compliance_page_url&order=created_at.asc`);
    const listings = Array.isArray(l.data) ? l.data : [];

    // 3. Resolve each listing's visible images from its Blobs project record
    const projectStore = getProjectStore();
    const plan = [];
    const usedFolders = new Set();
    for (const listing of listings) {
      let project = null;
      try {
        const raw = await projectStore.get("pid_" + listing.project_id);
        project = raw ? JSON.parse(raw) : null;
      } catch (e) { console.warn(`export: could not read project ${listing.project_id}: ${e.message}`); }
      if (!project) continue;
      const images = (project.images || []).filter((img) => !img.hidden && (img.originalUrl || img.stagedUrl));
      if (!images.length) continue;

      let folder = safeName(listing.address || project.address, 60);
      if (usedFolders.has(folder)) folder = `${folder}_${safeName(listing.project_id.slice(-6), 8)}`;
      usedFolders.add(folder);
      plan.push({ listing, project, images, folder });
    }

    const total = plan.reduce((n, p) => n + p.images.filter(i => i.originalUrl).length + p.images.filter(i => i.stagedUrl).length, 0);
    if (!total) { await writeStatus({ status: "empty" }); return; }
    await writeStatus({ status: "building", progress: { done: 0, total } });

    // 4. Stream the ZIP
    const key = `smart-stage-scratch/account-exports/${userId}/${jobId}.zip`;
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `SmartStagePRO_Listing_Images_${stamp}.zip`;
    let done = 0, added = 0, failedFetches = 0;

    await buildZipToS3({
      key, filename,
      produce: async (addEntry) => {
        const indexLines = [
          "SMART STAGE PRO™ — LISTING IMAGE EXPORT",
          "========================================",
          `Account:     ${authUser.email || userId}`,
          `Exported:    ${new Date().toISOString()}`,
          `Listings:    ${plan.length}`,
          "",
          "Each folder holds the original (unaltered) photo and the virtually",
          "staged final for every image on that listing's compliance page.",
          "",
        ];
        for (const { listing, project, images, folder } of plan) {
          indexLines.push(`${folder}/`);
          indexLines.push(`  Address:         ${listing.address || project.address || ""}`);
          indexLines.push(`  Status:          ${listing.status || ""}`);
          indexLines.push(`  Compliance page: ${listing.compliance_page_url || project.complianceUrl || ""}`);
          indexLines.push(`  Image sets:      ${images.length}`);
          indexLines.push("");
        }
        await addEntry(Buffer.from(indexLines.join("\n"), "utf8"), "INDEX.txt");

        for (const { images, folder } of plan) {
          for (let i = 0; i < images.length; i++) {
            const img = images[i];
            const nn = String(i + 1).padStart(2, "0");
            const room = safeName(img.roomName || `room_${nn}`, 40);
            for (const [label, url] of [["ORIGINAL", img.originalUrl], ["STAGED", img.stagedUrl]]) {
              if (!url) continue;
              try {
                const buf = await fetchImageBuffer(url);
                await addEntry(buf, `${folder}/${nn}_${room}_${label}.${extFromUrl(url)}`);
                added++;
              } catch (e) {
                failedFetches++;
                console.warn(`export: skipped ${label} for ${folder} #${nn}: ${e.message}`);
              }
              done++;
              if (done % 10 === 0) await writeStatus({ status: "building", progress: { done, total } });
            }
          }
        }
      },
    });

    await writeStatus({
      status: "ready", key,
      imageCount: added, listingCount: plan.length, skipped: failedFetches,
      progress: { done: total, total },
    });
    console.log(`export-account-zip: user ${userId} — ${added} images, ${plan.length} listings, ${failedFetches} skipped`);
  } catch (err) {
    console.error("export-account-zip error:", err);
    await writeStatus({ status: "failed", error: err.message });
  }
};
