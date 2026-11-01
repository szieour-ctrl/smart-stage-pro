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
| Freshness | news and commentary: published within 60 days. Authoritative primary (role `primary`, kind `government_record` or `financing_economic`): within 365 days. Older than 365 days: only as background, and only while a current authoritative source in the same opportunity confirms it (an authoritative primary record within 12 months, or a government or financing record within 60 days). Otherwise dropped (`stale`, `stale_primary_unconfirmed`). At least one non-background source is required |
| Dates | `published` (per source), `action_date`, `status_checked_date` stored separately |
| Distinctness | no two opportunities with the same development and angle; near-identical questions overlap. **No article or publisher quota**; several opportunities may rest on one article; no reordering for article diversity |
| Geography | `geographic_relationship` required; anything other than `exact_market` or `same_jurisdiction` needs `route_to_market`, else it is left out. Scope is `selected` for the first two, `broader_context` otherwise |
| Required content | question, explanation, editorial thesis, named development and angle |
| Trends | a trend claim needs evidence points |
| Slots | one to five; fewer than five is valid and explained in `research_limits` |

Dropped sources and topics are recorded with PR 1's stage and code vocabulary plus the new codes (`stale_primary_unconfirmed`, `only_background_sources`, `no_editorial_thesis`, `bad_geographic_relationship`, `broader_without_route`, `duplicate_development_angle`, ...).

## Billing, partial results and limits

* **Five qualifying opportunities delivered: one session charged.** Fewer: the valid results are kept, the session is **not** charged, the limitation (`research_limits.reason`) is shown with a note offering the MLS Market Trend Reel. Legacy billing is unchanged.
* **Server-side limit on uncharged partial sets:** five per user per rolling 24 hours, plus a monthly protection limit (default 30 per rolling 30 days; `AGENT_MARKETING_PARTIAL_DAILY_LIMIT` and `AGENT_MARKETING_PARTIAL_MONTHLY_LIMIT` override; **the monthly default is a starting value to calibrate**). Only partial Article-Led sets count. Over the limit the request is refused (429, `partial_limit`) before anything is started. Failed runs are not counted (they cost provider money too; say if you want them counted).
* **MLS Market Trend Reel:** a separate, deliberate workflow (report only, needs a confirmed report, same confirmation step). It is never started automatically and never takes an article-led position.

## Interim behavior to know about

With a confirmed report attached (`both`), the report's figures are attached to each opportunity with the same function combined mode uses (`applyReportPrecedence`), so Reel creation keeps working. That marks the topic `reportFirst`, which the existing planner path treats as it treats a combined-mode web topic. Planner, renderer and gate are not changed in this PR; the structured editorial brief is a later PR.

## Benchmarking v1 against v2

Same markets, same controlled configurations, one search, retries off:

```
PERPLEXITY_API_KEY=placeholder NODE_USE_ENV_PROXY=1 node scripts/research-baseline.js --live --prompt v2          # 3 v2 cells x 4 markets x 2 repeats = 24 searches
node scripts/research-baseline-inventory.js <folder> --sample-cells v2_r20_c6000_o5000 --out inventory.md
```

v2 cells: `v2_r20_c6000_o5000` (the approved starting point), `v2_r20_c6000_o2200` (only the output-token allowance differs), `v2_default` (v2 settings with its one retry). The v1 reference is the completed 40-run baseline. Compare, side by side with the review sample of actual opportunities (the folder also holds each run's delivered cards): distinct developments, relationships, primary and local sources, brokerage or agent sourcing, status support, evidence gaps, and cost. Do not rely on the proxy score alone.
