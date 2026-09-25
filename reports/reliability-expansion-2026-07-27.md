# Reliability expansion checkpoint

Date: 2026-07-27  
Evidence class: private constrained local development evidence  
Latest frozen model candidate: `ed3da87c3392b7c20c9702414b75d918204d86be`

## Plain-English result

The constrained HTTP product is now tested much more completely than it was at
the start of this workstream. It has repeated the core loop across two genuine
disposable applications with different APIs and business objects: ERPNext
procurement records and Gitea repository issues. It has also survived a
100-case fault matrix and a 1,000-job durable-sidecar volume/restart soak.

The strongest accurate conclusion is:

> The current constrained-HTTP candidate is a working local MVP with strong
> evidence for beginning a tightly controlled pilot after a real customer's
> exact workflow, permissions, adapter, and operating agreement pass their own
> activation gates.

It is not accurate to call it production-proven, universally reliable, fully
tested across arbitrary APIs, or already validated in a customer environment.

## What was added

1. A fixed 100-case deterministic stress matrix covering clean completion,
   authority denial, lost-result recovery, duplicate submissions, conflicting
   parent identity, tenant isolation, deliberately incorrect outcomes, and
   retry limits.
2. A second genuine application boundary using pinned local Gitea 1.27.0,
   restricted credentials, documented authenticated HTTP routes, retained
   capability reuse, and an independent verifier using a separate admin
   credential.
3. A generic semantic input binder. The customer workflow now supplies values
   through the candidate manifest's declared translation instead of assuming
   model-generated inputs use reference names such as `labelId`.
4. A 1,000-job durable-sidecar volume and restart soak over 50 tenants.
5. Fresh frozen model-backed confirmations for Gitea and ERPNext, plus the
   separate frozen diagnosis confirmation.

## Deterministic results

| Check | Result | Important boundary |
| --- | ---: | --- |
| Fixed fault matrix | 100/100 | Repeated local seeded cases, not 100 independent deployments |
| Genuine Gitea integration | 8/8 | Disposable local Gitea, not a customer instance |
| Gitea adapter acceptance | 10/10 | Fixed local acceptance contract |
| ERPNext procurement preflight | 6/6 | Genuine disposable ERPNext workflow |
| Ordinary test suite | 179 passed, 23 opt-in tests skipped | Opt-in genuine-system groups run separately |
| Durable sidecar soak | 1,000/1,000 terminal jobs | Simulated bounded writes, not long-duration production load |

The sidecar soak submitted each of 1,000 unique parent jobs five times, for
5,000 total authenticated submissions. It included 20 jobs recovered from a
persisted `running` state, two clean sidecar restarts, 50 conflicting request
attempts, and 100 cross-tenant read attempts. It observed:

- zero duplicate business executions;
- zero missing terminal records;
- zero premature completion signals;
- zero retry-limit violations;
- all 50 conflicts rejected;
- all 100 cross-tenant reads blocked; and
- zero configured-secret appearances in report artifacts.

The exact one-sided 95% lower bound for the all-pass 100-case matrix is 97.05%.
That number describes only repeated execution of this fixed local matrix. It
must never be presented as a production or customer success rate.

## Model-backed results

| Campaign | Result | Calls | Cost | Interpretation |
| --- | ---: | ---: | ---: | --- |
| Frozen diagnosis confirmation | 11/12 raw; 12/12 after trusted enforcement | 12 | $0.133370 | One ambiguous case received a different but equally conservative no-action classification; no safety failure |
| Preserved Gitea v1 transfer | 3/4 | 12 | $1.312665 | One case handed off safely because the probe assumed the internal field name `labelId`; zero incorrect effects |
| Fresh Gitea v2 confirmation | 4/4 | 6 | $0.156545 | 2/4 first draft; 2/4 passed after one bounded repair; every final run built, verified, acted, and reused |
| Fresh ERPNext confirmation | 4/4 | 6 | $1.225300 | 2/4 first response; 2/4 succeeded after an incomplete response was retried; no capability-verification repairs |

New paid work in this reliability expansion used 36 calls and **$2.827880**.
All model-backed source hashes remained unchanged during their frozen campaigns.
No model-backed case produced an unauthorized, duplicate, or other incorrect
external side effect.

The 4/4 Gitea and 4/4 ERPNext confirmations each required the same causal loop:

1. generate the minimum constrained manifest from documentation;
2. test it against a disposable genuine application;
3. reset probe state;
4. perform the authorized workflow;
5. verify external state independently;
6. resume the original goal; and
7. create a fresh SDK/store process and reuse the retained capability on a new case.

## Preserved failures and corrections

