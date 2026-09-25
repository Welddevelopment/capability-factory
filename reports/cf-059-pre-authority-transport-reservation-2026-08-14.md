# CF-059 — Pre-authority transport reservation

Date: 2026-08-14

Status: frozen private local checkpoint

Spend: $0; no model calls

## Result

The trusted constrained-HTTP compiler now asks the hardened pinned-HTTPS action transport to validate and reserve the exact local dispatch before requesting signed write authority. This moves the normal fallible request, credential, path, header, body, serialization, reviewed-operation, and transport-rate checks ahead of lease issuance.

The reservation digest is signed into the authority lease, persisted with the lease row, and required again when the transport durably consumes the lease. The reservation is one-use. If authority issuance fails, the compiler cancels the still-pre-authority reservation and releases its local capacity. If local transport capacity is already full, the request stops with zero lease rows and zero network activity.

The safer design deliberately does not create a signed “nothing was sent” receipt after authority has already been issued. Once a lease exists, the trusted joined route performs only reservation lookup, exact reservation/lease comparison, durable authority consumption, and dispatch using already prepared private bytes and options. Any network or response failure after consumption remains uncertain and enters CF-056 reconciliation.

## Causal order

1. Compile the exact reviewed request from bounded workflow input.
2. Resolve the customer-local credential handle.
3. The genuine pinned-HTTPS transport snapshots and validates the request and credential.
4. It constructs the safe URL, headers, encoded body, TLS options, byte bounds, and local rate reservation.
5. It returns one opaque single-use prepared write with an exact reservation digest.
6. The authority issuer evaluates the current workspace activation, policy, approval, limits, request, work identity, and reservation digest.
7. The resulting lease signs and persists the exact reservation digest.
8. The prepared write compares and durably consumes that lease immediately before creating the outbound request.
9. A separate observer remains responsible for proving the external business outcome.

## Focused evidence

- Two simultaneous prepared writes occupied a two-request local bound; a third preparation stopped before authority issuance.
- Cancelling both pre-authority reservations released the capacity; replaying cancellation failed closed.
- Attempting a direct unsigned dispatch produced zero lease rows and zero writes.
- One valid compiler action created one reservation-bound lease and one external write.
- A later over-quantity action passed transport preparation but failed the authority policy. Its reservation was cancelled, its lease count stayed unchanged, and a following valid action used the released capacity successfully.
- Once the two real dispatch slots were consumed, the next action stopped at transport preparation. The durable authority lease count and external write count both remained unchanged.
- A unit attack supplied the wrong reservation digest to the durable verifier. It failed before consumption; the exact signed reservation then consumed successfully once, and replay failed.
- Existing CF-056 precommit-loss recovery still completed with one retry and one final write.

## Verification

- 42/42 deterministic authority, compiler, binding, onboarding-authority, and qualification checks passed.
- 8/8 localhost TLS integration checks passed across the signed joined route, pinned-HTTPS compiler route, and transport route.
- Strict TypeScript compilation passed.
- No model calls, external services, customer data, or spend were used.
- An independent skeptical code audit accepted only the narrow trusted live-process compiler and pinned-HTTPS scope and explicitly excluded restart-durable reservation claims.

## Exact boundary

- This checkpoint prevents normal trusted transport-local validation failure after authority issuance. It does not yet provide durable restart recovery for a process crash after lease issuance but before consumption.
- Reservations and transport-rate capacity are process-local. A future checkpoint must durably retire and replace an issued-but-unconsumed lease generation after restart without reusing approval or exceeding the execution-attempt ceiling.
- The authority issuer records a supplied reservation digest but does not independently prove its transport origin. Safety at execution comes from the genuine transport holding the corresponding private reservation and refusing any mismatched lease. The supported claim is therefore the trusted joined compiler/transport route, not free-standing issuer use by an arbitrary plugin.
- The compiler and transport are trusted customer-local infrastructure. Prepared-write objects must not be exposed upstream.
- An authority rejection after issuance but before consumption—for example revocation or expiry racing the final consume—still produces zero network activity but may strand the issued lease. It is not silently cancelled.
- Local rate reservations are conservative process-local controls, not a distributed or restart-durable quota service.
- The proof remains one local fictional constrained-HTTP/OpenAPI route. It is not real-provider, customer, production, hostile-administrator, arbitrary-API, public, or general transport evidence.
- Credentials can exist transiently in customer-local process memory.
- No automatic compensation exists. No customer, deployment, activation, demand, public, or CF-DAS integration claim follows.

## Strongest accurate private claim

In the trusted local constrained-HTTP route, Capability Factory now completes transport-local request validation and capacity reservation before issuing write authority, signs the exact reservation into the lease, and consumes that lease only at the final dispatch boundary. Normal local validation or capacity failures therefore produce zero lease and zero network activity; post-consumption uncertainty still requires independent external reconciliation.

## Next gap

Implement durable lease generations so a provably unconsumed issued lease can be retired across restart and replaced without counting as a consumed execution attempt, while preserving fresh approval, current policy checks, one-live-generation concurrency, and the complete append-only audit trail.
