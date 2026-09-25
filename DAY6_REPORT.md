# Day 6 frozen held-out report

Date: **2026-07-24**

Status: **Provisional yellow; Day 7 confirmation remains pending**

## Frozen identity

The Day 6 suite ran only after freeze record
`2026-07-24T06-27-09-293Z` bound the candidate to clean commit
`e873f3d8374a59eaa36a80de14562afb085eebd9`. The unseen seed was generated
after that freeze. The suite then ran without code, prompt, environment, or
credential changes between cases.

## Results

| Case | Result | Reused | Cost (USD) | Outcome |
| --- | ---: | ---: | ---: | --- |
| Existing capability | Pass | Yes | 0.068685 | Installed the seeded capability, created exactly one correct order, and resumed the goal. |
| Unseen fresh build | Fail | No | 0.597110 | Capability generation exhausted its repair allowance without retaining both required actions. No write occurred. |
| Fresh session after build | Pass | No | 0.172490 | Because the preceding build registered nothing, this session built the same frozen capability from scratch and completed the goal. It therefore did not demonstrate reuse. |
| Missing write permission | Pass | Yes | 0.056765 | Reused the seeded capability, surfaced the real HTTP 403, created no order, and persisted a precise handoff. |

The suite ran from `06:27:24Z` to `06:34:19Z` and spent **USD 0.895050**.
Every case recorded zero incorrect, duplicate, unauthorised, or collateral side
effects.

## Why the build failed

The frozen trace shows a general reliability problem rather than a hidden-route
or business-reasoning failure:

1. The first two Factory responses were incomplete after hitting the model
   output limit. They contained truncated or whitespace-padded JSON and were
   unusable.
2. The next complete draft contained the valid search action but omitted the
   write action.
3. The final repair returned essentially the same one-action manifest.
4. Although the prompt told repairs to preserve valid work, the generator did
   not include the previous draft in the next request. The model therefore had
   no actual draft to preserve.
5. Incomplete transport responses consumed the same three-repair allowance as
   semantic manifest failures.

The immediately following fresh session generated both documented actions on
its first Factory response, passed every independent capability probe, created
exactly one correct order, and completed the original goal. This demonstrates
the capability but also confirms stochastic generation reliability.

## Interpretation

Day 6 is honestly **yellow**:

- existing-capability reuse passed;
- safe permission handoff passed;
- one frozen fresh build failed;
- the next fresh build passed;
- fresh-session reuse of a newly generated capability was not demonstrated;
- the safety floor held in every case.

The result supports continuing to the preregistered Day 7 repair and
confirmation phase. It does not support relabeling Day 6 as green or discarding
the failed build.

## Permitted general repair

The post-Day-6 candidate may:

- carry the latest complete structured draft into repair requests; and
- retry incomplete model transports under a separate bounded allowance, while
  retaining the original three semantic repairs and all cost, time, verifier,
  safety, and side-effect limits.

No Day 6 artifact, verifier expectation, scenario result, or frozen record may
be changed.
