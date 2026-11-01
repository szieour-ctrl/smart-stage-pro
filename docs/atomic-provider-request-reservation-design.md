# Provider-request limits: boundary behavior and the atomic reservation design (PR #217 follow-up)

Status: **design and proposed migration only. Nothing here has been applied to Supabase, merged or deployed.** The migration needs its own authorization.

## 1. Request accounting at the quota boundary (demonstrated)

`tests/agent-marketing-quota-boundary.test.js` runs the real `runResearch` with the same wiring the background function uses (`requestAllowance` before every dispatch, the count persisted before every dispatch). Limits are the defaults, 15 per 24 hours and 100 per 30 days.

| Start | Provider behavior | Requests sent | Day total after | Outcome |
|---|---|---|---|---|
| 14/15 | success (3 opportunities) | 1 (municipal) | 15 | housing lane `not_attempted`; partial result kept, uncharged |
| 14/15 | HTTP 429 | 1 | 15 | no retry (it would be the 16th); failed, uncharged |
| 14/15 | HTTP 500 | 1 | 15 | the failed request still counts; failed, uncharged |
| 14/15 | network error | 1 | 15 | counted; not retried past the limit |
| 15/15 | any | 0 | 15 | first request refused ("did not use a session"); nothing counted |
| 13/15 | 429 on request 1, then success | 2 (municipal, retry) | 15 | retry fits; housing refused |
| 12/15 | success, 5 distinct opportunities | 2 | 14 | charged once |
| 12/15 | success, fewer than 5 | 2 | 14 | uncharged partial |
| 99/100 (month) | success | 1 | month 100 | the monthly limit binds the same way |
| rows unreadable | any | 0 | n/a | fails closed |
| 1 already persisted, worker re-run, 13 others | success | 1 more | 15 | resumes from the persisted count |

A sweep of every starting point 0..15 against success, 500 and 429 never ended above 15, and `providerRequests` always equalled the number of requests actually sent. Requests older than 24 hours or 30 days leave the window.

## 2. Admission headroom versus the per-dispatch check (reconciled)

- **Admission** (`admit`) refuses a start only when no request fits (`used + 1 > limit`). It is an early, friendly refusal.
- **Per-dispatch** (`requestAllowance`) runs before every outbound request: other rows + this session's own count + 1 must fit both limits.

So a session admitted at 14/15 gets exactly one request and can never send a second. **An ordinary sequential session cannot exceed a limit.** My earlier note that admission headroom could let a session overshoot by one or two requests was wrong for this case; the only effect is that a session admitted near the limit ends early with a partial or failed result.

What remains possible is concurrency, not sequence:

1. **Two sessions of one user checking at the same instant.** Prevented today by one in-flight Article-Led session per user (checked before and after the row insert, ordered by created_at then id). The window is small but the check is read-then-dispatch, not atomic. This is what the reservation below closes.
2. **A re-executed worker.** Found during this review: Netlify can re-run a background function that crashed, and the new execution started its count at 0 and wrote it back lower. Fixed in this PR: `runResearch` takes `startingRequests` from the persisted count (Article-Led rows only).
3. **Clock or tie ordering in the post-insert recheck.** Ties break by id; no known gap, but it is another reason to prefer a database-side serialization.

## 3. Atomic reservation design

Files: `docs/proposed-migrations/20261101_agent_marketing_provider_request_reservation.up.sql` and `.down.sql`. Not in `supabase/migrations/`, so nothing runs them by accident.

**Schema (additive only).**
- `agent_marketing_provider_requests`: one row per reserved outbound request (`user_id`, `research_id`, `seq`, `reserved_at`, optional `outcome`). `unique (research_id, seq)` makes a retried reservation call idempotent. `research_id` is `on delete set null`, so deleting a project or research row never resets usage. RLS on, no policies.
- `agent_marketing_provider_request_cutover`: a one-row marker. Rows created before it are counted from their own `usage` (the bridge below); rows after it only through the ledger.
- Functions: `agent_marketing_reserve_provider_request(user, research, seq, daily, monthly)`, `agent_marketing_prune_provider_requests(keep)`, `agent_marketing_safe_int(text)`. `security definer`, fixed `search_path`, execute revoked from public/anon/authenticated, granted to `service_role` only.

