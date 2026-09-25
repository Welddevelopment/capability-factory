# CF-020 — durable recurring capability lifecycle

Date: 2026-08-14

Status: local technical checkpoint complete

## Result

CF-020 joins retained-capability health, dependency visibility, recurring and triggered re-probes, drift handling, CF-016 recovery decisions, replacement qualification, atomic activation/rollback and exact workflow continuation into one customer-local SQLite lifecycle.

Implementation: `src/product/durable-capability-lifecycle.ts`

Tests: `test/durable-capability-lifecycle.test.ts`

This is local fictional technical evidence. It is not a customer deployment, production reliability result, managed lifecycle service or new family-level acceptance claim.

## Durable state and selection rule

Each record is bound to tenant, runtime family, capability key, semantic version, qualification digest and expiry, documentation digest, schema digest, provenance digest and retention evidence.

The lifecycle persists:

- all capability versions and exact status;
- workflow dependencies;
- health assessments and triggers;
- activation/rollback receipts; and
- append-only lifecycle events.

Workflow continuation selects only an exact `active` record. It blocks when:

- there is no active version;
- the workflow is not a registered dependent;
- qualification has expired;
- a scheduled probe is due;
- health or composed recovery quarantined the record; or
- a replacement is merely staged but not activated.

No stale, candidate, quarantined, replaced or rolled-back version is selected automatically.

## Recurring health policy

Periodic runs inspect only due active records. Triggered runs can recheck immediately for documentation, schema, provenance, recovery or manual events.

The exact policy is:

- unchanged material plus a passing independent probe remains active;
- compatible documentation-only drift remains active only after a passing independent probe, with the observed documentation digest persisted;
- breaking documentation drift, schema drift or provenance drift quarantines;
- verifier failure, observation unavailability or stale qualification quarantines; and
- every assessment includes the affected workflow dependency snapshot.

CF-016 receipts are integrity-checked before use. `stale`, `partial`, `incorrect`, `duplicate` and `collateral` recovery decisions quarantine the exact matching lifecycle version. Cross-qualification recovery evidence is rejected.

## Replacement and rollback

A candidate replacement must:

- preserve tenant, runtime family and capability key;
- use a strictly higher semantic version;
- carry a fresh qualification digest and expiry;
- bind the exact documentation, schema and provenance digests; and
- pass independent replacement qualification and probing.

Activation changes the prior and replacement statuses in one immediate SQLite transaction and emits an integrity-bound rollback token. Dependency visibility remains attached to the stable family/key identity and is snapshotted in the activation receipt.

Rollback is also atomic:

- if the prior version was healthy and active, rollback restores it to active;
- if the prior version was quarantined, rollback preserves that quarantine and leaves no active capability.

The latter rule prevents rollback from silently reviving stale evidence.

## Exercised matrix

The lifecycle was exercised across the existing reusable family identifiers:

1. `generic-local-sqlite`
2. `generic-local-schema-file`

Five fictional dependent workflows were registered across the two families. The tests injected:

- benign documentation drift;
- breaking schema drift;
- verifier failure;
- stale qualification;
- unavailable observation;
- composed-recovery stale classification;
- lower-version replacement;
- failed replacement verification;
- stale replacement qualification;
- successful higher-version replacement;
- rollback from a quarantined prior;
- rollback from a healthy prior;
- twenty concurrent dependency reads through two SQLite connections; and
- close/restart continuation from the same durable database.

Family claims remain separate. CF-020 proves the lifecycle contract composes with these identifiers and deterministic test worlds; it does not modify or strengthen the frozen CF-006/CF-014 campaign evidence.

## Verification

- Strict TypeScript check: passed (`tsc --noEmit`).
- Focused CF-020 tests: 6/6 passed.
- No model calls, network access, paid spend, container work, customer action, queue edit or commit.

## Historical evidence boundary

The sealed multi-family sources were not edited. Their source hashes remain historical evidence. Adopting this lifecycle inside a sealed campaign would require a new campaign version, new precommitment and new seal rather than mutation of the prior receipt.
