# CF-055 configured-admin signed immediate HTTP authority checkpoint

Date: 2026-08-14
Status: private local fictional development checkpoint; no customer, deployment, production, or public-claim implication

## Result

Capability Factory now has a hardened constrained-HTTP write path in which a configured
workspace-admin key activates one exact authority contract and a separate customer-local
authority module issues a short-lived Ed25519-signed lease for one exact reviewed request.
The pinned-HTTPS transport consumes that lease once, synchronously after all local request
validation and immediately before the outbound write. The action response remains excluded
from business-outcome proof; a separately scoped read-side observer verifies external state.

One author-known fictional OpenAPI fixture exercised the joined path against a real loopback
TLS provider. The exact approved request wrote once, an independently authenticated read route
observed the resulting record, and the existing outcome classifier returned the externally
verified result. This is a local authority-mechanism checkpoint, not customer authorization or
production evidence.

## Authority and trust boundary

The exact authority contract binds:

- configured workspace and admin signer identity;
- authority compilation and its policy epoch;
- reviewed action declaration, target, operation and method;
- credential alias, without credential values;
- credential resolver identity;
- pinned transport boundary, including endpoint, operation set, certificate and resource limits;
- exact compiled request digest, parent goal and work-item identity;
- quantity and monetary metric bindings when limits require them;
- lease issue and expiry times; and
- an exact signed approval receipt when the action policy requires approval.

The authority contract and activation receipt are deeply snapshotted before use. The
configured workspace-admin activation is signature checked during construction, rechecked for
expiry at every lease issuance, and caps the lease expiry so a lease cannot outlive the
activation. This proves activation by the configured admin key. It does not prove that the
admin key itself came from an independent customer trust store; that bootstrap remains an
explicit later requirement.

Production construction owns its wall clock and cryptographic nonce source. A separate,
explicitly test-only constructor permits deterministic time and nonce injection. Durable SQLite
state records policy epochs, revocation, lease issue/consumption, approval consumption,
actions-per-hour accounting and a clock high-water mark. A consumed lease cannot be replayed
after restart, and concurrent issuance for the same policy epoch and work item is serialized.

## Joined hardened route

The hardened route is deliberately distinct from the older acceptance-compatible path:

1. reviewed OpenAPI source produces exact action and observer declarations;
2. customer-local binding qualification is checked against current runtime state;
3. the configured admin key signs the exact authority contract;
4. the trusted authority issuer is bound to the declaration, resolver and transport verifier;
5. the hardened compiler requires the genuine module-created authority-enforced pinned-HTTPS
   transport rather than accepting a structurally similar object;
6. action input is compiled and the exact credential alias is resolved;
7. the authority issuer checks current policy, limits, approval, request identity and activation,
   then signs one short-lived exact-request lease;
8. the transport repeats its local request bounds, consumes the lease once, then performs the
   TLS write; and
9. the separate observer route reads external state and classifies the result without using the
   action response as proof.

The legacy unsigned grant remains available only to preserve frozen historical acceptance
evidence. It is not accepted by the hardened compiler entry point and is not part of this
checkpoint's claim.

## Negative controls and repaired failures

The checkpoint rejects or fails closed on:

- absent, malformed, expired, replayed, revoked or wrong-request leases;
- wrong parent goal, work item, operation, method, target, credential alias, resolver or transport;
- forged issuer/verifier objects and structurally forged authority-enforced transports;
- changed policy, declaration, compiler inputs or live customer-local qualification state;
- an unsigned action through the hardened low-level transport;
- missing or reused approvals and approvals for different exact work;
- quantity, monetary and actions-per-hour limit violations;
- configured workspace-admin activation mismatch or expiry;
- lease lifetime extending beyond admin activation;
- concurrent duplicate issuance and replay after verifier restart; and
- local clock rollback relative to durable state.

Several weaknesses were found during development and preserved rather than hidden: mutable
policy/declaration inputs, repeat issuance for the same work, structurally forged issuer and
verifier objects, caller-controlled production time, mutable compiler dependencies, a
structurally forged transport and authority activation that was checked only at startup. The
final route snapshots dependencies, uses module-local trust brands, owns production time and
nonce generation, serializes one attempt per work item and rechecks/caps activation at issuance.

## Verification

Parent-run verification after the final repairs:

- authority, compiler, factory, onboarding-authority and qualification tests: 39 passed, 0 failed
  across 5 files;
- joined signed-authority, pinned-HTTPS and transport tests: 7 passed, 0 failed across 3 files;
- strict TypeScript `--noEmit`: passed;
- `git diff --check`: passed;
- paid/model calls and spend: zero;
- external network: zero; loopback TLS only.

## Exact claim boundary

Strongest current private wording:

> In one local fictional constrained-HTTP route, Capability Factory used a configured
> workspace-admin-key activation to issue a short-lived signed lease for one exact reviewed
> write. The pinned-HTTPS transport consumed that lease once immediately before the write, and
> a separately scoped read route independently verified the external result.

Do not claim independent customer authorization, universal policy enforcement, production
security, remote-network readiness, hostile-local-admin resistance, automatic compensation,
customer usability or broad provider compatibility.

## Remaining technical risks

- A consumed attempt cannot yet be reissued after an independently verified `not-started`
  result. Unknown, partial, incorrect and stale states correctly remain blocked. The next item
  should add a bounded exact-work reissue only after separate fresh proof of `not-started`.
- The configured admin public key is supplied during authority bootstrap rather than resolved
  from a separately pinned workspace trust store.
- SQLite durability is customer-local crash/restart evidence, not protection from a hostile
  same-user administrator or filesystem rollback. There is no external monotonic anchor.
- A lease is consumed before connection establishment. A pre-commit transport failure therefore
  stops safely and currently requires handoff rather than automatic retry.
- Metric bindings are explicit trusted configuration; this checkpoint does not infer the correct
  business meaning of a quantity or monetary field.
- Credentials exist transiently in customer-local process memory. No hardware-backed isolation,
  mTLS customer deployment, rotation system or memory-secrecy claim is established.
