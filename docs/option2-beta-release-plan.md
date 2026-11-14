# Option 2 controlled beta: release plan (prepared Nov 14, 2026; nothing here has been deployed)

Release candidate: branch `b1-stageb-dev`, commit `d9d9b5d` (Test deploy only). Production (`main`, Supabase `dnpaenpwdhjmslymgkse`) is unchanged and its prompt hash is still `25f3118fed1b9726fc4dc78b16dcc92233cef785d3c074ef89a6ee7aaf7b0495`.

## What the candidate changes (all behind the article-led switch `AGENT_MARKETING_B1_EVIDENCE=dev`)
1. A subscriber-approved script is final. If it no longer matches the scenes it carries, the render job makes ONE storyboard-planning call from the approved words, the stored topic and its evidence (no B1/B2 rerun). Code cuts the scenes at sentence ends and owns every scene's words. A failure stops the job with an explicit, retryable message and uses nothing from the old scenes. An unchanged script makes no call.
2. A script edit drops the discarded plan's angle, claims and hook.
3. Test prompt: a median stays a median. Editor: a lead-in attribution is folded into the fact's sentence before it is cut.
4. The article-led switch (not the Test database) lets an opening or closing scene carry the article, in the manifest and its validation.

## Schema (production could not be read from this session: the connector has no access to it)
Option 2 needs these, which exist in Test and are only *proposed* in the repo (`docs/proposed-migrations/`):
- `20261101_agent_marketing_provider_request_reservation` (tables `agent_marketing_provider_requests`, `agent_marketing_provider_request_cutover`)
- `20261105_agent_marketing_article_evidence` (table `agent_marketing_article_evidence`, column `agent_marketing_projects.article_evidence_id`)
- `20261108_agent_marketing_article_capture_attempts` (table `agent_marketing_article_capture_attempts`)
- `20261108_agent_marketing_projects_market_update_mode` (column `agent_marketing_projects.market_update_mode`)
Each has a `.down.sql`. This release adds NO new migration. Compare with a read-only query on production before anything else:
`select table_name, column_name from information_schema.columns where table_schema='public' and (table_name like 'agent_marketing%') order by 1,2;` and diff against Test.

## Flags and allowlist (read from code; production values not read)
- `AGENT_MARKETING_ENABLED` must be `true`.
- `AGENT_MARKETING_USER_IDS`: comma-separated beta subscriber ids. WARNING: an empty list means everyone is allowed.
- `AGENT_MARKETING_B1_EVIDENCE=dev` is site-wide, so it turns on the article-led behavior for every allowed user. There is no per-user Option 2 switch, so the allowlist must equal the beta group.
- Related article-led settings in code: `AGENT_MARKETING_ARTICLE_LED_ENABLED`, `_LANES`, `_RETRIES`, `_DESIGN`, `AGENT_MARKETING_MARKET_REVIEW`. Confirm their intended production values.
- `testEvaluation()` stays false on the production database, so the retired Test claim checks remain ON in production (see risks).

## Deployment plan
1. Authorization from Sam. 2. Read-only schema diff on production. 3. Apply the four migrations (in order) if missing. 4. Record the current live deploy id (`6aef759ec773603f086ff291`). 5. Set `AGENT_MARKETING_USER_IDS` to the beta ids first, then merge `b1-stageb-dev` to `main`. 6. Set `AGENT_MARKETING_B1_EVIDENCE=dev`. 7. Smoke test with one beta account: script approved as written (no storyboard call), one partial edit, one complete replacement, one render each.

## Rollback
- Fastest: set `AGENT_MARKETING_B1_EVIDENCE` empty (article-led behavior off; new projects fall back to the existing flow; stored beta projects remain, and an approved Option 2 script blocks only at the evidence check).
- Code: publish the recorded previous Netlify deploy (`6aef759e…`).
- Data: migrations are additive; leave them in place (their `.down.sql` only if Sam asks).

## Open risks before go
- Production still applies the editorial claim checks (`invented_number` etc.) to AI scripts; the Test run showed article-led scripts pass only with them off. Needs a decision and a Test emulation on stored evidence.
- 60 s has not been run end to end since Phase B.
- Scene-1 article credit is not drawn by the renderer (opening scenes must name the article in speech or carry no article fact).
