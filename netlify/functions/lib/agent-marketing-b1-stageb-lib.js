// lib/agent-marketing-b1-stageb-lib.js — Netlify (shared). DEVELOPMENT ONLY (Nov 5, 2026). Pure functions, no I/O, no provider calls.
//
// Stage B connects a selected Article-Led project to ONE stored B1 evidence record (design: docs/b1-stage-b-design.md; table proposed in
// docs/proposed-migrations/20261105_agent_marketing_article_evidence.up.sql, NOT applied). This file only:
//   - computes the cache key that decides whether an existing B1 result can be reused (same source snapshot, same approved B1 request settings),
//   - checks a stored record against the project and the approved B1 settings, and
//   - turns the record into the topic's b1Evidence, failing closed: a missing, malformed or mismatched record makes the evidence BLOCKED, and
//     agent-marketing-b1-evidence-lib then stops the Planner before any model call.
// Nothing here runs B1, retrieves an article, or touches the database. With AGENT_MARKETING_B1_EVIDENCE unset the topic is returned unchanged.
"use strict";

const crypto = require("crypto");
const b1 = require("./agent-marketing-b1-evidence-lib");

// The approved B1 request settings (B1 Reference v1.2.1). A record made with anything else is never used.
const APPROVED_B1 = Object.freeze({
  prompt_version: "v1.2.1",
  instructions_sha256: "67edf2afc1157b3d44c6c7536e743c986c2bf2e51576adbcd6f35b23fafef7cc",
  model: "anthropic/claude-sonnet-5-5",
  max_output_tokens: 5000,
  reasoning_effort: "minimal",
  extractor: "extract_v3", // the default for new snapshots (Nov 8, 2026): the article without page furniture
});
// Extractors a stored record may have used. extract_v2 is the input text the v1.2.1 regression and the frozen FA/FB/FC fixtures were made from;
// records made with it stay valid (immutable evidence). The extractor is part of the cache key, so the two never share a B1 result.
const EXTRACTORS = Object.freeze(["extract_v3", "extract_v2"]);
const FIXTURE_EXTRACTOR = "extract_v2";
/** The extractor for a new snapshot: B1_EXTRACTOR when it names an accepted one; extract_v2 in fixture mode (its saved B1 responses were made
 *  from extract_v2 text); otherwise extract_v3. */
function extractorFor(env) {
  const e = env || process.env;
  const want = String(e.B1_EXTRACTOR || "").trim();
  if (EXTRACTORS.includes(want)) return want;
  if (String(e.B1_SNAPSHOT_SOURCE || "").trim().toLowerCase() === "worker-fixture") return FIXTURE_EXTRACTOR;
  return APPROVED_B1.extractor;
}
/** The evidence key of a topic: a topic written by B2 during research (Nov 8, 2026) points at its ARTICLE's evidence (b1.articleKey); any other
 *  Article-Led topic is its own key (its topic id). Topic ids alone repeat across research sets, so lookups also match the research run. */
function topicKeyOf(t) { return t && t.b1 && typeof t.b1 === "object" && typeof t.b1.articleKey === "string" && t.b1.articleKey ? t.b1.articleKey : (t && t.id); }
const KEY_FIELDS = ["snapshot_sha256", "extractor", "instructions_sha256", "model", "max_output_tokens", "reasoning_effort"];
const sha = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
const HEX64 = /^[0-9a-f]{64}$/;
const BEGIN = "=====BEGIN RETRIEVED TEXT=====\n", END = "\n=====END RETRIEVED TEXT=====";   // the B1 input wrapper (B1 build_inputs_v2.wrap)

/** cacheKey(k) → sha256 of the inputs that decide B1's result. The gate version is deliberately NOT part of it: a gate change re-gates the
 *  stored raw response without a new provider call. */
function cacheKey(k) {
  const v = k || {};
  if (!HEX64.test(String(v.snapshot_sha256 || ""))) throw new Error("cacheKey: snapshot_sha256 must be a sha256");
  return sha(["b1-cache/1", ...KEY_FIELDS.map((f) => `${f}=${v[f] == null ? "" : String(v[f])}`)].join("|"));
}

/** The reuse key for an approved B1 run over a snapshot. */
function approvedKey(snapshotSha256, extractor) { return cacheKey({ ...APPROVED_B1, extractor: extractor || APPROVED_B1.extractor, snapshot_sha256: snapshotSha256 }); }

/**
 * checkRecord(record, project) → [] when the record may be used for this project, else a list of problems.
 * record: a row of agent_marketing_article_evidence (see the proposed migration). project: the stored project row.
 */
