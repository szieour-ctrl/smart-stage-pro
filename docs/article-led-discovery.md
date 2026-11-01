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

## Three-lane experiment, expired events, Natomas sub-areas, publisher registry (Oct 31, after the compact benchmark)

The compact benchmark (20 runs) delivered 2.2 opportunities per run and no run delivered five; the model returned 2.9 candidates on average while using 550 to 2,100 of 4,500 to 6,000 output tokens. The output allowance was not the limit. Decisions approved for the next experiment (none permanently adopted until results are reviewed):

* **Three lanes (experiment only, `AGENT_MARKETING_ARTICLE_LED_LANES=three`).** Three independent compact passes: Municipal and Local Developments; Housing and New Construction; Financing and Local Economic Forces. Every lane gets the identical selected market and geographic hierarchy and may not enlarge the market. Code merges the candidates, deduplicates by underlying development (the strongest version is kept; duplicates are recorded on it as `alsoFoundIn`), then qualifies and ranks the strongest five. No lane or publisher quotas, no padding. One lane failing does not lose the others. No retry. Per-lane cost, yield and errors are recorded (`discovery.lanes`). Harness: `--prompt lanes` (one `lanes3_r20_c6000_o4500` session = three provider requests); review package: `scripts/research-lanes-report.js`. Default behaviour is the single compact pass.
* **Lanes run sequentially, with rate-limit handling.** The first live lane experiment was invalid: sent concurrently, the provider rejected two of three lane requests with HTTP 429 in all eight runs. Concurrent dispatch is removed. `agent-marketing-lane-runner-lib.js` runs the lanes one at a time with: a configurable minimum interval between lane starts (`AGENT_MARKETING_LANE_MIN_INTERVAL_MS`, default 3000, doubled for every 429 seen so a stricter limit is found rather than assumed away); the provider's `Retry-After` when sent (seconds or HTTP date; one longer than `..._LANE_MAX_WAIT_MS`, default 60 s, is not waited out), otherwise bounded exponential backoff with jitter (`..._BACKOFF_BASE_MS` 2000, `..._BACKOFF_CAP_MS` 30000), at most `..._LANE_MAX_ATTEMPTS` (default 4) requests per lane. Each lane has its own state: `success`, `rate_limited`, `failed` or `not_attempted`. A successful lane's answer is kept whatever happens to the others; a lane that did not answer records `returned: null` (never zero candidates); an unreadable answer is `failed` but its cost is still counted. Every run records, per lane, attempts, HTTP statuses, wait durations, actual provider cost, candidates returned and selected, with no credential. All lanes failing is a failed run, never a partial one.
* **Time budget.** The research runs in `agent-marketing-research-background` (timeout 900 s in netlify.toml). The lane phase has its own budget (`..._LANE_BUDGET_MS`, default 240 s): a request starts only if `elapsed + expected call time (60 s) <= budget`, so the lane phase can end no later than budget - expected + the 120-s call timeout = 300 s with defaults, a third of the limit. Lanes that cannot start are `not_attempted` with reason `time_budget`. Typical sequential time is about 45 to 60 seconds. If a deployment changed these settings so the worst case approached 900 s, `discovery.lane_run.within_budget` would say so.
* **Harness fix.** `scripts/research-baseline.js` passed a no-op sleep to every run, including live runs, so no backoff or interval was ever actually waited in the earlier live benchmarks; live runs now use real sleeps (replays still do not).
* **A past event is not an upcoming opportunity; a consequential decision, appeal or process after it can still be a discovery.** An expired meeting, hearing, workshop or comment period is never presented as upcoming (`presentedAs: past_event_outcome`). It stays only with source-supported continuing relevance: a kept source published on or after the event that states what it establishes, AND an open process (explained next steps, a still-open state such as pending, appealed, proposed or under construction in `status_by_source`, or conflicting status evidence). `continues_after_event` alone never decides it. Regression: the Sierra View shopping-center appeal.
* **Natomas.** North Natomas, South Natomas and named developments (for example ParkBridge, Northlake, Innovation Park) are recognized sub-areas, not treated as equivalent to ZIP 95834. A relationship level the hierarchy lacks (a `district` for Natomas) is not rejected: the market name and the known sub-areas are looked for instead, and the result stays provisional; the boundary is never verified.
* **Publisher registry.** Added `professional_commentary` (sacramentoappraisalblog.com), `local_business_news` (whatnow.com), syndicated (yahoo.com, aol.com, msn.com, newsbreak.com), portal (resideline.com) and a path rule for CBS News (only its Sacramento newsroom paths count as original local reporting). Syndicated, aggregated and professional-commentary material gets no original-reporting credit. Unknown hosts stay `unclassified` and usable; `onsiteobserver.com` is deliberately left unclassified because its nature was not verified.
* **Thin markets and billing.** Crocker Ranch is a subdivision in West Roseville in the City of Roseville; West Roseville and Roseville municipal actions can be relevant without being Crocker-specific, and geographic attribution stays separate from relevance. The MLS Market Trend fallback is unchanged when fewer than five qualified opportunities are found. The five-opportunity charging threshold and the approved request and partial limits are unchanged.

