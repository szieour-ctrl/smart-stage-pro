# Stage B development infrastructure plan (Nov 7, 2026)

**Status: nothing provisioned, no migration applied.** Each numbered step needs its own approval.
Production configuration is not changed by any step except step 1, which narrows production secrets so they stop reaching non-production deploys.

## 0. Prerequisite already in place
Team-login protection is ON for non-production deploys. That is why the page now starts the Stage B background function itself (`docs/b1-stage-b-step3-browser-dispatch.md`).

## 1. Netlify scoping (production config change; smallest step, $0)
- Scope every production-only secret to the **Production** context only. Previews and branch deploys must not inherit them.
  - Paid provider keys: `ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`.
  - Admin credentials: `SUPABASE_SERVICE_ROLE_KEY` (production), `STRIPE_*`, `S3_*`, `NETLIFY_ACCESS_TOKEN`, `INTERNAL_API_KEY`.
  - Production URLs: `SITE_URL`, `NETLIFY_URL`.
- Give the `b1-stageb-dev` **branch deploy** context only the variables in step 5. No other context gets them.
- How to check afterwards without reading values: in each variable's "Deploy contexts" panel, the Branch deploys and Deploy Previews rows are empty.

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

Not set on this context: `INTERNAL_API_KEY` (Stage B no longer uses it) and every paid provider key.

## Open items before a deployed mock run
- **Mock responses on a deploy:** `B1_PROVIDER=mock` needs the saved B1 responses (`B1_MOCK_RESPONSES_DIR`). Those are private and are not in this public repository, so they can't be bundled into Netlify functions.
  - Option A: the first deployed run stops at the provider step with `mock_no_response`. That run still proves auth, admission, the snapshot, the reservation and failure handling.
  - Option B: serve the saved responses from the private worker as a mock endpoint (offline, no network calls).
- **Paid provider call:** not implemented. It needs separate approval (about $0.02–$0.05 per article).
- **Controlled trial:** needs a named, authorized reviewer. The allowlist is still empty by instruction.

## Total recurring cost of steps 1–5
**$1–3/month** with a Free-org Supabase project, or **$11–13/month** with a Pro-org project. There are no paid AI calls.
