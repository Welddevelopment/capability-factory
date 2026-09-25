# Controlled-pilot threat model — 2026-07-30

Status: **private development threat model; not an independent audit or certification**

This model covers the customer-local, constrained-HTTP pilot shape. It does not cover a
future hosted control plane, browser/device/code drivers, production multi-region service,
or unknown customer infrastructure.

## Assets and trust boundaries

The protected assets are external-system credentials, customer records, customer authority,
validated plans, retained capabilities, durable job state, continuation grants, audit/evidence
records, release bytes and the integrity of externally reported outcomes.

The principal boundaries are:

1. **Existing agent → localhost sidecar.** Authenticated by a customer-local sidecar token.
   An ordinary goal is input, not authority.
2. **Sidecar → trusted runtime.** Only validated plans, declared target aliases and credential
   aliases cross this boundary. Generated manifests are constrained data, not arbitrary code.
3. **Trusted runtime → external HTTP target.** Base origins, methods, paths, response limits,
   idempotency and timeouts are policy-controlled. Credential values are injected locally.
4. **Action → independent verifier.** Capability fitness before use and external outcome after
   action are separate gates.
5. **Customer operator → continuation.** A signed, expiring, revocable grant can resume only the
   exact saved plan/item/state version; changed authority re-enters trusted planning.
6. **Build/release → customer installation.** Pinned inputs, an SBOM, detached signatures and an
   immutable image digest protect the handoff. The signing key is not stored in the repository.

## Threats, controls and residual risk

| Threat | Current controls | Residual risk / required pilot treatment |
|---|---|---|
| Credential leakage | Customer-local secret files; aliases in requests/manifests; exact-value and structural redaction; secrets excluded from config, evidence, support bundles and image inputs | A compromised customer host or malicious trusted runtime can access local secrets. Use least-privilege sandbox credentials and customer endpoint security. |
| Sidecar network exposure | Client accepts localhost only; Compose publishes `127.0.0.1`; container-internal bind requires explicit acknowledgement; token comparison is timing-safe | Another process under the same host user may reach localhost. Host isolation and token file permissions remain customer responsibilities. |
| Arbitrary or cross-origin HTTP | Trusted target aliases; no credential/query/fragment in base URL; encoded path inputs; redirects disabled; rendered origin rechecked | DNS and lower-network attacks are not solved by application policy alone. A pilot should use customer egress controls where available. |
| Request/response exhaustion | Bounded input body, timeouts, streamed response byte ceiling with early cancellation, bounded job attempts, process limit | A permitted endpoint can still consume bandwidth/CPU below limits. Pilot monitoring and egress rate limits remain advisable. |
| Unauthorized/destructive action | Explicit methods/actions/targets/scopes; writes require idempotency; operation budgets; customer-local run/drain/halt; missing authority hands off | Policy correctness depends on customer-reviewed documentation, adapter and workflow scope. This has not been validated against a customer environment. |
| Duplicate write after lost response | Stable parent/job identity, idempotency keys, durable queue, external reconciliation before retry, unknown-state stop | Non-idempotent external APIs may be unsuitable. If external state cannot establish the outcome, the system stops rather than guarantees recovery. |
| False completion | Independent external-outcome verification and aggregate goal criteria; no completion on malformed/missing response output | Verifiers are customer-specific code/configuration and can be wrong. Their evidence and collateral-state checks require customer review. |
| Capability drift/tampering | Documentation hashes, pre-use verification, health reprobes, quarantine, versioned replacement | Drift detection cadence and real-world failure frequency remain unvalidated. |
| Tenant/identifier confusion | Tenant-scoped records, deterministic parent identity, conflicting-request rejection, cross-tenant lookup denial | The current sidecar is intended for a tightly scoped customer-local pilot, not hostile public multi-tenancy. |
| Continuation replay/escalation | HMAC signature, expiry, exact plan/item/state binding, durable revocation, live precondition and state reconciliation | Key compromise permits forged grants until rotation/revocation. Rotation must invalidate outstanding grants. |
| Backup/rollback tampering | Private files, byte hashes, exact payload-manifest match, normalized paths, backup/installation identity match, verified rollback | A malicious actor with write access to both manifest and payload can recompute local hashes. Store/copy critical backups under customer-controlled integrity protection. |
| Release/supply-chain substitution | Pinned base digests, allowlisted 1.4 MB build context, shell-free scratch runtime, SBOM, vulnerability scan, signed release manifest, immutable image reference | No public registry provenance, reproducible-build proof, external signing authority or independent supply-chain audit yet exists. |
| Audit/evidence manipulation | Append-only status events, redaction, immutable export paths, hash-chained operational audit in the reference core | A host administrator can alter local storage. External anchoring/WORM retention is not implemented. |
| Container escape | Non-root, shell-free scratch image, read-only root, dropped capabilities, `no-new-privileges`, PID limit, localhost publish | Container isolation is not a security boundary against every kernel/runtime vulnerability. Customer patching and host hardening remain necessary. |

## Stop conditions

The pilot must halt on any unauthorized write, surviving duplicate write, incorrect side effect,
unresolved unknown external outcome, credential crossing the customer boundary, failed release or
backup verification, corrupt durable storage, mismatched tenant/plan identity, or inability to
run the independent verifier. Automatic compensation/reversal is not implemented.

## Evidence boundary

Local tests exercise these controls, including a real locally isolated container and fictional
HTTP worlds. They do not prove production reliability, customer security acceptance, formal
compliance, resistance to a determined hostile insider, or correct behavior against every API.

