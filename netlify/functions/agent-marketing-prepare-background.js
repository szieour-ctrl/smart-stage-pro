// agent-marketing-prepare-background.js — Netlify Background Function. Prepares everything an Agent Marketing Reel needs, then hands the
// frozen manifest to Railway. Dispatched only by agent-marketing-render.js (shared internal key).
//
// Steps (each one saved in the job record as it finishes, so a retry never repeats paid work):
//   1. narration  ElevenLabs with-timestamps -> audio + word timings        (assets.audio)
//   2. images     one per scene per SELECTED format: GPT Image 2, an approved wide image already in the project, or a brand plate drawn in code
//                                                                           (assets.images["<scene>_<format>"])
//   3. manifest   am-manifest-2 built from the approved narrative and the verified figures, then validated; blocking errors stop the job
//   4. dispatch   presigned asset links + manifest -> Railway POST /render-agent-marketing
// Beta: nothing is charged. Usage (images made, narration characters) is logged on the job.
const https = require("https");
const crypto = require("crypto");
const sharp = require("sharp");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { supabase, getProfileRow } = require("./lib/marketing-profile-lib");
const am = require("./lib/agent-marketing-lib");
const img = require("./lib/agent-marketing-images-lib");
const timing = require("./lib/agent-marketing-timing-lib");
const assetsLib = require("./lib/agent-marketing-assets-lib");
const sourcesLib = require("./lib/agent-marketing-sources-lib");
const planLib = require("./lib/agent-marketing-plan-lib");
const cardCopyLib = require("./lib/agent-marketing-cardcopy-lib");

// Narration model. Eleven v4 (Oct 2026) by default; set AGENT_MARKETING_TTS_MODEL to change it without a code change.
const TTS_MODEL = process.env.AGENT_MARKETING_TTS_MODEL || "eleven_v4";
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
const s3 = new S3Client({ region: process.env.S3_REGION, credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } });
const BUCKET = () => process.env.S3_BUCKET_NAME;
const put = (Key, Body, ContentType) => s3.send(new PutObjectCommand({ Bucket: BUCKET(), Key, Body, ContentType }));
const presign = (Key, secs) => getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET(), Key }), { expiresIn: secs });

function postJson(hostname, path, headers, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const req = https.request({ hostname, path, method: "POST", headers: { ...headers, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const raw = Buffer.concat(chunks).toString("utf8"); let json = null; try { json = JSON.parse(raw); } catch { /* not JSON */ } resolve({ status: res.statusCode, json, raw: raw.slice(0, 400) }); });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("Request timed out")));
    req.on("error", reject); req.write(body); req.end();
  });
}

async function patchJob(id, fields) {
  const r = await supabase("PATCH", "agent_marketing_jobs", { ...fields, updated_at: new Date().toISOString() }, `?id=eq.${encodeURIComponent(id)}`);
  if (r.status >= 300) console.error("agent-marketing job update failed:", r.status, JSON.stringify(r.data || "").slice(0, 200));
}
async function fail(job, message) {
  console.error(`[agent-marketing-prepare] ${job.id}: ${message}`);
  await patchJob(job.id, { status: "error", error: String(message).slice(0, 900), step: "Stopped" });
}

