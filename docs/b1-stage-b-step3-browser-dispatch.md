# Stage B step 3: the page starts the background job (Nov 7, 2026)

Development only. Everything here is off unless `AGENT_MARKETING_B1_EVIDENCE=dev`.

## Why
A development deploy sits behind Netlify team login, so one function cannot call another function on the same deploy over HTTP.
The background function also must not trust a user ID that another function hands it.

## Flow
1. **Status:** the page sends `GET agent-marketing-stageb?projectId=` with the user's Bearer token.
   - 404 means Stage B is not offered for this user or project, and the panel stays hidden.
   - On the production config (`ssp-public-config` env `production`) the page never sends this request.
2. **Start:** the page sends `POST agent-marketing-stageb { action: "start", projectId }`. This request only runs checks.
   - 202 `{ state: "dispatch" }`: go to step 3.
   - 202 `{ state: "reserved" | "running", code: "in_progress" }`: a job is already live.
   - 200 `{ state: "ready" }`: the evidence already exists.
   - Refusals: 401, 404, 409, or 503 on a production host or production database.
3. **Background job:** the page sends `POST agent-marketing-stageb-background { projectId }` with its own Bearer token.
   - The function verifies the token with Supabase. The user is always the token's user; a `userId` in the body is ignored.
   - It then repeats every check (`precheck`), and only after that runs `runJob`. This is the same snapshot, ledger reservation, mock provider, Python gate and attach as before.
   - There is no internal-key path, and Stage B no longer needs `INTERNAL_API_KEY`.
4. **Polling:** the page polls the status every 5 s, for up to 17 minutes, until the state is `ready` or `failed`.
   - The status contains no evidence text.

## Checks, applied at the start and again in the background job
- `AGENT_MARKETING_B1_EVIDENCE=dev`.
- Agent Marketing is enabled for the user.
- The user is in `B1_STAGEB_USER_IDS`. An empty or missing list denies everyone.
- `SUPABASE_URL` is not the production project.
- The request host is not a production host.
- The project belongs to the token's user.
- The project is Local Market Insider with an Article-Led topic selected.

## What is unchanged
- **Job tracking:** in `agent_marketing_article_evidence` rows, with every state change conditional on the current state.
- **Concurrency:** one in-flight row per cache key (enforced by the database).
- **Reservations:** the ledger reservation is made before any provider call. There are per-user and global daily caps.
- **Retries:** a failed run can be retried with a new reservation. A stale `reserved`/`running` row (older than 16 minutes) is retired by the next start or background call.
- **Provider:** only the mock exists (`B1_PROVIDER=mock`). The paid provider is not implemented.
- **Python evidence gate:** unchanged, reached through the worker (`B1_WORKER_URL`) or a local child process (`B1_WORKSPACE`).

## Tests
- `tests/agent-marketing-b1-stageb-flow.test.js`, which runs against the real worker and the frozen FA/FB/FC fixtures:
  - token-only background admission;
  - a forged body `userId`;
  - the page skipping the start request;
  - duplicate and concurrent background calls (one provider call, one reservation).
- `tests/b1-production-isolation.test.js`:
  - no function-to-function call in the Stage B path;
  - production hosts refused at both the start and the background job;
  - the exact list of background dispatchers;
  - the page's Stage B code: never asked on production, Bearer token, `projectId` only.
- **Browser check** (headless Chromium, every server call mocked):
  - on the development config, the panel appears; clicking it sends the start request, then the background call with a Bearer token and only `{ projectId }`; polling then shows "ready";
  - on the production config, the page makes no Stage B request.
