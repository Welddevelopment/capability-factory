# CF-071 — Exact later reclassification of ambiguous legacy authority

Date: 2026-08-14
Status: deterministic local authority-migration control complete
Calls/spend: 0 / $0

## Problem closed

CF-068 deliberately left a legacy authority store permanently audit-only when
its historical recovery state could not be established. That was the correct
default, but it provided no safe route for exact evidence discovered later.

CF-071 adds that route without treating later evidence as permission to act.
An ambiguous migrated store can now be reclassified only through a new signed
attestation that binds all of the following:

- the original legacy source-state digest;
- the first migration receipt;
- the exact current migrated audit-state digest;
- tenant, environment, workspace and trust configuration;
- the exact append-only event prefix and activation-contract scope; and
- either an independently attested never-recovered conclusion or one exact
  current external recovery guard.

## Authority boundary

Reclassification has no activation or execution effect. It preserves the
audit-only activation mode, gives every pre-existing lease zero authority and
still requires a fresh post-reclassification activation and fresh authority
state. An anchored recovery retains the continuity requirement. A
never-recovered conclusion can remove that recovery requirement, but it still
cannot reactivate the historical activation.

## Atomic serialized publication

CF applies reclassification in one SQLite `BEGIN IMMEDIATE` transaction. The
transaction first recomputes the entire exact migrated audit state and rejects
the operation if it differs from the signed inspection. It then applies the
lineage record and confirms before commit that:

- the activation/event history is unchanged;
- the store remains audit-only;
- no old activation can be resolved; and
- the resulting recovery-continuity classification is exact.

Only then does the transaction commit atomically. The current assessor is
rechecked before commit and, for anchored recovery, the whole transaction runs
inside the external guard's current-recovery boundary.

## Durable evidence and replay defense

The published store retains exactly one reclassification row containing the
receipt and signed attestation. The authority trust validator independently
replays this evidence whenever it validates the append-only authority state.
It verifies the assessor signature at the original issue time, publication
window, original source and migration digests, classification, recovery
lineage and the exact historical event prefix. Legitimate fresh activations
may append later events without invalidating the preserved prefix.

Repeated reclassification is rejected. Pre-publication mutation, forged or
cross-migration attestations, changed receipts, widened authority effects and
post-publication receipt tampering all fail closed.

## Failure-driven corrections

The first implementation mutated the live database before performing its final
validation. Although transaction rollback covered the mutation itself, a
post-commit validation failure could have returned an error after changing
state. This was first replaced with staged validation and file replacement.
CF-076 then exposed the remaining same-host rename race and replaced it with
one fully serialized in-place transaction whose complete validation occurs
before commit. Crash rollback and competing-writer behavior are now covered by
real-process tests.

A later validation run correctly exposed that the preserved event head is a
historical prefix, not the forever-current head: a legitimate fresh activation
appends a new event. Validation now proves that the preserved digest is still
the exact event at the recorded sequence rather than incorrectly requiring the
whole event log never to advance.

Two initial focused-test failures were test defects: an over-specific expected
error phrase and non-hex test nonces. Neither weakened product rules.

## Verification

- 7/7 focused migration and reclassification tests passed.
- 23/23 focused and adjacent authority, enrollment and process-boundary tests
  passed.
- Strict TypeScript passed.
- No model call, external network, customer data or spend occurred.

## Exact boundary

This proves one local deterministic migration/reclassification mechanism. It
does not establish customer migration, production recovery, hostile-host
resistance, remote attestation, legal authority, universal historical
classification or reliability under multi-host concurrent administration.
The never-recovered conclusion still depends on a trusted independent
assessor. The anchored path still depends on a separately trusted and current
external continuity guard. A fresh activation remains mandatory before any
write authority can exist. Multi-host coordination remains outside this local
SQLite serialization boundary.