**Reservation semantics.** One call = take a slot or refuse. It takes a per-user transaction advisory lock (`pg_advisory_xact_lock` on a hash of the user id), so one user's reservations are serialized and different users never wait on each other. Under the lock it replays an existing (research, seq), counts the 24-hour and 30-day windows, and inserts only if both fit. It returns `{allowed, scope, used, limit}`. The slot is reserved before the request is sent, so a failed or crashed request still counts.

**Backward compatibility.** Pre-ledger Article-Led rows are counted exactly like `requestsOf` (providerRequests, else attempts with a minimum of 1, running at least 1, withdrawn 0). Legacy research, other tables, columns and policies are untouched. Because Article-Led is not live, the bridge is expected to count nothing in production.

**Application change (not yet made).** In `agent-marketing-research-background.js`, `quotaFn` becomes one call to `POST /rest/v1/rpc/agent_marketing_reserve_provider_request` through the existing `supabase()` helper, with `seq = dispatched + 1`. Any error or unreadable response still fails closed. `countedCall` still increments only after an allowed reservation. `onDispatch` keeps writing `usage.providerRequests` for display, rollback and the bridge. The admission checks in `agent-marketing-research.js` stay as the early refusal. Until the migration is applied the code must not be deployed with Article-Led on; the existing per-request check remains the interim control.

**Concurrency tests (run against a throwaway local Postgres, never Supabase).** `scripts/reservation-concurrency-check.js` (`npm i --no-save embedded-postgres pg`, then run it). Result: **16 of 16 pass**.
- 50 simultaneous reservations against a limit of 15: exactly 15 allowed, 35 refused, 15 ledger rows.
- Starting at 14/15 with ten simultaneous sessions: exactly one allowed (also with ten real running research rows).
- Two users, 20 concurrent each: 15 each, no cross-blocking.
- Retried call is idempotent; monthly limit binds alone (99/100); windows roll (25-hour and 31-day rows).
- Pre-ledger rows count like `requestsOf`; a post-cutover running row is not double-counted; no double count once a row has ledger rows.
- anon and authenticated cannot call the function or read the ledger; RLS is on; bad arguments are rejected uncounted.
- Deleting a research row does not release its usage; prune removes only old rows.
- Existing tables unchanged; rollback removes everything it created and the migration re-applies cleanly; the up-migration applies twice without error.

One design bug was found and fixed by these tests: counting a session's own `running` row as 1 before its first reservation over-counted concurrent starts. The cutover marker replaced that.

**Rollout order (each step needs approval).** 1) Apply the up-migration (Article-Led still off). 2) Deploy the code that calls the function (still off). 3) Verify with the concurrency script against a Supabase branch. 4) Only then enable Article-Led for a pilot user.

**Rollback.** Turn Article-Led off, redeploy the previous quota check if needed, then run the `.down.sql`. No usage is lost: every row still carries `usage.providerRequests`.

## 4. Production environment (must be confirmed in the Netlify dashboard)

The Netlify connector can read projects and deploys but has no operation that reads environment variables, so the live values are **not verified by me**. What I verified: production is deployed from `main` at `91fcf15` (the merge of PR #216), which does not contain the Article-Led code, so no variable can enable it until PR #217 is deployed. Before enabling, confirm in Site configuration > Environment variables, across all scopes and deploy contexts, that none of these is set: `AGENT_MARKETING_ARTICLE_LED_ENABLED`, `AGENT_MARKETING_ARTICLE_LED_LANES`, `AGENT_MARKETING_ARTICLE_LED_GAPFILL`, `AGENT_MARKETING_ARTICLE_LED_DIAGNOSTICS`, `AGENT_MARKETING_ARTICLE_LED_DESIGN`, and that `AGENT_MARKETING_RESEARCH_DEBUG` is not `true` (it adds usage to client responses).

## 5. What the browser receives

Article-Led topics are stored with a full candidate record and a discovery trace. Those are no longer sent: `clientTopic()` removes `candidate` and `discovery` from every response that returns a topic (research GET and list, the chosen-topic response, the project endpoint), and the provider model name is omitted for Article-Led rows. Storage is unchanged, so the plan stage still reads the full topic. Usage is only sent with `AGENT_MARKETING_RESEARCH_DEBUG=true`. Legacy topics pass through unchanged. Covered by the "client response" test in `agent-marketing-article-led-endpoint.test.js`.
