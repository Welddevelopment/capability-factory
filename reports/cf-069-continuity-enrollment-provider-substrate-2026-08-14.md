# CF-069 — Non-optional continuity enrollment at the write-authority boundary

Date: 2026-08-14  
Status: default production authority boundary joined and verified
Calls/spend: 0 / $0

## Implemented

A separately signed enrollment policy now binds one exact tenant,
installation, workspace, authority contract, trust configuration and runtime
release. A distinct short-lived provider response additionally binds a fresh
boot challenge, current policy epoch and current enrollment state.

The trusted local guard is created only when:

- the policy and response verify under the separately pinned Ed25519 provider
  key;
- policy and response identities match exactly;
- policy is enrolled and response state is active;
- the response is no older than five minutes and is inside policy validity;
- the boot challenge is exact, preventing replay into another start;
- the runtime-release digest is exact, blocking old local runtime state; and
- a recovered installation's response binds the exact current trusted
  external-continuity guard.

The guard rechecks expiry, provider policy validity and external recovery
continuity at use time. Its synchronous consumption boundary refuses promises.

## Joined production authority boundary

The default production `createCustomerLocalHttpWriteAuthority` constructor now
requires a module-trusted enrollment guard. It refuses omission and binds the
guard's exact tenant, workspace, authority-contract, trust-configuration and
recovery-continuity identities before creating an authority issuer or verifier.

Enrollment identity is included in the durable authority policy and in both
issuer and verifier implementation identities. The exact guard is rechecked:

- at authority construction;
- before every lease issue;
- inside the same synchronous currentness boundary as durable lease insertion;
- before every lease consumption; and
- inside the same boundary as the customer-local trust check and durable
  one-shot consumption.

An expired provider response therefore stops both new authority and the use of
an already-issued, still-unconsumed lease. Recovered installations additionally
remain bound to the external monotonic recovery guard; the enrollment guard
serializes that check instead of creating a second unsynchronized path.

The provider policy itself must now be in literal `enrolled` state. A correctly
signed suspended or revoked policy is inactive rather than accepted merely
because its signature is valid.

The pre-CF-069 constructor remains exported only under the conspicuous name
`createUnenrolledCustomerLocalHttpWriteAuthorityForCompatibility` so frozen
historical tests can preserve their original evidence. No source runtime path
uses it. New production callers selecting the default constructor cannot omit
enrollment. Removing this compatibility seam after the historical fixtures are
migrated is tracked separately rather than rewriting their evidence in this
checkpoint.

## Verification

Thirty-one focused and adjacent deterministic tests pass:

- exact current installation and runtime;
- suspended, stale, replayed challenge and old runtime;
- provider key, policy, installation and response mutation;
- post-creation expiry and asynchronous consumption; and
- exact recovered-installation continuity plus later-anchor invalidation.
- default-constructor omission;
- exact joined issue and consumption;
- post-construction response expiry before issue and before consumption;
- signed wrong-contract and wrong-tenant enrollment;
- existing durable authority, trust-store and recovery behavior; and
- three permitted localhost joined HTTP acceptance tests.

Strict TypeScript passes. No network, model, customer data or provider service
was used.

## Boundary

This is local protocol and process-boundary evidence. The provider policy and
response were signed by fictional local keys; there is no deployed independent
continuity service, customer installation, production reliability, hostile-admin
resistance or old-binary rollback proof. A pinned provider key remains a required
deployment trust root. Short-lived signed responses provide bounded currentness;
live revocation or expiry during a long-running process is a separate next risk.