// ── 1. narration ──────────────────────────────────────────────────────────────────────────────────────────────
async function prepareNarration(job, project, tagged, pronunciations) {
  if (job.assets && job.assets.audio && job.assets.audio.key) return job.assets.audio;
  const voiceId = assetsLib.voiceIdFor(project.voice);
  if (!voiceId) throw new Error("This voice is not configured yet.");
  if (!process.env.ELEVENLABS_API_KEY) throw new Error("Narration is not configured.");
  const sent = timing.applyPronunciations(tagged, pronunciations); // respellings are spoken, never shown: the captions below are mapped back to the written words
  const res = await postJson("api.elevenlabs.io", timing.endpointPath(voiceId), { "xi-api-key": process.env.ELEVENLABS_API_KEY }, timing.buildRequest(sent, { modelId: TTS_MODEL }), 180000);
  const j = res.json;
  if (res.status !== 200 || !j || !j.audio_base64) throw new Error(`The narration service returned ${res.status}${res.json && res.json.detail && res.json.detail.message ? ": " + res.json.detail.message : ""}`);
  const audio = Buffer.from(j.audio_base64, "base64");
  const al = j.alignment;
  const lastEnd = al && al.character_end_times_seconds && al.character_end_times_seconds[al.character_end_times_seconds.length - 1];
  const check = timing.checkAlignment(al, sent, lastEnd);
  if (!check.ok) throw new Error("The narration timings were not usable: " + check.problems.join(" "));
  let words = timing.restorePronunciations(timing.wordsFromAlignment(al), pronunciations, tagged);
  if (!timing.wordsMatchCaption(words, tagged)) {
    const same = timing.reconcileWords(words, tagged); // differs only in punctuation or case: the caption keeps the approved spelling
    if (!same) throw new Error("The narration timings do not match the approved words.");
    words = same;
  }
  const key = `agent-marketing-assets/${job.user_id}/${job.project_id}/${job.id}/narration.mp3`;
  await put(key, audio, "audio/mpeg");
  const durationSec = Math.round(Math.max(lastEnd + 0.4, (audio.length * 8) / 128000) * 100) / 100; // default output is 128 kbps mp3
  const rec = { key, duration_sec: durationSec, words: words.map((w) => ({ text: w.text, start: w.start, end: w.end })), voice_id: voiceId, model_id: TTS_MODEL, characters: sent.length, pronunciations_applied: sent !== tagged ? timing.cleanPronunciations(pronunciations).length : 0 };
  const usage = { ...(job.usage || {}), narration_characters: sent.length };
  job.assets = { ...(job.assets || {}), audio: rec }; job.usage = usage;
  await patchJob(job.id, { assets: job.assets, usage });
  return rec;
}

