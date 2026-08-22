// migrate-marketing-media.js — Netlify Function
// ONE-TIME migration tool. Downloads the ~36 hardcoded landing-page images
// (and 1 demo video) that were still living on Cloudinary — index.html has
// ALREADY been updated to point at their predicted S3 URLs (see the diff
// that shipped alongside this file); this function's only job is to make
// those URLs actually resolve by putting the real bytes at those exact
// keys. Run once, confirm the summary shows 0 failures, then this file
// can be deleted from the repo — it has no ongoing purpose.
//
// Protected by a shared secret query param (?secret=...) since it's a
// public URL surface that does real work (downloads + S3 writes) — set
// MIGRATION_SECRET in Netlify env vars to something random before running,
// then visit:
//   https://smartstagepro.com/.netlify/functions/migrate-marketing-media?secret=YOUR_SECRET
//
// Safe to re-run: any asset that fails (e.g. the one authenticated-type
// video URL, if its embedded signature already expired) is reported
// individually — successful ones aren't re-uploaded on your next attempt
// unless you want them to be, this always re-fetches everything, it's
// just idempotent because it overwrites the same key with the same bytes.

const https = require("https");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const s3 = new S3Client({
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

const MARKETING_ASSETS = [
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/q_auto/f_auto/v1781192520/ChatGPT_Image_Jun_11_2026_08_41_17_AM_qtuzy1.png", key: "smart-stage-marketing/ChatGPT_Image_Jun_11_2026_08_41_17_AM_qtuzy1.png" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/q_auto/f_auto/v1783694842/Clean_and_Stage_Original_b3oo9u.jpg", key: "smart-stage-marketing/Clean_and_Stage_Original_b3oo9u.jpg" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1780935171/Smart_Stage_PRO_Logo_zciwlo.png", key: "smart-stage-marketing/Smart_Stage_PRO_Logo_zciwlo.png" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1781158004/FINAL_Decluttered_Landing_Page_Declutter_a8h7qz.jpg", key: "smart-stage-marketing/FINAL_Decluttered_Landing_Page_Declutter_a8h7qz.jpg" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1781158058/Landing_Page_Declutter_mmi08k.jpg", key: "smart-stage-marketing/Landing_Page_Declutter_mmi08k.jpg" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1783610067/smart-stage-finals/szregsolo_234benttreect_061726/s2e3nqcvwc7f9edoog5l.jpg", key: "smart-stage-marketing/s2e3nqcvwc7f9edoog5l.jpg" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1783611979/smart-stage-originals/eo6w5cnubfua0ykaum7b.jpg", key: "smart-stage-marketing/eo6w5cnubfua0ykaum7b.jpg" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1783611982/smart-stage-finals/szregsolo_234benttreect_061726/sgkib6nys15kcr0bxtfb.jpg", key: "smart-stage-marketing/sgkib6nys15kcr0bxtfb.jpg" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1784228608/smart-stage-originals/p71pfnfgncrfwdroeg8s.jpg", key: "smart-stage-marketing/p71pfnfgncrfwdroeg8s.jpg" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1784228718/smart-stage-originals/h8qv8znmklrauhjnb1xs.jpg", key: "smart-stage-marketing/h8qv8znmklrauhjnb1xs.jpg" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1784230572/smart-stage-originals/kmyo8j3un4qemwk3ynop.jpg", key: "smart-stage-marketing/kmyo8j3un4qemwk3ynop.jpg" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1784241924/smart-stage-originals/hzygsrulokul0q9pbfki.jpg", key: "smart-stage-marketing/hzygsrulokul0q9pbfki.jpg" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1784241931/smart-stage-finals/szregsolo_5935quilterst_071626/a5j8asox2eolsljdkgqm.jpg", key: "smart-stage-marketing/a5j8asox2eolsljdkgqm.jpg" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1784772780/smart-stage-finals/szregsolo_234benttreect_061726/t4yjv2i10fhwnkjwholq.jpg", key: "smart-stage-marketing/t4yjv2i10fhwnkjwholq.jpg" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1784822498/smart-stage-originals/mbrekxvrjm7azwys5kvo.jpg", key: "smart-stage-marketing/mbrekxvrjm7azwys5kvo.jpg" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1784822501/smart-stage-finals/szregsolo_234benttreect_061726/rsc7c8slfk2wmpoatcdh.jpg", key: "smart-stage-marketing/rsc7c8slfk2wmpoatcdh.jpg" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1784950018/AB_723_Dashboard_pezbce.png", key: "smart-stage-marketing/AB_723_Dashboard_pezbce.png" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1785087638/IMG_8310_2_drhmrs.jpg", key: "smart-stage-marketing/IMG_8310_2_drhmrs.jpg" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1785108532/smart-stage-finals/szregsolo_234benttreect_061726/ehb3de5qtczarmkdltgf.jpg", key: "smart-stage-marketing/ehb3de5qtczarmkdltgf.jpg" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1785117913/Backyard_tnco79_doimfx.jpg", key: "smart-stage-marketing/Backyard_tnco79_doimfx.jpg" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1785173037/smart-stage-finals/szregsolo_3027blackpointct_072726/h7zqp79a5osopty094md.jpg", key: "smart-stage-marketing/h7zqp79a5osopty094md.jpg" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1785173079/smart-stage-finals/szregsolo_3027blackpointct_072726/n7dcpowdtrth1cgzlsfi.jpg", key: "smart-stage-marketing/n7dcpowdtrth1cgzlsfi.jpg" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1785181963/smart-stage-finals/szregsolo_3027blackpointct_072726/py0rnc5ej1btygffxnmn.jpg", key: "smart-stage-marketing/py0rnc5ej1btygffxnmn.jpg" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1785181992/smart-stage-finals/szregsolo_3027blackpointct_072726/ytbyqyi6nburoo8tofon.jpg", key: "smart-stage-marketing/ytbyqyi6nburoo8tofon.jpg" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1785191910/Social_Post_nh8bv8.png", key: "smart-stage-marketing/Social_Post_nh8bv8.png" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1785192661/Compliance_Page_oslzp3.png", key: "smart-stage-marketing/Compliance_Page_oslzp3.png" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1785194765/AI_Cinematic_Photo_Director_n7petz.png", key: "smart-stage-marketing/AI_Cinematic_Photo_Director_n7petz.png" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1785194942/FINAL_MLSBright_eedde97f-0ff7-46ff-9e6e-61fbef4479ff_laqvpu.jpg", key: "smart-stage-marketing/FINAL_MLSBright_eedde97f-0ff7-46ff-9e6e-61fbef4479ff_laqvpu.jpg" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1785194963/FINAL_LuxuryEditorial_eedde97f-0ff7-46ff-9e6e-61fbef4479ff_fkxj6x.jpg", key: "smart-stage-marketing/FINAL_LuxuryEditorial_eedde97f-0ff7-46ff-9e6e-61fbef4479ff_fkxj6x.jpg" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1785194994/FINAL_HDRNatural_eedde97f-0ff7-46ff-9e6e-61fbef4479ff_ncekon.jpg", key: "smart-stage-marketing/FINAL_HDRNatural_eedde97f-0ff7-46ff-9e6e-61fbef4479ff_ncekon.jpg" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1785195013/FINAL_BuilderShowcase_eedde97f-0ff7-46ff-9e6e-61fbef4479ff_i0fwyz.jpg", key: "smart-stage-marketing/FINAL_BuilderShowcase_eedde97f-0ff7-46ff-9e6e-61fbef4479ff_i0fwyz.jpg" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1785195032/FINAL_Magazine_eedde97f-0ff7-46ff-9e6e-61fbef4479ff_gx7eos.jpg", key: "smart-stage-marketing/FINAL_Magazine_eedde97f-0ff7-46ff-9e6e-61fbef4479ff_gx7eos.jpg" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1785195059/FINAL_PremiumDetail_eedde97f-0ff7-46ff-9e6e-61fbef4479ff_x0v4lf.jpg", key: "smart-stage-marketing/FINAL_PremiumDetail_eedde97f-0ff7-46ff-9e6e-61fbef4479ff_x0v4lf.jpg" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1785261201/smart-stage-finals/szregsolo_234benttreect_061726/raxbigoaneb2rzo4sctk.jpg", key: "smart-stage-marketing/raxbigoaneb2rzo4sctk.jpg" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/image/upload/v1785279727/SmartStage_QR_1515_Demo_St_Rocklin_CA_ijtxhh.png", key: "smart-stage-marketing/SmartStage_QR_1515_Demo_St_Rocklin_CA_ijtxhh.png" },
  { sourceUrl: "https://res.cloudinary.com/de18zsi7o/video/authenticated/s--yEuuIBoK--/v1785266771/smart-stage-pro-plus/szregsolo_1515demost_072726/video_16x9_1785266770390.mp4?_a=BAMAAAfi0", key: "smart-stage-marketing/video_16x9_1785266770390.mp4" },
];

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow one redirect — Cloudinary occasionally 301s to a CDN edge.
        return downloadBuffer(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        res.resume();
        return;
      }
      const contentType = res.headers["content-type"] || "application/octet-stream";
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ buffer: Buffer.concat(chunks), contentType }));
      res.on("error", reject);
    }).on("error", reject);
  });
}

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json" };

  const providedSecret = event.queryStringParameters?.secret;
  if (!process.env.MIGRATION_SECRET || providedSecret !== process.env.MIGRATION_SECRET) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: "Missing or incorrect ?secret=" }) };
  }

  const bucket = process.env.S3_BUCKET_NAME;
  if (!bucket) return { statusCode: 500, headers, body: JSON.stringify({ error: "S3_BUCKET_NAME not configured" }) };

  const results = [];

  for (const asset of MARKETING_ASSETS) {
    try {
      const { buffer, contentType } = await downloadBuffer(asset.sourceUrl);
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: asset.key,
        Body: buffer,
        ContentType: asset.key.endsWith(".mp4") ? "video/mp4" : contentType,
      }));
      results.push({ key: asset.key, ok: true, bytes: buffer.length });
      console.log(`Migrated: ${asset.key} (${Math.round(buffer.length / 1024)}KB)`);
    } catch (err) {
      results.push({ key: asset.key, ok: false, error: err.message, sourceUrl: asset.sourceUrl });
      console.error(`Failed: ${asset.key} - ${err.message}`);
    }
  }

  const failures = results.filter(r => !r.ok);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      total: results.length,
      succeeded: results.length - failures.length,
      failed: failures.length,
      failures,
    }, null, 2),
  };
};
