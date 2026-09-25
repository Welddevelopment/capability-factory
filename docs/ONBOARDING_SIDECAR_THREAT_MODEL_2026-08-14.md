# Authenticated onboarding sidecar threat model

Status: local development threat model, not a formal security audit or certification
Applies to: `src/product/onboarding-productization-sidecar.ts` v1

## Assets

The sidecar protects:

- the customer-local access token;
- tenant and onboarding-session identity;
- approved API material and workflow facts;
- authority and credential aliases, never credential values;
- reviewed adapter, verifier and authority provenance;
- compiled action/observer declaration identity;
- verifier-template qualification identity and lifetime;
- acceptance campaign results and their evidence chain;
- the final non-activating readiness receipt;
- availability of the local onboarding service and SQLite state.

The most consequential integrity property is that no request, customer declaration, replay or stored mutation may convert preparation or synthetic acceptance into activation authority, customer evidence or production readiness.

## Actors and attacker capabilities

### Authorized local platform engineer

May submit approved documents and review decisions and inspect local status. The engineer may make mistakes, use stale artifacts or accidentally submit credential values. The system must reject unsafe material and explicit conflicts rather than guessing.

### Local untrusted process

May reach the listening interface, guess or replay headers, send malformed or oversized JSON, probe session IDs, race duplicate requests and attempt tenant/session crossing. It does not initially possess the sidecar token.

### Token-bearing but untrusted caller

May possess the local token but should still be unable to invent authority, replace a reviewed artifact, cross the configured tenant, attach evidence from another session, fabricate acceptance or activate a runtime.

### Local state tamperer

May modify, copy, delete or partially write SQLite rows while the service is stopped. This attacker is stronger than the HTTP caller. Integrity digests detect mutation and substitution, but the current local design does not provide hardware-backed anti-rollback or confidentiality against a host administrator.

### Compromised runtime dependency

A configured transport, credential resolver or acceptance store may return a malicious error, changed digest or forged evidence. Pair reconstruction, qualification validation, receipt chains and response redaction must fail closed. Full isolation from a malicious host-level dependency is out of scope.

## Trust boundaries

1. **HTTP boundary:** everything in headers, paths and bodies is untrusted until authenticated, bounded and validated.
2. **Tenant boundary:** the process is configured for one tenant. Payload tenant IDs do not select tenancy.
3. **Preparation boundary:** the durable preparation workflow owns session/revision state. API envelopes do not replace it.
4. **Runtime boundary:** action/observer transports and credential resolution are customer-local configured code. Credential values must not enter onboarding artifacts or responses.
5. **Evidence boundary:** the generic acceptance store owns executed case evidence. The sidecar may link and validate evidence but never fabricate or edit it.
6. **Activation boundary:** activation authority is outside this API. There is deliberately no activation endpoint or activation-capable input.
7. **Persistence boundary:** SQLite envelopes are integrity checked on every read. Filesystem confidentiality, OS compromise and anti-rollback remain deployment responsibilities.

## Principal threats and controls

| Threat | Control | Remaining limitation |
|---|---|---|
| Token guessing or length probing | SHA-256 both candidate and configured token, then fixed-length `timingSafeEqual`; uniform 401 response | This is code-level constant-time intent, not a laboratory timing proof |
| Secret smuggling | Iterative nested scan, secret-shape rejection, size/depth/node limits, error redaction | Novel secret formats may require new detectors |
| Tenant/session crossing | Configured tenant check, stable session syntax, tenant/session-bound artifact primary key | Host administrator can still read local SQLite |
| Pair/evidence substitution | Pair digest, session-derived acceptance binding ID, campaign revision and evidence-head checks | Does not provide remote attestation |
| Replay or semantic conflict | Exact digest idempotency; different content for an occupied stage returns conflict | No distributed multi-host consensus |
| Stored envelope mutation | Payload and envelope digests plus tenant/session/stage checks on every load | Legitimate whole-database rollback is not yet detected |
| Acceptance-chain forgery | Recompute every receipt hash, previous-hash link, case order, pair identity, checks and side effects | Trusts the configured acceptance store implementation to return bytes |
| Expired verifier qualification | Qualification registry revalidates identity, registries and expiry at readiness time | Requires a current trusted clock |
| Crash between durable stages | Exact retry repairs missing intake/review envelope; binding request is persisted only after successful compile | Filesystem/disk corruption needs backups and operator recovery |
| SQL/path/header injection | Parameterized SQL, restricted path identifiers, Fastify header parsing, no path-derived filesystem access | Fastify/SQLite supply-chain vulnerabilities are outside this test |
| Resource exhaustion | HTTP body limit plus structural limits for depth, nodes, strings, collections and keys | Not load-tested against hostile sustained traffic |
| Error leakage | Sanitized, length-bounded single-line errors; bearer/key/password/private-key redaction | Business identifiers may still appear in safe diagnostic errors |
| Synthetic evidence upgraded to activation | No activation route; receipt truth fields are literal false; customer claims remain declarations | Real activation remains a separate future contract |

## Explicitly out of scope

- production network exposure, TLS termination, multi-user identity or RBAC;
- HSM-backed secrets, remote attestation, encrypted SQLite or OS-hardening certification;
- denial-of-service resistance under sustained hostile traffic;
- formal side-channel analysis;
- supply-chain, kernel, hypervisor or physical-host compromise;
- formal verification, penetration-test certification or regulatory compliance;
- customer-production security evidence.

This threat model is a development control surface. Passing its deterministic attacks means the named regressions were not reproduced; it does not establish general security or production hardening.