// ── 2. images ─────────────────────────────────────────────────────────────────────────────────────────────────
function postEdit(prompt, refBuffer, refMime, size) {
  return new Promise((resolve, reject) => {
    const boundary = "----AMBoundary" + crypto.randomBytes(6).toString("hex");
    const field = (n, v) => `--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}`;
    const text = Buffer.from([field("model", IMAGE_MODEL), field("prompt", prompt), field("n", "1"), field("size", size), field("quality", img.settings().quality), field("output_format", "png")].join("\r\n") + "\r\n", "utf8");
    const fileHdr = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="reference.png"\r\nContent-Type: ${refMime}\r\n\r\n`, "utf8");
    const body = Buffer.concat([text, fileHdr, refBuffer, Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")]);
    const req = https.request({ hostname: "api.openai.com", path: "/v1/images/edits", method: "POST", headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length } }, (res) => {
      let d = ""; res.setEncoding("utf8"); res.on("data", (c) => (d += c)); res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, json: null }); } });
    });
    req.setTimeout(240000, () => req.destroy(new Error("Image request timed out")));
    req.on("error", reject); req.write(body); req.end();
  });
}
// reference: { buffer, mime } for an image of the agent (their own profile photo), else a plain concept image.
async function generateImage(prompt, size, reference) {
  const res = reference
    ? await postEdit(prompt, reference.buffer, reference.mime, size)
    : await postJson("api.openai.com", "/v1/images/generations", { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, { model: IMAGE_MODEL, prompt, n: 1, size, quality: img.settings().quality, output_format: "png" }, 240000);
  const b64 = res.json && res.json.data && res.json.data[0] && res.json.data[0].b64_json;
  if (res.status >= 300 || !b64) {
    const msg = res.json && res.json.error && res.json.error.message ? res.json.error.message : `Image service returned ${res.status}`;
    throw new Error(/safety|policy|moderation/i.test(msg) ? "An image was declined by the image service. Adjust that scene's description and try again." : `An image could not be created (${String(msg).slice(0, 120)})`);
  }
  return Buffer.from(b64, "base64");
}
async function fetchPhoto(url) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error("One of your chosen photos could not be loaded. Choose it again on the Visuals step.");
  const b = Buffer.from(await r.arrayBuffer());
  if (b.length > 25 * 1024 * 1024) throw new Error("One of your chosen photos is too large to use.");
  return b;
}
// Closing plate (no picture of its own): a darkened, softly blurred version of the nearest earlier scene's image, so the closing
// text sits on the same photography as the rest of the Reel. No brand colours; with no earlier picture, a neutral warm charcoal.
async function objectBuffer(Key) {
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET(), Key }));
  const chunks = [];
  for await (const c of r.Body) chunks.push(c);
  return Buffer.concat(chunks);
}
async function closingPlate(format, sourceBuf) {
  const [w, h] = format === "9x16" ? [1080, 1920] : [1920, 1080];
  if (sourceBuf) return sharp(sourceBuf).rotate().resize(w, h, { fit: "cover" }).blur(38).modulate({ brightness: 0.5, saturation: 0.85 }).png().toBuffer();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><radialGradient id="g" cx="0.3" cy="0.25" r="0.9"><stop offset="0" stop-color="#4a4238"/><stop offset="1" stop-color="#1c1a18"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function prepareImages(job, project, narrative, brand, formats, profile) {
  const images = { ...((job.assets && job.assets.images) || {}) };
  // photos the agent chose themselves on the Visuals step (not generated by us): used for every format
  const ownRes = await supabase("GET", "agent_marketing_assets", null, `?project_id=eq.${job.project_id}&user_id=eq.${job.user_id}&status=eq.approved&source=neq.gpt_image_2&select=scene_index,version,asset_key,original_url,ai_generated&order=version.desc`);
  const ownRows = new Map();
  for (const r of (Array.isArray(ownRes.data) ? ownRes.data : [])) if (!ownRows.has(r.scene_index) && (r.asset_key || /^https:\/\//.test(r.original_url || ""))) ownRows.set(r.scene_index, r);
  const needs = assetsLib.imageNeeds(narrative, new Set(ownRows.keys()));
  const unsupported = needs.filter((n) => n.kind === "unsupported");
  if (unsupported.length) throw new Error(`Scene ${unsupported[0].scene + 1} uses a visual source (${unsupported[0].source || "none"}) that Agent Marketing rendering does not support yet.`);
  // images the agent APPROVED on the Visuals step are reused for their own format (a 9:16 image for the 9:16 Reel, a 16:9 image for the 16:9 Reel)
  const rows = await supabase("GET", "agent_marketing_assets", null, `?project_id=eq.${job.project_id}&user_id=eq.${job.user_id}&source=eq.gpt_image_2&select=scene_index,version,status,asset_key,generation&order=version.desc`);
  const existing = (Array.isArray(rows.data) ? rows.data : []).filter((r) => r.asset_key && r.status === "approved" && r.generation && r.generation.state === "done" && (r.generation.format === "16x9" || r.generation.format === "9x16"));
  const todo = [];
  for (const n of needs) for (const f of formats) {
    const slot = `${n.scene}_${f}`;
    if (n.kind === "reuse" || (images[slot] && images[slot].key)) continue;
    if (n.kind === "plate") { todo.push({ slot, n, f, plate: true }); continue; }
    if (n.kind === "own") { todo.push({ slot, n, f, own: ownRows.get(n.scene) }); continue; }
    const adopt = existing.find((r) => r.scene_index === n.scene && r.generation.format === f);   // the image the agent approved for THIS format
    if (adopt) { images[slot] = { key: adopt.asset_key, source: "existing_project_image" }; continue; }
    todo.push({ slot, n, f });
  }
  if (todo.some((t) => !t.plate) && !process.env.OPENAI_API_KEY) throw new Error("Image generation is not configured.");
  const usage = { ...(job.usage || {}) };
  let done = 0;
  const worker = async (t) => {
    const base = `agent-marketing-assets/${job.user_id}/${job.project_id}/${job.id}/${t.slot}`;
    let buf, source;
    if (t.plate) {
      let src = null;
      for (let i = t.n.scene - 1; i >= 0 && !src; i--) { const e = images[`${i}_${t.f}`]; if (e && e.key && e.source !== "closing_plate") { try { src = await objectBuffer(e.key); } catch (_) { /* fall back to neutral */ } } }
      buf = await closingPlate(t.f, src); source = "closing_plate";
    }
    else if (t.own) {
      const [w, h] = t.f === "9x16" ? [1080, 1920] : [1920, 1080];
      const src = t.own.asset_key ? await objectBuffer(t.own.asset_key) : await fetchPhoto(t.own.original_url);
      buf = await sharp(src).rotate().resize(w, h, { fit: "cover", position: t.f === "9x16" ? sharp.strategy.attention : "centre" }).png().toBuffer(); source = "own_photo";
    }
    else {
      const prompt = img.buildFormatPrompt({ kind: t.n.imageKind, scenePrompt: t.n.prompt, format: t.f, framing: t.n.framing && t.n.framing[t.f], people: img.peopleAllowedFor(project) });
      let reference = null;
      if (t.n.imageKind === "agent_scene") {
        const refKey = img.pickReferenceKey(profile);
        if (!refKey) throw new Error("Add a headshot or full-body photo to your Marketing Profile first, so the image of you can be made.");
        reference = { buffer: await objectBuffer(refKey), mime: /\.jpe?g$/i.test(refKey) ? "image/jpeg" : /\.webp$/i.test(refKey) ? "image/webp" : "image/png" };
      }
      buf = await generateImage(prompt, t.f === "9x16" ? img.tallSize() : img.SIZES[img.WIDE], reference);
      source = "gpt_image_2"; usage.images_generated = (usage.images_generated || 0) + 1; usage.image_model = "gpt-image-2"; usage.image_quality = img.settings().quality;
    }
    const key = `${base}_${crypto.randomBytes(3).toString("hex")}.png`;
    await put(key, buf, "image/png");
    images[t.slot] = { key, source, ...(source === "own_photo" ? { ai: !!(t.own && t.own.ai_generated) } : {}) };
    done++;
    job.assets = { ...(job.assets || {}), images }; job.usage = usage;
    await patchJob(job.id, { assets: job.assets, usage, step: `Images ${done} of ${todo.length}` });
  };
  // pictures first; plates built from them go last
  const queue = todo.filter((t) => !t.plate), plates = todo.filter((t) => t.plate);
  const runners = Array.from({ length: Math.min(3, queue.length) }, async () => { for (let t = queue.shift(); t; t = queue.shift()) await worker(t); });
  await Promise.all(runners);
  for (const t of plates) await worker(t);
  job.assets = { ...(job.assets || {}), images };
  return images;
}

// ── 4. hand to Railway ────────────────────────────────────────────────────────────────────────────────────────
function railwayPost(pathname, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${process.env.RAILWAY_RENDER_URL}${pathname}`);
    const body = JSON.stringify(payload);
    const req = https.request({ hostname: url.hostname, path: url.pathname, method: "POST", headers: { "x-railway-secret": process.env.RAILWAY_SECRET, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      let d = ""; res.setEncoding("utf8"); res.on("data", (c) => (d += c)); res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch { /* */ } resolve({ status: res.statusCode, json: j }); });
    });
    req.setTimeout(30000, () => req.destroy(new Error("Railway request timed out")));
    req.on("error", reject); req.write(body); req.end();
  });
}
async function dispatchRender(job, manifest, headshotKey) {
  const keys = new Set([manifest.audio.narration_key]);
  if (headshotKey) keys.add(headshotKey);
  manifest.scenes.forEach((s) => Object.values(s.visual.image_keys || {}).forEach((k) => keys.add(k)));
  const assets = {};
  for (const k of keys) assets[k] = await presign(k, 12 * 3600);
  const r = await railwayPost("/render-agent-marketing", { jobId: job.id, manifest, assets, musicStyle: job.music || "default" });
  return r;
}

