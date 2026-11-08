# B1 Stage B: Live-Fetch milestone, test specification (implemented Nov 8, 2026; hosted Layer C run accepted Nov 8)

Nov 7, 2026. Development only (`b1-stageb-dev`, development Supabase `ooxigbxthabstahrexia`, Railway project `ssp-b1-stageb-worker`).

**Goal:** prove that Stage B captures a *live* article correctly, recognises an unchanged source, refuses a changed one with
`source_changed`, and fails closed with an explicit, durably recorded code for every other case. No paid call of any kind is made or possible.

**Non-goals:** live B1 provider call, Perplexity or any research call, Planner/script generation, production deployment, reviewer authorization.

## 1. Where the code stands today (read from the code, Nov 7)

| Area | Current behaviour | Gap for this milestone |
|---|---|---|
| Live fetch (`bridge-lib.fetchArticle`) | Plain GET, follows redirects, 20 s timeout, needs HTTP 200, `content-type` containing `html`, ≤ 4 MB, same site after redirects (`www.` ignored). | Every non-200, network error and timeout is the same code `inaccessible`. The 4 MB check runs only after the whole body is downloaded. No scheme/host hardening (http allowed, IP literals allowed). |
| Snapshot (worker `snapshot` op) | Extracts article text; refuses `incomplete` (too little text) and `inaccessible` (script/robot-check/paywall-like page). The cache key is the hash of the **extracted text**, not the raw HTML, so markup-only changes (ads, timestamps) do not count as a change. | Worker `inaccessible` reuses the fetch code: the stage is ambiguous. |
| Unchanged vs changed | `prepare()` compares the new snapshot key with the project's existing non-failed row: same key → reuse, different key → `source_changed`. Both happen **before** any reservation. | Not reachable for a project that already has a `ready` row: `precheck()` returns `ready` without fetching. There is no way to re-check a source. |
| Failure recording | Failures after the evidence row exists are stored on the row (`error`). | Failures **before** the row exists (fetch, snapshot, `source_changed`) are stored nowhere: the evidence table needs `snapshot_text`, `cache_key`, `request_text` (NOT NULL). The page only learns "could not start" after 150 s. |
| Retry safety | Pre-row failures consume no reservation and no daily-cap slot (proven by the five 401 runs on Nov 7). A failed row never blocks a retry. | None. Must be re-proven for every new code. |
| Provenance | Row keeps `source_url`, `final_url`, `raw_html_sha256`, `extractor_sha256`, `bridge_version`, `capture_flags`, `snapshot_retrieved_at`. | The `SOURCE TITLE` in the request comes from the **seeded topic**, not the fetched page (this caused the FC mismatch). Out of scope to change (it would change the approved request hashes); record the page `<title>` alongside for comparison. |

## 2. Smallest code changes (SSP only; no worker change, no change to the approved request)

1. **C1 `verify_source` mode.** `run.verifySource({ userId, projectId, ... })`: same admission and Article-Led checks as Stage B, then live fetch →
   worker snapshot → compare the key with the project's attached `ready` row (else its latest non-failed row). Outcome `unchanged` |
   `source_changed` | `no_baseline` | a failure code. It **never** inserts an evidence row, reserves, or calls a provider. Started like Stage B:
   `POST agent-marketing-stageb { action: "verify_source", projectId }`, then the page starts the background function with
   `{ projectId, mode: "verify_source" }` (fetch 20 s + snapshot ~1.3 s does not fit the 10 s synchronous limit).
2. **C2 durable attempt log (proposed migration, development database only).** New append-only table
   `agent_marketing_article_capture_attempts`: `id, user_id, project_id, topic_id, mode ('verify_source'|'evidence'), stage
   ('fetch'|'snapshot'|'compare'), outcome, http_status, content_type, bytes, source_url, final_url, page_title, raw_html_sha256,
   snapshot_sha256, compared_to (evidence id), created_at`. RLS on, no policies (service role only), update/delete refused by trigger,
   ownership trigger as on the evidence table. One row for every `verify_source` and for every Stage B `prepare` that ends before an
   evidence row exists. Text and HTML are never stored here (hashes only).
3. **C3 explicit fetch codes (Node `fetchArticle`).**
   `bad_url` (not https, IP literal, credentials, non-default port), `fetch_timeout`, `fetch_failed` (DNS, TLS, reset, redirect without a location),
   `too_many_redirects` (more than 5 hops),
   `http_error` (+ `http_status`, e.g. 401/402/403/404/410/451/5xx), `not_html`, `empty`, `too_large` (refused on `Content-Length` before
   reading, and the body read stops at 4 MB), `redirected_elsewhere`. The worker's `inaccessible` is reported as `capture_blocked`
   (`incomplete` unchanged). Existing callers of `inaccessible` are updated in the same change.
