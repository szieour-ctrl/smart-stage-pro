// lib/agent-marketing-b1-evidence-lib.js — Netlify (shared). DEVELOPMENT ONLY (Nov 5, 2026): B1 article evidence for the Article-Led Market Update.
//
// Where it sits: Stage A discovery selects an article topic (selected_topic). B1 (Stage B editorial analysis, built and gated outside this repo)
// reads that article; its output passes the B1 evidence gate (quote verifier, qrec-1, human evidence review) and is exported through the gate's
// load_evidence() as an "ssp-b1-evidence/1" bundle. This file is the ONLY reader of that bundle here. It sits between research extraction
// (the frozen selected_topic) and the Planner (plan-lib topicBrief / buildUserMessage) and the content gate (gate.verifiedFromTopic).
//
// Rules:
//   - The bundle is checked before anything is used: format, the sha256 of the exact payload text, the status, and the shape. Anything wrong
//     reads as BLOCKED with no findings.
//   - Four separate collections: validated, held, excluded, and completeness_status (COMPLETE | PASSED_WITH_HOLDS | BLOCKED).
//   - ONLY validated findings are verified research evidence. Held findings stay visible for review (the B1 review page, the plan warning) but
//     their claims and quotations never reach the Planner input or the gate's verified text. Excluded findings are never used.
//   - BLOCKED stops downstream processing: the Planner refuses to run (assertNotBlocked) before any model call.
//   - PASSED_WITH_HOLDS is always labeled incomplete, in the Planner input and as a plan warning the agent sees.
//   - Off unless the SERVER environment sets AGENT_MARKETING_B1_EVIDENCE=dev. No request field can turn it on. With it off nothing here runs
//     and production behaviour is unchanged.
"use strict";

const crypto = require("crypto");

const FORMAT = "ssp-b1-evidence/1";
const COMPLETE = "COMPLETE", WITH_HOLDS = "PASSED_WITH_HOLDS", BLOCKED = "BLOCKED";
const STATUSES = [COMPLETE, WITH_HOLDS, BLOCKED];
const ENV_FLAG = "AGENT_MARKETING_B1_EVIDENCE";
// Sections whose findings are claims about the article's subject. extraction_defects describe the page's text quality, not the market: never claims.
const CLAIM_SECTIONS = ["headline_claims", "essential_explanatory_mechanisms", "numerical_basis", "material_qualifications_and_unresolved_assertions",
  "source_contradictions", "practical_consequences_stated_by_source"];
const KIND = { headline_claims: "headline_claim", essential_explanatory_mechanisms: "explanation", numerical_basis: "figure",
  material_qualifications_and_unresolved_assertions: "qualification", source_contradictions: "contradiction", practical_consequences_stated_by_source: "consequence" };

class B1EvidenceBlocked extends Error {
  constructor(reason) { super(`B1 article evidence is BLOCKED: ${reason}. The plan was not started.`); this.code = "B1_EVIDENCE_BLOCKED"; }
}

/** Development switch, read from the server environment only. */
function enabled(env) { return String((env || process.env)[ENV_FLAG] || "").trim().toLowerCase() === "dev"; }

const blocked = (reason) => Object.freeze({ status: BLOCKED, validated: [], held: [], excluded: [], provenance: null, blockedReason: reason, incomplete: true });
const isArr = Array.isArray;

