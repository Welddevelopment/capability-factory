# CF-072 — Live suspension and revocation of running write authority

Date: 2026-08-14
Status: local protocol and joined authority boundary complete
Calls/spend: 0 / $0

## Risk retired

CF-069 made current provider enrollment mandatory at authority-capable startup
and bounded its cached response to five minutes. That did not by itself prove
that a provider could stop an installation which was already running. Waiting
for cached expiry is materially weaker when an installation is suspended or
revoked after startup.

CF-072 adds a live signed status exchange to the trusted enrollment guard. At
each authority check, the guard generates a fresh random challenge and asks the
configured provider boundary for a response which binds:

- provider, policy and monotonically observed status epoch;
- tenant, installation and workspace;
- exact authority contract and trust configuration;
- exact runtime release;
- the fresh challenge;
- current state and a maximum 30-second response lifetime; and
- the separately pinned provider signing identity.

The response has no execution-authority effect. It can confirm currentness or
stop authority; it cannot grant a write, widen policy, change credentials or
replace workspace-admin activation.

## Continuous enforcement

The live query runs through the CF-069 guard already joined to construction,
lease issue and lease consumption. A valid live response takes over from the
initial five-minute startup response, allowing a process to remain running
while it continues to prove currentness rather than requiring a blind restart
every five minutes.

The guard remembers the greatest status epoch and state it has observed. It
rejects suspended, revoked or unknown state; provider unavailability; stale,
forged, cross-installation or malformed responses; an older challenge; a
status-epoch rollback; and conflicting state at the same epoch.

A state transition must therefore advance the provider status epoch. A later
active epoch may restore currentness, while replaying an older active state
after suspension cannot.

## Precise stop receipt

Live-currentness failures throw a typed error containing a bounded receipt. It
includes exact non-secret installation and contract identities, observed state
and epoch where trustworthy, a reason code, observation time and literal
`auditAccessAllowed: true` / `executionAuthorityEffect: stop-only` boundaries.
It excludes the challenge and contains no credential or provider private-key
material.

The joined authority test started a process, issued a lease, then advanced the
provider to a new suspended epoch. New issuance stopped, the unconsumed lease
could not cross the transport authority boundary, and the existing signed
workspace-activation audit remained readable and unchanged. Newer revocation
and provider unavailability also stopped issuance.

## Verification

- 30/30 focused and adjacent non-network authority tests passed.
- 3/3 permitted localhost joined HTTP integration tests passed.
- Strict TypeScript passed.
- Queue validation passed.
- No model call, external network, customer data, deployed provider or spend
  was used.

## Boundary and next omission

The live provider in this checkpoint is a synchronous signed local interface,
not a deployed remote continuity service. Signatures and fresh challenges make
caller substitution fail closed, but this does not prove network availability,
TLS identity, provider durability, hostile-admin resistance, long-running
operational reliability or rollback resistance of an old binary.

The stop receipt is returned to the caller but is not yet durably appended to a
separate customer-local incident ledger. A production-shaped provider process
boundary and durable stop recording are the next honest local gaps; neither is
needed to reinterpret this checkpoint as customer or production evidence.
