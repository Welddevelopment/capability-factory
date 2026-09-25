# CF-021 — seeded generative/metamorphic boundary fault campaign

Date: 2026-08-14

Status: local technical checkpoint complete

## Exact result

- Stored xorshift32 seeds: **12**
- Precommitted scenario families: **26**
- Generated cases: **312**
- Passed after fixes: **312/312**
- Unexpected failures remaining: **0**
- Unique modeled transitions: **26**
- Defects discovered, minimized, preserved and fixed: **4**
- Model calls: **0**
- Paid spend: **$0**

The seed corpus is stored at `validation/cf-021-seeded-boundary-faults-v1/seeds.json`. The reusable campaign is `src/product/seeded-boundary-fault-campaign.ts`; the deterministic runner is `src/product/run-seeded-boundary-fault-campaign.ts`; tests are in `test/seeded-boundary-fault-campaign.test.ts`. The generated replay receipt is `output/cf-021-seeded-boundary-faults-v1/campaign-receipt.json`.

## Joined boundaries

The campaign drives the real local contracts for:

1. generic controlled-pilot acceptance accounting;
2. verifier-template qualification and registry assertion;
3. CF-016 composed recovery, retry and parent resumption; and
4. CF-020 retained lifecycle, continuation, replacement and rollback.

Each scenario is replayed for all twelve stored seeds. Generated case receipts bind seed, scenario, observed transition, result and detail. Re-running the same ordered seeds produces the same campaign receipt digest.

## Generated attacks and transition coverage

The 26 transition families cover:

- authority tenant, parent, plan and family widening;
- expired retry authority and replayed retry permits;
- cross-tenant and cross-plan evidence substitution;
- capability documentation/schema/provenance material substitution;
- mutation of an integrity-bound recovery receipt;
- verifier qualification expiry;
- verifier runtime-family mismatch;
- verifier registry mismatch;
- verifier corpus/receipt mutation;
- lost response reconciled as completed without retry;
- lost response reconciled as not-started with exactly one retry;
- four concurrent retry consumers with one winner;
- duplicate parent-resumption replay;
- restart after external parent commit but before local completion receipt;
- quarantine selection blocking;
- failed replacement qualification;
- rollback that does not revive a quarantined predecessor;
- rollback requested before any activation;
- cross-tenant continuation attempts;
- action-response-as-proof; and
- acceptance binding identity replay.

The generated receipt reports zero surviving unauthorized writes, blind retries, duplicate parent resumptions, stale/quarantined selections, unsafe rollback revivals, cross-tenant evidence uses and action-response proof acceptances.

## Defects found, minimal counterexamples and fixes

### 1. Cross-tenant recovery evidence binding

Minimal mutation: change only `tenantId` on otherwise valid independent recovery evidence.

The CF-016 evidence and authority contracts previously bound plan digest, work item, state version, family and capability but did not explicitly carry tenant, parent-goal and plan-ID identity. The fix adds and checks all three identities. Cross-tenant and cross-parent substitution now fails before any transition.

### 2. Expired retry authority

Minimal mutation: set only `expiresAt` to one millisecond before decision time.

CF-016 authority receipts previously had no explicit expiry. They now carry `checkedAt` and `expiresAt`; both permit issuance and permit consumption require authority to be active at the coordinator's current time. One-use durable consumption still rejects replay.

### 3. Capability-material substitution at initial retention

Minimal mutation: change only the documentation digest supplied to CF-020 retention.

CF-020 checked exact qualification identity and recovery evidence but did not recompute a digest over documentation, schema and provenance material. CF-016 evidence/context now bind `capabilityMaterialDigest`; CF-020 recomputes it before initial retention. Documentation, schema or provenance substitution fails closed.

### 4. Action response accepted as an acceptance artifact reference

Minimal value: `action-response:claimed-complete` as the only artifact reference.

Generic acceptance already required non-empty unique evidence references but did not reject a reference explicitly identifying itself as an action/execution/self-reported response. Such references now fail validation before an evidence receipt is created and force reconciliation-required state.

All four counterexamples are stored in minimized form in the campaign receipt, without generator noise fields, and replayed across all twelve seeds.

## Restart, concurrency and reordering

- Four simultaneous consumers of the same retry permit produce exactly one authorized consumer.
- Four parent-resumption replays return the same receipt after one external execution.
- A fault after external parent completion but before local receipt commit is followed by process close/reopen against the same SQLite database; the resumed process independently reconciles and does not execute the parent again.
- A rollback arriving before any activation is rejected and leaves the current healthy version active.
- A rollback after replacing a quarantined predecessor leaves both versions unusable rather than reviving stale evidence.

## Verification

- Focused CF-021 campaign: **3/3 tests passed**.
- Generated case assertions: **312/312 passed**.
- Strict repository-wide TypeScript check: passed.
- Targeted adjacent CF-016, CF-020, verifier, acceptance and sealed-history validation: **9 files / 44 tests passed**.
- Diff whitespace/error check: run at handoff.

No network, paid call, container, customer data/action, queue edit or commit was used.

## Remaining boundaries and claim limits

The campaign is deterministic local model-based evidence, not a proof over all possible programs, schedules or failures. It does not cover operating-system or hardware corruption, SQLite engine defects, hostile code execution inside the process, real multi-host consensus, production clock synchronization, credential-store compromise, customer-specific adapters, real service semantics or unbounded concurrency. Seed diversity improves replayable transition coverage but is not independent customer evidence or a security certification.

The two exercised reusable family identifiers do not inherit one another's family-level evidence. Historical sealed campaign sources and receipts were not edited; this checkpoint does not strengthen or reinterpret those frozen claims.
