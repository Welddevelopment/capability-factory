# CF-076 — Serialized reclassification publication

Date: 2026-08-14
Status: deterministic local cross-process serialization complete
Calls/spend: 0 / $0

## Problem closed

CF-071's staged-file publication removed partial reclassification risk, but a
same-host process that already held the original SQLite file could still race
the final rename. A valid admin change committed in that narrow window could
be written to the old inode and disappear from the newly published path.

CF-076 removes the rename boundary entirely. Reclassification now executes as
one SQLite `BEGIN IMMEDIATE` transaction against the actual authority store.

Inside that transaction CF:

1. recomputes the entire signed pre-reclassification state;
2. rejects any changed event, activation, admin, metadata or schema state;
3. writes the reclassification receipt, attestation and terminal metadata;
4. proves the event head/count and audit-only mode remain exact;
5. rechecks current assessor trust;
6. holds the external recovery guard's serialized currentness boundary for an
   anchored recovery; and
7. commits once, or rolls back everything.

SQLite serializes every cooperating writer to the same store. There is no
replacement file and therefore no stale-inode publication window.

## Real-process evidence

Three process-level controls were added.

### Two reclassifiers

Two child processes opened the same ambiguous store with the same frozen
attestation and started together. Exactly one committed one lineage receipt.
The other stopped on the changed/terminal state. The final database retained
one reclassification, one original activation and no execution authority.

### Crash rollback

A child process began an immediate write transaction, inserted an uncommitted
probe and exited without commit. SQLite released the writer and rolled the
probe back. The unchanged signed attestation then completed normally, with no
partial crash residue.

### Admin rotation race

A real admin-rotation process raced a reclassifier. The rotation was never
lost. If rotation serialized first, the old reclassification attestation
became stale and stopped. If reclassification serialized first, rotation
appended afterward and the reclassification remained bound to the exact older
event prefix. A fresh exact attestation could safely reclassify the rotated
ambiguous store when needed.

The concurrency test was repeated three times to exercise scheduling
variation.

## Failure-driven correction

The first race test used a rotation issue time earlier than the preceding
activation event. Historical replay correctly rejected it. The fixture was
corrected by advancing the test clock before signing rotation; chronology
validation was not weakened.

An attempted Vitest repeat flag was unsupported by the installed CLI. The
tests were then executed three times as three separate unchanged runs.

## Verification

- 12/12 focused migration/reclassification/concurrency tests passed.
- The focused race suite passed in three consecutive runs.
- 40/40 focused and adjacent authority, write-authority, enrollment and
  provider-process tests passed.
- Strict TypeScript passed.
- No model call, external network, customer data or spend occurred.

## Exact boundary

This is same-host local SQLite writer serialization. It does not prove
multi-host consensus, network-partition behavior, distributed databases,
hostile-kernel resistance, production throughput or customer disaster
recovery. Concurrent backups see a complete state before or after the atomic
commit, but a full joined post-restore write-authority path under a new
external recovery generation and live enrollment provider remains CF-077.
