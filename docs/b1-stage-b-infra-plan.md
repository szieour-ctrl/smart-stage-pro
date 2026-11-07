# Stage B development infrastructure plan (Nov 7, 2026)

**Status: nothing provisioned, no migration applied.** Each numbered step needs its own approval.
No step changes a production value: step 1 only adds values for the branch `b1-stageb-dev`.

## 0. Prerequisite already in place
Team-login protection is ON for non-production deploys. That is why the page now starts the Stage B background function itself (`docs/b1-stage-b-step3-browser-dispatch.md`).

## 1. Netlify isolation for `b1-stageb-dev` (same site; production values untouched; $0)
Decision (Nov 7, 2026): use the existing site with deploy-context isolation. No second site.

**Method: branch-specific values only.**
- Every variable listed below gets a value for the specific branch `b1-stageb-dev`. Production, Deploy Preview and other branch values are left exactly as they are.
- CLI form: `netlify env:set NAME VALUE --context branch:b1-stageb-dev`. This adds only that branch's value.
- UI form: Site configuration → Environment variables → NAME → Options → Edit → "Different value for each deploy context" → "Add branch value" → `b1-stageb-dev`. Leave the Production row unchanged.
- **Do not** set `URL` or `DEPLOY_URL`: Netlify reserves both.
- Until a branch named `b1-stageb-dev` is pushed, these values have no effect on anything.

**a. Replaced with the development project's values** (database and browser config):

| Name | Value |
|---|---|
| `SUPABASE_URL` | `https://<dev-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | the dev project's service-role key |
| `SSP_PUBLIC_SUPABASE_URL` | the same dev URL |
| `SSP_PUBLIC_SUPABASE_ANON_KEY` | the dev project's anon key |

**b. Billing and self-calls:**

| Name | Value |
|---|---|
| `SITE_URL` | `https://b1-stageb-dev--smart-stage-pro.netlify.app` |
| `NETLIFY_URL` | `https://b1-stageb-dev--smart-stage-pro.netlify.app` |
| `INTERNAL_API_KEY` | a new random value, different from production |

The four billing callers send `debit-credit` to `${SITE_URL}`. With these values they reach the branch deploy, never production. If any call does reach production, production refuses it because the internal key differs.

**c. Neutralised** (Nov 7 review). Prefer an **empty** branch value: the code then fails before any network call.
- Paid providers, Stripe and Pabbly: each has a "not configured" check or no usable URL.
- Supabase: an empty URL gives no usable endpoint.
- Blobs: `@netlify/blobs` throws `MissingBlobsEnvironmentError` when the token is empty.

If Netlify refuses an empty value, use the agreed disabled placeholder (an invalid value that names this branch). For URLs use the same placeholder as a host under the reserved `.invalid` domain. A placeholder fails at authentication or name resolution, and nothing is charged or written.
- **Production database admin** (until step 2 provides dev values): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
- **Job storage (Netlify Blobs):** `NETLIFY_ACCESS_TOKEN`.
  - Every store passes this token explicitly.
  - The library would prefer a runtime Blobs context, but no function connects one (`connectLambda` is not used; all are `exports.handler`).
  - Verify on the first branch deploy that a Blobs call fails there.
- **Media storage:** `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET_NAME`.
- **Paid AI and data providers:** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `PERPLEXITY_API_KEY`, `ELEVENLABS_API_KEY`, `REPLICATE_API_KEY`, `BRIGHTDATA_API_KEY`, `RENTCAST_API_KEY`, `GOOGLE_MAPS_API_KEY`.
- **Payments:** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
- **Render service:** `RAILWAY_SECRET`, `WEBHOOK_SECRET`, `RAILWAY_RENDER_URL`, `RAILWAY_SMART_CORRECT_URL`, `RAILWAY_SMART_CORRECT_UPLOAD_URL`.
- **Customer email and webhooks:** `PABBLY_COMPLIANCE_REPORT_WEBHOOK_URL`, `PABBLY_VIDEO_DELIVERY_WEBHOOK_URL`, `PABBLY_TRANSACTIONAL_EMAIL_WEBHOOK_URL`, `PABBLY_IMAGE_PACK_WEBHOOK_URL`.
- **Signing secrets:** `REEL_SHARE_SECRET`, `PROMO_LINK_SECRET`.

