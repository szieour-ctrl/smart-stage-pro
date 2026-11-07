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

If Netlify refuses an empty value, use the placeholder `b1-dev-disabled`. For URLs use `https://b1-dev-disabled.invalid`. A placeholder fails at authentication or name resolution, and nothing is charged or written.
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

Stage B itself does not use `INTERNAL_API_KEY` or any paid provider key; on this branch those carry the step 1 values (a new internal key, and the `b1-dev-disabled` placeholders).

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
- **Placeholders:** cut-off variables use `b1-dev-disabled`, or `https://b1-dev-disabled.invalid` for URLs. `b1-env-check` reports them as `disabled`.
- **Secrets that verify inbound requests or sign links must be private random values, never the placeholder.** With a published placeholder, anyone could forge requests on the branch.
  - `WEBHOOK_SECRET`: render callbacks to `video-notify`, `reel-notify` and `smart-correct-notify`.
  - `STRIPE_WEBHOOK_SECRET`: `stripe-webhook`.
  - `REEL_SHARE_SECRET`: reel share links.
  - `PROMO_LINK_SECRET`: `create-promo-link`.
  - `INTERNAL_API_KEY`: server-to-server calls.
- **Legacy credentials:** `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `MIGRATION_SECRET`, `DECOR8_API_KEY` and `IMGBB_API_KEY` are no longer read by this code. If they exist on the site, Netlify still injects them into every function, so they get the placeholder (or stay absent).
- **Supabase:** `SUPABASE_URL` and `SSP_PUBLIC_SUPABASE_URL` must be the development project. If the keys are JWTs, the check reads their project and role, and nothing else.
- **No SDK picks up credentials on its own:** all S3 clients pass explicit credentials, the Cloudinary SDK is no longer loaded, and Blobs uses the explicit token.

