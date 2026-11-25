# Stage B: connecting B1 evidence to a selected Article-Led project (design, development only)

Status: **design plus inert, development-only code**. No provider call, no table applied, no deployment. Migration review: `docs/b1-stage-b-migration-review.md`; store: `lib/agent-marketing-b1-store-lib.js`.
- Implemented and tested: the reuse key and the record checks, `lib/agent-marketing-b1-stageb-lib.js`.
- Proposed only: the table, `docs/proposed-migrations/20261105_agent_marketing_article_evidence.up.sql`.
- Everything stays behind `AGENT_MARKETING_B1_EVIDENCE=dev`.

## What exists today

- `agent-marketing-research.js` (`action: "select"`) freezes the chosen topic on the project: `selected_topic` and `selected_research_id`. An
  Article-Led topic carries its `candidate` record and source references (URL, title, outlet class). **The article's text is not stored
  anywhere**: SSP has no article retrieval yet. `docs/article-led-discovery.md` lists retrieval as a future PR.
- The Planner reads `selected_topic` through `topicBrief()`, and the content gate reads it through `verifiedFromTopic()`. Both already read B1
  evidence (validated only) through `agent-marketing-b1-evidence-lib` when the topic carries `b1Evidence`.

So the "frozen source snapshot" B1 needs does not exist in SSP. Stage B has to create it once and then treat it as immutable.

## The smallest connection

```
select topic (existing) ──> Stage B (new, dev-only, explicit owner action) ──> project.article_evidence_id
                                 1 snapshot   2 reuse or run B1   3 gate   4 store
plan dispatch (existing) ──> load project + evidence row ──> stageb.topicWithEvidence() ──> generatePlan()  (fails closed)
```

1. **Snapshot.** Take the selected article's URL from the topic's candidate record. Retrieve it once and extract the text with the same method
   B1 v1.2.1 was validated on, `extract_v2`. Store the exact text, its sha256, the extractor and the time. A snapshot is never refreshed silently:
   new text is a new snapshot, and so a new cache key.
2. **Reuse or run.** Compute the reuse key with `cacheKey()`, which covers the snapshot hash and the approved B1 settings: prompt hash `67edf2af…`,
   model, 5,000-token cap, minimal effort, and extractor. The gate version is deliberately not part of the key.
   - If a `ready` row exists for the key, associate it with the project. No call.
   - If a `reserved` or `running` row exists, wait for it.
   - Otherwise insert a `reserved` row. The unique partial index on `cache_key` makes this atomic, so two sessions cannot both call B1. Only then
     send the B1 request, built from the snapshot with the B1 wrapper. **This is the paid step and it is not implemented.**
3. **Gate.** Run the B1 evidence gate (verifier, qrec-1, review-1 with the empty allowlist) on the stored raw response, then export the
   `ssp-b1-evidence/1` bundle.
4. **Store and associate.** Store the request, raw response, hashes, bundle and completeness status in one row, set it `ready`, and set
   `agent_marketing_projects.article_evidence_id`. Once a row is `ready`, a trigger makes the snapshot, request, raw response and key immutable.
   Re-gating after a gate change never edits a ready row: it adds a new row (`reused_from` the original, new gate version), so earlier evidence is kept.
5. **Plan time.** The plan background function loads the project and its evidence row and calls `topicWithEvidence(project, row)`. Then:
   - **Switch off, or a legacy topic:** the topic is unchanged.
   - **Switch on:** the topic carries the bundle, but only if `checkRecord` passes. Otherwise it carries a BLOCKED value, and `generatePlan`
     throws `B1_EVIDENCE_BLOCKED` before any model call. A missing row is BLOCKED; it never falls back to unevidenced planning.

## What `checkRecord` already enforces (tested)

| Check | Fails closed when |
|---|---|
| Project association | the row's `project_id`, `research_id` or `topic_id` differs from the project's current selection (for example, the topic changed after B1 ran) |
| State | the status is not `ready` |
| Approved B1 settings | the prompt hash, model, cap, effort, extractor or prompt version differs, in the row or in the stored request |
| Snapshot | the text is missing or its sha256 differs, or the stored request's input does not carry it byte for byte between the markers |
| Request and raw response | either is missing or does not match its stored sha256 |
| Reuse key | `cache_key` does not match the row's inputs |
| Bundle | it is BLOCKED, tampered or malformed; it was made from another input or raw response; or its status differs from the stored one |

## Decisions needed before anything is built

1. **Retrieval method.** v1.2.1 was validated on `extract_v2` text from captured raw HTML. Two options:
   - **Recommended:** a plain HTTP GET of the article's HTML plus `extract_v2`. This has no provider cost, but SSP needs network access to the
     publishers' hosts.
   - Perplexity `fetch_url` text, the Step 1 method. This is a paid call of about $0.001, and v1.2.1 has never been run on that input type.
2. **Where the gate runs.** The gate and `extract_v2` are Python, and Netlify functions here are Node.
   - **Recommended:** port the verifier, qrec-1, review-1, the export and `extract_v2` to JavaScript, with a parity test proving the bundles are
     byte-identical to Python's on all 21 frozen responses.
   - Alternatively, run the Python gate as a separate worker. Either is a separate approval.
3. **Who triggers Stage B.** The recommendation is an explicit owner action per project, counted in the existing provider-request reservation
   ledger. B1 costs roughly $0.02 to $0.05 per article; the v1.2.1 run was $0.019 to $0.047.
4. **Topic change.** The `select` action should clear `article_evidence_id` when the topic changes. Until it does, `checkRecord`'s topic check
   blocks a stale row anyway.
