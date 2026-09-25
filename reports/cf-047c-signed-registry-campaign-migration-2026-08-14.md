# CF-047C — Signed registry campaign migration

Date: 2026-08-14
Scope: deterministic local development evidence only
Model/API calls: 0
Paid spend: USD 0

## Outcome

CF-044 and CF-045 now use the hardened CF-047B durable-family-registry contract. The migration removed all self-issued v1 lifecycle receipts, obsolete partial refreshes and caller-asserted lifecycle digests from these campaigns.

The campaigns now accept lifecycle evidence only from an injected authority interface. Production modules contain no test private key and do not export a fixture issuer. Tests use one fixed Ed25519 fixture issuer from `test/support/`, with an exact key ID, issuer and public-key trust configuration.

## CF-044 migration

- Lifecycle receipts are schema v2 and bind tenant, environment, family, candidate, capability version, issuer, key ID, issuance/check/expiry timestamps and all material digests.
- Every route uses the digest of the exact signed lifecycle receipt as its opaque evidence reference.
- The three runtime families have explicit dependencies: pinned document -> signed message -> scoped database.
- Every action uses `recheckBeforeAction`, which revalidates the persisted snapshot, current registry row, dependency graph and exact signed lifecycle receipt immediately before the action.
- Quarantine is applied through a complete `refreshEvidence` observation for all three registered families. It does not use a partial or weak refresh.
- Unrelated families remain registry-eligible after complete evidence refresh. The deliberately quarantined database family is ineligible.
- A replacement requires a separately signed higher-version lifecycle receipt, an exact expected revision, a new snapshot and explicit lineage.
- Cross-family receipt substitution and invalid-signature substitution are both blocked before action.
- The existing restart, lost-response idempotency, no-replacement handoff, higher-version replacement and exactly-once parent resumption semantics are preserved.

## CF-045 migration

- All 18 frozen fault/boundary transitions now execute against the hardened registry.
- Drift, expiry, quarantine, revocation and observer-loss each use a complete signed observation set for every family. There is no selective evidence omission.
- Unrelated families remain eligible when their exact signed observation is supplied.
- Evidence-source substitution is tested as an invalidly altered signed receipt. The upsert fails atomically, the valid registry state remains unchanged and the remaining graph can proceed as a safe no-op.
- Every genuine post-verification health fault invalidates the old snapshot before the next action.
- A permitted recovery uses a separately signed higher-version replacement, preserves prior verified work, creates a new snapshot, rechecks every remaining action and resumes the parent exactly once.
- Incompatible output schema, authority, credential and manifest-lineage replacements remain blocked.
- Handoff cases do not create new aggregate proof or resume the parent.

## Frozen evidence versioning

The original v1 corpora and seals were preserved unchanged. Because the lifecycle and refresh contracts changed materially, new v2 corpora and seals were created:

- `validation/cf-044-registry-snapshot-mixed-family-v2/`
- `validation/cf-045-generated-health-fault-v2/`

The new seals bind the exact v2 corpus bytes and implementation bytes. Tests also verify that corpus mutation fails closed.

## Verification

Targeted TypeScript check:

- `tsc --noEmit`: passed

Targeted campaign tests after the final migration:

- CF-044: 5/5 passed
- CF-045: 5/5 passed
- Total: 10/10 passed

Final integration-targeted verification, including the shared hardened registry suite:

- 3 test files, 18/18 tests passed
- `git diff --check`: passed
- v2 corpus and implementation hashes matched their sealed values

Observed campaign invariants:

- CF-044: 8 intended writes, 1 blocked write, 2 parent resumptions, 0 retries, 0 stale/unauthorized/cross-family/substituted-evidence actions.
- CF-045: 18 transitions across 6 faults and 3 graph boundaries; 3 atomic safe no-ops, 5 compatible replacements, 10 precise handoffs, 20 incompatible replacements blocked, no replay of verified prefixes and no second parent resumption.

## Files changed by CF-047C

- `src/product/registry-snapshot-mixed-family-executor.ts`
- `src/product/cf045-generated-health-fault-campaign.ts`
- `test/registry-snapshot-mixed-family-executor.test.ts`
- `test/cf045-generated-health-fault-campaign.test.ts`
- `test/support/cf047-lifecycle-authority.ts`
- `validation/cf-044-registry-snapshot-mixed-family-v2/corpus.json`
- `validation/cf-044-registry-snapshot-mixed-family-v2/seal.json`
- `validation/cf-045-generated-health-fault-v2/corpus.json`
- `validation/cf-045-generated-health-fault-v2/seal.json`

CF-047C did not edit the hardened registry implementation, its tests, the onboarding journey, the queue/review system or the paused CF-046 draft.

## Remaining boundary

This is deterministic fictional local evidence. It does not establish production reliability, customer use, customer trust-key operations or a live key-rotation service. Trust-key revocation and substitution enforcement are supplied by CF-047B and exercised here through signed revocation state plus invalid-signature substitution; operational multi-key rotation remains a separate deployment concern.