Eight-session experiment (four markets, two repeats), then the review package:

```
PERPLEXITY_API_KEY=placeholder NODE_USE_ENV_PROXY=1 node scripts/research-baseline.js --live --prompt lanes --repeats 2 --out /tmp/rb-lanes
node scripts/research-lanes-report.js --single /tmp/rb-compact --lanes /tmp/rb-lanes --out /tmp/lanes-review.md --json /tmp/lanes-review.json
```

## Two-lane confirmation, deduplication by development identity, source-supported events (Oct 31, after the valid three-lane benchmark)

* **Decision.** The economy lane is out of the next experiment (it never created a fifth opportunity and supplied the generic mortgage-rate and affordability topics; genuinely relevant local economic developments found by the two remaining lanes are not excluded). `AGENT_MARKETING_ARTICLE_LED_LANES=two` runs Municipal & Local Developments then Housing & New Construction, sequentially, with the same rate-limit handling; harness cell `lanes2_r20_c6000_o4500` (`--prompt lanes2`). `three` remains available for comparison. Billing and limits are unchanged.
* **The deduplication defect.** Both Lincoln three-lane runs delivered Parkwood twice (a municipal and a housing candidate about the same 122-home development agreement), and the benchmark reported zero duplicates, because the old test compared wording only. A five-opportunity yield now means five DISTINCT developments.
* **Identity (`agent-marketing-development-identity-lib.js`).** Two candidates are the same development when they share (1) an identifier: a permit, application, case or ordinance number, or an official record reference such as a CEQAnet record (`<SCH number>/<document number>`); or (2) a distinctive project name (not a place or generic planning word; a "Phase 2" qualifier is part of the name) plus a shared source or a similar description; or (3) a primary or official record plus a similar description. A shared secondary article alone is not enough (one article reports several projects: Parkwood and Hidden Hills stay apart), and an editorial angle never makes two developments. Rules run strongest candidate first, so the best version is kept.
* **Preserved for Stage B.** The duplicate's question, angle, why, gap, strength, relevance, status, lane and source references stay in the kept candidate's record as `alternativeAngles`; `alsoFoundIn` lists what was absorbed and on what basis.
* **Rerank and backfill.** Duplicates are removed before the five are chosen, so the next distinct qualified candidate backfills and is reported (`summary.replacements`, with its rank before and after). If fewer than five distinct developments qualify, fewer are delivered (never fabricated), uncharged, with the MLS option. `summary.duplicate_groups` lists every group; `depth_v2.distinct_developments` is computed from identity with an `identity_collisions` audit that must be 0.
* **Past events (source-supported only).** A past event is never upcoming. Its development stays only when a kept source published on or after the event reports a continuing process, pending action, appeal or consequential outcome as that source's own state in `status_by_source` (proposed, pending, appealed, under construction, approved, denied, withdrawn). The model's `after_event` text and `continues_after_event` never qualify by themselves; `completed` and `unknown` do not qualify. Regressions: Sierra View (kept: approved and appealed sources after the meeting) and Hidden Hills (dropped when no source reports an outcome).
* **Publisher registry.** `californiaconstructionnews.com` is a `trade_publication` (no local-reporting credit). A `<tenant>.legistar.com` record is official only when the tenant is an agency in the market's own hierarchy (sacramento.legistar.com for Natomas or Sacramento; placer.legistar.com for a Placer County market); otherwise it stays `unclassified`. Uncertain hosts are never granted authority automatically.

Confirmation run and package (provider-access session):

