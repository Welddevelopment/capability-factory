# CF-056 — Exact not-started signed reissue

Date: 2026-08-14

Status: frozen private local checkpoint

Spend: $0; no model calls

## Result

In one trusted local fictional constrained-HTTP route, the first exact signed write lease was durably consumed and the provider then dropped the request before committing it. A separately authenticated read-side observation began after that durable consumption, proved that the exact same work was not started, and produced a receipt that authorized one same-request reissue. The retry completed once. Replaying either the receipt or the retry lease was rejected, and the external observer found exactly one resulting record.

This is a bounded recovery result. It does not authorize retry after an unknown, partial, incorrect, stale, duplicate, collateral, unavailable, or conflicting outcome.

## Mechanism

The authority declaration must explicitly permit two attempts and name the configured recovery observer. The first lease binds the exact request, parent goal, work item, authority declaration, policy epoch, transport, credential alias, and attempt number. Its consumption is persisted immediately before the outbound write.

After an uncertain dispatch, the compiler starts a trusted observer-local recovery session immediately before the actual read-side transport. The completed observation receipt binds:

- the exact prior consumed lease;
- the exact action request and work identity;
- the exact observation request and reconciliation key;
- the configured observer signer, implementation, binding, and qualification identities;
- the observed result and state digests;
- locally measured observation start and completion times;
- expiry, nonce, and signature.

The authority store permits attempt two only when that exact receipt is authentic, fresh, attached to a `not-started` observation, and locally began after the first lease was durably consumed. It then reapplies the current activation, revocation, approval, quantity, monetary, rate, target, method, and authority checks. A unique durable attempt identity and unique receipt identity prevent concurrent or restarted callers from obtaining multiple retries. There is no attempt three.

The action response is not evidence of success. After the retry, a separate read-side observer verifies the actual external state.

## Adversarial controls

The focused checks cover:

- forged, stale, mutated, cross-work, and cross-request recovery receipts;
- transplanting a valid observation result to a different work item;
- an observation that began before durable lease consumption;
- a future or misleading provider timestamp that cannot replace local causal timing;
- restart and concurrent reissue races;
- receipt, lease, and completed-action replay;
- attempt-three issuance;
- unknown, partial, incorrect, stale, duplicate, collateral, unavailable, and conflicting outcomes;
- changed method, target, request, authority, credential alias, transport, policy, and parent/work identity;
- missing or stale approval, activation, permission, and rate/quantity/monetary bounds;
- unreviewed HTTP responses and network loss after lease consumption, which become uncertain rather than automatically retried.

## Verification

- 42/42 deterministic checks passed across the authority store, compiler, binding factory, onboarding authority, and customer-local qualification surfaces.
- 8/8 localhost TLS integration checks passed across the signed-authority joined route, pinned-HTTPS compiler route, and transport boundary.
- Strict TypeScript compilation passed.
- `git diff --check` passed.
- The joined TLS case performed one first dispatch that was dropped before commit, one independently observed `not-started` result, one authorized retry, and one final business write. Replay did not add a second write.

## Preserved failure history

The first skeptical audit refused to freeze CF-056. It found that an observation result could be transplanted between work items, that causality trusted the target system's server timestamp, and that test-owned signing did not prove the receipt came from the trusted observer path.

The repair added an exact observation-request and reconciliation-key binding, local observer-session start/completion timing, and a module-created observer signer that is invoked only around the actual read-side transport. New transplant and timing attacks now fail closed. A second independent audit accepted the checkpoint for the trusted joined compiler and observer-signer route.

## Exact boundary

- The observer signer is trusted customer-local infrastructure. It must not be exposed to an upstream agent, arbitrary plugin, or untrusted adapter.
- The action and observer use separate authenticated bindings and implementations, but the fictional joined test does not prove process- or failure-domain independence.
- Timing uses the customer-local host clock; there is no external monotonic rollback anchor.
- Durable behavior covers normal SQLite crash/restart and concurrency, not a hostile same-user administrator rewriting the database.
- A lease that is issued but rejected by a trusted local pre-consumption guard still needs a separate safe cancellation or recycling mechanism. CF-056 does not silently reuse that attempt.
- The proof covers one local fictional flat constrained-HTTP/OpenAPI route, not arbitrary APIs, real providers, customer environments, production reliability, or general retry safety.
- Credentials are resolved customer-locally and can exist transiently in process memory. This is not a claim of hardware-backed secret isolation.
- No automatic reversal or compensation exists.
- There is no customer, deployment, demand, activation, public, or CF-DAS integration claim.

## Strongest accurate private claim

Capability Factory now has a local constrained-HTTP reference path in which a consumed signed write attempt can be reissued exactly once only after a trusted, separately authenticated observer proves that the same external action was not started. The authority, recovery receipt, request, work identity, and retry ceiling remain durably bound, and the final external state is independently verified.
