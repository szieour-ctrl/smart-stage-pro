// Private B1 fixtures for the public tests (development only).
//
// smart-stage-pro is a PUBLIC repository. The B1 prompt, the frozen article text, the exported evidence bundles and every article-derived test
// sentence live in the private B1 workspace (szieour-ctrl/ssp-b1-evidence), never here. Tests load them through B1_WORKSPACE:
//   - B1_WORKSPACE unset            -> `skip` is a reason string: the dependent tests are SKIPPED and say why (never a silent pass).
//   - B1_WORKSPACE unset and B1_FIXTURES_REQUIRED=1 -> loading throws: the run FAILS (use this in CI).
//   - B1_WORKSPACE set but a file is missing or a sha256 does not match its manifest -> loading throws: the run FAILS.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const REASON = "B1 private fixtures not configured: set B1_WORKSPACE to the private ssp-b1-evidence workspace (B1_FIXTURES_REQUIRED=1 makes this a failure)";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

function verifyManifest(dir, manifest, files) {
  const p = path.join(dir, manifest);
  if (!fs.existsSync(p)) throw new Error(`B1 private fixtures: ${p} is missing`);
  const want = Object.fromEntries(fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { const m = l.match(/^([0-9a-f]{64})\s+\*?(.+)$/); return m ? [m[2].trim(), m[1]] : null; }).filter(Boolean));
  for (const f of files) {
    const fp = path.join(dir, f);
    if (!fs.existsSync(fp)) throw new Error(`B1 private fixtures: ${fp} is missing`);
    if (!want[f]) throw new Error(`B1 private fixtures: ${f} is not listed in ${p}`);
    if (sha(fs.readFileSync(fp)) !== want[f]) throw new Error(`B1 private fixtures: ${fp} does not match its sha256 in ${manifest}`);
  }
}

function load(env) {
  const e = env || process.env;
  const ws = String(e.B1_WORKSPACE || "");
  if (!ws) {
    if (String(e.B1_FIXTURES_REQUIRED || "") === "1") throw new Error(`B1_FIXTURES_REQUIRED=1 but ${REASON}`);
    return { skip: REASON, workspace: null };
  }
  const fx = path.join(ws, "ssp_fixtures"), run = path.join(ws, "frozen", "v121_run");
  verifyManifest(fx, "SHA256SUMS", ["bundles/FA.json", "bundles/FB.json", "bundles/FC.json", "bundles/BLOCKED.json", "cases.json"]);
  verifyManifest(run, "SHA256SUMS.txt", ["FA.request.json", "FA.response.json", "FB.request.json", "FB.response.json", "FC.request.json", "FC.response.json"]);
  const cases = JSON.parse(fs.readFileSync(path.join(fx, "cases.json"), "utf8"));
  return {
    skip: false, workspace: ws, cases,
    bundle: (n) => JSON.parse(fs.readFileSync(path.join(fx, "bundles", `${n}.json`), "utf8")),
    request: (c) => fs.readFileSync(path.join(run, `${c}.request.json`), "utf8"),
    response: (c) => fs.readFileSync(path.join(run, `${c}.response.json`), "utf8"),
  };
}

/** FA control items of the B1 workspace scorer (src/score_b1.py), with the article markers read from the private cases. */
function faItems(items, cases) {
  const k = cases.fa_markers;
  const C = items.filter((x) => x.section === "source_contradictions").map((x) => [x.finding.first && x.finding.first.quote, x.finding.second && x.finding.second.quote, x.finding.what_differs, x.finding.could_be_explained_by].filter(Boolean).join(" "));
  const D = items.filter((x) => x.section === "extraction_defects").map((x) => [x.finding.quote, x.finding.problem].filter(Boolean).join(" "));
  return {
    A1: C.some((t) => k.A1_all.every((s) => t.includes(s))),
    A6: C.some((t) => k.A6_any.some((s) => t.includes(s))),
    A7: C.concat(D).some((t) => k.A7_any.some((s) => t.includes(s))),
  };
}

const P = load();
if (P.skip && !load.warned) { load.warned = true; process.emitWarning(P.skip, { code: "B1_FIXTURES_SKIPPED" }); }
module.exports = { ...P, load, faItems, REASON };
