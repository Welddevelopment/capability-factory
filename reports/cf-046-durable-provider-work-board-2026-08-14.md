# CF-046 — Durable customer-local provider work board

Date: 2026-08-14
Scope: deterministic local development evidence
Model/API calls: 0
Paid spend: USD 0
Network, containers and customer data: none

## Outcome

CF-046 now turns the provider-specific implementation gap into a durable, exact 14-task dependency graph instead of a prose checklist. It is additive to the customer-local onboarding journey and does not grant execution or activation authority.

The work board no longer accepts a caller-supplied onboarding snapshot, work pack, semantic draft, artifact digest or passing-proof boolean. It reads the current hardened v1.2 journey through a configured customer-local reader and resolves artifacts and proofs through a separate configured evidence reader. Caller-provided digests are concurrency guards only: the board derives and validates the authoritative values from the reader before accepting start or evidence.

## Hardened source binding

Before board start and every evidence attachment, CF-046 obtains a fresh hardened journey read and validates:

- exact journey and tenant identity;
- the derived source-identity digest;
- the whole journey snapshot digest;
- the complete append-only journey event history, including exact event count, event head, previous-event links and current-state binding;
- every one of the ten required onboarding stages;
- the cumulative stage-by-stage lineage, including each previous-lineage link;
- the exact CF-036 work pack and CF-041 reviewed semantic draft for the provider;
- the currently trusted release signer and exact signed release manifest identity;
- the current readiness receipt, expiry, zero unresolved failures and exact required-stage digests.

The board pins the source identity, source event count/head/state digest, journey revision/digest, cumulative lineage digest, release manifest digest and readiness receipt digest. A changed or truncated journey history, release, readiness receipt, work pack or semantic review cannot silently continue the board.

## Exact 14-task DAG

The frozen work graph contains:

1. SDK source review
2. bounded action runtime
3. no-write probe
4. stable identity and conflict handling
5. idempotency and lost-response reconciliation
6. separate read-side observer
7. freshness/outcome classifications
8. customer credential and authority confirmation
9. negative controls
10. plugin conformance
11. binding qualification
12. mandatory acceptance
13. signed release
14. host doctor

Owner split:

- engineer: 8 tasks
- customer/domain owner: 1 task
- independent proof: 5 tasks

Dependencies are checked for missing IDs, self-dependency and cycles. The projection exposes both all currently actionable tasks and one deterministic longest remaining critical path.

## Artifact and proof gates

Task completion requires two independently resolved customer-local records:

- an artifact material record; and
- a proof material record.

Both are self-digested and exactly bound to tenant, provider, journey and task. Proof additionally binds the artifact digest, every prerequisite evidence digest, source identity, exact source-event state, cumulative lineage, release manifest and readiness receipt.

Executable tasks reject generated stubs, declaration-only files and non-executable material. Their implementation digest must equal the exact reviewed content digest. Independent observer and proof tasks require an independent evidence class and cannot use the action response as observer proof. Independent proof requires a producer distinct from the explicit reviewer.

Every completed artifact and proof is re-read on board status, restart and export. Local mutation after review therefore fails closed.

## Replacement and invalidation

Replacing completed work requires the exact prior evidence digest. The replacement preserves the old evidence in an invalidation ledger and recursively invalidates every completed descendant. Invalidated work remains explicitly labelled rather than silently reverting to ordinary ready state. It can proceed only after a new exact artifact and proof are attached.

An append-only hash-linked event chain records board creation, evidence attachments, replacements and restarts. Its event count and head are committed into the board snapshot, and each event head binds the exact current board-state payload. Tail deletion, insertion, reordering and changed state therefore fail closed. SQLite compare-and-swap updates reject concurrent stale writes.

## Interfaces

CF-046 exposes:

- an authenticated localhost Fastify API for start, status, evidence, restart, events and redacted export;
- an authenticated local CLI projection over an already configured board and journey/evidence authorities;
- a redacted export that omits artifact URIs, artifact bodies and producer identities while preserving task state, digests, proof classes, invalidation history and measurements.

