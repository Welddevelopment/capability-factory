# CF-060 — Durable unconsumed lease-generation replacement

Date: 2026-08-14

Status: frozen private local checkpoint

Spend: $0; no model calls

## Result

The constrained-HTTP authority store now distinguishes a signed lease generation from an actual execution attempt. If a process is lost after a lease is issued but before the transport durably consumes it, the expired generation can be retired after restart and replaced without falsely counting that interruption as an external execution attempt.

Replacement is intentionally narrow. The prior lease must be authentic, exact for the same request and work, still durably `issued`, never consumed, never previously retired, and expired according to the trusted customer-local clock. The current authority process must still pass workspace activation, policy epoch, revocation, request, quantity, monetary, hourly, and approval checks. Retirement of the old generation and insertion of the new generation happen in one `BEGIN IMMEDIATE` SQLite transaction.

Only one live generation can exist for an action and execution-attempt number. Only one generation can ever become consumed for that attempt. A replacement points to the exact retired lease digest, has a new transport-reservation digest, and is hard-capped at generation three. Approval-gated work requires a fresh signed approval for every replacement generation; a prior approval remains single-use even though its lease was never consumed.

The change is protocol-versioned rather than silently altering the old authority meaning. The authority protocol is now `1.1`, generated leases are schema `2.1`, and the replacement policy, generation ceiling, fresh-approval rule, and conservative hourly-counting rule are bound into the authority contract plus issuer/verifier implementation identities. Older `2.0` serialized leases fail closed; this private development checkpoint does not silently migrate or reinterpret them.

## Joined causal route

The final local TLS route exercised both kinds of recovery without conflating them:

1. The trusted transport prepared an exact fictional order write.
2. Authority issued execution attempt 1, generation 1.
3. The authority process closed before the lease was consumed; zero network activity occurred.
4. The lease expired.
5. A restarted authority process verified the durable row, atomically retired generation 1, and issued attempt 1, generation 2 for a fresh exact transport reservation.
6. The genuine transport consumed generation 2 immediately before dispatch.
7. The fictional provider dropped the request before committing, making the consumed attempt externally uncertain.
8. A separately authenticated read-side observer found the exact action `not-started` and signed that result through the trusted observer route.
9. CF-056 then authorized execution attempt 2, generation 1.
10. The action completed once, a separate observer verified the external state, and replay did not create a duplicate.

This preserves the important distinction:

- pre-consumption process loss can replace a lease generation after durable expiry;
- post-consumption uncertainty requires independent external-state evidence before another execution attempt.

## Adversarial controls

- replacement before expiry fails;
- cross-work and forged-generation prior leases fail;
- two restarted authority processes racing to replace the same prior generation produce one success and one rejection;
- the contention test uses two actual child processes opening the same SQLite authority state, not two promises executing synchronously in one event loop;
- the retired prior lease cannot later consume;
- the replacement lease can consume exactly once;
- a consumed replacement cannot itself be treated as unconsumed after expiry;
- both possible SQLite-serialized orders of policy revocation versus replacement fail closed: revocation-first blocks issuance, replacement-first blocks consumption;
- replacement with a reused approval fails and rolls back the attempted retirement;
- a fresh approval permits the next generation;
- generations 1, 2, and 3 preserve exact lineage; generation 4 fails before state mutation;
- execution attempt 2 can itself replace an expired unconsumed generation while retaining the earlier independently verified not-started chain transitively through exact lease digests;
- a still-live prepared generation-1 transport object cannot dispatch after another authority process retires that lease and generation 2 becomes consumed;
- the exact expiry boundary is tested: consumption is invalid and retirement is eligible at the same `expiresAt` instant, with no overlap;
- reservation digest, generation, attempt, retirement state, prior-generation lineage, policy, request, credential, and work identity are checked again at consumption;
- post-consumption network loss remains uncertain and cannot enter the generation-replacement path.

## Verification

- 45/45 deterministic checks passed across authority, compiler, binding, onboarding-authority, and qualification surfaces.
- 8/8 localhost TLS integration checks passed across the signed joined route, pinned-HTTPS compiler route, and transport route.
- Strict TypeScript compilation passed.
- `git diff --check` passed.
- No model calls, external services, customer data, or spend were used.
- A second independent skeptical audit froze the exact versioned local protocol scope after the protocol-identity, cross-process contention, approval rollback, attempt-2 lineage, revocation-order, and old-lease rejection checks were added.

## Exact boundary

- Retirement relies on the durable authority row and trusted customer-local time. It does not use an external monotonic anchor and does not resist a hostile local administrator or database rollback.
- Authority protocol `1.1` deliberately rejects old schema-`2.0` leases. There is no automatic migration of pre-generation private development state; it must be retired or re-established under the new activated contract.
- Replacement waits until the signed lease has actually expired. It does not infer safety merely because a process disconnected.
- The feature supports normal SQLite crash/restart and transaction serialization, not distributed consensus or multi-host authority.
- Lease generations count conservatively toward the existing actions-per-hour issuance ceiling. Replacement can therefore be denied even when the execution attempt was unconsumed.
- The generation ceiling is a hard internal safety bound of three, not a customer-tuned reliability promise.
- The joined action and observer use separate authenticated bindings, but the fictional environment does not prove failure-domain independence.
- The proof remains one local fictional constrained-HTTP/OpenAPI route. It is not arbitrary-API, real-provider, customer, production, hostile-administrator, public, or universal recovery evidence.
- Credentials can exist transiently in customer-local memory. There is no hardware-backed secret or clock guarantee.
- No automatic compensation exists. No customer, deployment, activation, demand, public, or CF-DAS integration claim follows.

## Strongest accurate private claim

Capability Factory's local constrained-HTTP authority path can now recover across a process loss before external execution by atomically retiring an exact expired, durably unconsumed signed lease generation and issuing one bounded replacement for the same execution attempt. Once a lease is consumed, this path is unavailable and only independently verified external state can authorize further action.
