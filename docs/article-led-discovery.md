# Article-Led discovery v2 (PR 2)

Behind `AGENT_MARKETING_ARTICLE_LED_ENABLED` (1, true, yes or on). It applies to a **Market Update** that is **not report-only**. With the flag off, or for Local Events or a report-only request, the v1 prompt, validation, combined mode and billing are exactly as before (the golden tests in `tests/agent-marketing-research-diag.test.js` prove it).

Purpose: discover up to **five substantive editorial opportunities**, not five article summaries. The confirmed MLS report remains the only numerical market authority and **never fills one of the five positions**.

## What changes, by file

| File | Change |
| --- | --- |
| `lib/agent-marketing-article-led-lib.js` (new) | the v2 prompt and schema, request builder, parser, validation, billing rule, partial-session limit, depth measures |
| `lib/agent-marketing-research-run-lib.js` | routes to v2 when on; keeps the strongest usable answer (separate commit); no search widening on a v2 retry; attaches report figures instead of writing report topics |
| `lib/agent-marketing-research-lib.js` | `outcomeFields` can leave a session uncharged (`charge: false`, only v2 partial sets); shared helpers exported |
| `lib/agent-marketing-research-diag-lib.js` | source records carry role, kind and freshness window |
| `agent-marketing-research.js` (endpoint) | server-side limit on uncharged partial sets; client fields (`pathway`, `delivered`, `limitation`, `offerMlsTrend`); `articleLed` in the schema |
| `agent-marketing-research-ui.js`, `agent-marketing.html` | the "Create an MLS Market Trend Reel" option; the confirmation says when a session is used |
| `scripts/research-baseline.js`, `scripts/research-baseline-inventory.js` | v2 cells, v2 depth table, delivered cards, inventory and review sample for v1 and v2 |

## The v2 request

* Prompt: `systemPromptV2()` (read it in the lib; it is the reviewed and approved text, with the four corrections below).
* Search: **20 results, 6,000 search-context tokens** (the starting point; `AGENT_MARKETING_RESEARCH_MAX_RESULTS` and `..._SEARCH_TOKENS` override for measurement). **5,000 output tokens** by default, measured separately (`AGENT_MARKETING_RESEARCH_MAX_TOKENS=2200` reproduces the v1 allowance). The publication-date filter is 12 months; the validator applies the per-source-class windows. A retry does **not** widen the search.
* Input: the selected market (with type, city and ZIP), audience, focus and keywords. No MLS-statistics focus and no uploaded-report scope note go to the web provider.

## Schema

```
{ research_limits: { returned, reason },
  opportunities: [ { question, headline, editorial_thesis, why_it_matters, homeowner_decision, development, angle,
      geographic_relationship, route_to_market, status, status_evidence { source, shows, as_of }, action_date, status_checked_date,
      established_facts[], possible_explanations[], project_facts[ { fact, source, basis } ],
      evidence_points[ { text, area, period, source } ], evidence_gaps[], verification_needs[], access_confidence, keyword_match,
      sources[ { title, url, published, role, kind, source_geography, reporting_period, what_it_establishes } ] } ],
  recommendation }
```

Each opportunity becomes a v1-compatible topic (`question`, `whyItMatters`, `trendSignals`, `scope`, `scopeNote`, `sources`) plus an `editorial` card, so the UI and later stages keep working.

## Corrections applied (Oct 31 review)

1. **Source-supported claims are not verified facts.** `project_facts` carry `basis`: `source_stated` or `primary_record_cited`; the code keeps `primary_record_cited` only when the cited source is a kept authoritative primary record, and marks every fact `verification: pending_primary_record_check`. Nothing in the pipeline marks a fact verified; that belongs to the later fetcher.
2. **Per-source geography and period.** Every source stores `sourceGeography` and `reportingPeriod`, separately from the opportunity's `geographic_relationship`.
3. **Status only with authoritative evidence.** `status` new, ongoing, completed or superseded is kept only when `status_evidence` points to a kept authoritative primary source, has an `as_of` date, and `status_checked_date` is within 60 days; `new` also needs an `action_date` within 60 days. Otherwise the status becomes `unverified` and the reason is stored. An older announcement is never converted to ongoing or new.
4. **Access confidence is provisional** (`{ value, provisional: true }`) until article retrieval is tested in the fetcher PR.

