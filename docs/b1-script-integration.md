# B1 Article-Led Market Update: evidence inside "Write my script" (Nov 8, 2026)

Development only (`b1-stageb-dev`, development Supabase `ooxigbxthabstahrexia`). Everything here is off unless the server sets
`AGENT_MARKETING_B1_EVIDENCE=dev`. Production, PR #219 and the paid providers are unchanged.

## Subscriber workflow

Research → Select Topic → **Write my script** → Edit if desired → Storyboard → Images → Narration → Render.

- There is no separate evidence step for the subscriber.
- "Check the article's evidence", "Re-check the article" and the evidence panel are removed.
- One "Write my script" click reuses or obtains the qualified article evidence, then writes the script.
- There is no article monitoring, no scheduled or elapsed-time re-check, and no automatic research refresh.
- A subscriber who returns can resume the project, pick another saved research topic, or start new research.

## How it runs

1. **Status.** The page asks `GET agent-marketing-stageb?projectId=`.
   - 200 means the evidence flow is offered for this user and project.
   - 404 means it is not offered, and the page uses the unchanged `agent-marketing-project { action: "plan" }` path.
   - On production the page never asks.
2. **Script check.** `POST agent-marketing-stageb { action: "script", projectId }` runs these checks:
   - admission;
   - the Article-Led topic;
   - the usual planning checks (`planStart`, shared with `action: "plan"`);
   - the script-writer configuration.

   It then writes the `planning` stub and answers 202 `{ state: "dispatch", mode: "script" }`.
3. **Background job.** The page starts `agent-marketing-stageb-background { projectId, mode: "script" }` with its own login token.
   - It cannot be another function calling it: the branch deploy is behind team login, which blocks a function calling its own deploy over HTTP.
   - Checked Nov 8: the Netlify API reports `requiresSSOTeamLogin: non_production`, and `action: "plan"` dispatches with a plain server-side `fetch`, so on the branch that dispatch never reaches the planner.
   - The job runs in this order:
     1. Use the evidence row already attached for this project, topic and research run.
     2. Otherwise reuse saved-topic evidence (below).
     3. Otherwise run the existing evidence job: snapshot, ledger reservation, provider, evidence gate, attach.
     4. Run the planning run (`lib/agent-marketing-plan-run-lib.js` `runPlan`) with that evidence. This is the same code `agent-marketing-plan-background` runs.
4. **Progress.** The page polls the project as before (up to 18 min in this mode). It shows:
   - "Reading the article and checking its evidence…" while the evidence job runs;
   - "Article evidence is ready (N checked, M held back as unverified). Writing your script…" once evidence is ready.

**If evidence cannot be obtained or does not qualify, no script is written.**
- The narrative becomes an error with the reason, plus `evidence: { code, providerAttempted }`.
- "No article analysis was run, so there is no analysis cost" is said only when no B1 provider request was made, meaning the run never reached `running`.
- Otherwise the message says that a request was made and counts toward usage.

## Edit, approval and storyboard checks

The following load the attached evidence (`withPlanEvidence`) before running the content gate:
- `save_narrative` and `approve_narrative` (`agent-marketing-project.js`);
- the image-description checks (`agent-marketing-images.js`).

So the same validated quotations are verified text, held statements stay blocked (D1), and article figures keep their context checks.
- An Article-Led script is not approved while its evidence is missing or invalid (409 `evidence_blocked`).
- The evidence is read for each check and never written onto the project.
- As on the existing gate path, a brand-new number the agent types into an edit is the agent's own claim.

## Reusing evidence for a saved topic

A saved research set opened in another project is copied into that project (`usage.copiedFrom`), so the topic keeps its id but gets a new research run id. `reuseSavedTopic` reuses this user's existing evidence for the same topic of the same original research, without fetching the article or calling B1. Before reuse it checks:

- **Ownership:** the row is this user's.
- **Topic identity:** same topic id, and both research runs lead back to the same original run (at most 10 `copiedFrom` links).
- **Source version:** the row's source URL is the topic's article URL, and the stored snapshot still matches its hash.
- **Evidence contract:** `checkRecord` passes in full for the row's own project: approved B1 settings, request, raw response and bundle.

The database lets a project point only at its own evidence rows (R1).
- The reuse is therefore a provenance-linked row. `reused_from` names the original row (never a copy of a copy), and the row has no provider reservation.
- The database checks that it has the same cache key and raw response as the original.
- Pointing a project directly at another project's row would need a change to rule R1. That is not done.

The existing identical-snapshot rule is unchanged. It is separate from saved-topic reuse:
- a fresh capture whose snapshot equals a completed run shares that B1 result;
- this applies across users and projects;
- the article is still read for this project.

