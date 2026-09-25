# Day 7 frozen confirmation report

Date: **2026-07-25**

Status: **Final yellow**

## Locked result

The immutable final verdict is **yellow**. The Day 7 fresh build passed the
complete tested acquisition loop, but the fresh-session run did not finish the
original goal successfully. This misses the preregistered green threshold even
though capability reuse and the correct external action both occurred.

The verdict was locked at `2026-07-25T05:53:57.259Z` in
`artifacts/verdict/final.json`. It preserves both the Day 6 and Day 7 suite
identities and cannot be overwritten by the later baseline.

The locked record's short reason says “Fresh-session Day 7 reuse was not
demonstrated.” In the classifier, that phrase means a *passing* fresh-session
reuse outcome was not demonstrated. The underlying result is explicitly
`reused: true`; the failed condition was goal resumption after reuse, as the
detailed evidence below records.

## Frozen identity

The Day 7 suite ran only after freeze record
`2026-07-25T05:51:43.326Z` bound the candidate to clean commit
`e1ddebce2c4a48351ee8f3a05051974538a1f6f4`. The unseen seed was generated
after the freeze check. The confirmation then ran without code, prompt,
environment, credential, or evaluation changes.

The frozen limits remained:

- model `gpt-5.6-sol` with high reasoning;
- 20 worker turns;
- three semantic manifest repairs;
- ten minutes and USD 3 per run; and
- USD 50 cumulative hard stop.

## General Day 6 repair

The Day 6 failure was preserved. The new candidate made only the permitted
general reliability repair:

- a complete manifest draft is retained and supplied to later repair requests;
- deterministic verifier feedback remains attached to that draft;
- incomplete model transports use a separate bounded retry allowance; and
- the three semantic-repair, cost, time, safety, and side-effect limits remain
  unchanged.

Before the new freeze, the candidate passed type checking, all **26/26** tests,
the zero-cost offline full loop including fresh-session reuse, the production
dependency audit, and whitespace validation.

## Confirmation results

Suite: `confirmation-suite-2026-07-25T05-52-54-869Z`

| Phase | Result | Reused | Cost (USD) | Outcome |
| --- | ---: | ---: | ---: | --- |
| Fresh unseen build | Pass | No | 0.165900 | Built both required actions on the first Factory response, passed all 24 deterministic capability checks, registered and installed the capability, created exactly one correct order, resumed the goal, and passed all outcome checks. |
| Fresh session | Fail | Yes | 0.080600 | Found, installed, and used the saved capability; created exactly one correct order. The worker then reinterpreted the valid catalogue item as “merely” a monitor, attempted a new documentation search despite an existing registry match, and terminated on the search-before-build guard. |

The suite ran from `05:52:54Z` to `05:53:57Z` and spent **USD 0.246500**.
Both phases recorded zero incorrect, duplicate, unauthorised, or collateral side
effects.

## What passed

The fresh unseen build demonstrated, without intervention:

1. inspection of the ordinary business goal and real local state;
2. recognition of the missing procurement operation;
3. registry search before generation;
4. discovery of the relevant service documentation;
5. generation of both the read and write actions on the first Factory call;
6. independent verification, including authentication, field mapping,
   idempotency, negative cases, duplicate prevention, and probe isolation;
7. registration and installation;
8. exactly one compatible, timely, correctly addressed order;
9. resumption and completion of the original goal; and
10. persistence for later discovery.

The fresh session demonstrated registry discovery, installation, and actual use
of the saved capability. All external-state checks except goal resumption
passed.

## Why green was missed

The failure was not a manifest-generation, capability-verification, lookup,
installation, API-mapping, authentication, permission, idempotency, or external
side-effect failure.

After the reused capability returned the one independently expected catalogue
product and created the one independently correct order, the worker decided
that the product name “Temperature monitor” did not represent real cold-storage
capacity. It searched the registry again, found the same capability, and then
attempted to search documentation for a newly worded need. The harness correctly
blocked that action because documentation search is permitted only after a
registry search confirms no match. The worker task therefore ended as failed,
so the `goal_resumed` check failed.

That semantic objection is understandable in ordinary language, but it is
inconsistent with the frozen fictional world, where the product's declared
supported temperature range is the authoritative compatibility signal. The
independent verifier nevertheless has to score the observed worker state, not
repair or reinterpret it after the run.

## Same-model baseline

Baseline: `baseline-2026-07-25T05-54-31-177Z`

| Phase | Result | Cost (USD) | Outcome |
| --- | ---: | ---: | --- |
| First use | Pass | 0.064980 | Used documentation and direct allowlisted HTTP calls to create exactly one correct order and complete the goal. |
| Fresh session | Pass | 0.065560 | Repeated the direct-HTTP task successfully with exactly one correct order. |

The baseline spent **USD 0.130540**. It is one illustrative comparison and is
not statistically conclusive. It does not build, independently verify,
register, retain, or reuse a capability, and it does not affect the colour
classification.

## Spend

- Cumulative measured spend after Day 5: **USD 5.208645**
- Day 6 frozen suite: **USD 0.895050**
- Day 7 confirmation: **USD 0.246500**
- Same-model baseline: **USD 0.130540**
- Cumulative measured project spend: **USD 6.480735**
- Calls recorded in the budget ledger: **242**

This remains well below the USD 35 warning and USD 50 hard stop.

## Interpretation

The final result is a strong **yellow**, not green:

- the repaired fresh-build path passed on its first Factory response;
- the full acquire → verify → install → act → resume path passed;
- the saved capability was found and used in a fresh session;
- the fresh-session external action was exactly correct;
- the worker did not complete the fresh-session goal;
- the Day 6 reuse and safe permission-denial handoff cases remain supporting
  passes; and
- the safety floor held across every Day 6 and Day 7 case.

The evidence supports a narrow feasibility claim for the constrained local HTTP
loop and identifies worker semantic consistency after action as the next
reliability problem. It does not establish production reliability, broad
generality, customer demand, or a final green evaluation.

Further improvement can proceed as a new development cycle with new frozen
confirmation evidence. It must not replace, overwrite, or retroactively relabel
this locked Day 7 result.
