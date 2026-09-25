# CF-057 — Independent customer-local workspace authority trust

Date: 2026-08-14
Status: private local fictional checkpoint; independently frozen at the narrow reviewed scope

## Why this checkpoint existed

CF-055 required a signed workspace-admin activation immediately before a constrained HTTP write, but its production constructor still accepted the admin public key and activation receipt from the same caller that assembled the authority runtime. That proved signed enforcement inside the fixture, not an independently pinned customer authority boundary.

CF-057 removes those caller-supplied authority facts from the production constructor. A separate customer-local trust database now owns the workspace, root trust configuration, admin-key lineage, exact current activation, activation revocation, durable clock boundary, and signed audit lineage. The write-authority runtime resolves a branded binding from that store and rechecks it at issuance and at the serialized lease-consumption boundary.

## Implemented behavior

### Independent authority root

`CustomerLocalHttpAuthorityTrustStore` is scoped to one exact workspace, tenant, environment, root trust-configuration digest, and initial admin key. Restart with a substituted workspace, trust configuration, bootstrap key, clock mode, or store implementation fails closed.

The normal production `createCustomerLocalHttpWriteAuthority` constructor accepts only the independent trust store. It explicitly rejects a caller-supplied admin key or activation receipt. The older direct form is retained only behind the explicitly named test-only constructor for frozen historical campaigns; it is outside this checkpoint's production-constructor claim.

The authority contract uses the stable workspace plus root trust-configuration identity rather than one transient activation digest. This avoids a circular contract while allowing an activation to rotate. Each issued lease still binds the exact activation digest that authorized it, and prior-lease recovery/replacement lineage must match that exact digest.

### Signed lifecycle and exact currentness

The store supports:

- signed activation import for one exact workspace and authority contract;
- explicit dual-signed admin-key rotation adoption;
- a mandatory fresh successor activation after admin rotation;
- signed revocation of one exact activation;
- append-only lifecycle events with a digest predecessor chain;
- full historical replay of every admin rotation, activation signature, and revocation signature from the independently pinned root trust configuration;
- comparison of replayed lineage with every materialized admin, activation, head, rotation, and revocation record.

A hash chain by itself was rejected during audit because an attacker able to rewrite the database could recalculate hashes. The final local integrity check therefore re-verifies the original signatures and lineage rather than trusting only stored digests.

### Clock and serialization boundary

Production authority trust owns the system clock through the root customer-local trust store. A caller-controlled clock is accepted only through an explicit test-only boundary, and that clock mode is persisted so test state cannot later reopen as production state. The store also persists a last-seen time and fails closed if the clock moves backward relative to it.

Activation import, admin rotation, activation revocation, and lease consumption recheck their current admin/activation state at their serialized SQLite transaction point. Lease consumption holds the independent trust-store write lock while the exact authority lease is durably consumed, defining the local ordering between revocation and consumption. A real two-process contention control exercises both orders against the same trust and authority databases.

### Signed audit-only recovery

The official backup path creates a coherent SQLite snapshot plus a bounded manifest and detached Ed25519 signature from an independently pinned active root key. The manifest binds the exact workspace, tenant, environment, trust configuration, initial/current admin identity, source activation mode, event count/head, raw database bytes/hash, validity window, and non-authorizing restore rule.

Restore requires a fresh destination and verifies the exact file set, scope, validity, detached signature, raw database identity, schema identity, lifecycle signatures, event lineage, and materialized state. It then enters `audit-only-restored` mode. Historical activations—including an activation that was valid when backed up—cannot authorize a write after restore. Only a new signed activation issued strictly after the restore boundary can re-enable the exact contract. Existing resolved bindings also recheck this mode and fail closed.

The restore explicitly reports zero execution and activation authority. It preserves audit evidence; it does not silently recover permission.

## Failures preserved during development

The first implementation was not frozen. Skeptical review found four meaningful weaknesses:

1. A caller-controlled clock could indirectly enter what looked like a production authority store.
2. The event chain checked hashes but did not replay and verify every historical signature.
3. Revocation/consumption behavior was tested in one process rather than under real process contention.
4. Recovery and audit semantics did not yet prevent restored old authority from becoming live.

The repaired version separates and durably marks test clocks, cryptographically replays the complete signed lineage, adds actual child-process contention, exposes exact revocation in audit, and restores signed backups in a non-activating audit-only state.

## Verification

- 58/58 focused deterministic checks passed across seven authority, compiler, binding, onboarding-authority, qualification, and verifier files.
- 8/8 localhost TLS integration checks passed across the signed joined route, pinned-HTTPS compiler route, and pinned transport route.
- The authority-trust suite includes restart, substitution, rotation, revocation, exact expiry, unavailable trust, cryptographic/materialized tamper, real process contention, signed backup/restore, stale activation, torn-copy, signature, raw-file, and cross-workspace controls.
- Strict TypeScript compilation passed.
- `git diff --check` passed.
- Model calls: 0. Spend: $0. External services/customer data: none. Network: loopback TLS only.
- Final independent skeptical verdict: **FREEZE**. The initial audit blocked on clock injection, incomplete signed-lineage replay, weak concurrency evidence, and recovery semantics. A second audit blocked on a live-before-audit-only publication race. After staging the audit-only transition before atomic publication, the final re-audit found no remaining blocking defect in the reviewed scope.

## Exact boundary

- This is one local fictional constrained-HTTP authority path using SQLite and a customer-local trust root. It is not customer, production, arbitrary-API, public, or distributed evidence.
- It covers normal crash/restart, signed lifecycle validation, and local multi-process SQLite serialization. It does not provide multi-host consensus.
- The official signed restore path is fail-closed and non-activating. A hostile privileged local administrator can still replace or roll back live database files outside the API. Resisting that requires an external monotonic anchor, hardware/OS-backed trust, or remote attestation and is explicitly not claimed.
- The system clock has a durable local rollback check but no hardware-backed secure-time guarantee.
- Keys and credential values are not hardware protected by this checkpoint. Credentials may still exist transiently in customer-local memory.
- Rotation and revocation are exact local protocols, not enterprise identity-provider integration or certificate-policy certification.
- The direct caller-supplied admin/activation path remains only for explicit test fixtures and is excluded from the production-constructor claim.
- No automatic compensation exists. No customer, deployment, demand, activation, production-reliability, public, or CF-DAS integration claim follows.

## Strongest accurate private claim

In Capability Factory's production constrained-HTTP constructor, workspace-admin authority is resolved from an independently persisted customer-local trust boundary rather than supplied by the runtime caller. The exact signed activation is bound to the lease and rechecked at serialized consumption; signed rotation and revocation fail closed locally; and the official signed recovery path preserves history without silently restoring write authority.

## Next technical gate

After freeze, CF-058 should run the complete mandatory ten-case acceptance contract on a fresh generated candidate through the hardened trust, authority, transport, observer, restart, recovery, and conflicting-parent route. That would test whether the productized pieces compose without weakening any of the individual boundaries; it would still remain local fictional evidence.