## Validation in code

| Rule | Behavior |
| --- | --- |
| Eligibility | same as v1: plain https, not paywalled, an article and not a listing or agent landing page, has a title |
| Freshness | news and commentary: published within 60 days. Authoritative primary (role `primary` **and** a publisher recognized as official in code, see Source authority): within 365 days. Older than 365 days: only as background, and only when a newer official source in the same opportunity that is current says **explicitly** that it confirms that record (`confirms` = its number, with a `confirmation_basis`). Sharing an opportunity is not confirmation. Otherwise dropped (`stale`, `authority_unconfirmed`, `stale_primary_unconfirmed`). At least one non-background source is required |
| Source authority | decided from the host, in code (`lib/agent-marketing-source-authority-lib.js`): `.gov` and `.ca.us` are official government; Freddie Mac, Fannie Mae and Federal Reserve banks are official financing; names that merely look official (`cityof...`, `...county` on a `.org` or `.com`) are `uncertain` and never trusted; everything else is not official. The model's `role` and `kind` alone never open the extended window, confirm an older record, support a status or make a project fact `primary_record_cited`. A source the model calls authoritative but whose publisher is not recognized follows the 60-day rule, is dropped with `authority_unconfirmed` when older, and is flagged for review |
| Confirmation signal | how a confirming source ties to the older record, from the addresses and titles: `shared_identifier` (the same project, permit or ordinance number), `same_publisher`, or `model_asserted` (the model's word alone: accepted because the relation was stated, counted and flagged for review) |
| Dates | `published` (per source), `action_date`, `status_checked_date` stored separately |
| Distinctness | no two opportunities with the same development and angle; near-identical questions overlap. **No article or publisher quota**; several opportunities may rest on one article; no reordering for article diversity |
| Geography | `geographic_relationship` required; anything other than `exact_market` or `same_jurisdiction` needs `route_to_market`, else it is left out. Scope is `selected` for the first two, `broader_context` otherwise. **The relationship is the model's assertion**: for `exact_market` and `same_jurisdiction` it is checked against the sources' own geography (a kept source names the market, its ZIP, or for `same_jurisdiction` its city, in `source_geography`; failing that, in a title, address or summary). An unsupported claim is kept, flagged (`geographyCheck.supported = false`, `review.needsReview`, `qualification.geography = model_asserted_unsupported`) and never silently trusted or rewritten. Source-specific geography and reporting period are always preserved |
| Required content | question, explanation, editorial thesis, named development and angle |
| Trends | a trend claim needs evidence points |
| Slots | one to five; fewer than five is valid and explained in `research_limits` |

Dropped sources and topics are recorded with PR 1's stage and code vocabulary plus the new codes (`stale_primary_unconfirmed`, `only_background_sources`, `no_editorial_thesis`, `bad_geographic_relationship`, `broader_without_route`, `duplicate_development_angle`, ...).

## Billing, partial results and limits

* **Five qualifying opportunities delivered: one session charged.** Fewer: the valid results are kept, the session is **not** charged, the limitation (`research_limits.reason`) is shown with a note offering the MLS Market Trend Reel. Legacy billing is unchanged.
* **Partial results (uncharged, ready):** 5 per user per rolling 24 hours and 30 per rolling 30 days, enforced server-side (`AGENT_MARKETING_PARTIAL_DAILY_LIMIT`, `..._MONTHLY_LIMIT`; the monthly value is a starting point to calibrate).
* **Provider requests (a separate limit):** failed runs stay uncharged, but **every** Article-Led request counts toward it whatever its outcome: charged, partial, failed or still running. A finished run counts the provider requests it made (one, plus its retry); a running one counts one. Default **15 per rolling 24 hours and 100 per rolling 30 days** (`AGENT_MARKETING_REQUEST_DAILY_LIMIT`, `..._MONTHLY_LIMIT`; starting values to calibrate). Over the limit: 429 `provider_request_limit`, nothing started.
* **Concurrency:** one Article-Led request in progress per user. A check before saving the row cannot be atomic, so each request is checked again **after** its row is saved, against only the rows ordered before it (`created_at`, then `id`). When two requests race, the earlier row stays and the later is withdrawn (marked failed, uncharged, `usage.withdrawn`, never dispatched), so simultaneous requests cannot exceed a limit. If the rows cannot be read for that second check, the request is withdrawn (fails closed). Withdrawn rows are not counted.
* Legacy research is not affected by any of these.
* **MLS Market Trend Reel:** a separate, deliberate workflow (report only, needs a confirmed report, same confirmation step). It is never started automatically and never takes an article-led position.

## Qualified discovery candidates, not publication-authorized evidence

Discovery validation can show that an opportunity is **structurally complete** and grounded in sources the provider found. It does not show that the article's claims, the project facts or the geographic assertions are true. Every opportunity therefore carries `editorial.qualification`: `stage: discovery_candidate`, `publicationAuthorized: false`, claims `source_reported_not_verified` (stored as `sourceReportedFacts`, not "established" facts), project facts `pending_primary_record_check`, geography `source_corroborated_not_verified`, `model_asserted_unsupported` or `wider_area_with_stated_route`, status `unverified` or `authoritative_source_cited_not_independently_verified`, access `provisional_estimate`, and `externalMarketStatistics: not_authorized_for_publication`. Nothing in the pipeline marks anything verified or authorized; that belongs to later stages (retrieval, the evidence registry, the publication gate).

## The MLS handoff is compatibility only (future PRs)

With a confirmed report attached (`both`), the report's figures are attached to each opportunity with the existing `applyReportPrecedence()`. That is **compatibility with the legacy Planner and gate**, nothing more. Every v2 topic is marked `reportFirst` (with or without a report), so the article's market statistics are not verified text and the only numbers a script may state are the MLS report's figures (none, when no report is attached); the article's project facts still pass. `externalStatisticsAuthorized` is `false`. The editorial card is carried unchanged.

Each opportunity states what MLS evidence it has (`mlsEvidence`) and **never says it is complete**: `none_attached`, `unreadable_or_missing` (the agent is told), `truncated` (only N of M figures were carried, because the legacy attachment ceiling is 40; the agent is told), or `read_figures_included` (every figure the reader produced was carried; whether the reader found every figure in the report is not verified).

**Future PRs, not in this one:** the structured evidence registry (a complete, validated, metric-aware set of report figures with periods and geographies, replacing the 40-figure attachment), the structured editorial brief and full Article-Led Planner integration, article retrieval and primary-source verification, and claim-level publication validation. Planner, renderer, gate and Local Events research are not changed by PR 2.

## Compact Stage A (the default Article-Led design)

Decided Oct 31, 2026, after the live benchmark: the detailed five-card prompt under-produced because the model self-limited and five cards of analysis pressed against the output allowance. Stage A is now **discovery only**: up to **eight compact, traceable candidates** (about 250 to 400 output tokens each). Heavy analysis, competing explanations, project-fact verification and the ten-question exploration belong to the selected article in Stage B (a later PR; no article fetcher or evidence registry here). `AGENT_MARKETING_ARTICLE_LED_DESIGN=detailed` keeps the earlier prompt for diagnostics.

* **Code qualifies, ranks and selects up to five.** A weak slot is never filled and eight are not required. Billing is unchanged: five qualifying opportunities are one charged session; fewer is an uncharged partial result with the MLS Market Trend option.
* **Qualify first:** grounded sources, a named development and angle, homeowner relevance, not low strength, a legitimate geographic attribution (wider-area information needs a route), timeliness (60 days for news, 12 months for official primary records), and no expired event.
* **Then rank:** editorial substance and homeowner relevance first (strength, relevance, a dated development), then authoritative or original-source support, geographic specificity (only when a name was actually found in a title, address or host), corroboration, recency. Source type alone does not outrank a more useful story. Brokerage and agent sources are not banned; they are labelled.
* **Geography:** relationship vocabulary `market, district, zip, city, county, region, state, national`. Only the selected subdivision or market itself is scope `market`. Crocker Ranch is a subdivision within West Roseville, ZIP 95747, the City of Roseville and Placer County; levels are separate and are never assumed to share boundaries. A Roseville planning action can matter greatly to Crocker Ranch homeowners without being a Crocker-specific development. The model's `source_geography` is provisional and is not corroboration; a name found in a title or URL is recorded as name evidence, never as verification of project boundaries. An unsupported claim is kept provisional, flagged for review and given no ranking weight.
* **Events:** an expired event or past comment deadline is not presented as upcoming. It stays only when the research explains what continues AND a kept source published after the event supports it; the `continues_after_event` flag alone is not enough.
* **Status:** the enum includes `unresolved`. Conflicting approval, entitlement, construction or completion evidence (a model-stated conflict, or sources showing different states) stays unresolved, even when one source is official.
* **Publisher classification** is deterministic where reliable (government record, original local reporting, trade aggregation, brokerage or agent commentary, syndicated release, and others) from an outlet registry plus official hosts.
* **Retries:** the ordinary retry is **off** for Article-Led (`AGENT_MARKETING_ARTICLE_LED_RETRIES`, default 0, only to measure it). A targeted second discovery pass is to be evaluated later. Legacy keeps its strongest-attempt retry.
* **Output allowance:** 4,500 tokens is the initial compact configuration, compared with 6,000. Neither is locked for production until the benchmark shows acceptable yield and cost.
* **Stage B handoff record** (stored with each selected candidate, as `candidate`): a stable candidate ID (a hash of market, development, angle and the first non-background article), source references (`<id>:s1`...) with outlet class, the development's identity (name and angle keys), geographic context (relationship, route, hierarchy, name evidence, provisional flags), status including any conflict, the event, selection scores, and a provisional evidence status (`publicationAuthorized: false`, claims source-reported and not verified, project facts not investigated until Stage B).

Benchmark (20 runs, provider-access session): eight compact runs at 4,500 output tokens, eight at 6,000, and four runs of the detailed prompt at 8,000 (one per market):

```
PERPLEXITY_API_KEY=placeholder NODE_USE_ENV_PROXY=1 node scripts/research-baseline.js --live --prompt compact --repeats 2 --out /tmp/rb-compact
node scripts/research-baseline-inventory.js /tmp/rb-compact --sample-cells compact_r20_c6000_o4500 > /tmp/rb-compact-inventory.md
node scripts/research-benchmark-report.js --v1 /tmp/rb-full --v2 /tmp/rb-compact --out /tmp/compact-review.md --json /tmp/compact-review.json
```

## Benchmarking v1 against v2

Same markets, same controlled configurations, one search, retries off. The v1 reference is the completed 40-run baseline (its `r10_c6000` and `r20_c6000` cells, plus `as_shipped`).

```
# 1. the 24 v2 searches (3 cells x 4 markets x 2 repeats); writes runs.jsonl, discovery and cards per run, summary.md
PERPLEXITY_API_KEY=placeholder NODE_USE_ENV_PROXY=1 node scripts/research-baseline.js --live --prompt v2 --out /tmp/rb-v2

# 2. one review document comparing v2 with the saved v1 baseline folder
node scripts/research-benchmark-report.js --v1 /tmp/rb-full --v2 /tmp/rb-v2 --out /tmp/benchmark-review.md --json /tmp/benchmark-review.json
```

v2 cells: `v2_r20_c6000_o5000` (the approved starting point), `v2_r20_c6000_o2200` (only the output-token allowance differs), `v2_default` (v2 settings with its one retry). The review document holds: measured provider cost (total, per run, per opportunity, per configuration); development diversity; opportunities with an official source or a local news or government source; local relevance (the model's relationship label, and for v2 whether a source names the market); opportunities led by an external housing statistic (a hook that pairs a figure with a market measure and names no development, and opportunities whose sources are only statistics, brokerage or portal material); brokerage or agent reliance; rejected-source diagnostics by stage and code for both versions; the v2 source inventory; and the actual v2 opportunities with their evidence for a human to judge. The proxies are structural; the review sample is the real test of quality.
