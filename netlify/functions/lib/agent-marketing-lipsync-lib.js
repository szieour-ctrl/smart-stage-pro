// agent-marketing-lipsync-lib.js — the optional Lip sync step of an Agent Marketing Reel (Nov 25, 2026).
// Off by default. When a job asks for it, the opening scene and the closing scene each get a short talking clip of the agent's profile headshot,
// made by HeyGen from the exact narration excerpt for that scene. Everything else about the Reel is unchanged: SSP's narration stays the only voice.
//
// Nothing here reaches HeyGen unless BOTH are set: HEYGEN_API_KEY and AGENT_MARKETING_HEYGEN_LIVE=approved (Sam's go-ahead to spend credits).
// Without them every requested scene is simply skipped and keeps its still headshot.
//
// State is saved on the job (job.assets.lipsync) after every step, so a retry reuses what is already paid for:
//   scenes[n] = { role, status: "done" | "failed" | "pending" | "skipped", excerpt_key, heygen_video_id, clip_key, duration_sec, error, attempts }
//   done     the clip is stored; reused as is.
//   pending  HeyGen was asked and had not finished in time; the next attempt checks THE SAME HeyGen job, it never starts a second one.
//   failed   HeyGen refused or failed; the next attempt may ask once more (only for that scene).
"use strict";

const POLL_MS = 10000;
const MAX_WAIT_MS = 9 * 60 * 1000;

function live(env) {
  const e = env || process.env;
  return !!(e.HEYGEN_API_KEY && String(e.AGENT_MARKETING_HEYGEN_LIVE || "").trim().toLowerCase() === "approved");
}

/** Whether this job asked for lip sync. Absent means Off, including every job made before this existed. */
function requested(job) { return !!(job && job.assets && job.assets.lipsync && job.assets.lipsync.requested === true); }

/** Planning budget (Nov 28, 2026): opening + closing together are planned within 20 seconds of HeyGen, each at most 10. A target, never enforced. */
const BUDGET_SEC = 20, SHOT_CAP_SEC = 10;
const r1 = (n) => Math.round(n * 10) / 10;
/** Planned seconds come from the cut windows; actual seconds come from the clips HeyGen returned. */
function budget(manifest, report) {
  const planned = targets(manifest).reduce((a, t) => a + Math.max(0, t.end - t.start), 0);
  const actual = (report || []).reduce((a, r) => a + (r.status === "used" && Number(r.duration_sec) > 0 ? Number(r.duration_sec) : 0), 0);
  return { budget_sec: BUDGET_SEC, shot_cap_sec: SHOT_CAP_SEC, planned_sec: r1(planned), actual_sec: r1(actual), planned_within_budget: planned <= BUDGET_SEC + 0.05, actual_within_budget: actual <= BUDGET_SEC + 0.05 };
}

/** The scenes that get a clip: the opening and the closing. */
function targets(manifest) {
  const sc = (manifest && manifest.scenes) || [];
  if (!sc.length) return [];
  const pick = sc.length === 1 ? [sc[0]] : [sc[0], sc[sc.length - 1]];
  return pick.map((s, i) => ({ n: s.n, role: pick.length === 1 || i === 0 ? "opening" : "closing", start: s.window.start, end: s.window.end, aspect: /editorial_portrait/.test(String(s.composition)) ? "4:5" : "1:1" }));
}

const roleLabel = (r) => (r === "opening" ? "opening" : "closing");

/**
 * prepareLipSync({ job, manifest, audio, headshotKey, env, deps }) -> { manifest, report, state, calls }
 * deps: { cutExcerpt(narrationUrl, start, end) -> Buffer, put(key, buf, contentType), presign(key, secs) -> url, heygen: { create, get, download },
 *         saveState(state), sleep(ms), now() }
 * The returned manifest has scene.lipsync = { clip_key } on every scene whose clip is done; report names each scene's outcome.
 */
