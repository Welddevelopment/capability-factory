# Post-Day-7 development iterations

Date: **2026-07-25**

Status: **Two consecutive frozen fresh-build and fresh-session-reuse pairs
passed after one preserved development failure**

These iterations are additional development evidence. They do not overwrite,
replace, or relabel the immutable Day 7 **yellow** verdict.

## Why development continued

Day 7 demonstrated the full fresh-build path and a correct reused external
action, but the fresh-session worker did not finish the original goal. Trace
review showed that the fictional task and catalogue were semantically broader
and less precise than the outcome the verifier actually scored:

- the goal said to make sure the warehouse could store the shipment safely,
  which can reasonably imply installation, commissioning, and operational
  testing;
- the catalogue called the expected product a temperature monitor, which can
  reasonably sound observational rather than temperature-controlling; and
- the verifier expected one compatible unit to be ordered for delivery by the
  shipment deadline.

The next work therefore treated Day 7 as preserved evidence and began a new,
explicitly labeled development cycle.

## General repairs

The first post-Day-7 candidate:

- replaced ambiguous product display names with clear cold-storage,
  temperature-controlled, or refrigerated equipment names;
- returned an invalid documentation-search sequence as a safe, recoverable
  policy error rather than terminating the whole worker run;
- added a dedicated `eval:iterate` path that requires a clean matching freeze,
  generates its seed only after freeze verification, runs fresh build and
  fresh-session reuse against a persistent registry, and cannot write the
  locked verdict;
- expanded freeze coverage from a small subset to the worker, model gateway,
  prompts, Factory, runtime, registry, tool host, scenario, server, database,
  verifier, evaluator, task state, budget, trace, and dependency lock; and
- added regressions for unambiguous product semantics, recoverable policy
  errors, and report sanitization.

This candidate passed type checking, all local tests, the production dependency
audit, and the zero-cost offline build-and-reuse loop before commit and freeze.

## Iteration 1

Iteration:
`post-day7-iteration-2026-07-25T06-10-08-554Z`

Freeze commit:
`45afcac319352d7d976224c48cbf0e1fb200ee67`

| Phase | Result | Reused | Cost (USD) | Outcome |
| --- | ---: | ---: | ---: | --- |
| Fresh build | Pass | No | 0.425990 | Generated, verified, installed, and used the capability; exactly one correct order; goal completed. |
| Fresh session | Fail | Yes | 0.107130 | Found and used the saved capability and created exactly one correct order, then interpreted the broad goal as also requiring physical commissioning and an acceptance test. Its later model request was aborted, so goal resumption failed. |

The iteration spent **USD 0.533120**. Both phases recorded zero incorrect,
duplicate, unauthorised, or collateral side effects.

This preserved failure showed that clarifying the product name was not enough.
The remaining mismatch was the goal itself: it requested operational readiness
while the fictional world and verifier only provided and scored procurement.

## Goal-alignment repair

The future-development goal was changed from a broad storage-readiness request
to:

> A temperature-sensitive shipment arrives on Friday. Check whether its
> receiving warehouse already has compatible storage equipment. If not, order
> one compatible unit for delivery by the shipment's arrival.

This does not tell the worker which API route, fields, authentication, product,
capability, or actions to use. It aligns the natural-language request with the
external outcome the harness can actually observe and verify.

The repair passed type checking, **29/29** local tests, and the zero-cost full
offline loop before it was committed and frozen.

## Iteration 2

Iteration:
`post-day7-iteration-2026-07-25T13-56-45-165Z`

Freeze commit:
`2391197616a89a5c4a0c5b8cf36cf3fd59b57cbc`

| Phase | Result | Reused | Cost (USD) | Outcome |
| --- | ---: | ---: | ---: | --- |
| Fresh build | Pass | No | 0.153785 | Both required actions were generated on the first Factory response, passed deterministic capability verification without semantic repair, and completed one correct order and the goal. |
| Fresh session | Pass | Yes | 0.057880 | Found, installed, and used the persisted capability; exactly one correct order; goal completed. |

The iteration spent **USD 0.211665**, completed in **49.78 seconds**, and
recorded zero failed verifier checks or incorrect side effects.

## Iteration 3 — unchanged confirmation

Iteration:
`post-day7-iteration-2026-07-25T13-58-06-859Z`

Freeze commit:
`2391197616a89a5c4a0c5b8cf36cf3fd59b57cbc`

No code, prompt, scenario generator, verifier, limit, or freeze change occurred
between iterations 2 and 3. Iteration 3 generated a new seed after rechecking
the same freeze.

| Phase | Result | Reused | Cost (USD) | Outcome |
| --- | ---: | ---: | ---: | --- |
| Fresh build | Pass | No | 0.147975 | Both required actions were generated on the first Factory response, passed deterministic verification without semantic repair, and completed one correct order and the goal. |
| Fresh session | Pass | Yes | 0.058720 | Found, installed, and used the persisted capability; exactly one correct order; goal completed. |

The iteration spent **USD 0.206695**, completed in **45.32 seconds**, and
recorded zero failed verifier checks or incorrect side effects.

## Combined result

Across the three post-Day-7 iterations:

- all three fresh builds passed;
- all three fresh sessions found and used the saved capability;
- two of three complete build-and-reuse pairs passed;
- the one failed pair still created exactly the correct external state in both
  phases;
- the final two pairs passed consecutively under the same unchanged freeze;
- both final capabilities passed deterministic verification on the first
  Factory response with no semantic repair; and
- all six runs recorded zero incorrect, duplicate, unauthorised, or collateral
  side effects.

The three iterations spent **USD 0.951480**. Cumulative measured project spend
is now **USD 7.432215** across **297** recorded model calls, below the USD 35
warning and USD 50 hard stop.

## Interpretation

This is materially stronger development evidence than the locked Day 7 result:
after aligning the fictional request with its observable outcome, two new
fresh-seed build-and-reuse pairs passed consecutively without intervention or
code changes between them.

It is still not a claim of broad reliability. The scenarios remain variations
of one constrained local HTTP procurement world, and the two passing pairs are
a small sample. The correct conclusion is:

> The constrained autonomous capability-acquisition loop now has repeated
> fresh-seed development passes, including independent verification, correct
> external action, goal completion, persistence, and fresh-session reuse.

The historical final verdict remains **yellow**. A future formal evaluation may
use new preregistered scenarios and thresholds, but it must continue to preserve
the Day 6, Day 7, and post-Day-7 evidence.

## Subsequent targeted campaign

The next frozen candidate passed a five-case targeted edge campaign covering
API-key and bearer build/reuse, no-product handoff, permission-denial handoff,
and structured-error recovery. See
[EDGE_CAMPAIGN_REPORT.md](./EDGE_CAMPAIGN_REPORT.md). This later evidence is the
more relevant description of the current candidate; the historical yellow
record remains part of the chronology rather than a permanent product label.