**Billing check.** `video-job`, `smart-correct-usage`, `reel-quota-lib` and `video-notify` all send `debit-credit` to `${SITE_URL}` with `x-internal-key`. On this branch:
1. `SITE_URL` is the branch deploy, whose own `debit-credit` has no production database credentials.
2. A request that reached production would carry the development key. Production's `debit-credit` answers 401 before any database access (simulated Nov 7: wrong key, no key, and an unverifiable token all return 401).

**d. Stage B's own variables:** the table in step 5, on the same branch context.

**e. Build setting:** Site configuration → Build & deploy → Branches and deploy contexts → Branch deploys → "Let me add individual branches" → add `b1-stageb-dev`. This does not change Production or Deploy Previews.

**Already in place:** team-login protection covers branch deploys. The browser config on a non-production host comes from the server and refuses the production project (`ssp-public-config.js`).

## 2. Development Supabase project (Nov 7 review)
**Organizations:**
- The account has one Supabase organization, "SZ Real Estate Group", on the **Pro** plan. It holds production (`us-west-2`) and two other projects.
- **Free option:** create a new organization on the Free plan in the dashboard (Supabase allows 2 free projects per user across Free organizations; none are used today), then the project inside it. **$0**. It pauses after a week without activity.
- **Pro option:** a new project in the existing organization: Micro compute, about **$10/month**. The creation tool quotes the exact cost before anything is created.

**Project:** name `ssp-b1-stageb-dev`, region `us-west-2` (same as production).
- The connector's create tool doesn't offer `us-west-2`. Create it in the dashboard, or accept `us-west-1` through the connector.

**Schema import:** schema only, generated read-only from production's catalog. No rows are copied.
- Contents: extensions, the sequence, 31 tables, constraints, indexes, 16 functions, RLS on all tables, 22 policies, triggers including the two `auth.users` sign-up triggers, the trial-credit seed and the `ensure_rls` event trigger, and table/function privileges.
- The export is kept outside this public repository.

**Order:**
1. Schema export.
2. `20261101` (provider-request ledger).
3. `20261105` rev 3 (article evidence; needs `20261101`).

**Verified on a throwaway local PostgreSQL with Supabase-style roles and an `auth.users` stub:**
- All three apply cleanly, in that order.
- A new `auth.users` row creates its `public.users` row and one trial-credit ledger row.
- 34 tables, all with RLS. 22 policies.
- `anon` and `authenticated` cannot execute the reservation function.
- A newly created table gets RLS automatically.
- The production `MAINTAIN` privilege was stripped for the local PostgreSQL 16 check only.

**Seed after import:**
- 1–2 development users (sign up on the branch deploy).
- Then the Article-Led test projects (FA, FB, FC), inserted by SQL. No paid research call.

## 3. Railway worker (new project, 1 replica)
- **Image:** the `Dockerfile` in the private `ssp-b1-evidence` repo (branch `dev/stageb-worker`).
  - Python 3, pinned and hash-locked `beautifulsoup4==4.15.0` and `lxml==6.1.3`.
  - Ships only `src/`, the approved prompt and the policy file; no frozen articles. Runs as non-root.
  - Health check at `/healthz`.
