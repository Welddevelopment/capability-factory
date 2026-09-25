# CF-048 — customer-local trust lifecycle and coherent signed backup

Date: 2026-08-14
Scope: local fictional development evidence only
Network/model/spend/customer data: none

## Result

CF-048 adds an independent customer-local trust ledger and coherent signed SQLite backup/restore boundary for the hardened onboarding v1.2 and registry v3 stores. It does not modify either store, grant execution authority, grant activation authority, or claim production readiness.

The trust ledger pins Ed25519 public keys and exact tenant/environment bootstrap configuration. Its states are `active`, `retiring`, and `revoked`. A rotation receipt binds the old and new key IDs, issuers, public-key digests, effective window, tenant and environment, and is verified under both the old and new keys. A revocation is a signed, effective-dated ledger event. On every read, readiness check, pre-action check, evidence write and restore, the store reconstructs current trust state from the immutable caller-pinned bootstrap plus signed lifecycle events and compares that reconstruction with the materialized key table. Restart with caller-substituted trust fails closed.

Signed evidence remains attributed to its original signing key. Reissue under a successor key requires an exact predecessor evidence ID and digest. Rotation never silently reinterprets old evidence as new-key evidence. Revocation becomes effective immediately at read, readiness, pre-action and restore.

An independent pre-seal review correctly found that three sequential `VACUUM INTO` operations, by themselves, proved only individual-file integrity—not cross-database coherence. That finding was preserved and resolved before this report was finalized. Backup now requires a trusted, signed, time-bounded receipt declaring an exclusive writer freeze over the exact trust/onboarding/registry source roles. It keeps observer connections open across all three snapshots and compares each source database's `data_version` before and after the complete set, rejecting any observed intervening write. The freeze does not create authority; the customer-local operator must actually enforce the declared exclusive-writer lease.

With that precondition, backup uses SQLite `VACUUM INTO` separately for the trust, onboarding and registry databases. The detached Ed25519-signed manifest binds:

- tenant and environment;
- bootstrap trust-configuration digest;
- signing key ID and public-key digest;
- the exact signed exclusive-freeze receipt digest;
- creation and expiry;
- the exact three-file set;
- raw byte length and SHA-256 for every database;
- a role-specific semantic scope/head digest for every database;
- SQLite `user_version` and application schema versions (`trust 1.0`, `onboarding 1.2`, `registry 3.0`);
- caller-supplied opaque source-artifact IDs/digests;
- explicit nonactivation/no-authority boundaries; and
- the explicit rollback limitation.

Before any backup directory is created, each source database is opened read-only and fully validated. Trust must contain the exact tenant, environment and pinned configuration. Every onboarding current snapshot and immutable revision is re-digested; artifact payloads and lineages are re-digested; revisions must be contiguous; the current snapshot must equal the latest revision; every event must bind its exact revision state; and the event chain/current head must be complete. Registry scope state, current entry payloads, snapshot receipts and snapshot entries are re-digested; every event body and predecessor link is verified; current and historical snapshot heads must correspond to exact event-chain positions; and trust-configuration identities must be internally exact. Cross-scope and orphaned rows fail closed. The manifest binds the resulting role-specific semantic digest in addition to raw hashes.

Restore requires a fresh destination, authenticates the detached signature only through the separately opened pinned trust store, validates scope/currentness/exact membership/raw hashes/SQLite headers/schema versions/full integrity before copying, and rejects additional WAL/SHM files. Restore currentness is derived from `trustStore.currentTime()`; the legacy caller `now` must equal that value exactly, so a backdated caller cannot accept an expired backup. Files are copied into a same-parent temporary directory, then raw length/hash, SQLite and complete semantic/event-chain validation are repeated against the copied bytes. Only a successful set is atomically renamed into the destination. Any post-copy failure removes the temporary tree and publishes no destination. The deterministic fault-injection regression mutates a copied same-tenant onboarding snapshot, observes rejection and cleanup, then confirms a clean atomic restore succeeds.

Backup creation time is taken from the trusted store clock and a conflicting caller-supplied timestamp is rejected. Lifecycle replay now enforces monotonic recorded events plus `previous recorded ≤ issued ≤ effective ≤ current record`; rotation and revocation issuers must be trusted at issuance and effect, and neither event nor evidence may predate the relevant key introduction. This closes backdated backup manifests, retroactive rotations/revocations and backdated successor evidence.

## Adversarial checks

The focused campaign covered:

- old→new dual-signature rotation and restart reconstruction;
- caller trust substitution on restart;
- forged or mutated exclusive-freeze receipts;
- malformed, unbounded or duplicate source-artifact metadata;
- explicit evidence reissue lineage;
- immediate old-key revocation at read, readiness, pre-action and restore;
- direct materialized trust-state mutation;
- direct signed-evidence mutation;
- truncated and byte-mutated databases;
- unexpected WAL substitution;
- wrong tenant scope;
- mixed-scope database rows and orphaned onboarding rows;
- caller-backdated backup creation;
- non-monotonic or retroactive lifecycle events and evidence predating signer introduction;
- manifest signer substitution/self-supplied public key;
- expired backups; and
- restored onboarding v1.2 and registry v3 use.

Final combined CF-048/049 focused verification: **61 passed / 0 failed** across:

- `test/customer-local-trust-backup.test.ts`
- `test/product-customer-local-onboarding-journey.test.ts`
- `test/durable-family-registry.test.ts`
- `test/customer-local-resource-bounds.test.ts`
- `test/customer-local-provider-work-board.test.ts`

Full TypeScript verification: **clean** (`tsc --noEmit`).

The resealed CF-040 v3 claims suite separately passed **7/7**, for **68/68** across the six requested final test files. Strict TypeScript verification was clean. The new mutations cover same-tenant onboarding `snapshot_json`, registry snapshot payload, registry event chain, backdated/conflicting restore time, and copied-file TOCTOU cleanup. An earlier whole-suite verification for the combined work produced **652 passed / 62 localhost-permission failures / 60 skipped** in the default sandbox; all 62 failed cases passed in the separately authorized affected-file rerun (**104/104**), for an effective **714 passed / 0 product failures / 60 skipped** in that earlier run.

Implementation SHA-256: `c14122156d6cd135dfac6737b85a726ce2ab5b409a719d035acfe96309201deb`

Focused trust/backup test SHA-256: `7c1715ba74bcc1ca7d54daa472058efebcebf652e8e2ff96d72ca34948752aae`

The superseding additive CF-040 v3 seal binding this implementation is `cad3dd7d9a24129352b2a224c9c49062f3c6adda5e0950314689601617118e6d`.

## Deliberate limitation

The backup is integrity-bound and currentness-bounded, but it is **not rollback-resistant without an external monotonic anchor**. A coherent older backup that is still within its validity window and whose signer remains trusted can authenticate and restore. Preventing that requires an external monotonic counter, transparency log, hardware-backed epoch, or equivalent state outside the backup set. Neither the API nor this report claims otherwise.
