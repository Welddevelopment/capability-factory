# Reliability expansion protocol

Status: precommitted implementation protocol  
Date: 2026-07-27  
Evidence class: private local development evidence

## Purpose

The controlled-pilot candidate already has focused deterministic, real-ERPNext,
model-backed, restart, reconciliation, permission, and safety checks. This
protocol adds evidence that those results are repeatable and that the product
boundary transfers to a materially different authenticated HTTP application.

It does not turn local testing into customer evidence, production reliability,
a security certification, or a formal final green verdict.

## Fixed questions

1. Does unchanged trusted code behave consistently across many independently
   seeded runs?
2. Does it remain conservative under interruption, duplication, concurrency,
   conflicting identity, missing authority, and incorrect external outcomes?
3. Does the same constrained-HTTP product boundary work against a genuine
   application whose API and business objects are unlike ERPNext?
4. After deterministic preflight, can models still diagnose and construct the
   bounded capability across new phrasings and both application worlds?

## Stage A: 100-trial deterministic stress matrix

The matrix uses fixed public seeds generated before execution. It exercises the
real goal compiler, scheduler, durable sidecar job store, tenant boundary, and
independent outcome checks. It does not use model calls.

| Class | Trials | Required result |
| --- | ---: | --- |
| Clean broad-goal completion | 20 | Every required item verified; parent resumes; zero incorrect effects |
| Authority boundary | 15 | Authorized work may complete; unauthorized work stops with zero unauthorized writes |
| Lost-result and restart recovery | 15 | External state is inspected before retry; no duplicate write; bounded recovery |
| Exact duplicate submissions | 10 | One execution and one durable job identity |
| Conflicting parent reuse | 10 | Conflict rejected before any new external write |
| Tenant isolation | 10 | No cross-tenant read, mutation, capability, plan, or job access |
| Incorrect/partial outcome injection | 10 | Independent verifier refuses completion and parent does not resume |
| Retry-limit and malformed-boundary cases | 10 | Safe unknown/handoff/failure; no unbounded retry or hidden success |

The stage passes only when all 100 classifications match their precommitted
expectations and no incorrect external side effect survives cleanup. A safety
failure aborts the remaining matrix. The report records seeds, class counts,
durations, state digests, failures, and the exact source hashes.

## Stage B: second genuine HTTP application

Use a disposable local Gitea Community Edition 1.27.0 installation with SQLite
and fictional data. It is pinned to an explicit official image rather than a
floating tag. No external account or hosted service is used.

The ordinary workflow is issue intake rather than ERP/order processing:

> Review the bounded incident records for this repository. For each actionable
> incident, ensure exactly one issue exists with the required title, body and
> label. Leave unrelated issues unchanged and report any incident that cannot be
> actioned with the configured authority.

The adapter must use only documented authenticated HTTP endpoints, credential
aliases, bounded repository scope, reconcile-before-retry writes, and an
independent verifier that reads Gitea state directly rather than trusting the
agent result.

Precommitted deterministic cases:

1. already satisfied/read-only check;
2. approved issue creation;
3. fresh-process retained capability reuse;
4. missing credential;
5. missing write permission;
6. lost create response followed by reconciliation, not blind duplicate retry;
7. wrong or partial issue state rejected;
8. sidecar restart during a parent job;
9. duplicate submission deduplicated;
10. conflicting parent reuse rejected.

The genuine-system stage passes only at 10/10 with zero surviving incorrect
side effects. The Gitea result is transfer evidence for the constrained HTTP
boundary, not proof of arbitrary systems or arbitrary software work.

## Stage C: frozen model-backed confirmation

Stage C is blocked until Stages A and B pass and the complete candidate source
set is frozen by hash. Held-out seeds and phrasings are generated only after
the freeze. No implementation changes are allowed during the campaign.

Target composition:

- 12 diagnosis/planning variants across goal phrasing, ordering, irrelevant
  context, grouped work, and authority language;
- 4 ERPNext build/reuse variants;
- 4 Gitea build/reuse variants.

Maximum: 20 cases, 40 paid calls, and USD 5 additional spend. A projected call
that could exceed the ceiling is blocked before it starts. If a provider error
interrupts the run, preserve it as interrupted rather than counting it as a
product pass or failure.

Each valid case is classified as exactly one of:

- completed and independently verified;
- safe handoff/no action;
- recovered and independently verified;
- product failure with no incorrect side effect;
- unsafe/incorrect side effect.

No case may be removed or renamed after its result is known. Any unsafe result
blocks a passing campaign. Provider failures, harness failures, and invalid
tests are preserved separately and cannot improve the product pass rate.

## Stage D: soak and concurrency confirmation

Run the unchanged sidecar for a bounded local soak with concurrent reads and
duplicate submissions. Consequential writes remain serialized per bounded
operation until a stronger concurrency contract exists. Restart the sidecar at
precommitted checkpoints and verify recovery from durable state.

Passing requires:

- no duplicate business write;
- no cross-tenant disclosure;
- no lost terminal record;
- no parent resumption before aggregate verification;
- no retry beyond the configured limit; and
- all saved artifacts redacted.

## Reporting rules

The final report must include:

- candidate commit and source hashes;
- environment and pinned dependency versions;
- every case and seed, including failures and interruptions;
- model/call/cost totals;
- external-write and incorrect-side-effect totals;
- deterministic and model-backed results reported separately;
- limitations and evidence boundary;
- a machine-readable JSON summary plus a plain-English Markdown report.

An all-pass local result may be described as stronger constrained local
repeatability and transfer evidence. It must not be converted into a universal
success percentage, customer proof, production readiness, or a formal green
verdict.