4. **C4 status and page.** `GET agent-marketing-stageb?projectId=` adds `lastAttempt: { mode, stage, outcome, httpStatus, at }` (no URLs or
   text). The panel shows the specific code instead of the generic "could not start", and gets a development-only "Re-check the article"
   button (C1). No other UI change.
5. **Configuration (branch only):** delete `B1_SNAPSHOT_SOURCE` (live fetch); keep `B1_PROVIDER=worker-fixture` as a fail-safe (any
   non-frozen request answers `mock_no_response`; no paid provider exists in the code). Workers unchanged.

## 3. Test sources

| Layer | Source | Determinism | Proves |
|---|---|---|---|
| **A. Offline acceptance (required, CI)** | A local HTTP server on 127.0.0.1 inside the test, one route per scenario; the real `fetchArticle`, the real worker code (`B1_WORKSPACE`), in-memory evidence and attempt stores. Frozen FA/FB/FC HTML from the private workspace for unchanged; a copy with one sentence edited for changed. | Full | Every code, record and no-spend rule below. |
| **B. Hosted controlled (recommended)** | A new tiny Railway service `b1-test-pages` in the development project serving **synthetic** pages only (no frozen article text, no secrets, no auth needed). Seeded development projects point at its URLs. Leaves both verified workers untouched. Needs owner approval (new service, cents per month). | Full | The same scenarios through real Netlify egress, real HTTP, real database. |
| **C. Real publishers (supplementary)** | `verify_source` on the existing FA/FB/FC projects (real URLs; FC's requested URL redirects within the same site). | None: publishers may edit pages | Real-world capture. **Pass = no spend and a recorded outcome**; `unchanged` is expected, `source_changed` or `http_error` is acceptable and reported. |

## 4. Acceptance tests (Layer A required; Layer B repeats LF-01…LF-14 hosted)

Every test also asserts: **0** new reservations, **0** new evidence rows, **0** provider or Perplexity calls, **0** daily-cap slots used,
exactly **1** new attempt row with the expected `stage`/`outcome`, and no change to existing evidence rows or project pointers.

| ID | Scenario | Expected outcome / code | Stage |
|---|---|---|---|
| LF-01 | Frozen FA HTML served unchanged; project has its ready row | `unchanged` (`snapshot_sha256` equals the ready row's) | compare |
| LF-02 | Same, markup changed but article text identical (extra script, ad block) | `unchanged` (normalisation ignores markup) | compare |
| LF-03 | One sentence of article text edited | `source_changed` | compare |
| LF-04 | Project with no evidence row | `no_baseline` (verify) / proceeds to reservation only in evidence mode | compare |
| LF-05 | 301/302 within the same site (incl. `www.`) to the article | `unchanged`; `final_url` recorded | compare |
| LF-06 | Redirect to another site | `redirected_elsewhere` | fetch |
| LF-07 | Redirect loop / more than 5 hops; redirect without a location; https→http hop | `too_many_redirects`; `fetch_failed`; `bad_url` | fetch |
| LF-08 | 404, 410, 451, 500 | `http_error` with `http_status` | fetch |
| LF-09 | 401, 402, 403 (hard paywall / blocked) | `http_error` with `http_status` | fetch |
| LF-10 | 200 soft paywall / robot check page | `capture_blocked` (or `incomplete` if too little text) | snapshot |
| LF-11 | `application/pdf`, `application/json`, `text/plain` | `not_html` | fetch |
| LF-12 | `Content-Length: 5 MB` | `too_large`, body not read | fetch |
| LF-13 | Chunked body over 4 MB, no length | `too_large`, read stops at 4 MB | fetch |
| LF-14 | No response within the timeout (injected short timeout) | `fetch_timeout` | fetch |
| LF-15 | `http://`, IP literal, `user:pass@`, odd port | `bad_url`, no request sent | fetch |
| LF-16 | Empty 200 HTML | `empty` | fetch |
| LF-17 | Evidence mode: a capture failure before any row; and a project that already has ready evidence | failure recorded as an `evidence` attempt, no row, no reservation, no provider call; a ready project is answered from its row without fetching (`source_changed` on a ready project is reached through the re-check, LF-03) | fetch / — |
| LF-18 | Retry after any failure above | Allowed immediately; each attempt is its own row; nothing to reset | — |
| LF-19 | Provenance on success | Attempt row has `source_url`, `final_url`, `page_title`, `raw_html_sha256`, `snapshot_sha256`, `compared_to`; no HTML or text stored | — |
| LF-20 | Isolation | With `AGENT_MARKETING_B1_EVIDENCE` off, or a non-allowlisted user, or a production host, or the production database: 404/503, no fetch | — |
| LF-21 | Frozen evidence unchanged | FA/FB/FC request, response and bundle hashes still equal the approved fixtures (existing worker/e2e tests) | — |

Hosted check after each Layer B/C session: reservations still 4, evidence rows still 4 (plus none new), worker logs show only `snapshot`
calls (no `fixture provider`, no `gate`), attempt rows match the clicks.

## 5. Order of work (each step reviewed before the next)
1. C3 + C1 + C2 (store code and the proposed migration file) with Layer A tests; migration applied to the development database only after review.
2. C4 (status field, panel message, re-check button) with its tests.
3. Layer B service, seeded test projects (synthetic URLs), hosted run of LF-01…LF-16 equivalents; then Layer C on FA/FB/FC.
4. Restore: `AGENT_MARKETING_B1_EVIDENCE` off between sessions.

## 6. Open decisions for the owner
- Approve Layer B (`b1-test-pages` service) or rely on Layers A + C only.
- Approve the proposed attempt-log migration for the development database.
- The request's `SOURCE TITLE` source (seeded topic vs fetched page) is recorded, not changed, in this milestone; decide before live research.

## 7. Implementation status (Nov 8, 2026, local only; nothing hosted has run)

| Step | State |
|---|---|
| Attempt-log schema (`docs/proposed-migrations/20261108_…capture_attempts.up/down.sql`) | Done. Local throwaway check `scripts/b1-attempts-migration-check.sh`: 25/25 PASS (ownership, append-only, no direct delete, minimal shape, RLS on with no policy, no anon/authenticated privilege, rollback, re-apply). |
| Applied to development Supabase `ooxigbxthabstahrexia` only | Done. Re-verified there: RLS on, 0 policies, anon/authenticated no privilege, service_role select/insert, 3 triggers, 0 rows. Evidence (4) and reservations (4) unchanged. |
| C1 verify mode (`run.verifyJob`, `startVerifyRequest`; background `mode: "verify_source"`) | Done. No provider is created on that path; no evidence write, reservation or link change; one attempt row. Verify-only cap `B1_VERIFY_MAX_PER_USER_DAY` (default 20). |
| C3 explicit codes (`fetchArticle`) | Done: manual same-site https redirects (≤ 5, cross-site hop never requested), `Content-Length` pre-check and streaming 4,000,000-byte cap, timeout code, worker `inaccessible` → `capture_blocked`, fixture refusal → `fixture_refused`. |
| C2 durable recording | Done: every verification, and every evidence-mode capture failure before a row exists (`fetch`, `snapshot`, `source_changed`). A failed log write never changes the outcome. |
| C4 status + panel | Done: `lastAttempt` (mode, stage, outcome, HTTP status, time only); plain-language messages; "Re-check the article" button; the watcher ends on the new attempt and ignores the project's earlier rows. |
| Seeded title | Unchanged and authoritative; the fetched `<title>` is stored only as `observed_title`. FA/FB/FC requests through the live path still hash to the approved fixtures (LF-21). |

**Tests:** `tests/agent-marketing-b1-fetch.test.js` 14/14 (no private material; local server, plain-http adapter and Node's real `fetch`),
`tests/agent-marketing-b1-live-fetch.test.js` 11/11 (real worker snapshot code on the frozen articles), `tests/agent-marketing-b1-attempts-store.test.js`
4/4, `tests/agent-marketing-stageb-ui.test.js` 13/13. Full SSP suite: **752/752** with `B1_WORKSPACE` + `B1_FIXTURES_REQUIRED=1` (695 pass,
57 skipped without the workspace). All 21 acceptance cases covered.

### Layer B assessment (deferred, as instructed)
Remaining gap after Layer A (which already runs Node's real `fetch`): the failure-path codes (`http_error`, `not_html`, `too_large`,
`fetch_timeout`, redirects) have not been observed over **real TLS from the Netlify runtime**, and live attempt rows have not yet been written
through PostgREST. Layer C (real publishers) covers the success path, real TLS/egress and the real attempt writes. **Recommendation: no Layer B
unless Layer C shows a discrepancy.** If needed, minimum: one Railway service in the development project with ~10 static synthetic routes
(no secrets, no frozen text), 1 replica at the smallest size; estimated well under US$1/month while it exists, deleted after the run.

### Hosted Layer C run (needs owner go-ahead)
1. Branch values: add `AGENT_MARKETING_B1_EVIDENCE=dev`; **remove** `B1_SNAPSHOT_SOURCE` (live fetch); keep `B1_PROVIDER=worker-fixture`. Redeploy.
2. On FA, FB, FC: click "Re-check the article" once each. Expected `unchanged`; `source_changed` or an `http_error` is acceptable and reported.
3. Verify: 3 new attempt rows; evidence rows still 4, reservations still 4, project links unchanged; worker logs show only `snapshot` calls.
4. Switch Stage B off again and restore `B1_SNAPSHOT_SOURCE=worker-fixture` if fixture runs are wanted later.

### Hosted Layer C result (Nov 7–8, 2026: accepted, one exception recorded)
Owner clicked "Re-check the article" once per article on `b1-stageb-dev` (deploy commit `e008235`), with Stage B on and live snapshots.
Every fetch: final URL = seeded URL (no redirect), HTTP 200, `text/html; charset=UTF-8`, one fixture-worker `POST /v1/snapshot` 200.

| Case | Attempt | Outcome | Compared to (ready row) | Live raw HTML / frozen | Live snapshot / baseline snapshot |
|---|---|---|---|---|---|
| FA | `7721dfd7…` (Nov 7 20:49:59 UTC) | `unchanged` | `4d3de9de…` | `0b8f620e…` ≠ `0ef4131d…` | `f9effc5a…` = `f9effc5a…` |
| FB | `ec30bbe8…` (Nov 7 20:54:26 UTC) | `unchanged` | `80bd9c28…` | `01229809…` ≠ `95e46235…` | `cd9d1f1f…` = `cd9d1f1f…` |
| FC | `7dfa0d60…` (Nov 8 14:49:55 UTC) | `source_changed` | `8d760639…` | `254ffbd1…` ≠ `932443b9…` | `11a09d7c…` ≠ `3e37060b…` |

FC full hashes: live snapshot `11a09d7cde784337ed1b49e280351197befa77ce11eadd2a80245ce9d4d3c5d1`; baseline snapshot
`3e37060bacc90ad30f404137f863a418091478f13ff2206e6f5142702713ec67`. Live page 108,977 bytes, observed title
"Local housing analyst: Prices down slightly in region for 2026 – Citrus Heights Sentinel".

- **Invariants held** (dev database audit after FC): 3 attempt rows (one per project); evidence rows 4 and reservations 4, none created on Nov 8;
  project links FA→`4d3de9de…`, FB→`80bd9c28…`, FC→`8d760639…`; stored bundle `payload_sha256` = recomputed hash for all three
  (`17978cb5…`, `764d1ef4…`, `63b948c9…`); `cost_usd` total 0. Railway: only `POST /v1/snapshot` (3 in total), no fixture article,
  provider or gate call; primary worker `b1-stageb-worker` had no traffic. No paid provider call; evidence daily cap untouched.
- **Markup-only changes are tolerated** (FA, FB): raw HTML differed from the frozen copy, extracted text identical, outcome `unchanged` (LF-02).
- **Exception (FC, open):** the extracted text really differs, so `source_changed` is correct by design and the evidence was kept. But the
  frozen FC snapshot (5,263 chars) includes the site's "Related stories", "Latest stories" and "Previous/Next post" blocks, which change whenever the
  publisher posts. The likely cause is that rotating page furniture, not the article body. Not proven: attempt rows store no text by design, and
  the live page was not re-fetched outside the product. Consequence: `source_changed` can be a false alarm on sites with rotating link lists.
  Before re-checks drive any evidence refresh, either strip related/latest/previous/next blocks in the extractor (a new extractor version,
  which changes snapshot hashes and needs its own fixture review) or compare on the article body / quoted passages only.
- **Layer B** stays deferred: no fetch-path discrepancy was observed; the FC difference comes from page content.
- Session closed: Stage B switched off and `B1_SNAPSHOT_SOURCE=worker-fixture` restored on the branch (see `docs/b1-stage-b-infra-plan.md`).

## 8. Scope correction (Nov 8, 2026): the source re-check is removed
The subscriber workflow has no article monitoring, re-checks or research refresh. The "Re-check the article" capability (`verify_source`: start
action, background mode, `verifyJob`, `B1_VERIFY_MAX_PER_USER_DAY`, the page button) is removed. Kept: live capture for evidence, the explicit fetch
codes, immutable snapshots and provenance, and the attempt log as the audit trail of capture failures (the Layer C rows above stay as history).
Acceptance cases LF-01, LF-03, LF-04 and LF-18 were re-check cases and are gone; LF-02, LF-10, LF-17, LF-19…LF-21 now run on the evidence path.
Article evidence is now obtained inside "Write my script": `docs/b1-script-integration.md`. The FC exception above (related/latest-story blocks in
the snapshot) is a first-capture quality question for `extract_v3`, deferred to a separate review; it is not an ongoing comparison feature.