function checkRecord(record, project) {
  const p = [];
  const r = record && typeof record === "object" ? record : null;
  if (!r) return ["no B1 evidence record for this project"];
  const t = project && project.selected_topic && typeof project.selected_topic === "object" ? project.selected_topic : null;
  if (!t) return ["the project has no selected topic"];
  if (r.project_id !== project.id) p.push("record belongs to another project");
  // An article-keyed topic points at its ARTICLE's evidence, so an otherwise compatible record of this project written by an earlier research run is
  // still the right record (Nov 12, 2026). Any other topic key repeats across research sets, so its research run must still match.
  const articleKeyed = !!(t.b1 && typeof t.b1.articleKey === "string" && t.b1.articleKey && r.topic_id === t.b1.articleKey);
  if (r.topic_id !== topicKeyOf(t) || (r.research_id !== t.researchId && !articleKeyed)) p.push("record is for a different selected topic (the topic changed after B1 ran)");
  if (r.status !== "ready") p.push(`record status is ${r.status || "missing"}, not ready`);
  for (const f of ["instructions_sha256", "model", "max_output_tokens", "reasoning_effort", "prompt_version"]) {
    if (r[f] !== APPROVED_B1[f]) p.push(`${f} is not the approved B1 setting`);
  }
  if (!EXTRACTORS.includes(r.extractor)) p.push("extractor is not an accepted extractor");
  for (const f of ["snapshot_sha256", "input_sha256", "raw_response_sha256", "cache_key"]) if (!HEX64.test(String(r[f] || ""))) p.push(`${f} missing or malformed`);
  if (p.length) return p;
  if (typeof r.snapshot_text !== "string" || sha(r.snapshot_text) !== r.snapshot_sha256) p.push("source snapshot is missing or does not match its hash");
  if (typeof r.raw_response_text !== "string" || sha(r.raw_response_text) !== r.raw_response_sha256) p.push("raw B1 response is missing or does not match its hash");
  // The exact request sent to B1: its input must hash to input_sha256 and must carry the snapshot text, byte for byte, between the markers.
  let req = null; try { req = JSON.parse(String(r.request_text)); } catch (e) { p.push("stored B1 request is missing or not JSON"); }
  if (req) {
    const input = typeof req.input === "string" ? req.input : "";
    if (sha(input) !== r.input_sha256) p.push("stored B1 request does not match input_sha256");
    if (typeof r.snapshot_text === "string" && !input.includes(`${BEGIN}${r.snapshot_text}${END}`)) p.push("B1 input does not carry the stored source snapshot");
    if (req.model !== APPROVED_B1.model || req.max_output_tokens !== APPROVED_B1.max_output_tokens || !req.reasoning || req.reasoning.effort !== APPROVED_B1.reasoning_effort) p.push("stored B1 request does not use the approved settings");
    if (typeof req.instructions !== "string" || sha(req.instructions) !== APPROVED_B1.instructions_sha256) p.push("stored B1 request does not use the approved B1 prompt");
  }
  let key = null; try { key = cacheKey(r); } catch (e) { p.push(e.message); }
  if (key && key !== r.cache_key) p.push("cache key does not match the record's inputs");
  const v = b1.readBundle(r.bundle);
  if (v.status === b1.BLOCKED) p.push(`evidence bundle is BLOCKED: ${v.blockedReason}`);
  else {
    if (v.provenance.input_sha256 !== r.input_sha256) p.push("evidence bundle was made from a different B1 input");
    if (v.provenance.raw_response_sha256 !== r.raw_response_sha256) p.push("evidence bundle was made from a different raw B1 response");
    if (r.completeness_status !== v.status) p.push("stored completeness status does not match the bundle");
  }
  return p;
}

/** A bundle-shaped value that always reads as BLOCKED, carrying the reason (readBundle rejects it: no payload). */
const blockedDoc = (problems) => ({ format: "ssp-b1-stageb-blocked", reason: problems.join("; ") });

/**
 * topicWithEvidence(project, record, env) → the selected topic to give the Planner.
 *  - switch off, or not an Article-Led topic (no candidate record): the topic unchanged (legacy path, production behaviour);
 *  - switch on: the topic with b1Evidence = the record's bundle when checkRecord passes, otherwise a BLOCKED value. Never the topic without
 *    b1Evidence, so a missing record cannot silently fall back to unevidenced planning.
 */
function topicWithEvidence(project, record, env) {
  const t = project && project.selected_topic;
  if (!b1.enabled(env) || !t || typeof t !== "object" || !t.candidate) return t;
  const problems = checkRecord(record, project);
  const withBundle = b1.attachToTopic(t, problems.length ? blockedDoc(problems) : record.bundle);
  // Nov 12, 2026: B1's stored summary of the author's central claim rides along as editorial context for the planner (read from the stored raw
  // response; nothing is stored or fetched). Only with a record that passed the contract; never a verified quotation.
  const central = !problems.length && record ? b1.centralArgumentOf(record.raw_response_text) : null;
  return central ? { ...withBundle, b1CentralArgument: central } : withBundle;
}

module.exports = { topicKeyOf, APPROVED_B1, EXTRACTORS, FIXTURE_EXTRACTOR, extractorFor, KEY_FIELDS, cacheKey, approvedKey, checkRecord, topicWithEvidence, sha };
