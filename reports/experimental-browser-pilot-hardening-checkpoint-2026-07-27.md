# Experimental browser pilot hardening checkpoint — 2026-07-27

## Plain-English result

The browser expansion is no longer a single trusted click-path demonstration. It is now a separate, bounded local product route that can take one ordinary goal, split it into several browser-backed work items, construct the minimum action sequence from a hashed customer-trusted UI contract, verify that sequence without performing the business write, enforce exact authority and network rules, act once, inspect the external result independently, resume the parent goal, retain the verified capability, and reuse it from a fresh process.

It also runs through the existing authenticated durable sidecar and private operator-console event contract. Restart recovery, duplicate-parent idempotency, exact signed continuation of permission-blocked work, operational evidence, and a separate ten-case adapter acceptance gate have been exercised locally.

This materially narrows the engineering gap between the constrained HTTP route and one constrained browser-action route. It does **not** make browser actions a supported pilot mode, prove arbitrary-site discovery, or change the supported controlled-pilot mode from `constrained-http-api`.

## What was added

- A versioned `experimental-browser-actions` manifest and runtime, separate from the HTTP manifest and runtime.
- Exact semantic locators: test ID, exact label, exact placeholder, exact named accessible role, or one unnamed main landmark. Arbitrary CSS/XPath selectors and page-injected JavaScript remain unavailable.
- Exact request policies binding method, path, query, purpose, and maximum count. Session authentication is distinguished from the single authorized business write.
- Guards against cross-origin requests, unexpected redirects, WebSockets, popups, downloads, uploads, dialogs, unapproved methods, extra requests, and post-write actions other than bounded observations.
- Customer-local secret aliases resolved only at the final browser boundary; literal credentials are not stored in the capability, adapter descriptor, or acceptance artifacts.
- Reconciliation against external state before action and after a browser error. Partial, incorrect, ambiguous, or policy-escaping results stop, create an incident, and quarantine the capability instead of causing a blind retry.
- A hashed trusted UI contract and deterministic minimum builder. The builder receives a diagnosed need and exact contract hash rather than the ordinary goal or a credential value.
- An optional model-backed translator behind the same trust boundary. The model cannot invent a host, path, control, credential alias, permission, approval, or verifier, and trusted code requires it to preserve the complete minimum sequence.
- A browser broad-goal bridge using the existing validated planning/scheduling contracts. One fictional goal becomes three conservative work items, with direct verification per item and a separate aggregate external-state check before parent resumption.
- Durable sidecar operation with stable job identity, duplicate-submission idempotency, conflicting-parent rejection, restart recovery, and signed continuation bound to one saved blocked item.
- Operator-console projection through the existing sanitized event contract, with the artifact correctly labelled as a constrained browser capability rather than an HTTP manifest.
- A separate experimental adapter descriptor and ten-case acceptance harness. It cannot satisfy the HTTP pilot-readiness gate or be passed to the HTTP controlled-pilot SDK.
- A genuine disposable Gitea 1.27.0 UI transfer using session login, semantic controls, exact request policy, a direct Gitea API verifier, retained reuse, and a safe wrong-credential case.

## Frozen deterministic confirmation

Candidate commit: `74eee448cfdaa0de4eecc8f5f156931c9bd482f2`

Run: `real-browser-confirmation-2026-07-27T13-25-55-732Z-da7c0929`

The runner started from a clean worktree, hashed 178 tracked source/test/console files, and confirmed that the commit, source hashes, and worktree remained unchanged.

Passed stages:

1. strict TypeScript compilation;
2. console JavaScript syntax validation;
3. ordinary suite: 200/200 active tests passed, with 50 opt-in tests skipped in that stage;
4. genuine disposable ERPNext integration: 6/6;
5. genuine disposable ERPNext product route: 1/1;
6. genuine disposable ERPNext procurement confirmation: 6/6;
7. genuine disposable ERPNext durable sidecar: 3/3;
8. genuine disposable Gitea HTTP route: 8/8;
9. the complete simulated HTTP controlled-pilot lifecycle;
10. browser core/fault/reuse campaign: 17/17;
11. browser broad-goal, durable-sidecar, restart, signed-continuation and console campaign: 6/6;
12. the browser adapter test containing all ten precommitted acceptance cases;
13. genuine Gitea browser transfer: 2/2.

The browser core campaign includes twenty sequential operations through fresh SDK instances: one construction followed by nineteen retained reuses. The broad-goal case compiled one ordinary prompt into three work items and completed them with one construction plus two retained reuses before aggregate verification and parent resumption.

No model call or paid API spend was used in this deterministic confirmation.

Private report artifact:

`artifacts/real-browser-confirmation/real-browser-confirmation-2026-07-27T13-25-55-732Z-da7c0929/confirmation-report.json`

## Separate model-backed Gitea confirmation

Protocol: `gitea-browser-model-confirmation-v1`

Run: `gitea-browser-model-confirmation-v1-2026-07-27T13-28-47-437Z`

Against the same frozen commit and source hashes:

- one model call translated the hashed trusted Gitea UI contract into the exact constrained browser capability;
- trusted code accepted the complete bounded sequence;
- the candidate passed a pre-use browser probe that could authenticate but could not perform the business write;
- the runtime created exactly one intended Gitea issue;
- the independent Gitea API verifier confirmed the exact issue and unchanged baseline;
- after reset, a fresh SDK process reused the retained capability;
- the reuse path made zero model calls and did not invoke the fallback builder;
- both build and reuse produced zero incorrect side effects; and
- measured API spend was USD 0.043135, under the USD 2 ceiling.

This is model-backed structured translation of a trusted UI contract. It is **not** model discovery of an unfamiliar arbitrary UI. Deterministic construction remains the safer default whenever the same trusted contract already contains all required mappings.

Private report artifact:

`artifacts/gitea-browser-model-confirmation/gitea-browser-model-confirmation-v1-2026-07-27T13-28-47-437Z/confirmation-report.json`

## Preserved development chronology

The development run was not failure-free:

- the first combined genuine-system command pointed Docker at the default socket and stopped the Gitea cases before product execution; rerunning only those cases with the project-pinned Colima socket passed 2/2;
- earlier Gitea development attempts exposed unallowlisted background heatmap/repository reads, a content-history route, versioned JavaScript assets, and browser newline normalization; each caused a safe stop or independent-verifier mismatch before the frozen candidate was committed;
- the genuine ERPNext suites interfere with one another when launched against the same disposable state in one combined concurrent stage; the frozen runner now runs them as isolated sequential stages, which matches their intended test design.

These are development/harness findings, not hidden product passes. The final evidence comes from the later clean committed candidate and unchanged-source confirmation.

## Evidence boundary

Supported today remains `constrained-http-api`.

The browser work is private local experimental evidence in fictional or disposable localhost environments. It does not establish:

- arbitrary-site or universal browser capability acquisition;
- reliable discovery of an unfamiliar UI without trusted metadata;
- resilience to ordinary third-party UI changes beyond the pinned Gitea version;
- multi-write browser transactions, automatic compensation, or cross-site workflows;
- customer deployment, customer demand, production reliability, a security certification, or a service-level agreement;
- a locked commercial beachhead; or
- a formal final green verdict.

The next evidence boundary for browser actions would require a company-specific safe workflow, representative system, least-privilege account, customer-approved UI contract and authority envelope, acceptance rerun, and agreed stop/operations process. Until then, the route should remain isolated, reversible, and labelled experimental.
