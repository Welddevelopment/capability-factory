# Product security and operations gate

Status: **private design and local-reference checklist — not a security certification**

## Non-negotiable trust boundaries

- Model output may propose a declarative manifest; trusted code owns policy and execution.
- Credentials enter only through customer-configured aliases and never enter prompts,
  manifests, hosted job payloads, logs, or verification receipts.
- The customer authority envelope controls targets, credential aliases, HTTP methods, and
  whether each write is denied, preauthorized, or separately approved.
- Capability verification and outcome verification are separate. A connector can work
  technically while producing the wrong business result.
- A failed or ambiguous outcome is not success. It creates a precise, redacted handoff.

## Threats and required controls

| Threat | Required control | Local reference status |
|---|---|---|
| Malicious documentation or prompt injection | Treat docs as data; strict schema; no generated shell/JavaScript; policy checks after generation. | Declarative manifests and runtime validation exist; adversarial-doc campaign remains future work. |
| Server-side request forgery | Exact customer-configured host, method, and route allowlists; block redirects and private-network expansion by default. | Exact localhost host/method/route policy exists; production network policy is unbuilt. |
| Credential leakage | Secret aliases, redacted events/handoffs, encrypted local secret provider, never persist values in registry. | Alias-only manifests and deterministic redaction exist; production secret manager is unbuilt. |
| Excess authority | Least-privilege roles, explicit write authority, per-action approval for consequential classes. | Authority envelope and real restricted ERPNext roles exist. |
| Duplicate writes after timeout | Stable operation key plus read-before-retry reconciliation when the API lacks native idempotency. | Synthetic lost-response and genuine ERPNext reconciliation cases pass locally. |
| False success | Direct external-state verifier with exact, forbidden, duplicate, and collateral checks. | Implemented in local worlds; customer-specific verifiers remain required. |
| Blind retry after an ambiguous execution error | Inspect external state first; classify it as completed, not started, partial, incorrect, or unknown; quarantine before handoff unless an explicit verified-state resumption path exists. | The shared SDK now blocks blind retry, emits a structured redacted incident, quarantines failed/ambiguous capabilities, and has passing local tests for every classification. No automatic compensating-action engine is claimed. |
| Cross-tenant leakage | Tenant-scoped registries, queues, encryption keys, logs, caches, and authorization checks. | Hashed per-tenant local store and tenant-scoped queue tests exist; production auth is unbuilt. |
| Compromised retained capability | Immutable verification receipt, version pinning, quarantine/revoke, expiry, reverify on docs/policy change. | Receipt, documentation-hash match, status fields exist; signing and distributed revocation are unbuilt. |
| Concurrent duplicate acquisition | Coalesce identical tenant + need + documentation-hash requests. | Passing local concurrency test. |
| Control-plane compromise | Hosted plane carries redacted context and aliases only; customer runner resolves secrets and executes. | Split-plane contract sanitizes prose and keeps secret values local; transport security is unbuilt. |
| Unauthenticated local sidecar | Bind to localhost, require workload authentication, cap request/response sizes, block redirects. | Reference client is localhost-only and uses a constant-time checked access token; production identity/rotation are unbuilt. |
| Managed fallback becoming an agency | Exception-only queue, complete machine context, repair returns to retained capability and original goal. | Product rule only; managed operations service is unbuilt. |

## Operational gates before a real pilot

1. Customer-approved safe workflow and synthetic or sandbox data.
2. Written target, method, record, and write-authority policy.
3. Dedicated least-privilege credentials with expiry and revocation.
4. Direct verifier designed before the capability run.
5. Reset/cleanup route and duplicate reconciliation tested.
6. Tenant authentication and authorization independently tested.
7. Encryption in transit and at rest, with a defined secret provider.
8. Audit retention and deletion agreed with the customer.
9. Capability version rollback, quarantine, and kill switch.
10. Incident owner and explicit escalation path.
11. No production consequential action until the sandbox acceptance cases pass unchanged.

The current local work does not clear these production gates. It makes them concrete and
testable.

## Current recovery boundary

The local reference can now distinguish five externally observed states after an action
fails or returns an ambiguous transport result:

- **completed:** direct inspection proves the intended final state and no incorrect side
  effect; resumption is allowed only through an explicit verified-state path that cannot
  repeat the write;
- **not started:** no intended write is visible;
- **partial:** some intended state exists, but the exact outcome contract is incomplete;
- **incorrect:** a duplicate, forbidden, collateral, or otherwise wrong side effect is
  visible; and
- **unknown:** the independent evidence channel cannot establish the state.

For the last four states the SDK blocks automatic retry, quarantines the capability from
reuse, and creates a redacted incident with the next required recovery decision. It does
not yet perform automatic reversal or compensation. That omission is intentional:
undoing a real-world action is itself a consequential capability and must be separately
defined, verified, and authorized.
