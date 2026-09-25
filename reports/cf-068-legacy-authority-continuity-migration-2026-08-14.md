# CF-068 — Legacy authority continuity migration

Date: 2026-08-14  
Status: complete local protocol reference  
Model calls/spend: 0 / $0

## Problem

CF-067 added two durable facts to the customer-local authority trust store:

- whether recovery continuity is required; and
- the latest recovery time.

Stores created before CF-067 do not contain those facts. Absence is not proof
that no recovery happened. Automatically treating every old store as
`never-recovered` would let an old or restored authority lineage bypass the new
external-continuity guard.

## Implemented migration policy

Migration is non-destructive. It never edits the source database and never
inherits an old write-authority lease database. It creates a distinct fresh
authority-trust database and returns a receipt that says a fresh activation and
a fresh write-authority state are both required.

The source is inspected read-only. The inspection digest covers:

- SQLite schema objects;
- all trust metadata;
- all admin rotations;
- all activations and activation heads; and
- every append-only trust event.

The source is copied using a SQLite snapshot. The copied legacy state is
re-digested before any migration metadata is added. A source change between
inspection and snapshot therefore fails rather than attaching old evidence to
new bytes.

## Three classifications

### 1. Independently attested never recovered

A short-lived Ed25519 attestation must bind the exact source-state digest,
tenant, environment, workspace, trust configuration, event head/count and the
statement that independent records show this exact store was never restored.
The signer must be a currently active key in the separate customer-local trust
root at both issue time and migration time.

The migrated copy records `recovery_continuity_required=false`, but remains
audit-only until a strictly fresh signed activation is imported. Existing
write-authority state is not migrated.

### 2. Externally anchored recovery

The same exact-store signed attestation must bind an exact current trusted
external-continuity guard and an effective recovery time. The guard must cover
the same tenant, workspace, trust configuration and the sole current authority
contract in the legacy store. The external anchor is checked for currentness.

The migrated copy records `recovery_continuity_required=true`. After a fresh
activation, production authority still requires that exact current guard.

### 3. Ambiguous history

If no exact attestation exists, migration may still create an audit-readable
copy, but it records `ambiguous-audit-only` and continuity required. Importing
a fresh activation cannot leave audit-only mode. This copy can be inspected but
cannot issue authority.

Torn metadata—only one of the two CF-067 fields present—is treated as
corruption, not ordinary ambiguity, and is rejected.

## Receipt boundary

Every successful migration receipt binds:

- the source logical-state digest;
- destination path identity;
- tenant, environment, workspace and trust configuration;
- classification and attestation identity;
- external guard identity where applicable;
- audit-only activation mode;
- whether external continuity is required;
- fresh activation and fresh write-authority-state requirements; and
- literal zero authority for existing leases and the migration itself.

The receipt digest and source digest are also written into the migrated trust
metadata. The existing constructor then performs its full event-chain and
activation audit on both the staged and published copy before migration
returns.

## Verification

Four focused migration cases and the adjacent authority/recovery suite passed:

- never-recovered migration remained audit-only, preserved audit history,
  required a fresh activation, then resolved only the exact current contract;
- ambiguous history remained audit-only even after a fresh signed activation
  was offered;
- exact current externally anchored recovery migrated with continuity required,
  while a later external checkpoint made the old guard stale and unusable;
- stale, forged, cross-store and torn evidence failed without publishing a
  destination;
- 35/35 focused and adjacent deterministic tests passed;
- strict TypeScript and diff checks passed; and
- no model, network, customer data, deployment or spend was involved.

## Exact boundary

This is a local SQLite migration protocol and deterministic evidence. It does
not prove that an assessor's factual statement is true; it proves that the
statement came from the separately pinned trusted signer and applies to the
exact inspected state. It does not resist a hostile administrator who can
replace the runtime, trust root and databases together. It does not migrate or
authorize old leases, provide a remote continuity service, or establish
customer/production reliability.

The next related gap is CF-069: make external-continuity enrollment mandatory
at the customer-local boot boundary so an old runtime cannot simply omit the
provider check.
