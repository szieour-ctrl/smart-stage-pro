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

## 2. Development Supabase project (new hosted project)
- **What it contains:** a schema-only copy of production `public`, plus the two `auth.users` triggers (user row and trial-credit seed). No rows are copied.
  - Then apply migration `20261101` (provider-request ledger), then `20261105` rev 3 (`docs/proposed-migrations/`, verified locally by `scripts/b1-migration-check.sh`).
  - It is not a Supabase branch: production's tracked migration history starts in July 2026 and lacks the base tables.
- **Cost:**
  - **$0** in a Free organization (2 free projects per org; pauses after a week idle).
  - About **$10/month** as a new project in the existing Pro organization (Micro compute, $0.01344/hour). That org's included $10 compute credit is already used by production.
  - These are prices recorded Nov 5, 2026; confirm in the Supabase dashboard when creating.
- **Seed data, created there, never copied:**
  - 1–2 dev users (sign-up on the dev deploy).
  - One Local Market Insider project per frozen case (FA, FB, FC), with its Article-Led topic inserted by SQL. This avoids a paid Stage A research call.

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