```
PERPLEXITY_API_KEY=placeholder NODE_USE_ENV_PROXY=1 node scripts/research-baseline.js --live --prompt lanes2 --repeats 2 --out /tmp/rb-lanes2l
node scripts/research-lanes-report.js --single /tmp/rb-compact --lanes /tmp/rb-lanes2l --out /tmp/lanes2-review.md --json /tmp/lanes2-review.json
```

## Implemented after the final design approval (Oct 31): gap-fill, completed infrastructure, request accounting, relevance cap

* **Completed infrastructure.** A completed public project (an `opening` event whose date has passed) is eligible when a kept, non-background source published on or after the completion reports state `completed` for that source AND the candidate states a consequential `completed_outcome` (`physical` or `policy`, 20 words or fewer) tied to that source; a ceremony alone is not an outcome; a past meeting or comment period with a completed state still has nothing continuing. Event expiration (`event.expired`, `presentedAs: completed_improvement`) and the improvement (`improvement: { status, completedDate, outcome, source, ref, provisional: true, verified: false }`) are recorded apart, always flagged for review, and stay provisional until the verification stage. An expired opening or ceremony is never described as upcoming: hook or explanation wording such as "will open", "grand opening", "ribbon cutting Saturday" or "upcoming" on a past event is rejected as `completed_framed_as_upcoming`. All 14 regression cases are tests; the Arena Boulevard / Jackrabbit Trail crossing is the positive fixture (`tests/fixtures/research-diag/arena-crossing.json`).
* **Relevance cap.** A county, region, state or national relationship is capped at `indirect`; the model's label is kept as `modelRelevance` with `relevanceCapped` and a reason. A broader jurisdiction may directly cover the market, but promotion to `direct` needs independently supported applicability, which Stage A does not have, so verification is deferred and the cap holds.
* **Gap-fill pass (diagnostic, off by default, never production).** `AGENT_MARKETING_ARTICLE_LED_GAPFILL=diagnostic`, with the two-lane configuration, fires one more compact request only when exactly 3 or 4 distinct qualified developments remain after deduplication: same market and hierarchy, sequential, the same rate-limit handling and the remaining time budget, spaced from the previous request's start. The prompt carries up to six exclusions (identities and source references built by code); code then checks every new candidate against ALL existing qualified identities (`gapfill_duplicate`), and existing developments are processed first, so the pass can only add. It never forces a fifth and changes no billing rule. The full before and after candidate pools with source provenance are stored in `usage.gapFill` (outside the size-capped discovery record).
* **Provider request accounting.** `usage.providerRequests` is the authoritative count of actual outbound provider requests, counted once at a single gate (lanes, retries, failed requests and the gap-fill pass included; `attempts` stays the number of research passes). Article-Led rows only; legacy rows are unchanged. Before EVERY dispatch the worker checks the 15-per-24-hours and 100-per-30-days limits (`requestAllowance`; it fails closed if the rows cannot be read), a refused request is neither sent nor counted, and lane results already obtained survive an optional call being blocked (`not_attempted`, reason `request_limit`). The running row's count is written before each dispatch, so a crashed worker still leaves its true count. Older rows count their `attempts` (at least 1); a running row counts at least 1.
* **Concurrency review (limitation).** There is no atomic reservation primitive in the current schema: limits are summed from the user's own rows. What keeps them from being exceeded is (1) one Article-Led session in flight per user (admission checks, then checks again after inserting the row, ordered by created_at and id, so of two racing starts the earlier stays and the later is withdrawn), and (2) the per-request gate above, which reads the persisted counts before each dispatch. Residual risks: the two reads are not one atomic operation, so a read replica lagging behind a just-written row, or two different workers for the same user that both pass admission before either insert is visible, could briefly overshoot by a few requests. A hard guarantee needs an atomic increment (for example a small counter table updated with a conditional `UPDATE ... WHERE used + 1 <= limit` through a function). That is a database migration, which is not authorized, so it is reported as a limitation before production approval.
* **Benchmark.** 16 diagnostic sessions (4 markets x 4 repeats), then the review package with the approved stop criteria:

```
PERPLEXITY_API_KEY=placeholder NODE_USE_ENV_PROXY=1 node scripts/research-baseline.js --live --prompt gapfill --repeats 4 --out /tmp/rb-gapfill
node scripts/research-gapfill-report.js --in /tmp/rb-gapfill --out /tmp/gapfill-review.md --json /tmp/gapfill-review.json
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
