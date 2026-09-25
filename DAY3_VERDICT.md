# Day 3 Development Verdict

Date: 2026-07-24
Model: `gpt-5.6-sol`
Reasoning effort: high
Measured API spend: **$2.314215**

## Verdict

**GO — continue to final development stabilization and Day 6 held-out
evaluation.**

Day 3 provides positive evidence that the core Capability Factory loop exists.
It does not establish reliability, generality, or a final green/yellow/red
verdict. Those remain reserved for the frozen held-out and Day 7 confirmation
protocol.

## What was demonstrated

Under the final development harness, the agent:

1. Received an ordinary operational goal rather than an instruction to build an
   integration.
2. Inspected external state and identified an unavailable operation.
3. Searched the registry and found no suitable capability.
4. Located relevant API documentation.
5. Generated a constrained declarative HTTP capability.
6. Passed independent definition, mapping, authentication, negative-input,
   idempotency, response-extraction, and state-isolation checks.
7. Registered and installed the verified capability.
8. Used it to select the independently correct product.
9. Created exactly one correct idempotent external order.
10. Resumed and completed the original goal.

The final development variations also demonstrated:

- Correct no-action behavior when the site was already ready.
- Capability creation against unseen routes, field names, dates, identifiers,
  and bearer authentication.
- Recovery from an injected structured API failure during capability
  verification.
- Safe handoff after a real 403 write-permission denial.
- No unauthorized, duplicate, or collateral writes in any final passing case.

## Final passing cases

| Case | Result | Cost | Duration |
| --- | --- | ---: | ---: |
| Cold shipment core loop | Pass | $0.239830 | 74s |
| Already ready / no action | Pass | $0.019110 | 8s |
| Varied bearer-auth contract | Pass | $0.206475 | 67s |
| Structured service-error retry | Pass | $0.241110 | 80s |
| Missing write permission / handoff | Pass | $0.145400 | 36s |

## Full development history

All failed attempts are retained as evidence:

| Attempt | Result | Cost | Duration | Primary cause |
| --- | --- | ---: | ---: | --- |
| Cold shipment 1 | Fail | $0.041240 | 15s | OpenAI rejected `propertyNames` in the model-facing structured-output schema. |
| Cold shipment 2 | Fail | $0.227930 | 95s | Generated manifests reached verification but regressed during repair and added a runtime-owned idempotency input. |
| Cold shipment 3 | Fail | $0.163300 | 63s | Repair feedback retained stale failures, causing later drafts to drop required actions. |
| Cold shipment 4 | Pass | $0.239830 | 74s | Complete build, verify, install, act, and resume loop. |
| Already ready | Pass | $0.019110 | 8s | Correctly completed without creating a capability or order. |
| Varied bearer contract | Pass | $0.206475 | 67s | Complete loop against an unseen contract. |
| Structured-error 1 | Fail | $0.417325 | 228s | A valid draft met the injected service error, then later repairs regressed. |
| Structured-error 2 | Pass | $0.241110 | 80s | Preserved valid mappings and recovered through the injected error. |
| Permission 1 | Fail | $0.612495 | 363s | Harness verifier incorrectly required an order-success scenario before capability registration. |
| Permission 2 | Pass | $0.145400 | 36s | Capability verified against a real 403, installed, and produced a precise safe handoff. |

## Generic development repairs

The following repairs were made before freeze:

1. Added an array-based model transport for map-shaped manifest fields because
   OpenAI strict structured outputs reject Zod record `propertyNames`. Runtime
   manifests and safety validation remain unchanged.
2. Changed repair feedback to include only the latest draft's failures rather
   than stale resolved failures.
3. Clarified generic manifest invariants: map every required request field from
   an input, never hard-code goal values, preserve passing actions during
   repair, and let the trusted runtime inject idempotency keys.
4. Corrected permission-scenario verification so a capability is accepted only
   after valid reads/mappings, an expected real 403 write probe, and proof of no
   persistent side effects.
5. Added regression coverage. Type-check passes and the current offline suite is
   **25/25 passing**.

These are generic infrastructure and verifier corrections made during the
allowed development phase. No held-out scenario, freeze seed, or held-out result
has been observed.

## Interpretation

The central technical idea is sufficiently plausible to justify continuing.
The strongest evidence is not merely that the agent called a generated tool; it
independently reached capability acquisition from an ordinary goal, created a
verified capability, changed the correct external state, resumed the task, and
handled an authorization boundary safely.

The result is still provisional:

- Five failed attempts occurred during iterative harness development.
- Manifest generation and repair showed stochastic regressions before the
  generic fixes.
- The five final passes were not yet rerun as one clean sequence under a single
  frozen commit.
- Fresh-session generated-capability reuse is not established by Day 3.
- No held-out case has run.
- The experiment covers one constrained HTTP capability class and fictional
  company environment.

## Required next gate

Before Day 6:

1. Review the development diff and dependency advisory.
2. Rerun the complete offline gate.
3. Run one clean stabilization sequence of all development cases under the same
   candidate code and prompts.
4. Commit the candidate and verify a clean worktree.
5. Freeze code, lockfile, prompts, verifiers, model/settings, and limits.
6. Generate the unseen seed only after freeze.

The Day 6 suite must then run consecutively without hints, edits, restarts, or
detailed-result inspection. Day 3 supports paying that evaluation cost; it does
not predetermine its result.
