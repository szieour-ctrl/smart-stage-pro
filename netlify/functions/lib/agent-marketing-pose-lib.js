// lib/agent-marketing-pose-lib.js — Netlify (shared). Nov 28, 2026.
// ONE pose field and ONE resolver for the supporting AGENT_SCENE shots of an Agent Marketing Reel.
//
//   The planner may suggest a pose (scene.pose = one of POSE_IDS) from the poses the subscriber has APPROVED on their Agent Appearance Sheet.
//   The subscriber may override it before generating (a pose id, or "none" to use the profile photo alone).
//   Image generation then sends TWO references: Image 1 = the profile headshot (likeness), Image 2 = the approved pose crop (posture, hands, proportions, clothing).
//   With no approved pose, no sheet, or a pose the subscriber left out, nothing changes: the scene uses the profile photo exactly as before (the fallback).
//
// The four poses are the four panels of the Appearance Sheet's "poses" stage (panel_index 0..3). Panels the subscriber left out are status "rejected" and are never offered.
"use strict";

const POSES = [
  { id: "standing_presenting", label: "Standing, presenting", panel: 0, use: "standing, three-quarter stance, open-palm presenting gesture" },
  { id: "seated_desk", label: "Seated at a desk", panel: 1, use: "seated at a desk, reviewing one blank document" },
  { id: "standing_folder", label: "Standing with a folder", panel: 2, use: "standing, holding a plain unmarked folder at mid-torso" },
  { id: "seated_listening", label: "Seated, listening", panel: 3, use: "seated and listening, hands at rest, torso angled toward the camera" },
];
const POSE_IDS = POSES.map((p) => p.id);
const byId = (id) => POSES.find((p) => p.id === id) || null;
const byPanel = (n) => POSES.find((p) => p.panel === Number(n)) || null;

const rows = (r) => (r && Array.isArray(r.data) ? r.data : []);

/**
 * approvedPoses(userId, supabase) → [{ id, label, use, assetId, key }] for the subscriber's approved, not-left-out pose panels, in sheet order.
 * Any failure returns [] so a Reel never stops because the sheet could not be read.
 */
async function approvedPoses(userId, supabase) {
  try {
    const r = await supabase("GET", "agent_appearance_assets", null, `?user_id=eq.${userId}&stage=eq.poses&kind=eq.crop&status=eq.approved&select=id,panel_index,s3_key&order=panel_index.asc,created_at.desc`);
    const seen = new Set(), out = [];
    for (const a of rows(r)) {
      const p = byPanel(a.panel_index);
      if (!p || !a.s3_key || seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({ id: p.id, label: p.label, use: p.use, assetId: a.id, key: a.s3_key });
    }
    return out;
  } catch (e) { return []; }
}

/**
 * resolvePose({ suggested, override, approved }) → { pose, source } where pose is an approved entry or null.
 * override: a pose id wins over the planner's suggestion; "none" asks for the profile photo alone. An id that is not approved resolves to null (the fallback).
 */
function resolvePose({ suggested, override, approved }) {
  const list = Array.isArray(approved) ? approved : [];
  if (override === "none") return { pose: null, source: "subscriber_none" };
  if (override && POSE_IDS.includes(override)) { const p = list.find((x) => x.id === override); return { pose: p || null, source: p ? "subscriber" : "fallback" }; }
  if (suggested && POSE_IDS.includes(suggested)) { const p = list.find((x) => x.id === suggested); return { pose: p || null, source: p ? "planner" : "fallback" }; }
  return { pose: null, source: "none" };
}

/** The planner is told only about poses that exist: [{ id, label }]. */
const forPlanner = (approved) => (approved || []).map((p) => ({ id: p.id, pose: p.label }));
/** A planner or subscriber pose value is kept only if it is one of the four ids. */
const cleanPoseId = (v) => (typeof v === "string" && POSE_IDS.includes(v) ? v : null);

// The reference order in the request and in the prompt: Image 1 is the headshot, Image 2 is the pose.
const REFERENCE_ORDER = ["headshot", "pose"];
/** Prepends the two-reference instructions to an agent-scene prompt that was already built. */
function promptWithPose(prompt, pose) {
  if (!pose) return prompt;
  return [
    `Image 1 is the approved headshot of the real person: it controls the face, hairline, beard and apparent age. Image 2 is the approved pose reference (${pose.label}): it controls posture, hand position, body proportions and clothing. Do not copy the background of either image.`,
    prompt,
  ].join("\n");
}

module.exports = { POSES, POSE_IDS, REFERENCE_ORDER, byId, byPanel, approvedPoses, resolvePose, forPlanner, cleanPoseId, promptWithPose };