/** readBundle(doc) → { status, validated, held, excluded, provenance, blockedReason, incomplete }. Never throws; a bad bundle is BLOCKED. */
function readBundle(doc) {
  if (!doc || typeof doc !== "object") return blocked("no B1 evidence bundle");
  if (doc.format === "ssp-b1-stageb-blocked") return blocked(`Stage B evidence record rejected: ${String(doc.reason || "unknown reason")}`);
  if (doc.format !== FORMAT) return blocked("unknown evidence format");
  if (typeof doc.payload !== "string" || typeof doc.payload_sha256 !== "string") return blocked("bundle is incomplete");
  if (crypto.createHash("sha256").update(doc.payload, "utf8").digest("hex") !== doc.payload_sha256) return blocked("bundle hash does not match (it was changed)");
  let p;
  try { p = JSON.parse(doc.payload); } catch (e) { return blocked("bundle payload is not JSON"); }
  if (!p || p.format !== FORMAT || !STATUSES.includes(p.completeness_status)) return blocked("bundle status is missing or unknown");
  if (p.completeness_status === BLOCKED) return blocked(String(p.blocked_reason || "the B1 evidence gate failed closed"));
  if (!isArr(p.validated) || !isArr(p.held) || !isArr(p.excluded)) return blocked("bundle collections are malformed");
  const okItem = (x) => x && typeof x === "object" && typeof x.section === "string" && x.finding && typeof x.finding === "object";
  if (![...p.validated, ...p.held, ...p.excluded].every(okItem)) return blocked("bundle findings are malformed");
  if (!p.provenance || typeof p.provenance.input_sha256 !== "string" || typeof p.provenance.raw_b1_output_sha256 !== "string") return blocked("bundle provenance is missing");
  const status = p.held.length ? WITH_HOLDS : p.completeness_status; // holds always win: a "COMPLETE" bundle that lists held findings is incomplete
  return Object.freeze({
    status, validated: p.validated, held: p.held, excluded: p.excluded, provenance: p.provenance, blockedReason: null, incomplete: status !== COMPLETE,
  });
}

const str = (x) => (typeof x === "string" ? x.trim() : "");
function claimText(section, f) {
  if (section === "headline_claims") return str(f.promise);
  if (section === "essential_explanatory_mechanisms") return str(f.mechanism);
  if (section === "numerical_basis") return [str(f.figure_as_written), str(f.measures), str(f.period_or_comparison)].filter(Boolean).join("; ");
  if (section === "material_qualifications_and_unresolved_assertions") return str(f.item);
  if (section === "source_contradictions") return str(f.what_differs);
  if (section === "practical_consequences_stated_by_source") return str(f.consequence);
  return "";
}
function quotesOf(f) {
  const out = [];
  const walk = (o) => { if (!o || typeof o !== "object") return; for (const [k, v] of Object.entries(o)) { if ((k === "source_quote" || k === "quote") && typeof v === "string" && v.trim()) out.push(v); else if (v && typeof v === "object") walk(v); } };
  walk(f);
  return out;
}
/** Who the article attributes the finding to, as B1 recorded it (null when B1 recorded none). Kept so the source stays named. */
function attributionOf(section, f) {
  if (section === "essential_explanatory_mechanisms") return str(f.attribution) || null;
  if (section === "numerical_basis") return str(f.named_source) || null;
  return null;
}
/** Limits B1 recorded on the finding itself (support level, what is missing, assumptions, a possible explanation of a conflict). */
function qualificationsOf(section, f) {
  const q = {};
  if (section === "headline_claims") { if (str(f.support)) q.support = str(f.support); if (str(f.missing)) q.missing = str(f.missing); }
  if (section === "numerical_basis" && str(f.stated_assumptions)) q.stated_assumptions = str(f.stated_assumptions);
  if (section === "source_contradictions" && str(f.could_be_explained_by)) q.could_be_explained_by = str(f.could_be_explained_by);
  return Object.keys(q).length ? q : null;
}
const validatedClaims = (view) => view.validated.filter((x) => CLAIM_SECTIONS.includes(x.section));

function statusLabel(view) {
  if (view.status === COMPLETE) return "COMPLETE: every B1 finding for this article passed the evidence gate.";
  return `INCOMPLETE (PASSED_WITH_HOLDS): ${view.held.length} B1 finding(s) for this article are held for review and are NOT verified; they are not included here.`;
}

