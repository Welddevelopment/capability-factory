# Authenticated network EDIFACT checkpoint — 2026-07-31

## Result

The separate experimental file-transfer mode now supports two explicitly different bounded
contracts:

- local-directory X12 850 to canonical order JSON; and
- authenticated-network EDIFACT ORDERS D96A to canonical order JSON.

The second route is not a renamed copy of the first parser. It has a separate EDIFACT grammar,
partner contract, file extension, sender/receiver identities, line/quantity representation,
trusted builder, disposable probe, authenticated transport and independent verifier.

## Authenticated network boundary

The customer-local reference uses a real loopback HTTP file gateway:

- bearer authentication is resolved through a scoped customer-local credential alias;
- the capability can read only the exact inbox alias selected during trusted planning;
- the input hash must still match the immutable planned hash;
- the capability can create only one deterministic outbox alias;
- output creation requires `If-None-Match: *`, so an existing output cannot be overwritten;
- request bodies have a SHA-256 integrity header and bounded byte limits;
- redirects and oversized responses are refused; and
- output state is inspected through a separate direct database verifier rather than trusting
  the transport client's response.

## Demonstrated loop

The opt-in network test demonstrated:

1. ordinary-goal diagnosis;
2. retained and trusted-source misses;
3. construction from the pinned EDIFACT/network contract;
4. a no-business-write capability probe;
5. authenticated network input read;
6. one permission-bound exclusive network output write;
7. independent external-state verification;
8. original-goal resumption and completion;
9. retained reuse on a second order;
10. simulated lost-response reconciliation without duplicate output;
11. repeat reconciliation with zero additional writes; and
12. zero-write stops for wrong gateway credentials and missing exact approval.

The same EDIFACT route also completed as a durable job through the shared customer-local
capability-mode package and sidecar. The gateway credential value did not appear in package
config.

## Validation

- Strict TypeScript check passed.
- Authenticated network EDIFACT suite passed: 4/4.
- Affected local file-transfer, package and shared-boundary regression passed: 16/16.

## Evidence boundary

This is fictional local experimental evidence. The network gateway is an actual authenticated
TCP service, but it is not SFTP, AS2, VAN connectivity, a customer endpoint, production
transport hardening or a general EDIFACT engine. Only the pinned ORDERS D96A subset and exact
partner contract were demonstrated. Regulation, customer credentials, real partner
onboarding, certificates, non-repudiation, enterprise networking and willingness to pay
remain unproved.

## GTM implication

This removes two product objections for file/EDI-shaped discovery:

- the mode is no longer limited to direct local directory access; and
- the evidence is no longer confined to one X12 850 layout.

It plausibly strengthens conversations with distributor, procurement, freight and
order-automation companies. It does not by itself qualify them as buyers or pilots.

