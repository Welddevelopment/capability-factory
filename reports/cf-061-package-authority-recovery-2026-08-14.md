# CF-061 — Package recovery cannot silently restore execution authority

Date: **2026-08-14**

Status: **private customer-local development checkpoint; no customer, production, deployment, activation or public claim**

## Investor objection attacked

> “The authority ledger is safe when tested alone, but ordinary package backup and restore can still bring back runnable state independently. A rollback could make an old package look active with stale authority.”

## Result

CF-061 joins the CF-057 independently signed workspace-authority trust ledger to the existing customer-local package lifecycle.

A recovery point now binds:

- the exact installation identity, product version and tenant;
- the raw package-config digest and pinned adapter-runtime digest;
- the exact ordinary installation backup manifest;
- the exact independently signed authority-trust backup manifest;
- the workspace, authority contract, trust configuration and current activation;
- the trusted signer, validity window and non-authorizing restore policy.

The package-level manifest has its own detached Ed25519 signature. The nested authority-trust backup keeps its separate signature and raw/semantic SQLite checks. Neither artifact grants execution or activation authority.

## Recovery sequence

1. The exact package recovery set, package config, installation backup, nested authority backup, currentness and independently pinned signer are verified.
2. The authority ledger is copied to a fresh customer-local state path and is changed to `audit-only-restored` before atomic publication.
3. Package data is restored through a dedicated authority-gated path. The installation is durably published as `deactivated`, with an `audit-only-awaiting-fresh-activation` marker.
4. An immutable package recovery receipt binds the installation backup, authority backup, authority restore receipt, restored database identity and final installation metadata.
5. Normal package reactivation and normal restore refuse to bypass the marker.
6. The old activation remains audit evidence but cannot resolve.
7. Reactivation requires a trusted binding from the exact restored authority-state path, for the exact workspace/contract/trust configuration, whose signed activation was issued strictly after the restore.
8. Only then is the durable package marker removed and the ordinary package-readiness gates evaluated again.

The restore also recreates the package's required empty private plan and continuation-revocation directories. The first joined test exposed that the older file-only backup format did not preserve empty directories; the recovery path now restores those required structural directories rather than weakening readiness.

## Negative controls

The focused campaign established that:

- a stale pre-restore activation cannot leave audit-only mode;
- a new activation imported into the old live authority database cannot unlock the recovered package;
- a different restore receipt cannot clear the package gate;
- ordinary `reactivate()` cannot clear the package gate;
- ordinary `restore()` cannot replace a gated installation with an older active backup;
- package-manifest mutation, tenant substitution, package-config drift and torn/extra recovery files stop before recovered state is published;
- the package stays non-ready while the recovery gate is present; and
- the exact fresh activation through the restored ledger clears the gate and returns the unchanged ordinary package checks to green.

## Verification

- strict TypeScript: **passed**;
- focused CF-061 + CF-057 + HTTP authority + pilot-package regression: **29/29 passed**;
- full repository suite with required loopback/process permissions: **798 passed, 18 failed, 60 skipped**;
- one unrelated CF-053 process-registration-window failure from the parallel full run: **passed immediately in isolation**;
- remaining persistent failures: **17**, matching the pre-existing CF-040 immutable-source-drift and short-lived plugin-fixture/doctor failures already recorded at the CF-058 checkpoint;
- model calls / spend: **0 / $0**.

The first sandboxed full run produced many `EPERM` loopback failures and is not treated as product evidence. The permitted rerun above is the relevant repository result.

## Exact boundary

This is a single-node customer-local recovery mechanism. It does not establish hostile-local-administrator resistance, distributed recovery, external monotonic rollback protection, customer use, production reliability, security certification or deployment readiness. A privileged actor who can replace raw package and trust files still requires an external monotonic anchor to prevent whole-state rollback.

The mechanism also does not make an expired or revoked activation valid. A human or authorized customer-local administrator must deliberately sign a new activation for the exact restored contract. That is an authority decision, not capability acquisition, and CF correctly stops until it exists.

## Strongest accurate private claim

> A customer-local Capability Factory package can now restore its package data and independently signed workspace-authority history as one integrity-bound recovery operation without restoring execution authority. The recovered package remains deactivated and its authority ledger remains audit-only until a strictly post-restore activation for the exact contract is signed through the exact restored trust state.