/** What the Planner may know from B1: validated claim findings only, with their exact source quotations, and the completeness label. */
function plannerArticleEvidence(view) {
  if (!view || view.status === BLOCKED) throw new B1EvidenceBlocked((view && view.blockedReason) || "no evidence");
  return {
    status: view.status, status_label: statusLabel(view),
    validated_findings: validatedClaims(view).map((x) => ({ kind: KIND[x.section], finding: claimText(x.section, x.finding), source_quotes: quotesOf(x.finding),
      attribution: attributionOf(x.section, x.finding), qualifications: qualificationsOf(x.section, x.finding) })),
    held_findings_not_verified: view.held.length, // a count only: no held claim or quotation is passed on
  };
}

/**
 * Nov 12, 2026: B1's own one-paragraph statement of the source's central claim ("central_argument", at most 80 words), read from the stored raw B1
 * response. The evidence gate does not export it, so it is NOT quotation-verified: it is editorial evidence for B2 to weigh (the author's claim, as B1
 * summarized it), never a verified fact, a figure source or an instruction. null when the response has none. Never throws.
 */
function centralArgumentOf(rawResponseText) {
  const find = (o) => {   // the model's answer text inside a Responses-style reply, or the answer object itself (offline fixtures)
    if (!o || typeof o !== "object") return null;
    if (typeof o.central_argument === "string") return o.central_argument;
    for (const item of Array.isArray(o.output) ? o.output : []) {
      for (const c of Array.isArray(item && item.content) ? item.content : []) {
        if (c && typeof c.text === "string") { const r = fromText(c.text); if (r) return r; }
      }
    }
    return typeof o.output_text === "string" ? fromText(o.output_text) : null;
  };
  const fromText = (t) => {
    const s = String(t).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try { const j = JSON.parse(s); return j && typeof j.central_argument === "string" ? j.central_argument : null; } catch (x) { return null; }
  };
  let out = null;
  try { out = find(JSON.parse(String(rawResponseText))); } catch (x) { out = null; }
  const text = String(out == null ? "" : out).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 700) : null;
}

/** Exact source quotations of validated claim findings: the only B1 text the content gate may treat as verified. */
function verifiedQuotes(view) {
  if (!view || view.status === BLOCKED) return [];
  return validatedClaims(view).flatMap((x) => quotesOf(x.finding));
}

/** The topic's B1 view when the development switch is on and the topic carries a bundle; null otherwise (the legacy path). */
function viewForTopic(topic, env) {
  if (!enabled(env) || !topic || typeof topic !== "object" || !("b1Evidence" in topic)) return null;
  return readBundle(topic.b1Evidence);
}

/** Throws B1EvidenceBlocked when the switch is on and the topic's B1 evidence is BLOCKED (missing, failed closed, or changed). */
function assertNotBlocked(topic, env) {
  const v = viewForTopic(topic, env);
  if (v && v.status === BLOCKED) throw new B1EvidenceBlocked(v.blockedReason);
  return v;
}

/** Plan warning the agent sees for incomplete evidence (empty when complete or when the switch is off). */
function planWarnings(topic, env) {
  const v = viewForTopic(topic, env);
  if (!v || v.status !== WITH_HOLDS) return [];
  return [`Article evidence is INCOMPLETE (PASSED_WITH_HOLDS): ${v.held.length} B1 finding(s) are held for review and were not used in this script.`];
}

/** Development helper: a copy of the topic carrying the bundle exactly as exported (re-verified every time it is read). */
function attachToTopic(topic, bundleDoc) { return { ...(topic || {}), b1Evidence: bundleDoc }; }

module.exports = { FORMAT, COMPLETE, WITH_HOLDS, BLOCKED, ENV_FLAG, CLAIM_SECTIONS, B1EvidenceBlocked, enabled, readBundle, plannerArticleEvidence, centralArgumentOf,
  verifiedQuotes, viewForTopic, assertNotBlocked, planWarnings, attachToTopic, claimText, quotesOf, attributionOf, qualificationsOf };
