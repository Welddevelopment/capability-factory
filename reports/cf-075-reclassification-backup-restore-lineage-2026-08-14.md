# CF-075 — Reclassification lineage across signed backup and restore

Date: 2026-08-14
Status: deterministic local backup/restore lineage complete
Calls/spend: 0 / $0

## Implemented

Signed authority audit backups now carry a semantic legacy-lineage descriptor
in addition to the existing raw database digest. For a reclassified legacy
store it binds:

- the terminal migration classification;
- original legacy source-state digest;
- first migration receipt;
- signed reclassification receipt;
- independent reclassification attestation; and
- exact pre-reclassification migrated audit state.

Backup creation verifies that the snapshotted database has the same lineage as
the live validated source. Restore verifies the signed descriptor against the
copied database before publication. The restored store then replays the full
independent reclassification receipt and attestation through the normal
authority-trust validator.

## Historical truth versus a new restore

A historical “never recovered” reclassification means the exact old store had
not been recovered before that attestation. Restoring a later signed backup is
a new recovery event; it must not rewrite that historical statement.

The validator now keeps those two facts separate:

- the original signed reclassification remains immutable; and
- the new restore sets a current recovery-continuity requirement with its own
  restore time.

For an originally anchored reclassification, a later restore may advance the
current recovery time but cannot move it before the attested original recovery.

## Restore evidence and authority boundary

The restored database records the exact source manifest digest and semantic
legacy-lineage digest. The restore receipt also binds that lineage digest.
Both metadata entries are required together and fail closed if torn or
malformed.

Restored stores remain audit-only. A fresh signed activation is still required
to leave audit-only mode. Importing that activation does not erase the new
recovery-continuity requirement: the write-authority product boundary still
requires the exact current external continuity guard, and the enrolled
production path separately requires its live provider enrollment/currentness
guard.

## Rollback and substitution controls

A signed backup made before reclassification can still be restored for audit,
but it restores the original ambiguous classification. It cannot accept a
fresh activation or authorize execution; exact later reclassification evidence
must be supplied again.

The joined attack also granted the backup signer its legitimate signing key,
modified the embedded independent attestation, recomputed the raw database
hash, replaced the manifest digest and re-signed the backup. Restore still
failed because the independent assessor's retained signature no longer matched.
This separates backup authenticity from reclassification truth.

Raw database tamper, manifest/database lineage mismatch, torn restore metadata,
reclassification receipt mutation and event-prefix mutation remain fail-closed
through the joined validators.

## Verification

- 9/9 focused legacy migration/reclassification/backup tests passed.
- 37/37 focused and adjacent authority, write-authority, enrollment and
  process-boundary tests passed.
- Strict TypeScript passed.
- No model call, external network, customer data or spend occurred.

## Exact boundary

This is local deterministic signed-backup evidence. It does not prove remote
backup custody, HSM-backed keys, hostile-host resistance, multi-host restore
coordination, disaster-recovery operations, customer use or production
reliability. Rollback remains non-authorizing by construction; determining
which recovery generation is current still depends on the separate external
monotonic continuity anchor and enrolled currentness provider. Same-host
reclassification publication concurrency is addressed separately by CF-076;
multi-host coordination remains outside the evidence.
