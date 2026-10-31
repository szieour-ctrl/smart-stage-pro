# Research diagnostics (PR 1)

Every research session now stores `usage.discovery` next to the cost fields it already had. It records **what the research did**, so weak research can be traced to the step that lost it and the redesigned discovery prompt (BP-01) can be measured against today's. It changes no prompt, no topic-selection decision, no compliance gate and nothing in Reel production: the research output is identical to before (see `tests/fixtures/research-diag/golden.json`, generated from main at 4037967).

No database migration is needed: `usage` is already JSON. A diagnostics error is caught and logged; it can never change the result.

## Schema (version 1)

```
usage.discovery
  schema                 1
  retention              { days: 90, expires: "YYYY-MM-DD" }
  request                mode, data_source, audience, geography {type,name,city,zip}, period, keywords_given (true/false only), data_focus
  reproduce              instructions_sha256, input_sha256 (hashes only; the prompt text is not stored), code_version
  settings.configured    model, search_context, max_output_tokens
  used_attempt           which answer the topics came from (a worse retry can replace a better first answer; see below)
  attempts[]             one per provider answer
    n, ms, retry_reason[] (why the previous answer was rejected), provider_error
    config               model, search_context, max_results, search_context_tokens, max_output_tokens, published_after   (what was actually sent)
    usage                promptTokens, completionTokens, reasoningTokens, searchQueries, costUsd, costEstimatedUsd (only when the provider sent no cost)
    grounding            applicable, provider_urls
    candidates[]         pages the provider says it read: url, host, provider_date, via   (max 30; candidates_total is the true count)
    sources[]            every page the model named, once each: topic, url, host, title(120), model_date, provider_date, date_from,
                         outcome kept|dropped, stage, code, detail
    topics[]             every topic the model wrote: topic, outcome kept|left_out, stage, code, detail, hook(140), final_rank
    funnel               provider_candidates > named_by_model > grounded_by_provider > article_eligible > date_ok > unique_sources;
                         topics_answered > topics_kept > topics_final
  funnel                 the used attempt's funnel
  depth                  rubric 1, computed on the web topics before report topics are added: per topic and for the set
  final                  the delivered set: topics, origin {web,report}, scope {selected,broader_context}, reframed
  trimmed[], bytes       what the size cap removed, and the final size
```

### Stages and codes

| stage | codes |
| --- | --- |
| `provider_grounding` | `not_in_provider_results` (the model named a page the provider never read) |
| `article_eligibility` | `not_a_source`, `not_a_web_address`, `not_plain_https`, `address_too_long`, `paywalled`, `listing_or_agent_site`, `no_title` |
| `publication_date` | `no_publication_date`, `future_dated`, `stale`, `unreadable_date` |
| `duplicate` | `duplicate_address_in_topic` |
| `topic_selection` | `no_question`, `question_too_long`, `no_explanation`, `trend_without_signal`, `broader_without_scope_note`, `no_usable_source`, `event_problem`, `overlaps_earlier_topic`, `ranked_beyond_five`, `kept`, `kept_repeat_article` |
| `accepted` | `accepted` |

A source is recorded once, with the stage that removed it. Note that the provider's own publication date replaces the model's date before the date check (existing behavior), so `date_from` says which date was judged.

### Depth measures (rubric 1)

Deterministic proxies from what validation already produced. They do not read articles; a model-based judgment of "distinct developments" belongs with the BP-01 redesign.

* Per topic: sources, distinct publishers, distinct articles, source kinds (government, housing research, association/nonprofit, education, other, by address), newest and oldest source age, trend signals and how many carry a figure or a period, explanation length, `geographic_relationship` (`exact_market`, `wider_area_with_note`, `wider_area_no_note`), whether the hook names the market, and a substance score 0-4 (two publishers, two signals, a figure with a period, an explanation of 120+ characters). `substantive` means 3 or more.
* Set: distinct articles and publishers, `distinct_developments_proxy` (distinct first articles, less overlapping topics removed), exact versus wider-area counts, substantive topics, multi-publisher topics, topics with a government or housing-research source, median age of each topic's newest source.

If the rubric changes meaning, `DEPTH_RUBRIC_VERSION` is bumped so runs are never compared across rubrics.

## What is never stored

Keys or anything key-like; the prompt or any request text (hashes only); keywords (a true/false only); the uploaded report, its scope note or any figure from it; URL query strings, fragments, credentials, ports and long opaque path segments; article text or snippets; trend signals or the model's explanation text (counts only); the raw provider answer (the existing failure-only `usage.topicDebug` is untouched).

## Limits and retention

* Size: 24,000 bytes per session. Over that, the least useful detail goes first (candidates past 12, source titles, all candidates, earlier attempts' source detail, topic detail) and `trimmed` lists what went.
* Per attempt: 30 candidates, 40 source records, 12 topic records. Titles 120 characters, hooks 140, details 160.
* Retention: 90 days. Each record carries its `expires` date. **Enforcement needs a scheduled purge, which this PR does not add** (no migration or deployment is authorized). The purge to approve later:

```sql
-- Removes only the diagnostics block, never the session, topics or cost fields.
update agent_marketing_research
set usage = usage - 'discovery'
where usage ? 'discovery'
  and (usage->'discovery'->'retention'->>'expires')::date < current_date;
```

## Baseline runs

`scripts/research-baseline.js` runs today's discovery for Lincoln, Natomas, Crocker Ranch and a thin market (Colfax; the ZIPs and the thin market are assumptions in `tests/fixtures/research-diag/markets.json`, edit to change) across five cells:

| cell | results | context tokens | retries |
| --- | --- | --- | --- |
| `as_shipped` | 10 then 20 on retry | 6,000 then 10,000 | as production |
| `r10_c6000` | 10 | 6,000 | off |
| `r20_c6000` | 20 | 6,000 | off (result count only) |
| `r10_c10000` | 10 | 10,000 | off (context allowance only) |
| `r20_c10000` | 20 | 10,000 | off |

```
node scripts/research-baseline.js --replay                              # offline smoke run, no key, no cost
PERPLEXITY_API_KEY=... node scripts/research-baseline.js --live         # 4 markets x 5 cells x 2 repeats = 40 searches
PERPLEXITY_API_KEY=... node scripts/research-baseline.js --live --markets lincoln --repeats 3
```

Live runs use the same `runResearch` as the app, write nothing to Supabase and charge no subscriber session. They write `runs.jsonl` (one line per run: full search configuration per attempt, tokens, searches, actual cost, funnel, depth), one `*.discovery.json` per run and `summary.md`. Stored web research sessions averaged $0.0134 each (max $0.0205, 11 sessions), so the full 40-run baseline should cost roughly $0.50 to $1.00.

The search limits for a cell are set through two optional settings, `AGENT_MARKETING_RESEARCH_MAX_RESULTS` (1-30) and `AGENT_MARKETING_RESEARCH_SEARCH_TOKENS` (1,000-16,000). Unset, the named context size decides exactly as before; out-of-range values are ignored.

## An observation, not changed here

When the first answer is usable but partial and the retry is also usable but worse, the retry's answer is the one kept (the "keep the first" fallback applies only when the retry is not usable at all). Scenario `partial_then_worse_retry` shows it: 3 topics on the first answer, 2 delivered. This PR records it (`used_attempt`) and does not change it.
