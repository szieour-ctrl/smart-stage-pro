# Stage B offline verification with the restored B1 workspace (Nov 5, 2026, development only)

SSP branch `claude/optimistic-allen-k7rcoj` at `c8b3ee3` (plus this note and a test comment). No provider call, no database, no deployment;
the Python and Node runs were made with networking disabled (`unshare -n`).

## Restored B1 workspace

| Item | Result |
|---|---|
| `SSP_B1_Workspace_stageb.zip` | sha256 `cf922d066fdcd8d8de2134ffc97ccf6a23942ec19b0d330e71970047d6968373`; extracted to an isolated scratch directory |
| `SSP_B1_History_stageb.bundle` | sha256 `2c66971ece1b8e24cb42349ec11c7abc94f9e0a92e024652f7353a410f3148cb`; `git bundle verify`: complete history |
| Branch heads | bundle and zip agree on all 7: `dev/article-led-integration` `1445dd7` (HEAD), `dev/integration` `2a184be`, `dev/evidence-review` `9b73a30`, `dev/qrec-1` `c22024d`, `dev/v1.2.1` `53b6efe`, `dev/v1.2-armA-corrections` `3aff481`, `dev/v1.2-candidate` `a4e8269` |
| Files | a clone of the bundle is byte-identical to the zip's working tree (including `frozen/`); `git fsck` clean; working tree clean |
| Frozen evidence | `frozen/v121_run` and `frozen/armA_run` SHA256SUMS: 0 mismatches |
| Dependencies | Python 3.13, `beautifulsoup4==4.15.0`, `lxml==6.1.3` (as pinned in `requirements.txt`), in a separate venv |
| Reviewer allowlist | `policy/authorized_reviewers.json` empty (unchanged) |
| B1 tests | `tests/run_all.py`: **259 run, 0 failures, 0 errors, 0 skipped** |
| Python gate | used as shipped; not modified, rebuilt or replaced |

## SSP results

- `B1_WORKSPACE=<workspace> node --test tests/agent-marketing-b1-e2e.test.js`: **5 of 5 pass, 0 skipped** (with the system `python3` and with the
  pinned venv via `B1_BRIDGE_PYTHON`). The three tests previously skipped now run:
  1. full offline path on FA, FB, FC: the bridge reproduces each frozen v1.2.1 request byte for byte and each reviewed bundle; statuses
     PASSED_WITH_HOLDS / COMPLETE / PASSED_WITH_HOLDS; FA A1 held, A6 and A7 validated; no held or excluded quotation reaches the Planner input
     or verified text; PASSED_WITH_HOLDS labelled INCOMPLETE; an unsupported figure is blocked on both attempts;
  2. no second B1 run for an unchanged article; a changed article fails `source_changed`; stored evidence immutable;
  3. bad captures (short, bot wall, 404, non-HTML, cross-site redirect) and tampered snapshot/gate replies fail closed.
- Full suite with `B1_WORKSPACE` set: **653 tests, 653 pass, 0 fail, 0 skipped**.

## Defects found

**D1: the content gate did not enforce FC's held headline. RESOLVED (approved with modification, Nov 5, 2026).** FC's held `headline_claims`
quotation states a figure with a period and a geography. The same figure is also validated through a shorter quotation without that framing,
and the gate checked numbers only, so a script restating the held headline passed. (The quotations are in the private B1 workspace.)

Fix: `lib/agent-marketing-b1-claims-lib.js`, called by the gate only when the topic carries B1 evidence and the switch is on. No blanket n-word rule.
1. A held or excluded quotation of five or more words restored verbatim is blocked (`b1_held_quote`), unless a validated quotation contains it.
2. A number does not authorize a claim: each sentence's article figures (any figure that appears in the B1 evidence, minus the agent's intake,
   report and report-derived numbers) must all come from ONE validated claim finding whose own quotations support every period or comparison
   basis, geography, measurement, direction and name the sentence states. A hedge on the figure ("a slight", "around") and a measurement basis
   ("median") must be kept (`b1_claim_context`). A figure only held or excluded findings give, or figures from two findings in one sentence,
   are blocked (`b1_unsupported_figure`). Attribution names a source (as a whole name) but never supplies geography or period.
3. Rule 2f unchanged: report figures are exempt, and on a report-first topic B1 figures stay blocked by the legacy rule. BLOCKED evidence
   authorizes no article figure. With B1 disabled the gate's input and output are identical to before.

Tests: `tests/agent-marketing-b1-d1.test.js` (11) and two added e2e assertions through the real Python gate and `generatePlan`.

No other integration defect: the bridge ran unchanged against the real workspace, and every Node-side check agreed with the Python gate.

## B1 workspace merge readiness

`dev/integration` (`2a184be`) is an ancestor of `dev/article-led-integration` (`1445dd7`): the merge is a fast-forward, and the merged tree passes
259 of 259 (checked in a scratch clone). Merged (approved, Nov 5, 2026): `dev/integration` fast-forwarded to `1445dd7` in the restored workspace; 259 of 259 pass after the merge.

## Private fixtures, Planner prompt gate and HTTPS worker (Nov 5, 2026)

- **Private fixtures.** Every B1 bundle, the frozen request and response, and every article-derived test string now load from the private
  B1 workspace (`ssp_fixtures/`, `frozen/v121_run/`) through `B1_WORKSPACE` (`tests/helpers/b1-private.js`). Hashes are checked against the
  workspace manifests; a missing or changed file fails the run. Without `B1_WORKSPACE` the dependent tests are skipped with the reason
  ("B1 private fixtures not configured ..."); `B1_FIXTURES_REQUIRED=1` turns that into a failure. History remediation:
  `docs/b1-public-history-remediation.md`.
- **Planner prompt gate.** Rules 2b, 2g and 2h use the B1 wording only with `AGENT_MARKETING_B1_EVIDENCE=dev`. Otherwise `buildSystemPrompt()`
  is byte-identical to production `main` (sha256 `25f3118f…0495`); with `dev` it is the approved B1 prompt (sha256 `bcde4707…26e1a`).
  Tests: `tests/agent-marketing-b1-prompt-flag.test.js`.
- **HTTPS worker.** `lib/agent-marketing-b1-bridge-lib.js` uses the private worker (B1 workspace `src/stageb_worker.py`) when `B1_WORKER_URL`
  (https only) and `B1_WORKER_SECRET` (at least 32 bytes) are set. Requests and replies are HMAC-signed, and a reply counts only if it is signed
  for that request's nonce. `checkSnapshot` and `checkGate` still run on every reply. Tests: `tests/agent-marketing-b1-worker.test.js`
  (the real worker on 127.0.0.1 with a throwaway certificate). Not deployed.
- Results, run with no external network: SSP **672 / 672** with `B1_WORKSPACE` and `B1_FIXTURES_REQUIRED=1` (0 skipped); 639 pass and 33 are
  skipped with the reason without it. B1 workspace (`dev/stageb-worker` at `c321f67`): **271 / 271**.