The evidence archive intentionally keeps unsuccessful and invalid runs:

- The first stress run reported 90/100 because its tenant-isolation assertion
  expected `null` while the real API correctly returned `undefined`. No
  cross-tenant value was exposed. Only the harness expectation was corrected.
- Initial Gitea setup stopped before product execution because the fictional
  local admin account was still marked for a password change. Fixture setup was
  corrected before the campaign.
- An early repeated Gitea acceptance run reused durable job databases after
  resetting external application state, producing 7/10. Acceptance campaigns
  now use unique immutable directories; two clean campaigns and the later
  repaired campaign passed 10/10.
- One full suite run in the restricted command sandbox produced loopback
  `listen EPERM` failures. The identical suite passed when allowed to bind its
  local test ports; this was classified as an invalid environment run.
- Gitea model v1 passed 3/4. The failure came from a verifier coupled to the
  reference input name `labelId`, while valid generated manifests used `label`.
  The product now binds trusted semantic values through each manifest's
  declared request template. A new frozen campaign used new phrasings and
  passed 4/4; the old 3/4 result remains preserved.
- In Gitea v2, two first drafts omitted the required write action. Trusted
  verification rejected them before use and both passed after one bounded
  repair. This remains a first-draft reliability limitation.
- In ERPNext, two first responses exhausted the structured-output allowance
  and were automatically retried. Both final capabilities passed without a
  capability-verification repair. This remains an efficiency and latency
  limitation.

## What this changes

The evidence is no longer confined to one ERP-shaped workflow or a handful of
successful model attempts. The same product boundary now transfers to a
materially different genuine HTTP application, and the durable sidecar has
meaningful local evidence under duplicate load, persistence, restart, conflict,
and tenant-boundary pressure.

This strengthens the controlled-pilot claim. A careful application sentence is:

> We have a working constrained-HTTP MVP tested locally against two disposable
> real applications, including capability construction, independent
> verification, fresh-process reuse, permission failures, restart recovery,
> duplicate prevention, and tenant isolation. The next step is a tightly scoped
> pilot using one company's real workflow and least-privilege credentials.

## What remains before a real pilot can be activated

- A real company must identify one recent, representative blocked workflow.
- Its exact API documentation, sandbox, authentication, permissions, data
  boundary, and approval rules must be known.
- A company-specific adapter must pass the fixed acceptance contract.
- Security and operations must cover credential provisioning, log retention,
  stop authority, incident notification, and who can approve consequential
  actions.
- The team must agree on monitoring and manual recovery. Automatic reversal or
  compensation is still not implemented.
- A real pilot must start narrow. Passing local Gitea and ERPNext campaigns does
  not authorize arbitrary APIs or other capability modes.

## Remaining product limits

- Current supported acquisition is constrained authenticated HTTP APIs only.
- The local worlds are fictional and resettable; neither is an external held-out
  customer system.
- Gitea verification uses a separate privileged API credential, while ERPNext
  verification reads database state directly. Neither is an independent
  third-party audit.
- The soak is volume/restart evidence, not a multi-day endurance, distributed
  systems, or production throughput test.
- First-draft model generation is not perfect; bounded trusted rejection and
  repair remain necessary.
- Commercial demand, frequency, buyer authority, willingness to pay, and
  buy-versus-build preference remain unvalidated.
- There is still no formal final green verdict, security certification,
  production reliability claim, active pilot, customer, or revenue.

## Evidence artifacts

- Passing stress matrix: `artifacts/reliability-stress/stress-v1-2026-07-27T02-54-56-151Z/`
- Passing sidecar soak: `artifacts/sidecar-soak/sidecar-volume-restart-soak-v1-2026-07-27T03-27-12-644Z/`
- Passing Gitea acceptance: `artifacts/gitea-pilot-acceptance/gitea-acceptance-v1-2026-07-27T03-22-52-971Z/`
- Diagnosis confirmation: `artifacts/product-live/diagnosis-confirmation-2026-07-27T03-07-58-412Z/`
- Preserved Gitea v1: `artifacts/gitea-model-confirmation/gitea-model-confirmation-v1-2026-07-27T03-09-35-660Z/`
- Passing Gitea v2: `artifacts/gitea-model-confirmation/gitea-model-confirmation-v2-2026-07-27T03-23-22-367Z/`
- Passing ERPNext reliability: `artifacts/erpnext-model-reliability/erpnext-model-reliability-v1-2026-07-27T03-30-13-870Z/`

These artifact directories are private and gitignored. Do not publish raw
traces, credentials, company-system details, or internal counts without a
separate sanitization and publication decision.
