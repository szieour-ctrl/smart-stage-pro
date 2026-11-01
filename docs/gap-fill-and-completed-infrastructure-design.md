# PR #217: gap-fill experiment and completed-infrastructure rule (design, for approval before implementation)

Status: design only. Nothing below is implemented except the report corrections in the last section. Preferred Stage A architecture (approved Oct 31): Municipal + Housing lanes, sequential provider execution with the existing rate-limit handling, cross-lane deduplication by development identity, economy lane disabled. Billing (five qualifying opportunities = one charged session) and the request and partial limits are unchanged. Nothing is merged, deployed or migrated.

## 1. Gap-fill pass (diagnostic experiment, not production)

**Trigger.** After the two lanes, validation and deduplication, run one extra pass only when the session has **three or four qualified, distinct developments**. Zero to two (the market is thin: the MLS Market Trend option is the answer) and five or more (nothing to fill) never trigger it. Of the last eight two-lane sessions this would have fired in two (Lincoln run 2 with four, Colfax run 2 with three), so the experiment needs more sessions to be informative (see Protocol).

**The pass.** One more compact request, run sequentially after the lanes, with the same market and hierarchy (no lane may enlarge the market), the same rate-limit handling and the same time budget (it starts only if elapsed + expected call time fits). Scope: municipal, housing, new-construction and *consequential local commercial or economic developments* in the selected market (so a genuinely relevant local employer, commercial project or fee change is not excluded). Cost about $0.008 per fired session.

