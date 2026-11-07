# Stage B, step 1: offline operational implementation (Nov 5, 2026; development only, nothing deployed)

## A. Per-deployment browser Supabase configuration
- `ssp-public-config.js` (loaded first by `index.html`, `agent-marketing.html`, `gallery.html`) sets `window.SSP_PUBLIC_CONFIG`:
  - **Production hosts** (`smartstagepro.com`, `www.`, `smart-stage-pro.netlify.app`, `main--smart-stage-pro.netlify.app`): the production URL,
    anon key and project ref, byte-identical to what the pages had hardcoded, with no network request.
  - **Any other host:** a synchronous `GET /.netlify/functions/public-config`.
  - Anything missing or inconsistent stops the page with a visible message and creates no Supabase client. It never falls back to production.
- `public-config` (lib `public-config-lib.js`) answers 200 only when all of these hold; otherwise 503 with a code:
  - `SSP_PUBLIC_SUPABASE_URL` equals the server's `SUPABASE_URL` (so browser and server sign-in use the same project);
  - the key is an anon or publishable key for that project, never a service-role or secret key;
  - outside production, the project is not the production project.
- Netlify variables (non-production contexts only): `SSP_PUBLIC_SUPABASE_URL`, `SSP_PUBLIC_SUPABASE_ANON_KEY`. Production needs none.
- Tests: `tests/ssp-public-config.test.js`. It covers the library, the function, the static script in a sandbox, and the three real pages in
  Chromium under a production host and a preview host (configured and unconfigured).

## B. Worker packaging (private repository `ssp-b1-evidence`, `dev/stageb-worker`)
- **Dockerfile:** pinned base image; hash-locked dependencies (`requirements.lock`); only `src/`, the approved prompt and the policy; non-root.
- **railway.json:** 1 replica, `/healthz`.
- **Worker:** reads `PORT`; caps connections; TLS handshake outside the accept loop. No frozen material is in the image (tested on a real image).

## C. Owner-only Stage B pathway
- **Endpoints:**
  - `POST /.netlify/functions/agent-marketing-stageb {action:"start", projectId}` → `202 {state:"queued"|"reserved"|"running", code?}` or
    `200 {state:"ready", reused}`.
  - `GET ?projectId=` → `{state:"none"|"reserved"|"running"|"ready"|"failed", completeness, counts:{validated,held,excluded}, error, reused,
    attached, createdAt, finishedAt}`. Never the snapshot, request, raw response or bundle text.
  - `agent-marketing-stageb-background` is internal only (`x-internal-key`).
- **Admission, checked on every request, start and background alike:**
  - `AGENT_MARKETING_B1_EVIDENCE=dev`;
  - Agent Marketing enabled for the user;
  - the user listed in `B1_STAGEB_USER_IDS` (an empty or missing list denies everyone);
  - `SUPABASE_URL` is not the production project (503);
  - the project belongs to the signed-in user (another user's project reads as 404);
  - Local Market Insider with a selected Article-Led topic (409).
- **Job state:** a row of `agent_marketing_article_evidence`, never `agent_marketing_jobs`:
  `(none) → reserved → running → ready | failed`; reused copies are inserted as `ready`; stale `reserved`/`running` rows (> 16 min) are retired as
  `failed` (`stale`) and retried.
- **Order of operations in the background job:**
  1. Admission.
  2. Snapshot via the worker; an atomic insert refuses a second in-flight run per cache key; reuse a ready result.
  3. B1 caps (`B1_STAGEB_MAX_PER_USER_DAY`, default 3; `B1_STAGEB_MAX_GLOBAL_DAY`, default 10).
  4. The atomic per-user ledger reservation (`agent_marketing_reserve_provider_request`, sequence 1001+ on the research run).
  5. Conditional `reserved → running` with the reservation.
  6. The provider (mock only).
  7. The Python gate via the worker, plus Node's own checks.
  8. Conditional `running → ready`, or `failed` (BLOCKED gives `evidence_blocked`).
  9. Attach `article_evidence_id`.
- The paid provider is absent: `B1_PROVIDER` other than `mock` fails the run before any reservation (`provider_not_implemented`).
- **Planning:** `agent-marketing-plan-background` calls `withPlanEvidence`. With the switch on, an Article-Led topic carries only its checked evidence
  row; a missing, tampered, stale or BLOCKED row, or a database error, is BLOCKED before any model call. Switch off: unchanged.
- **Migration 20261105 revision 3 (R11):** `provider_seq`, `provider_reservation_id`; no `running`/`ready` from a call without a reservation; set
  once. It depends on 20261101, which must be applied first. Verified by `scripts/b1-migration-check.sh` (41 checks).

## D. Results (no external network)
- SSP with `B1_WORKSPACE` and `B1_FIXTURES_REQUIRED=1`: 688 / 688 pass.
- Without the workspace: 646 pass, 42 skipped with the reason.
- Private repository: 285 offline tests, plus 4 container tests against the built image.