- **Variables:**

  | Name | Value |
  |---|---|
  | `B1_WORKER_SECRET` | new random secret, ≥ 32 bytes, shared only with the Netlify branch deploy; never the render worker's secret |
  | `B1_WORKER_PLAINTEXT_BEHIND_TLS_PROXY` | `1` (Railway's edge terminates TLS) |
  | `B1_WORKER_HOST` | `0.0.0.0` |
  | `PORT` | set by Railway |

- **Network:** one Railway-generated public domain. No custom domain.
- **Cost:** about **$1–3/month** at 1 replica and idle most of the time. It falls inside the plan's included usage if the account is on Hobby ($5/month, includes $5 of usage).

## 4. Branch deploy `b1-stageb-dev`
- A Netlify branch deploy of the PR #219 branch. Team login protects it.
- It is never Production; Stage B refuses production hosts and the production database regardless.

## 5. Netlify variables for the `b1-stageb-dev` branch context only

| Name | Value |
|---|---|
| `AGENT_MARKETING_B1_EVIDENCE` | `dev` |
| `B1_STAGEB_USER_IDS` | the dev user UUID(s); an empty value denies everyone |
| `AGENT_MARKETING_ENABLED` | `true` |
| `AGENT_MARKETING_USER_IDS` | same dev user UUID(s) |
| `SUPABASE_URL` | `https://<dev-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | the **dev** project's service-role key (secret) |
| `SSP_PUBLIC_SUPABASE_URL` | same dev URL (the server checks they match) |
| `SSP_PUBLIC_SUPABASE_ANON_KEY` | the dev project's anon/publishable key (a service-role key is refused) |
| `B1_WORKER_URL` | `https://<railway-domain>` |
| `B1_WORKER_SECRET` | same value as on Railway (secret) |
| `B1_PROVIDER` | `mock` |
| `B1_STAGEB_MAX_PER_USER_DAY` / `B1_STAGEB_MAX_GLOBAL_DAY` | `3` / `10` (the defaults) |
| `AGENT_MARKETING_REQUEST_DAILY_LIMIT` / `AGENT_MARKETING_REQUEST_MONTHLY_LIMIT` | ledger limits; defaults apply if unset |

Stage B itself does not use `INTERNAL_API_KEY` or any paid provider key; on this branch those carry the step 1 values (a new internal key, and the disabled placeholders).

## Open items before a deployed mock run
- **Mock responses on a deploy:** `B1_PROVIDER=mock` needs the saved B1 responses (`B1_MOCK_RESPONSES_DIR`). Those are private and are not in this public repository, so they can't be bundled into Netlify functions.
  - Option A: the first deployed run stops at the provider step with `mock_no_response`. That run still proves auth, admission, the snapshot, the reservation and failure handling.
  - Option B: serve the saved responses from the private worker as a mock endpoint (offline, no network calls).
- **Paid provider call:** not implemented. It needs separate approval (about $0.02–$0.05 per article).
- **Controlled trial:** needs a named, authorized reviewer. The allowlist is still empty by instruction.

## Total recurring cost of steps 1–5
**$1–3/month** with a Free-org Supabase project, or **$11–13/month** with a Pro-org project. There are no paid AI calls.

## Verifying isolation on the real branch deploy
`/.netlify/functions/b1-env-check`:
- Answers only on `b1-stageb-dev--smart-stage-pro.netlify.app`; 404 on every other host and context. The branch deploy is behind team login.
- Reports each variable as `unset`, `empty` or `set`, never a value. A production value that leaked through shows as `set` and fails the check.
- Checks that `SITE_URL`/`NETLIFY_URL` point at the branch, that `INTERNAL_API_KEY` has its own value and that Stage B is off.
- Probes Blobs with a read of a key that does not exist; the expected result is `blocked`.

## Hosted mock tests
Both tests need the Railway worker: the article snapshot and the evidence gate run there.

**Test 1: authentication, ownership, reservation, idempotency, failure.**
- Setup: `B1_PROVIDER=mock` with no saved responses, so every run fails at the provider step after its reservation (`mock_no_response`).
- Prove:
  - no token → 401; a user outside the allowlist → 404; another user's project → 404;
  - start → dispatch → background → the snapshot is stored and one ledger reservation is made;
  - a second start while the job is live → `in_progress`, with no second reservation;
  - after the failure, a retry makes a new reservation;
  - the daily caps refuse further runs before any reservation;
  - the status response never contains evidence text.

**Test 2: full mocked evidence.**
- The private worker serves the saved B1 responses by request hash. This needs a small offline change in the private repo.
- Prove:
  - FA, FB and FC reach `ready`, with the approved held/validated counts;
  - an unchanged article reuses its result without a provider call;
  - the Planner refuses a BLOCKED, stale or tampered bundle;
  - held quotations never become verified script text.

Only after test 2 passes: the paid provider call, under separate approval.

## Nov 7 final isolation review (Netlify refuses empty values)
- **Placeholders:** cut-off variables use the agreed disabled placeholder, or that placeholder as a host under the reserved `.invalid` domain for URLs. The literal is not written in this repository: Netlify's secret scan matches repository text against branch environment values. `b1-env-check` reports them as `disabled`.
- **Secrets that verify inbound requests or sign links must be private random values, never the placeholder.** With a published placeholder, anyone could forge requests on the branch.
  - `WEBHOOK_SECRET`: render callbacks to `video-notify`, `reel-notify` and `smart-correct-notify`.
  - `STRIPE_WEBHOOK_SECRET`: `stripe-webhook`.
  - `REEL_SHARE_SECRET`: reel share links.
  - `PROMO_LINK_SECRET`: `create-promo-link`.
  - `INTERNAL_API_KEY`: server-to-server calls.
- **Legacy credentials:** `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `MIGRATION_SECRET`, `DECOR8_API_KEY` and `IMGBB_API_KEY` are no longer read by this code. If they exist on the site, Netlify still injects them into every function, so they get the placeholder (or stay absent).
- **Supabase:** `SUPABASE_URL` and `SSP_PUBLIC_SUPABASE_URL` must be the development project. If the keys are JWTs, the check reads their project and role, and nothing else.
- **No SDK picks up credentials on its own:** all S3 clients pass explicit credentials, the Cloudinary SDK is no longer loaded, and Blobs uses the explicit token.


## Nov 7: branch deploy configuration (owner-confirmed)
- Production branch `main`. Branch deploys: "Let me add individual branches", only `b1-stageb-dev`. Deploy Previews: enabled.
- `b1-stageb-dev` carries branch-specific values (development Supabase, a private `INTERNAL_API_KEY`, `WEBHOOK_SECRET` and `STRIPE_WEBHOOK_SECRET`, placeholders for every production integration and legacy credential). `AGENT_MARKETING_B1_EVIDENCE` is absent, so Stage B is off.
- `REEL_SHARE_SECRET` and `PROMO_LINK_SECRET` do not exist on the site: share links are then signed with a key derived from the development service-role key, and promo-link creation refuses every request.
- Verification: `/.netlify/functions/b1-env-check` on `b1-stageb-dev--smart-stage-pro.netlify.app` (states only, never values).
- Nov 7: branch-only redeploy of `b1-stageb-dev` requested by the owner so the deploy picks up the updated branch environment values (Netlify applies environment changes only to new builds). Verified with `b1-env-check`.
- Nov 7: second branch-only redeploy of `b1-stageb-dev` after the owner saved a new 64-character branch `INTERNAL_API_KEY` (Netlify shows only the last characters of a masked value; the length is confirmed by `b1-env-check`, never by displaying it).

## Nov 7: development fixture mode for the hosted FA/FB/FC evidence test (Option A, owner-approved)
- The private worker gains a fixture variant (`Dockerfile.fixtures`, `src/stageb_fixtures.py` in `ssp-b1-evidence`). Its two signed endpoints answer only for the frozen FA, FB and FC cases, and only if every file matches the approved hashes in `fixtures/manifest.json`. The normal worker image is unchanged and carries no frozen material.
- In SSP, on the `b1-stageb-dev` branch only:
  - `B1_SNAPSHOT_SOURCE=worker-fixture` takes the article from the fixture worker instead of a live fetch.
  - `B1_PROVIDER=worker-fixture` takes the saved B1 response for the exact frozen request.
  - Both work only with `AGENT_MARKETING_B1_EVIDENCE=dev` and an HTTPS worker. No live article is fetched and no AI provider is called.
- Seed: `dev_ops/hosted_test_seed.sql` in the private repository.

## Nov 7: Stage B switched on for the hosted FA/FB/FC run (branch only)
- Owner saved the eight `b1-stageb-dev` branch values: `B1_WORKER_URL` (fixture worker), `B1_WORKER_SECRET`, `B1_PROVIDER=worker-fixture`, `B1_SNAPSHOT_SOURCE=worker-fixture`, `AGENT_MARKETING_ENABLED`, `AGENT_MARKETING_USER_IDS`, `B1_STAGEB_USER_IDS` (the development test user), and last `AGENT_MARKETING_B1_EVIDENCE=dev`. Checked through the Netlify API by state only; none of them has a Production value.
- Branch-only redeploy of `b1-stageb-dev` so the new values reach the functions. `main` and Production are unchanged.
- Expected: `b1-env-check` now lists `AGENT_MARKETING_B1_EVIDENCE: set` as its one failing check, because that check was written while Stage B had to stay off. Every other check should still pass.
- `AGENT_MARKETING_ENABLED` is a Netlify secret variable, so its branch value cannot be read back. Temporary `/.netlify/functions/b1-flag-check` (branch deploy only, 404 elsewhere) returns only `{ agentMarketingEnabled: true|false }` by the feature's own rule. Remove it after the hosted run.
- Nov 7: first hosted FC attempt persisted nothing. The fixture worker answered `401` to every `POST /v1/fixture/article` (5 attempts, 18:42–18:47 UTC); the job fails in `prepare` before any evidence row or ledger reservation exists, so the status stayed `none` and the page polled for up to 17 minutes. Likely cause: the branch `B1_WORKER_SECRET` is not the fixture service's secret.
- `b1-flag-check` now also reports `workerAuth`: one signed request for a `.invalid` (never allowlisted) URL; `true` only when the worker's reply is signed for that request's nonce with the same secret (an unsigned 401 or 404 is not authentication). No article, no provider.
- The Article Evidence panel stops polling when the status is still `none` 150 s after a start (longer than a healthy job's two 60 s worker calls before its first record) and says the check could not start. It never retries by itself.
- Nov 7 (19:00 UTC): owner replaced the branch `B1_WORKER_SECRET` with the fixture service's value (Netlify: secret, scopes builds/functions/runtime, branch value only; other contexts empty). The diagnostic still reported `rejected_401_unsigned`. The only branch deploy visible through the API was built at 18:55, before that change, and no commit followed it. `b1-flag-check` now also reports the answering deploy id, the runtime secret's length and character class (never the value), the worker's refusal code and the clock difference; this commit also gives the branch a fresh build carrying the current value.
- Nov 7 (19:38 UTC): owner set `B1_STAGEB_MAX_PER_USER_DAY=4` as a `b1-stageb-dev` branch value only (every other context empty) so FC retry, FA and FB fit in one day after the failed FC attempt. To be removed (default 3) after the run. `b1-flag-check` reports the effective `stagebCaps`. FC's seeded topic title was corrected to the frozen `page_title`; the corrected request hashes to the approved frozen FC request.

## Nov 7: hosted frozen-evidence validation, final result (development only)
All three frozen Article-Led cases ran end to end through the hosted development pipeline (browser on `b1-stageb-dev` → start and background
functions → private fixture worker on Railway → development Supabase), with no live article fetch and no paid provider call (`cost_usd` null).

| Case | Outcome | provider_seq | Request sha256 | Response sha256 | Bundle payload sha256 (= reviewed `ssp_fixtures/bundles/<case>.json`) |
|---|---|---|---|---|---|
| FA | ready, PASSED_WITH_HOLDS (21 validated, 2 held) | 1001 | `5b226dc7…6056` | `9a8bf66e…207c` | `17978cb5…f07a` |
| FB | ready, COMPLETE (14 validated, 0 held) | 1001 | `50f2e09c…bc8c` | `cb35123e…1e49` | `764d1ef4…0e9d` |
| FC | ready, PASSED_WITH_HOLDS (10 validated, 4 held) | 1002 | `106a0007…80a3` | `e113061b…8d31` | `63b948c9…d988` |

- Each project's `article_evidence_id` points to its ready row; each row is linked to its own ledger reservation. Worker log per run:
  `fixture article 200 → snapshot 200 → fixture provider 200 → gate 200`.
- History kept: FC's first attempt (`failed`, `mock_no_response`, seq 1001, reservation kept). Four reservations in total.
- Issues found and fixed on the way: wrong branch `B1_WORKER_SECRET` (worker 401, nothing persisted); the evidence panel polled forever when
  no record was created (now stops after 150 s with a clear message); the stale branch build after a variable change (Netlify applies
  variables only to new builds); FC's seeded title missing " – Citrus Heights Sentinel" (request hash mismatch → `mock_no_response`; fixed in
  the dev database and on `ssp-b1-evidence` branch `dev/hosted-seed-fc-title`).
- Cleanup: temporary `b1-flag-check` removed; the temporary branch value `B1_STAGEB_MAX_PER_USER_DAY=4` removed (default 3 again).
  The evidence panel's polling fix stays.

### Remaining limitations
- Proven only for the three frozen articles via fixture mode: no live article fetch, no live B1 provider call (not implemented; paid).
- No reviewer authorized: held findings stay held (FA A1, FC headline).
- Stage B is still switched on for `b1-stageb-dev` (`AGENT_MARKETING_B1_EVIDENCE=dev`), behind the user allowlist and the 3/day cap.
- `b1-env-check` reports `AGENT_MARKETING_B1_EVIDENCE: set` as its one failing check while Stage B is on (expected).
- `b1-stageb-dev` carries commits PR #219's branch does not (evidence panel polling fix, this log). PR #219 remains draft and unmerged.
- The seed correction is not on `ssp-b1-evidence` `dev/stageb-worker` (both Railway workers build from it; merging rebuilds them).
- Nov 7 (after the hosted validation): Stage B switched OFF between test sessions. The owner removed the `b1-stageb-dev` branch value of
  `AGENT_MARKETING_B1_EVIDENCE` (no context has a value now); every Stage B endpoint answers 404 and the panel stays hidden. All other branch
  values (worker URL/secret, fixture provider and snapshot source, allowlists) are kept for the next session. Re-enable: add the branch value
  `dev` again and redeploy. `b1-env-check` should now report `ok: true` with `AGENT_MARKETING_B1_EVIDENCE: unset`.