**Exclusions passed to it** (built in code from the validated candidates, never from the model's own words; capped at 6 entries and roughly 600 tokens):

```
Already found for this market. Do NOT return these developments, another angle on them, or a restatement of them:
1. Parkwood development agreement (Lincoln). Names: parkwood. Identifiers: PLN24-00048, CEQAnet 2010102018/42. Sources: ceqanet.lci.ca.gov/2010102018/42, cahousingmarketnews.com/2026/10/...
2. ...
Find DIFFERENT developments. A page above may be cited only for a different named project.
```

Each entry carries the development's identity (project names, permit, application and ordinance identifiers, official record references) and its source references. Code, not the prompt, is the safeguard: any gap-fill candidate that matches an existing identity by the deduplication rules is dropped as `gapfill_duplicate` and recorded.

**What the pass must not do.** It never forces five (a pass that finds nothing new adds nothing); it never changes billing, request limits or partial limits; it is behind its own setting (`AGENT_MARKETING_ARTICLE_LED_GAPFILL=diagnostic`, off by default) and, in the experiment, runs only from the harness. Before any production use, request accounting must count it (open item below).

**Selection.** Gap-fill candidates join the pool and everything is reranked, so a new candidate enters only on merit. Both selections are stored (before and after the pass) so the comparison is exact.

**Measurement.** Per eligible session: the distinct qualified count before and after; the candidates the pass returned; those dropped as duplicates; those that qualified; added cost. A new candidate is a **useful add** only if all of these hold:

1. *Deterministic:* qualified, a unique identity (different project names and identifiers and no shared primary record from every excluded entry), timely, geography name found in a source.
2. *Not a variation (human review, from the cards):* a different named project, action or decision, not a restatement of an excluded story from another angle.
3. *Substantiated:* an official primary source, or original local reporting, or two independent sources. Unclassified sources alone support a provisional lead only.
4. *Geographically relevant:* market scope, or a district or ZIP relationship with a found name. A county, region or neighboring-city story (a Rocklin project for Colfax) is recorded as context, not counted as directly relevant.

Report per session: before, after, useful adds, variations, reached-five (yes or no), cost.

**Protocol.** Run the Municipal + Housing configuration over 4 markets x 4 repeats (16 sessions, about $0.25), gap-fill firing inline on eligible sessions only (expected 5 to 7, about $0.05). Total about $0.30. Report only the eligible subset for the gap-fill result, and the full 16 for the base yield.

**Stop rules.** Drop the idea if it adds a useful new development in fewer than one of three fired sessions, or if more than a quarter of what it returns is a variation of an existing story, or if its cost per added useful development is above the cost of a whole extra lane pass.

**Open item before any production use (needs your decision).** Request limits count `usage.attempts` (1 for a lane session), so a two-lane session with a gap-fill pass would count as one provider request while making up to three. I propose recording `usage.providerRequests` (the sum of every lane and gap-fill attempt) and counting that, so the approved 15 per 24 hours and 100 per 30 days keep their intent. I have not changed it.

## 2. Completed public infrastructure (rule and regression tests, before implementation)

**Rule.** A past event is never presented as upcoming (unchanged). A **completed** public project is eligible when a timely source confirms an actual, consequential physical or policy outcome that remains relevant to homeowners. Event expiration and the continuing relevance of the improvement are recorded separately.

Conditions, all required:

1. A kept, non-background source published on or after the completion date reports that source's state as `completed` in `status_by_source`, within the timeliness window (60 days for news, 12 months for an official primary record).
2. The candidate states the **outcome** with its own field, `completed_outcome: { type: "physical" | "policy", what: <20 words or fewer>, source: <kept source number> }`. `none`, empty, or a source that is not post-completion fails. Ceremony alone (a ribbon-cutting held) is not an outcome.
3. The usual qualification: homeowner relevance, a supported geographic relationship (market, district or ZIP name found, or a stated route for a wider level), not low strength.
4. Framing: for an event that has passed, the question and why must not use opening or future language (will open, grand opening, ribbon cutting Saturday, upcoming, opens on). Such a candidate is rejected as `completed_framed_as_upcoming`.

Recorded on the candidate: `event.expired: true`, `event.presentedAs: "completed_improvement"`, and `improvement: { status: "completed", completedDate, outcome, source }`, so expiration and continuing relevance are separate fields. Always flagged for review ("completed improvement; confirm outcome and relevance").

What stays as it is: `completed` still does not qualify a past *meeting* or *comment period* (nothing continues); the pending, appealed, approved, denied and withdrawn rules are unchanged; `unknown` supports nothing. A completed amenity is now eligible on the same terms (for example the Colfax skatepark), so ranking by strength and relevance, not eligibility, decides whether it reaches the five.

**Regression tests to add (the Arena Boulevard / Jackrabbit Trail crossing is the positive fixture, rebuilt from the saved Natomas card whose sources are KCRA, 2026-10-26, "Jackrabbit Trail crossing construction in North Natomas now complete"):**

| # | Case | Expected |
| --- | --- | --- |
| 1 | Arena Boulevard crossing: completion event passed, kcra.com published after completion, source state completed, outcome physical "signalized crossing", geography Natomas found | Eligible; `presentedAs: completed_improvement`; never `upcoming`; review flag; outcome and source stored |
| 2 | Same candidate with only the model's `continues_after_event` and `after_event` text, no source state | Dropped as `expired_event` |
| 3 | Completed state but `completed_outcome` empty or `none` | Dropped (no outcome) |
| 4 | Outcome stated but the source predates the completion | Dropped (no post-completion source) |
| 5 | Ceremony only (ribbon-cutting held, no physical or policy outcome described) | Dropped |
| 6 | Completion older than the window (a non-authoritative source over 60 days old) | Dropped for timeliness |
| 7 | Hook or why says "will open" or "ribbon cutting Saturday" for a past event | Rejected `completed_framed_as_upcoming` |
| 8 | A future opening event (date ahead) | Remains `upcoming`, unchanged |
| 9 | A future date with a `completed` state | Inconsistent: not eligible as completed |
| 10 | Completed project in another city with only a county relationship and no route | Rejected by the geography rules; with a route it is eligible but not counted as directly relevant with a supported geography |
| 11 | Colfax skatepark with a completed state and a stated outcome | Eligible; ranked below stronger candidates |
| 12 | Regressions unchanged: Sierra View kept via an appealed and approved source, Hidden Hills dropped without a state, Parkwood deduplication | As today |
| 13 | A past meeting with state `completed` | Still dropped (nothing continues) |
| 14 | Diagnostics | Both `expired` and `improvement.status: completed` recorded, with the outcome, source and completion date |

## 3. Geographic relevance (Decision 4)

Three separate classifications already exist on every candidate and stay separate: **scope** (`selected` only for the selected market itself, else `broader_context`), **relevance** (direct, indirect), and **evidence** (`nameFoundInSource` true, false or not checked; the boundary is never verified). The final diagnostics now count "directly relevant with a source-supported geographic relationship" only for a *market, district or ZIP* relationship with a found name, so a Rocklin story for Colfax (county or region, even marked direct by the model) is context, not counted. I propose, with the implementation, also capping the *stored* relevance of a county, region, state or national relationship at `indirect` (recording the model's original value as `modelRelevance`), so the ranking cannot treat such a story as direct either. For Crocker Ranch, West Roseville and Roseville municipal developments stay valid context, never subdivision-specific.

## 4. Source registry (Decision 5)

`houseberry.com`, `worldjournalnewspaper.com` and `abridged.org` stay unclassified. Unclassified sources support provisional leads and earn no original-reporting or official authority.

## 5. Final diagnostics and report corrections (done now)

The lanes report now reads the lane configuration from the data ("Two lanes (municipal + housing)"), carries no stale "Three lanes" wording, and reports four tiers apart: (1) qualified by deterministic validation, before duplicates; (2) unique underlying developments; (3) delivered, directly relevant with a source-supported market, district or ZIP relationship; (4) provisional discovery, none publication-authorized. Tests pin the headings and the tier-3 definition.