async function prepareLipSync({ job, manifest, audio, headshotKey, env, deps }) {
  const todo = targets(manifest);
  const prior = (job.assets && job.assets.lipsync) || {};
  const state = { requested: true, scenes: { ...(prior.scenes || {}) } };
  const report = [];
  const save = async () => { await deps.saveState(state); };
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now || Date.now;

  if (!live(env)) {
    for (const t of todo) report.push({ n: t.n, role: t.role, status: "skipped", reason: "Lip sync is not switched on yet, so the still headshot is shown." });
    return { manifest, report, state, calls: 0 };
  }

  let calls = 0;
  const one = async (t) => {
    const rec = { role: t.role, ...(state.scenes[t.n] || {}) };
    state.scenes[t.n] = rec;
    try {
      if (rec.status === "done" && rec.clip_key) return;
      // 1. ask HeyGen (only when no job exists for this scene, or the earlier one failed)
      if (!rec.heygen_video_id || rec.status === "failed") {
        if (!rec.excerpt_key) {
          const narrationUrl = await deps.presign(audio.key, 3600);
          const mp3 = await deps.cutExcerpt(narrationUrl, t.start, t.end);
          if (!mp3 || !mp3.length) throw new Error("The narration excerpt could not be cut");
          rec.excerpt_key = `${audio.key.replace(/narration\.mp3$/, "")}lipsync_${t.n}.mp3`;
          await deps.put(rec.excerpt_key, mp3, "audio/mpeg");
        }
        rec.attempts = (rec.attempts || 0) + 1;
        const imageUrl = await deps.presign(headshotKey, 3600), audioUrl = await deps.presign(rec.excerpt_key, 3600);
        calls++;
        const made = await deps.heygen.create({ imageUrl, audioUrl, aspect: t.aspect, title: `SSP ${roleLabel(t.role)} ${job.id}`, idempotencyKey: `ssp-${job.id}-scene${t.n}-a${rec.attempts}` });
        rec.heygen_video_id = made.videoId; rec.status = "pending"; rec.error = null; rec.requested_sec = Math.round((t.end - t.start) * 100) / 100;
        await save();
      }
      // 2. wait for it (an existing job is only ever polled, never re-created)
      const started = now();
      for (;;) {
        const g = await deps.heygen.get(rec.heygen_video_id);
        if (g.status === "completed" && g.videoUrl) {
          const clip = await deps.heygen.download(g.videoUrl);
          rec.clip_key = `${audio.key.replace(/narration\.mp3$/, "")}lipsync_${t.n}.mp4`;
          await deps.put(rec.clip_key, clip, "video/mp4");
          rec.duration_sec = g.duration; rec.status = "done"; rec.error = null;
          await save();
          return;
        }
        if (g.status === "failed") { rec.status = "failed"; rec.error = String(g.failure || "HeyGen could not make this clip").slice(0, 200); await save(); return; }
        if (now() - started > MAX_WAIT_MS) { rec.status = "pending"; rec.error = "HeyGen had not finished in time"; await save(); return; }
        await sleep(POLL_MS);
      }
    } catch (e) {
      // keep whatever is already paid for (excerpt, HeyGen job id); only a scene that never reached HeyGen is a plain failure
      rec.status = rec.heygen_video_id && rec.status === "pending" ? "pending" : "failed";
      rec.error = String(e.message).slice(0, 200);
      try { await save(); } catch (se) { /* the next save will carry it */ }
    }
  };
  await Promise.all(todo.map(one));

  const out = { ...manifest, scenes: manifest.scenes.map((s) => (state.scenes[s.n] && state.scenes[s.n].status === "done" && state.scenes[s.n].clip_key ? { ...s, lipsync: { clip_key: state.scenes[s.n].clip_key } } : s)) };
  for (const t of todo) {
    const r = state.scenes[t.n];
    report.push({ n: t.n, role: t.role, status: r.status === "done" ? "used" : "fallback", ...(r.status === "done" ? { heygen_video_id: r.heygen_video_id, duration_sec: r.duration_sec } : { reason: r.error || "no clip", heygen_video_id: r.heygen_video_id || undefined }) });
  }
  return { manifest: out, report, budget: budget(manifest, report), state, calls };
}

module.exports = { prepareLipSync, budget, BUDGET_SEC, SHOT_CAP_SEC, targets, requested, live, POLL_MS, MAX_WAIT_MS };
