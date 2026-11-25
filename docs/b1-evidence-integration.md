# B1 article evidence in the Article-Led Market Update (development only)

Added Nov 5, 2026. **Off unless the server environment sets `AGENT_MARKETING_B1_EVIDENCE=dev`.** Nothing in `netlify.toml` sets it, and no
request field can turn it on. With it off, production behaviour is unchanged: the full test suite gives the same results as before.

## Where B1 sits

```
Stage A discovery (agent-marketing-research*, article-led-lib)  ->  selected_topic (frozen on the project)
        |
        |  B1 Stage B analysis of the selected article (outside this repo) -> B1 evidence gate
        |  (quote verifier, qrec-1, human evidence review) -> load_evidence() -> "ssp-b1-evidence/1" bundle
        v
selected_topic.b1Evidence  --agent-marketing-b1-evidence-lib-->  Planner input  (plan-lib topicBrief: selected_topic.article_evidence)
                                                           \-->  Content gate   (gate.verifiedFromTopic: verified text)
```

The point between research extraction and the Planner is `topicBrief()`, which is exactly what the Planner may know about the topic. The
matching point for the content gate is `verifiedFromTopic()`, the text the gate treats as verified. Both now read B1 evidence only through
`netlify/functions/lib/agent-marketing-b1-evidence-lib.js`.

## What downstream receives

`readBundle()` checks the bundle before anything is used: its format, the sha256 of the exact payload text, its status and its shape.
Anything wrong reads as `BLOCKED`. It returns four separate things:

| Field | Use downstream |
|---|---|
| `status` | `COMPLETE`, `PASSED_WITH_HOLDS` or `BLOCKED` |
| `validated` | the **only** verified research evidence. Claim findings and their exact source quotations go to the Planner (`article_evidence.validated_findings`) and to the gate's verified text. Extraction defects are never passed on as claims |
| `held` | visible for review (B1 review page, plan warning). **Never** in the Planner input or the gate's verified text; the Planner gets a count only |
| `excluded` | never used |

**Status handling:**
- **`BLOCKED`:** `generatePlan()` throws `B1_EVIDENCE_BLOCKED` before any model call. This covers a missing gate, a failed gate and a changed bundle.
- **`PASSED_WITH_HOLDS`:** the Planner input carries `status_label: "INCOMPLETE (PASSED_WITH_HOLDS): N B1 finding(s) ... are NOT verified"`. The plan's first warning, which the agent sees in the Agent Marketing page, says the article evidence is incomplete and N findings were held.
- **`COMPLETE`, but held findings are listed:** treated as `PASSED_WITH_HOLDS`.

## Not done (blockers before any trial)

- **Nothing attaches `b1Evidence` to a stored topic yet.** Running B1 is a paid provider call, and attaching its evidence to a project needs a Stage B step. Only the fixtures and `attachToTopic()` do it today.
- **The Planner's system prompt does not mention `article_evidence`.** Rule 2b lists the topic fields the Planner may state facts from. Using validated B1 findings in narration needs a Planner rule change, which is a prompt change and was not made. The content gate already accepts validated B1 quotations as verified text.
- **No human review UI in this app.** The development review page is generated in the B1 workspace (`src/review_ui.py`).
- **No authorized reviewer.** The B1 allowlist is empty, so no held finding can be released yet.

## Tests

`tests/agent-marketing-b1-evidence.test.js` (11 tests) uses the frozen v1.2.1 FA, FB and FC outputs after the gate. They are PRIVATE and are
loaded from the B1 workspace (`ssp_fixtures/`) through `B1_WORKSPACE` by `tests/helpers/b1-private.js`; without it these tests are skipped with
the reason, and `B1_FIXTURES_REQUIRED=1` makes that a failure.
It covers:
- the statuses and the separate collections;
- FA A1 held, with A6 and A7 validated;
- FC's headline held;
- no held or excluded claim or quotation in the Planner input or the gate's verified text;
- `BLOCKED` stops the Planner before any model call;
- `PASSED_WITH_HOLDS` labeled incomplete in the Planner input and the warnings;
- a tampered or malformed bundle reads as `BLOCKED`;
- the switch off changes nothing.
