# Market Update modes, source of truth, and B1/B2 in research (Nov 8, 2026)

Development and Test only. B1/B2, page-started jobs and script mode need `AGENT_MARKETING_B1_EVIDENCE=dev`. Production is unchanged.

## The three modes (chosen in the research form, saved on the project)

| Mode | Research `data_source` | Report | What may supply figures |
|---|---|---|---|
| 1. Market Trend Update (`trend_report`) | `upload` | required | the uploaded Trend/CMA report only |
| 2. Article-Led Market Update + Trend/CMA (`article_report`) | `both` | required | the article: facts, project counts, dates, milestones, context; the report: every local market performance statistic |
| 3. Article-Led Market Update, Realtor Editorial (`article_editorial`) | `web` | not used | the article's validated facts and attributed figures, with source and qualifiers |

How the mode is handled:
- **Storage:** `agent_marketing_projects.market_update_mode` (migration `20261108_agent_marketing_projects_market_update_mode`, applied to the development database only).
- **Saving:** the research endpoint saves the mode (`action: "set_mode"`, and again on `start`) and returns it with the project's research list.
- **Server rule:** `validateResearchRequest` derives the data source from the mode, and refuses modes 1 and 2 without a confirmed report.

## Source-of-truth correction (`lib/agent-marketing-article-lib.js`)

**Before:** every sentence pairing a digit with words like "listings", "sales", "rates" or "%" was dropped. This also removed planned-development counts, and turned "Could 81 builder listings change what Lincoln resale sellers can ask?" into the placeholder "the topic's question".

**Now:** `numberRoles()` classifies each number by the words around it.

| Classified as | Examples |
|---|---|
| Market statistic (comes from the report) | "81 builder listings", "$625,000 median", "49 days to sell", "2.7 months of inventory", "95% of list price" |
| Article fact (stays in the topic text) | "132-unit apartment complex", "1,200 homes", "March 2026", "$45 million project", "mortgage rates near 6.5%", "$20,000 in incentives", "Mello-Roos $300 a month" |

What mode 2 removes:
- **Questions:** only the market figure ("Could builder listings change…").
- **Other text:** only the sentences that state a market statistic.

Mode 3 topics written by B2 are not `reportFirst`, so their validated, attributed figures may be stated. Discovery topics without B1 stay conservative (`reportFirst`).

## B1/B2 in research

**`agent-marketing-research-background.js`** calls `b2.enrich` after discovery, for modes 2 and 3:

1. **B1:** up to three distinct articles from the discovery topics, each run through `articleEvidence`:
   - the existing evidence job (`extract_v3` snapshot, ledger reservation and caps, provider, evidence gate);
   - keyed by the article (`a-<sha>`) under the research run;
   - the project's evidence pointer is not set here.
2. **B2:** one Claude call with the structured Realtor editorial prompt (`b2.systemPrompt`).
   - **Input:** the validated findings (held findings as a count), the market, the audience, and in mode 2 the report figures (R ids).
   - **Output:** up to 10 candidates, each grounded in one article's findings, with mechanism, homeowner implication, angle and why it matters, plus 5 selected.
3. **Code checks (`b2.validate`), structure only since Nov 9, 2026:**
   - each cited finding exists and belongs to the candidate's article;
   - no near-duplicate questions;
   - fewer than 5 selected are filled in order from the remaining valid candidates.
   - The number-matching checks (mode 2 article market statistics, mode 3 numbers outside the cited quotations) are retired (product-owner decision).
4. **Cards:** the five become the existing research cards (`b2.toTopics`). Each carries:
   - `b1` (article key, evidence id, completeness, findings) and `b2` (mechanism, implication, angle, source quotations);
   - a `candidate` marker;
   - in mode 2, the report figures attached by `applyReportPrecedence`.
5. **Fallback:** if no article can be read, or B2 gives nothing usable, the discovery cards stay and `usage.b1b2.state` says why. Charging is decided by the research run, as before.

**Selecting a card** freezes it on the project. "Write my script" (script mode) then:
- finds the article's evidence row through `topicKeyOf(topic)` (the article key), so B1 is not called again;
- plans with `article_evidence` and the new `editorial_direction`, guided by planner rule 2i (development prompt only).

Edit, approval and storyboard checks use the same evidence.

**Mode 1 topics** (no article) go through script mode with the status `not_needed`, straight to the script writer.

## Test deploys behind team login

A branch deploy cannot call its own functions. With the development switch on, a non-production host and a non-production database:
- research `start` answers `dispatch: true`;
- the page starts `agent-marketing-research-background` itself with the user's token.

This is the same pattern as the B1 job and script mode.

## Tests

| File | Covers |
|---|---|
| `tests/agent-marketing-market-update-modes.test.js` | modes, classifier, B2 validation and cards, planner direction, page wiring |
| `tests/agent-marketing-b1-script-flow.test.js` | modes 1–3 end to end with the real worker and evidence gate, the mock B1 provider and a stub B2 answer; fallbacks |

Full suite with the private workspace: 773/773.

## Creative architecture (Nov 9, 2026, product-owner decisions, development only)

- **Editorial claim-evidence checks retired** in the development Test environment (`AGENT_MARKETING_B1_EVIDENCE=dev` and a non-production database):
  `b1_claim_context`, `b1_held_quote`, `b1_unsupported_figure`, `invented_number`, `report_priority` and the market-opinion note are not run for
  script generation, edits, approval, card copy or image descriptions; the render manifest skips its claim, on-screen number, small-sample and
  article-in-opening/closing errors; B2 no longer drops candidates by number matching. Kept: Fair Housing, specific-home/listing rules, the
  MetroList notice, AI-image disclosure, template allowlist, fabricated testimonials/results, structure and renderer checks.
- **Audience continuum.** B2's prompt (AUDIENCE, INTERPRETATION, rule 3b) and the development script-writer prompt (rules 2j, 2k) treat Seller and
  Buyer as interests, not readiness: sellers thinking (2–5 years), planning (1–2), preparing (0–1) or actively selling; buyers (renters and owners)
  exploring, considering, actively searching or preparing to decide. One coherent story, natural inclusive wording, no stage list.
- **Professional interpretation.** The article is the factual foundation, not the boundary. Missing dates, costs or outcomes do not force generic
  narration; nothing precise is invented. B2 returns `audience_journey`, carried as `editorial_direction.audience_journey` to the script writer.
  With no report, rule 2g no longer keeps article facts out of the first and last scenes.
- **End to end on the Test site.** Images and Reel preparation are started by the page with the subscriber's login on development deploys
  (`self-dispatch-lib` `pageDispatch` / `pageDispatchUser`), like research and script mode. Production keeps server-to-server dispatch.
