# Stage B migration review (Nov 5, 2026, development only)

Migration: `docs/proposed-migrations/20261105_agent_marketing_article_evidence.up.sql` (revision 2) and its `.down.sql`.
**Status: reviewed, verified on a throwaway local PostgreSQL 16 cluster, NOT applied to any hosted database.**

## Development application status

There is no authorized development database to apply this to:

- Supabase lists two projects. `dnpaenpwdhjmslymgkse` ("smart-stage-pro") is the database the deployed app uses (the existing migrations
  name it for the SQL editor). `vdoyrtybojnflqhouwfc` ("ssp-prospect-tracking") is a separate prospect-tracking project and has none of the
  Agent Marketing tables.
- `dnpaenpwdhjmslymgkse` has no development branches. Creating one is a billed Supabase resource, so it was not created.

So the migration was applied only to a local cluster created and destroyed by `scripts/b1-migration-check.sh`, on top of the repo's real
`20261022_agent_marketing_foundation.sql` and `20261024_agent_marketing_research.sql` (with `users`, `marketing_profiles` and `reel_jobs`
stubbed). To apply it to a development database, someone must first name one (for example an approved Supabase branch of the SSP project).

## Review findings and fixes (revision 1 → revision 2)

| # | Check | Revision 1 | Revision 2 (verified by `scripts/b1-migration-check.sh`) |
|---|---|---|---|
| R1 | Project ownership | Evidence row checked against its project, but `agent_marketing_projects.article_evidence_id` could point at any row, including another user's | New trigger on projects: the pointer must name a **ready** row of the **same project and user** |
| R2 | Research ownership | `research_id` not checked | Research run must belong to the same project and user |
| R3 | Snapshot immutability | Frozen only once `ready`; a reserved row's snapshot or request could be replaced by a later webpage version | Snapshot, request, hashes, cache key, B1 settings, user, topic and URLs are immutable **from insert** |
| R4 | Concurrent duplicates and idempotent retry | In-flight uniqueness correct, but `unique (project_id, cache_key)` made a `failed` row block every retry (the comment said the opposite); the bridge also handed the failed row back as "reused" | In-flight index kept. Project uniqueness is now one **ready** row per project, key and gate version; `failed` never blocks a retry. Bridge ignores failed rows and resumes its own reservation instead of duplicating it |
| R5 | Evidence versioning | A re-gate overwrote the bundle in place, which modifies historical evidence | Raw response, bundle, completeness status and gate version are frozen once ready. A re-gate is a **new** row (`reused_from` the original, new `gate_version`) |
| R6 | State machine | Any transition allowed before ready | reserved → running → ready / failed only; `ready` and `failed` are final; a new row is `reserved`, or `ready` only as a copy of a ready row with the same key and raw response |
| R7 | Completeness of a ready row | Nothing required | Check constraint: a ready row has its raw response, hash, gate version, bundle and completeness status; request fields are `not null` |
| R8 | Audit records | Deletable | `ready` and `failed` rows cannot be deleted directly; they go only with their user (cascade). Project deletion detaches the row (`set null`) and keeps it intact |
| R9 | Raw provider responses | RLS on, no policies | Also `revoke all` from `anon`, `authenticated`, `public`; trigger functions have a fixed `search_path` and no execute grant |
| R10 | Stale results | Code-only (`checkRecord` topic check) | Database also clears `article_evidence_id` when the selected topic or research run changes; `checkRecord` stays as the second guard |

One design change during the review: `reused_from` is `on delete set null` (not `restrict`), so another user's reused copy can never block an
account deletion. A copy carries its own snapshot, request, raw response and hashes, so it remains self-contained.

## Verification output (local throwaway cluster)

```
PASS migration applies twice (idempotent)
PASS R1 a user cannot attach evidence to another user's project
PASS R2 research run must belong to the project
PASS R6 a new row cannot be inserted ready without reused_from
PASS R4 a second concurrent B1 reservation for the same cache key is refused (any user)
PASS R4 a failed run does not block a retry for the same project and key
PASS R6 a failed row is final
PASS R8 a failed row is not deleted directly
PASS R3 a reserved snapshot cannot be replaced by a later webpage version
PASS R3 the exact B1 request cannot change after reservation
PASS R3 the cache key cannot change
PASS R7 a row cannot become ready without raw response, gate version, bundle and status
PASS reserved -> ready with full evidence; PASSED_WITH_HOLDS stored as such
PASS R5 the raw provider response is immutable once ready
PASS R5 a ready bundle cannot be upgraded in place (PASSED_WITH_HOLDS stays incomplete)
PASS R6 ready is final
PASS R8 a ready row is not deleted directly
PASS R4 one ready row per project, key and gate version (idempotent)
PASS reuse: another project copies a completed result as ready with reused_from
PASS reuse: a copy with another cache key is refused
PASS R1 a project cannot point at another user's evidence
PASS R1 a project cannot point at a failed row
PASS R10 unrelated project updates keep the pointer
PASS R10 changing the selected topic clears the evidence pointer (stale result)
PASS R9 anon/authenticated have no table privileges
PASS R9 RLS on, no policies
PASS R9 a signed-in client cannot read raw provider responses
PASS deleting a project detaches its evidence row; the audit record is kept intact
PASS deleting a user cascades through the audit guard
PASS another user's copy survives (reused_from set null), still self-contained
ALL MIGRATION CHECKS PASSED
PASS rollback removes every object
PASS migration re-applies after rollback
```

## Effect on existing behaviour

Additive only. The new trigger on `agent_marketing_projects` runs on every project insert or update, but it does nothing unless
`article_evidence_id` is set (it is always null until Stage B runs), and changing the selected topic only clears that new column.