exports.handler = async (event) => {
  const h = event.headers || {};
  const key = process.env.INTERNAL_API_KEY || "";
  if (!key || h["x-internal-key"] !== key) return { statusCode: 401, body: "" };
  let job = null;
  try {
    const body = JSON.parse(event.body || "{}");
    if (!/^[\w-]{6,80}$/.test(String(body.jobId || ""))) return { statusCode: 400, body: "" };
    const jr = await supabase("GET", "agent_marketing_jobs", null, `?id=eq.${encodeURIComponent(body.jobId)}&select=*&limit=1`);
    job = Array.isArray(jr.data) ? jr.data[0] : null;
    if (!job || !am.isEnabledFor(job.user_id)) return { statusCode: 404, body: "" };
    if (!["queued", "error"].includes(job.status) || (job.status === "error" && !body.retry)) return { statusCode: 200, body: "" }; // late or duplicate call
    await patchJob(job.id, { status: "preparing", error: null, step: "Starting", attempt: body.retry ? job.attempt + 1 : job.attempt });

    const pr = await supabase("GET", "agent_marketing_projects", null, `?id=eq.${job.project_id}&user_id=eq.${job.user_id}&select=*&limit=1`);
    const project = Array.isArray(pr.data) ? pr.data[0] : null;
    if (!project) return await fail(job, "The project was not found."), { statusCode: 200, body: "" };
    let narrative = project.narrative_approved;
    if (!narrative || !project.narrative_approved_at || !Array.isArray(narrative.scenes) || !narrative.narrationTagged) return await fail(job, "The narration has not been approved yet."), { statusCode: 200, body: "" };
    // A script approved before its scene text was re-matched to an edited narration is re-matched here (the words and their order are the narration's own).
    narrative = { ...narrative, scenes: require("./lib/agent-marketing-timing-lib").realignScenes(narrative.scenes, narrative.narrationTagged).scenes };
    const topic = project.selected_topic || {};
    if (project.selected_topic && narrative.intakeHash && narrative.intakeHash !== planLib.intakeHash(project.intake, project.selected_topic)) return await fail(job, "Your approved script was written for a different topic or different answers than the ones now on this project. Go back to the Script step, write a new script for your topic, approve it, and make the Reel again."), { statusCode: 200, body: "" };
    const reportFigures = topic.reportFigures;
    const noticeInfo = assetsLib.parseNotice(narrative.notice || topic.reportNotice);
    // Two kinds of Reel: from an uploaded MetroList report (verified figures + the MetroList notice), or from web research (checked,
    // dated sources + an on-screen source line, text cards only for now).
    const fromReport = Array.isArray(reportFigures) && reportFigures.length > 0;
    if (fromReport && !noticeInfo) return await fail(job, "The report has no dates or printed publication line for the MetroList notice. Upload a MetroList report that shows one."), { statusCode: 200, body: "" };
    if (!fromReport && !sourcesLib.sourceLine(topic.sources, topic.scopeNote)) return await fail(job, sourcesLib.usableSources(topic.sources).length ? "The source note for this topic is too long to show on screen. Run the research again to get a shorter one." : "This Reel needs either your uploaded report or at least one checked, dated research source."), { statusCode: 200, body: "" };
    const profile = await getProfileRow(job.user_id);
    if (!profile || !profile.licensed_name || !profile.headshot_key) return await fail(job, "Your Agent Profile needs your name and headshot before a Reel can be made."), { statusCode: 200, body: "" };
    const brand = { primary: profile.brand_primary, secondary: profile.brand_secondary, border: profile.brand_border, font: profile.brand_font || undefined, headshot_key: profile.headshot_key, agent: { name: profile.licensed_name, brokerage: profile.brokerage_name || "" } };
    const formats = job.formats;
    job.music = project.music || "default";

    await patchJob(job.id, { step: "Recording the narration" });
    const audio = await prepareNarration(job, project, narrative.narrationTagged, narrative.pronunciations);
    await patchJob(job.id, { step: "Creating the images" });
    const images = await prepareImages(job, project, narrative, brand, formats, profile);
    const imageKeys = {};
    for (const [slot, v] of Object.entries(images)) { const [sc, f] = slot.split("_"); (imageKeys[sc] = imageKeys[sc] || {})[f] = v.key; }

    await patchJob(job.id, { step: "Writing the card text" });
    // Claude writes the statement cards' text as the agent's perspective, within the word caps; a card that fails its checks (or any problem here) falls back to capped narration text.
    let cardCopy = {};
    const ccNotes = [];
    const askCardCopy = () => cardCopyLib.writeCardCopy({ project, narrative, intake: project.intake, reportFigures: fromReport ? reportFigures : [], anthropicKey: process.env.ANTHROPIC_API_KEY, log: (m) => { ccNotes.push(String(m).slice(0, 160)); console.log("[agent-marketing-card-copy]", m); } });
    try {
      cardCopy = await askCardCopy();
      // Oct 29, 2026: a Reel came back with no statement or support lines on its middle cards (the writer's reply was unusable); one more ask before falling back.
      if (!Object.keys(cardCopy).length && cardCopyLib.statementScenes(narrative, project.intake, []).length) cardCopy = await askCardCopy();
    }
    catch (e) { ccNotes.push("failed: " + String(e.message).slice(0, 160)); console.error("[agent-marketing-card-copy] failed, using fallback text:", e.message); }
    job.usage = { ...(job.usage || {}), card_copy: { accepted: Object.keys(cardCopy).length, notes: ccNotes.slice(0, 8) } };
    await patchJob(job.id, { usage: job.usage });
    await patchJob(job.id, { step: "Checking the facts and layout" });
    const built = assetsLib.buildManifest({ imageProvenance: assetsLib.imageProvenance(images), disclosureKind: assetsLib.disclosureKind(project), cardCopy, voiceShape: assetsLib.voiceShapeFrom(process.env), projectId: project.id, formats, narrative, intake: project.intake, reportFigures: fromReport ? reportFigures : [], articleTopic: fromReport && topic.origin === "web" ? topic : undefined, notice: fromReport ? noticeInfo : undefined, webTopic: fromReport ? undefined : topic, brand, narrationTagged: narrative.narrationTagged, audio: { narration_key: audio.key, duration_sec: audio.duration_sec, words: audio.words }, imageKeys });
    await patchJob(job.id, { validation: built.validation, manifest: built.manifest });
    if (!built.validation.ok) return await fail(job, "The Reel did not pass its checks: " + built.validation.errors.map((e) => e.message).join(" | ")), { statusCode: 200, body: "" };

    await patchJob(job.id, { status: "ready", step: "Sending to the renderer" });
    const r = await dispatchRender(job, built.manifest, profile.headshot_key);
    if (r.status !== 202) return await fail(job, r.status === 429 ? "The renderer is busy. Please try again in a few minutes." : `The renderer did not accept the job (${r.status}).`), { statusCode: 200, body: "" };
    await patchJob(job.id, { status: "rendering", step: "Rendering" });
  } catch (err) {
    console.error("[agent-marketing-prepare-background] failed:", err.message);
    if (job) { try { await fail(job, err.message); } catch (e) { console.error("could not write error state:", e.message); } }
  }
  return { statusCode: 200, body: "" };
};