**Topic ids repeat across research sets (`t1`…`t5`).** Every evidence lookup for a project (`findForProject`, `latestForProject`, the bridge's `prepare`) now also matches the research run. Before this, switching to another set's `t1` found the first set's row. The plan was then blocked for good, or the capture was refused as `source_changed`.

## Removed: the source re-check

Removed: `verify_source` (start action, background mode, `verifyJob`, `B1_VERIFY_MAX_PER_USER_DAY`, the page button and its texts).

Kept:
- the attempt log (`agent_marketing_article_capture_attempts`), including the Layer C rows (mode `verify_source`) as history;
- the capture-failure audit trail. Evidence-mode failures before a row exists are still recorded.

## Development fixture script writer

`lib/agent-marketing-b1-fixture-planner-lib.js` is a deterministic stand-in for the paid planner call.
- It is used only by script mode, and only when all of these hold: `AGENT_MARKETING_B1_EVIDENCE=dev`, `B1_PLANNER=fixture`, and a non-production database.
- It builds planner JSON from the planner input it is given. It states one validated finding's exact quotation in an "article" scene and no other figures.
- Its output passes through `generatePlan`'s normal checks.
- It is labelled `narrative.plannerFixture = true`, with a warning the agent sees.

## Extractor (`extract_v3`, Nov 8, 2026)

New snapshots use `extract_v3` (private workspace `src/extract_v3.py`). It keeps the article and drops page furniture, deciding by page structure, never by article wording.

**Removed:**
- navigation, banners, footers, dialogs and pop-ups;
- hidden elements;
- blocks whose class or id tokens name furniture (related, share, subscribe, comments, ads, tags, chatbot, sign-in and similar);
- link-heavy story lists, previous/next-post links and short subscription promos.

**Kept:**
- the headline, byline and publication line, even when it is link-heavy;
- captions, quotations, tables and figures.

**Text assembly:** the same as `extract_v2`, so every kept line is an unaltered line of the page.

| Frozen page | `extract_v2` → `extract_v3` | What `extract_v3` removes |
|---|---|---|
| FA | 15,660 → 15,649 characters | the "Share:" line |
| FB | 9,318 → 7,699 | menus, pop-ups, the hiring modal, tags, the footer, the chatbot |
| FC | 5,263 → 3,941 | the Related, Latest and previous/next story lists, and the subscribe promo |

Every claim quotation in the approved bundles survives verbatim. Re-gating the frozen v1.2.1 analyses against the `extract_v3` snapshots qualifies the same validated and held claim findings. The one change is FC's extraction-defect finding, which quoted the "Latest stories" contamination and is now excluded.

**Choosing the extractor:**
- `extract_v3` by default;
- `extract_v2` in fixture mode (`B1_SNAPSHOT_SOURCE=worker-fixture`), because the frozen B1 responses were made from `extract_v2` text;
- `B1_EXTRACTOR` names either one explicitly.

The extractor is part of the cache key. Records made with `extract_v2` stay valid immutable evidence and are still reused.

**The frozen fixtures:**
- They are a regression comparison, not a hash lock.
- Tests that replay the saved responses run with `B1_EXTRACTOR=extract_v2`.
- With `extractor: "extract_v2"`, the worker still reproduces the frozen requests byte for byte.

**A new `extract_v3` capture needs a real B1 analysis.**
- `B1_PROVIDER=live` (`lib/agent-marketing-b1-provider-lib.js` `liveProvider`) sends the stored request body byte for byte to `B1_ENDPOINT` with `B1_API_KEY`, as the approved v1.2.1 runner did.
- It accepts only HTTP 200 with status `completed`, and stores the reported cost in `cost_usd`.
- It runs behind the ledger reservation and the per-user and global daily caps.
- It is paid: switching it on is an owner decision.
- Without it, a new capture fails closed and the subscriber is told that no script was written.

**Deployment:** the Railway workers build from `ssp-b1-evidence` `dev/stageb-worker`, which has no `extract_v3` yet. `extract_v3` is on branch `dev/extract-v3`. Until that branch is merged (which rebuilds both workers), a hosted live-mode snapshot returns `extract_v2`, and SSP refuses it as `snapshot_inconsistent`. Fixture mode is unaffected.

## Tests

- `tests/agent-marketing-b1-script-flow.test.js` (14 cases, including `extract_v3`); `tests/agent-marketing-b1-provider-live.test.js` (stub only). It runs the real Python worker on 127.0.0.1, a fake PostgREST that enforces the migration rules, the mock provider, the fixture script writer, and the unmodified `agent-marketing-project.js`. It covers:
  - evidence obtained automatically;
  - validated-only input to the script writer;
  - held findings never reaching the script;
  - edit and approve checks;
  - approval refused without evidence;
  - storyboard text checks;
  - returning to saved topics (same project and new projects);
  - the reuse refusals;
  - repeated topic ids;
  - failures and their cost wording;
  - refusals and configuration;
  - one script per set of answers.
- Full suite:
  - with the private workspace (`B1_WORKSPACE`, `B1_FIXTURES_REQUIRED=1`): **760/760**;
  - without it: 693 pass, 67 skipped.

## Hosted run: branch values needed (owner actions, `b1-stageb-dev` only)

For the deterministic hosted demo:
- `AGENT_MARKETING_B1_EVIDENCE=dev` for the session only;
- `B1_SNAPSHOT_SOURCE=worker-fixture`;
- `B1_PROVIDER=worker-fixture`;
- `B1_PLANNER=fixture`.

FA/FB/FC already have ready evidence attached, so "Write my script" reuses it: no snapshot, provider or gate call.

## Proposed single live Anthropic script-generation test (needs separate approval)

**Call:**
- one "Write my script" on one seeded project (proposed: FC, PASSED_WITH_HOLDS);
- `B1_PLANNER` removed for that run, so the real planner is used: `claude-sonnet-4-6`, `max_tokens` 4000;
- evidence comes from the existing ready row: no B1 provider call.

**Size and cost:** the measured prompt is about 8.6k–9.8k input tokens (system prompt about 24k characters, plus the topic and evidence).
- `generatePlan` makes 1 call, plus at most one structural retry, one gate rewrite and one length rewrite: **4 calls at most**.
- At $3 / $15 per million input/output tokens: typical about $0.06 (one call, about 2k output), worst case about **$0.40** (4 calls × (about 11k in + 4k out)).

**Limits:**
- one click, on one project;
- the project's 4-attempt planning cap;
- no Perplexity and no B1 provider call;
- `B1_PLANNER=fixture` restored afterwards;
- Stage B off at the end of the session.
