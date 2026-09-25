# CF-050 — Evidence currentness, append-only state and exact Ed25519 closure

Date: 2026-08-14
Scope: deterministic customer-local development evidence
Model/API calls: 0
Paid spend: USD 0
Network, containers and customer data: none

## Outcome

CF-050 closes three independently reproduced high-severity integrity gaps in the durable family registry and customer-local onboarding journey without weakening their fail-closed boundaries:

1. action-time authorization no longer trusts an entry that was eligible when it was stored;
2. durable registry and onboarding state is now bound to an append-only event history whose current tail is committed into the current state;
3. lifecycle-receipt trust is restricted to exact Ed25519 public keys and exact configured signer identities.

The original reproductions were preserved as direct regressions. Before the repair, the registry accepted expired selected qualification/conformance evidence, accepted an expired transitive dependency, accepted a mutated event type, and accepted lifecycle receipts under an Ed448 key. The onboarding journey accepted deletion of the current event tail. The repaired paths reject each case.

## Action-time currentness

`DurableFamilyRegistry.recheckBeforeAction` now revalidates the selected capability and its full transitive dependency graph immediately before action. For every node it requires the exact current signed lifecycle receipt and checks:

- exact tenant, environment, family, candidate, version, manifest and receipt identity;
- active lifecycle status and unexpired lifecycle evidence;
- unexpired qualification and conformance evidence;
- a present independent observer;
- current healthy registry posture; and
- all recursively required dependencies under the same checks.

Stored `eligible` state is not treated as sufficient action authority. A dependency receipt cannot be omitted, substituted or inherited from a stale parent snapshot. The migrated CF-044 and CF-045 execution paths now supply the exact dependency lifecycle-receipt graph at every action recheck.

## Append-only registry history

The registry state contract is now version 3.0. Each scoped registry event commits:

- schema version;
- monotonic event body and scope;
- event type;
- exact payload digest;
- previous-event digest;
- occurrence time; and
- its own digest.

The current scope record commits the exact event count, head digest and trusted-signer-configuration digest. Every current registry entry is rebound after a mutation to that exact state head. Snapshots bind the same event count/head and trust digest, and retain the source event digest needed to validate historical snapshot provenance.

Reads, routing, snapshot validation, action rechecks and evidence export validate this history. Editing an event type or body, deleting the tail or a middle event, reordering, inserting, moving an event across scopes, breaking a link, changing the current head, or reopening the database under a substituted trust configuration fails closed.

Legacy registry state that lacks the v3 scope/event/trust commitments is not silently accepted or upgraded. It requires an explicit controlled migration.

## Append-only onboarding history

The customer-local onboarding journey is now version 1.2. Each event commits the exact state payload, previous event and event identity. The current snapshot commits the event count and head digest, and the snapshot digest covers those commitments.

Every read validates the complete event chain against the current snapshot. Event type edits, tail or middle deletion, reorder, insertion, broken links, snapshot substitution and reopening under a different trusted release signer fail closed. Existing artifact lineage, signed-release checks, readiness currentness and failure-ledger behavior remain in force.

Legacy v1.1 journey snapshots do not silently inherit the stronger guarantee. They fail closed until an explicit migration is performed.

## Exact cryptographic trust

Registry lifecycle trust now requires an explicit `Ed25519` algorithm declaration. At construction, every configured key must import as a public Ed25519 key. Ed448, RSA, wrong key types and malformed keys are rejected before registry use.

Each lifecycle receipt declares `signatureAlgorithm: "Ed25519"` and remains bound to the exact configured key ID and issuer. A valid signature from an unconfigured key, a configured key under the wrong issuer, or a changed trusted signer set does not satisfy the trust contract.

This is exact local signature verification, not a claim of production key management, hardware-backed custody, rotation operations or rollback-resistant storage.

## Campaign migration

The CF-044 registry-snapshot mixed-family campaign and CF-045 generated-health-fault campaign were migrated additively to v3 evidence:

- `validation/cf-044-registry-snapshot-mixed-family-v3/`
- `validation/cf-045-generated-health-fault-v3/`

Their v2 artifacts remain preserved as historical evidence. The v3 corpora and implementation hashes match their seals at this checkpoint. Their initial pre-seal drafts mistakenly used future UTC timestamps because the local Seoul date had been treated as UTC; this was detected before final handoff, corrected to actual measured UTC, and protected with explicit future-date rejection tests. No old result was overwritten or relabelled.

## Direct attacks exercised

- selected qualification expiry after snapshot;
- selected conformance expiry after snapshot;
- transitive dependency lifecycle expiry after snapshot;
- missing or substituted dependency lifecycle evidence;
- event-type mutation;
- tail deletion;
- middle deletion;
- event reorder;
- event insertion;
- cross-scope event movement;
- trust-configuration substitution across restart;
- Ed448 trust-key substitution;
- RSA trust-key substitution;
- invalid signer identity or signature substitution;
- onboarding signer substitution across restart.

All tested cases fail closed.

## Verification

- Focused migrated suite: 45/45 tests passed.
- Repository TypeScript check: passed.
- `git diff --check`: passed.
- Paid/model-backed work: none.

## Claim boundary

Supported: the local durable registry now recomputes current selected and transitive dependency eligibility before action, binds current state to a validated append-only scoped event chain and exact signer configuration, and accepts lifecycle authority only under explicitly configured Ed25519 identities. The local onboarding journey now detects ordinary SQLite event mutation, deletion, insertion, reorder and signer substitution through state-bound event-chain validation.

Not supported: tamper-proofing against an administrator who can rewrite the database, all historical revisions, trust configuration and every digest consistently; hardware-backed trust; external transparency logs; operational key rotation; backup rollback protection; distributed consensus; production security; customer deployment; or universal reliability. Those require separate operational and external trust mechanisms.

## Files changed

- `src/product/durable-family-registry.ts`
- `src/product/customer-local-onboarding-journey.ts`
- `src/product/registry-snapshot-mixed-family-executor.ts`
- `src/product/cf045-generated-health-fault-campaign.ts`
- `test/durable-family-registry.test.ts`
- `test/product-customer-local-onboarding-journey.test.ts`
- `test/product-customer-local-onboarding-journey-actual-output.test.ts`
- `test/registry-snapshot-mixed-family-executor.test.ts`
- `test/cf045-generated-health-fault-campaign.test.ts`
- `test/support/cf047-lifecycle-authority.ts`
- `validation/cf-044-registry-snapshot-mixed-family-v3/`
- `validation/cf-045-generated-health-fault-v3/`
- `reports/cf-050-evidence-currentness-event-chain-and-ed25519-closure-2026-08-14.md`

No queue/review implementation, outreach, deployment, customer artifact, public claim or historical result was changed.
