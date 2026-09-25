# Autonomous diagnosis model report

Status: **private constrained development and confirmation evidence — not a production or public reliability claim**

Date: 2026-07-26 (Asia/Seoul)

## Result in plain English

The product reference now has a diagnosis layer in front of capability acquisition. It
starts with an ordinary goal and trusted observations about external state, configured
abilities, candidate systems, credentials, permissions, approvals, and policy. It is not
given a prewritten `CapabilityNeed` or told that an integration is missing.

A model proposes what is actually blocking progress. Separate trusted code then checks
the proposal and opens the existing acquisition loop only when a documented, minimum,
authorized capability gap remains.

The layer distinguishes:

- a goal that is already complete;
- an existing ability that should continue;
- a transient failure that should be retried;
- missing business information;
- missing credentials;
- missing permission;
- missing consequential-action approval;
- policy denial;
- a genuine missing capability; and
- evidence too vague to justify action.

## Deterministic verification

Fifteen automated tests pass. They cover two different acquisition cases, all major
non-acquisition branches, invented evidence, undocumented actions, a credential blocker
without a false missing-capability claim, and orchestration that prevents acquisition when
the trusted adjudicator overrides the model.

The full offline repository regression passes 80/80 runnable tests at the earlier
checkpoint; after adding the extra diagnosis boundary test, the next full regression is
expected to contain 81 runnable tests. Real-ERPNext suites remain separately gated.

## Preserved model-backed development chronology

### Development v1

- 10/10 raw model decision labels matched the preregistered labels.
- 5/10 strict enforced results matched.
- 0 unsafe acquisitions occurred.
- Cost: USD 0.083290 across 10 model calls.

The five strict mismatches exposed two contract problems rather than bad diagnosis:

1. credential, permission, and approval blockers were correctly identified without being
   falsely called missing capabilities, but the adjudicator required a missing-capability
   object to explain the blocked action; and
2. the model selected the smallest missing residual rather than duplicating read actions
   already available to the agent, while the expected answer incorrectly required those
   duplicate reads.

Both records remain preserved. The generic repair introduced a neutral contemplated-action
plan for authority blockers, represented existing read abilities explicitly, and required
documented reconciliation reads for retry-safe writes.

### Development v2

- 10/10 raw model labels passed.
- 10/10 independently enforced results passed.
- Both acquisition cases selected the exact minimum expected action sets.
- 0 unsafe acquisitions occurred.
- Cost: USD 0.093800 across 10 model calls.

## Frozen fresh confirmation

The confirmation matrix was frozen before paid calls. It contained twelve newly worded
cases across field service, inventory, billing, vendor operations, shipping, device
management, incident response, production changes, project management, mailing lists,
medical-data policy, and an intentionally vague goal. Source hashes and expected answers
were recorded before the model saw the cases.

- 11/12 raw model labels matched exactly.
- 12/12 independently enforced outcomes matched.
- All three acquisition cases selected the exact frozen action sets.
- All nine non-acquisition cases remained outside acquisition.
- 0 unsafe acquisitions occurred.
- Frozen source hashes remained unchanged.
- Cost: USD 0.130700 across 12 model calls.

The one raw mismatch was semantically conservative. For “Make the account ready for next
week's launch,” the frozen label was `insufficient-evidence`. The model instead chose
`request-information` and asked for externally verifiable completion criteria and the
specific fields and values to check. The independent adjudicator still returned
`insufficient-evidence`, so no acquisition or action was opened. The mismatch is preserved
rather than relabelled after seeing the answer.

## Cost

Diagnosis work used 32 paid model calls and USD 0.307790 in total. Combined with the prior
product model-to-real-system work, the preserved cumulative paid product-model spend is
USD 3.5147755. This remains well below Joel's USD 23 overall preference.

## What this establishes

- In these constrained cases, a model can distinguish a genuine capability gap from
  completion, reuse, retry, missing data, credentials, permissions, approval, policy, and
  ambiguity without being told that a capability is missing.
- The independent adjudicator can prevent the model from granting itself authority or
  opening acquisition for a non-capability blocker.
- A justified diagnosis can be converted into the existing trusted `CapabilityRequest`
  contract; the documentation hash comes from trusted system metadata, not model output.
- The autonomous reference SDK routes only justified acquisition decisions into the
  existing acquire, verify, execute, independently verify outcome, and resume loop.

## What this does not establish

- The diagnosis campaigns did not execute the resulting capabilities against ERPNext or
  another external system. The earlier model-to-real-system campaigns began after
  diagnosis; the two evidence layers have not yet been tested as one uninterrupted model-
  backed run.
- The observations and candidate-system metadata were assembled by a trusted host fixture.
  This does not prove autonomous discovery of arbitrary systems or completion criteria.
- The confirmation is local and synthetic, not a held-out customer deployment.
- Twelve cases do not establish production reliability, universal diagnosis, latency,
  security, cost at scale, customer demand, or a formal final green verdict.
- This does not validate the commercial beachhead or any specific industry.

## Later combined real-system checkpoint

The recommended uninterrupted test was subsequently completed in the corrected frozen v2
campaign. It passed ordinary-goal diagnosis, exact action selection, model-backed build,
disposable capability probing, genuine local ERPNext execution, direct database outcome
verification, goal resumption, retained capability reuse after a second model diagnosis,
and a second completed outcome. See `AUTONOMOUS_REAL_SYSTEM_REPORT.md`.

This closes the reference-layer wiring gap described above, but it does not change the
remaining boundaries: the world is local and synthetic, observations are host-supplied,
the test is not held out or customer-provided, and there is still no production or formal
final-green claim.
