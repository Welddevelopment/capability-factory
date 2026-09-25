# CF-066 — external monotonic package/authority recovery continuity

Date: 2026-08-14  
State: complete, private local protocol checkpoint  
Spend/model calls: $0 / 0

## Investor objection attacked

> “A detached signature proves an old package and authority database were valid once. If both are rolled back together, what proves they are still the newest valid recovery state?”

## Result

CF-066 adds a separate append-only monotonic continuity head to the CF-061 joined package/authority recovery path.

Every new recovery point now:

1. binds the exact external-anchor identity, tenant, installation, workspace, authority contract, trust configuration and pinned Ed25519 signer into its signed manifest;
2. pins the final recovery-manifest digest as a new externally stored generation;
3. refuses to restore unless that manifest is still the current external head;
4. holds the external head under one immediate transaction for the complete synchronous restore operation;
5. restores package data deactivated and authority data audit-only exactly as CF-061 required;
6. binds the verified recovery generation and checkpoint digest into the immutable recovery receipt; and
7. advances the external head to `restore-completed` only after that exact non-authorizing receipt exists.

Once a newer recovery point is pinned, an older correctly signed package/authority pair fails before package state changes. A recovery manifest can appear only once in the continuity history, preventing an already consumed old manifest from being reintroduced at a later generation.

## Protocol shape

The reference anchor uses a separately located SQLite store with:

- immutable scope configuration and pinned signer identity;
- monotonically numbered, Ed25519-signed checkpoints;
- exact previous-checkpoint linkage;
- `recovery-pinned` and `restore-completed` states;
- full replay and signature verification on open/read/write;
- `BEGIN IMMEDIATE` serialization across pin and restore operations;
- a checkpoint-count bound, full synchronous SQLite durability and clock-rollback rejection; and
- no execution or activation authority effect.

The product refuses an anchor path inside the package root, including resolved symlink paths. Therefore an ordinary package backup cannot contain or restore the continuity head it is being checked against.

## Process-loss recovery

A failure after package publication but before continuity completion leaves the package deactivated, the authority store audit-only and the external head at `recovery-pinned`.

CF-066 adds an exact reconciliation path. It will advance the anchor only when:

- the original recovery manifest and detached signature remain valid;
- the exact persisted recovery receipt matches its digest and recovery evidence path;
- the current installation is still deactivated under the matching authority-recovery gate;
- the authority restore receipt, final installation metadata and external recovery checkpoint all match; and
- execution and activation authority remain false.

Reconciliation changes only the external continuity head. It cannot reactivate the package or authority store.

## Negative controls and verification

- older valid recovery after a newer pin: rejected before restore;
- consumed recovery replay and re-pin: rejected;
- anchor inside package root: rejected;
- anchor restart: exact current head preserved;
- raw checkpoint mutation: rejected;
- configuration substitution: rejected;
- read-only anchor write: rejected;
- anchor clock rollback: rejected;
- package/authority/tenant/config substitution and torn sets: existing checks remain green;
- simulated process loss after deactivated restore evidence: reconciled without authority promotion.

Strict TypeScript passed. Forty focused and adjacent deterministic checks passed across the continuity anchor, package/authority recovery, authority trust, write authority, installation and package lifecycle. No model call, provider request, external network or spend occurred.

## Exact boundary

This is a local reference implementation of the protocol expected from a separately protected continuity service or medium. Storing the anchor as an ordinary file elsewhere on the same administrator-controlled machine does **not** prove hostile-local-administrator resistance, remote-service availability, distributed consensus, hardware-backed monotonic state, production durability or customer deployment.

The result does prove the application protocol and failure behavior: when the product is configured with a distinct trusted anchor, recovery currentness is no longer inferred from signatures or local timestamps alone, and an older signed recovery pair cannot pass after a newer checkpoint is pinned.

The anchor does not grant authority. A restored package still requires the existing separately signed post-restore activation before the ordinary readiness and exact-write-authority gates can pass.

## Next risk

CF-067 should bind the current external `restore-completed` head into post-recovery activation and write-authority resolution. That closes the next whole-state rollback path: restoring or manually replacing package and trust files after recovery must not let an older local active state issue authority while the external head records a later recovery.
