# CF-074 — Customer-local authority-currentness process boundary

Date: 2026-08-14
Status: local process/mailbox reference complete
Calls/spend: 0 / $0

## Implemented

The live enrollment-status interface from CF-072 now has a genuine separate
process reference. The authority process and provider process communicate
through a durable SQLite challenge mailbox:

1. The authority guard generates a fresh random challenge.
2. The mailbox durably records the exact challenge and its digest.
3. A separate provider process reads only pending challenges.
4. That process validates the mailbox's pinned provider, policy, tenant,
   installation, workspace, authority-contract, trust-configuration and
   runtime-release identity.
5. It reads a separately signed provider-state record, rejects forged or
   cross-installation state, and signs the exact challenge response with the
   provider key held by the provider process.
6. The authority reads the response synchronously at its immediate issue or
   consume boundary. CF-072 then verifies the provider signature, fresh
   challenge, state epoch, state and lifetime.

The provider private key is not stored in the mailbox or stop ledger. A process
restart reopens the same pinned mailbox and continues answering new challenges.
If the provider is absent, malformed or cannot verify its signed state, the
authority times out within a fixed bound and fails closed.

## Durable stop evidence

A dedicated customer-local SQLite ledger now records typed CF-072 stop
receipts. It pins tenant and installation identity, validates every receipt's
intrinsic digest and appends each entry through a previous-hash chain under
`FULL` SQLite synchronization. Restart revalidates the full chain. Receipt,
ordering, insertion and identity tampering fail closed.

The ledger stores only redacted stop metadata: exact non-secret installation
and policy identities, reason, observed state/epoch where verified, time,
audit-access flag and stop-only effect. It does not persist challenges,
credentials, provider private keys or secret values.

## Fresh local rehearsal

One fictional provider process completed this sequence:

- active state answered a fresh challenge;
- a signed higher suspended epoch stopped authority;
- process termination caused a bounded provider-unavailable stop;
- the provider restarted against the same mailbox;
- a signed higher active epoch restored currentness;
- a tampered provider-state file could not be signed into an active response
  and timed out closed; and
- a later correctly signed active state resumed currentness.

Three stop receipts were retained and their hash chain verified. A mailbox
opened under a substituted installation identity was rejected.

## Failure-driven correction

The first process rehearsal exposed a real causal-time error: live response
freshness was compared with the time measured before the inter-process round
trip, so a truthful newly issued response appeared future-dated. The guard now
measures live response currentness after receipt. The failed attempt is
preserved in test history; the boundary was corrected rather than weakening
freshness rules.

## Verification

- 31/31 focused and adjacent authority/process tests passed.
- 3/3 permitted localhost joined HTTP authority tests passed.
- Strict TypeScript passed.
- No model call, external network, customer data or spend occurred.

## Boundary

This is a local process and durable-mailbox reference, not a remote service.
It does not establish TLS/network availability, multi-host durability,
hostile-admin resistance, OS-level key isolation, production throughput,
customer deployment or old-binary rollback resistance. The current synchronous
mailbox wait is deliberately bounded and correct for the immediate authority
boundary, but it is not a production latency or scale claim.