## Exercises and measurements

The genuine Zephyr Crate actual-output onboarding test now starts a CF-046 board from its real event-anchored v1.2 journey read, including the complete source event history, real Ed25519-verified release and final readiness receipt.

The complete 14-task work graph was then exercised twice with deterministic customer-local material readers for two materially different package identities:

- `zephyr-sdk`
- `harbor-ledger-sdk`

Each exercise reached preparation-complete after restart with all 14 task gates satisfied.

The deterministic full-board fixtures recorded:

- 14 completed tasks;
- 8 engineer / 1 customer / 5 independent-proof split;
- 6 executable implementation artifacts;
- 6 declared manual code files (one per executable fixture artifact);
- 2 manual configuration objects;
- 1 restart;
- zero execution or activation authority.

These 6/2 figures are fixture accounting for the work-board mechanism, not a fresh-human onboarding-time measurement. The separate genuine Zephyr preparation case continues to report its own actual local preparation accounting (2 manual code files and 3 manual configuration objects) and is not overwritten by the synthetic completed-board exercise.

## Measured remaining work

The genuine Zephyr actual-output exercise deliberately stops immediately after board creation. At that point the board reports the complete remaining provider-specific burden rather than pretending upstream onboarding preparation completed it:

- engineer-owned tasks remaining: 8;
- customer/domain-owner confirmations remaining: 1;
- independent-proof tasks remaining: 5;
- total board tasks remaining: 14;
- CF-046 work artifacts accepted: 0;
- execution or activation authority granted: 0.

In each deterministic completed-board fixture, the remaining counts reached 0 / 0 / 0 only after all exact artifacts and independent proofs were supplied. Those fixtures record six executable implementation artifacts and two configuration objects. They do not measure a fresh engineer's elapsed time, prove autonomous implementation or reduce the genuine Zephyr remaining-work count.

## Direct attacks exercised

- generated stub marked as completed executable work;
- declaration-only implementation;
- missing proof material;
- action response offered as observer proof;
- cross-provider material;
- cross-tenant material;
- cross-journey material;
- cross-task material rebound under a valid URI and recomputed material/proof digests;
- deleted source-journey event history;
- deleted provider-work event tail;
- future-issued artifact/proof material;
- stale journey revision/digest;
- stale release/readiness proof binding;
- cyclic task dependency;
- implementation mutation after review;
- upstream replacement attempting to preserve descendant proof;
- blocker/invalidation erasure through ordinary projection.

All fail closed. Upstream replacement preserves invalidation receipts and removes descendant completion evidence.

## Verification

- CF-046 plus genuine Zephyr actual-output integration: 2 files, 10/10 passed.
- Expanded targeted dependency and integration suite: 5 files, 41/41 passed.
- Repository TypeScript check: passed.

## Claim boundary

Supported: a durable, restart-safe, customer-local mechanism can represent and enforce the exact provider implementation/proof DAG, anchor it to a current event-validated hardened onboarding chain, detect source or board event-tail deletion, invalidate descendants on change and expose an authenticated operational surface.

Not supported: that CF autonomously completes these provider-specific engineering tasks; that these fixture artifact/proof readers are a production evidence store; that the two package exercises are customer or fresh-human validation; or that the board grants pilot activation, production reliability or customer demand.

## Files changed

- `src/product/customer-local-provider-work-board.ts`
- `test/customer-local-provider-work-board.test.ts`
- `test/product-customer-local-onboarding-journey-actual-output.test.ts` (additive CF-046 start assertion only)
- `reports/cf-046-durable-provider-work-board-2026-08-14.md`

No queue/review implementation, hardened onboarding implementation, external service, deployment or customer artifact was changed.

The repository's durable capability-family registry is currently schema v3. CF-046 neither changes it nor claims that provider-work completion automatically registers or activates a capability. A later integration must consume an exact current signed registry receipt through a separately authorized gate rather than infer registry eligibility from board completion.
