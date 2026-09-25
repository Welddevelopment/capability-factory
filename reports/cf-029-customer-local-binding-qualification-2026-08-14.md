# CF-029 — Customer-local credential and split-transport qualification

Date: 2026-08-14
State: deterministic local implementation complete; no activation or customer claim

## Why this checkpoint exists

The declarative action and independent-observer pair previously described which credential aliases and transports should exist, but acceptance compilation did not require proof that the aliases were bound to current customer-local secret-provider handles or that the two reviewed transports were distinct, reachable and still matched the declarations. That left a gap between a clean onboarding package and executable acceptance.

CF-029 adds a fail-closed qualification gate before acceptance compilation. It does not receive or persist credential values. It does not grant write authority, activate a binding, or establish production readiness.

## Implemented behavior

`src/product/customer-local-binding-qualification.ts` now qualifies:

- two distinct opaque credential aliases and handle digests;
- secret-provider, resolver-implementation and revision identity;
- exact operation scopes, current/non-revoked state and expiry;
- separate action and observer driver/source/implementation identities;
- exact server, path and method;
- declaration-derived request and response schema digests;
- approved-source digest and review expiry;
- bounded timeout and request-rate policy;
- reconcile-before-retry and no-blind-retry policy;
- HTTPS-required representation;
- separately authenticated observer independence from the action driver;
- a current no-write reachability/endpoint-identity probe.

The resulting receipt contains aliases, opaque digests, reviewed transport metadata and evidence boundaries only. It explicitly records `executionAuthorityEffect: none` and `activationEffect: none`.

`src/product/http-binding-compiler.ts` now rejects acceptance compilation without the exact qualification receipt. Both action and observer runtimes re-check the receipt before resolving credentials or performing transport work. Rotation, revocation, expiry, provider/resolver change, source drift, profile change, endpoint misrouting and transport unavailability therefore fail closed until the pair is requalified.

`src/product/onboarding-productization-sidecar.ts` automatically performs the qualification when reviewed bindings are submitted, persists the redacted integrity-bound receipt, exposes it through authenticated `GET /v1/onboarding/sessions/:sessionId/qualification`, and includes its state/digest/effects in the binding projection. There is still no activation route.

The shared declarative acceptance world now supplies declaration-derived schemas, opaque credential revisions and exact reachability probes. This keeps the existing clean-package and ten-case acceptance paths on the same qualification boundary.

## Deterministic evidence

Targeted TypeScript typecheck passed.

Targeted suite:

- 8 test files passed;
- 40 tests passed;
- 0 failed.

The qualification-specific adversarial tests covered:

- two isolated network-shaped local action/observer fixture instances;
- missing alias;
- shared handle;
- wrong scope;
- revoked alias;
- stale alias;
- request-schema drift;
- TLS-policy/server mismatch;
- unavailable or misrouted transport;
- approved-source drift;
- rotation and revocation after qualification;
- cross-tenant, cross-session and cross-package receipt reuse;
- receipt redaction and zero authority/activation effect.

The joined regression set also re-ran both clean-package families, their actual ten-case acceptance executions, sidecar restart/integrity/security tests, and HTTP compiler reconciliation tests. The two clean-package families each remained 10/10 with zero incorrect side effects. These are deterministic fictional local development results, not customer evidence.

No model call, paid API, external network, container, customer credential or customer data was used. The local fixture represents an HTTPS-required policy and endpoint identity; it is not evidence of a real TLS handshake or external service availability.

## Exact gap closed

Acceptance can no longer be compiled merely because two alias strings and transport objects exist. The customer-local runtime must prove, without exposing secret values, that the declared action and independent observer have current, separate, correctly scoped credential handles and exact reviewed transports.

## Remaining work

- A real customer-local secret provider must implement the inspector and resolver boundary.
- A real customer transport package must implement the no-write reachability probe and provide reviewed endpoint/schema/source digests.
- Actual TLS, DNS, proxy, certificate, firewall and service-availability behavior remains environment-specific and untested here.
- Customer authority, approval, legal/security review and activation remain separate gates.
- The fresh-platform-engineer under-one-day comparison and controlled customer workflow remain unrun.
- Credential-provider integrations and operational rotation procedures remain to be selected from real deployment requirements.

## Strongest accurate claim

Inside the local constrained-HTTP onboarding path, Capability Factory now requires and re-checks an integrity-bound, redacted qualification of separate customer-local action and observer credentials, transports, schemas and source material before acceptance execution can use them.

This is a stronger onboarding and safety foundation. It is not proof of self-serve onboarding, production reliability, customer validation, or universal capability acquisition.
