# CF-030 — Provider-neutral customer-local plugin conformance

Date: 2026-08-14
State: deterministic local conformance machinery complete; no authority, activation, production-security or customer claim

## Objective

CF-029 established that acceptance compilation must receive current, separate customer-local credential and transport bindings. CF-030 defines how a real customer-local secret provider and action/observer transports can earn those inputs without placing secret values in durable Capability Factory artifacts.

## Frozen plugin contract

`src/product/customer-local-plugin-conformance.ts` defines four provider-neutral boundaries:

1. **Credential inspector:** returns alias, opaque handle/provider/resolver digests, revision, exact scopes, revocation state and expiry. It cannot return a secret value.
2. **Short-lived scoped lease resolver:** returns a `ProcessLocalSecretLease`. Its value lives in a private field, is non-enumerable, can be read once, and is then cleared. The CF credential handle also exposes the value as a non-enumerable process-local property.
3. **Action transport:** consumes the exact action alias/scope and performs the reviewed write-side operation.
4. **Independent observer transport:** has a separate implementation, source and authentication boundary and checks external state independently.

The plugin bundle and passing receipt are bound to:

- contract/schema version;
- bundle and source-package digest;
- provider and resolver implementation digests;
- action and observer implementation digests;
- exact reviewed transport profiles;
- frozen control list;
- qualification and expiry times.

`provideCf029InputsFromConformantPlugins` is the production-facing bridge. It rejects failed, expired, mutated, source-drifted or implementation-drifted receipts. Only an exact passing bundle can expose its inspector, ephemeral resolver, transports and qualification runtime to CF-029. This bridge still grants neither execution authority nor activation.

## Frozen conformance controls

The runner executes 21 controls covering:

- contract and source-package identity;
- metadata-only, distinct credential inspection;
- provider/resolver/binding revision consistency;
- independent action/observer implementations and authentication;
- exact no-write transport probes;
- concurrent unique lease issuance;
- one-read lease behavior;
- zero-life/expired lease rejection;
- wrong alias and wrong scope rejection;
- valid action and independent observation;
- lost-response reconciliation to exactly one result;
- pre-rotation lease rejection;
- revocation after lease issuance;
- restart invalidation;
- action unavailability;
- observer misrouting;
- action transport drift;
- logs/events/snapshots/JSON/SQLite canary scanning;
- sanitized errors and causes;
- explicit core-dump evidence boundary.

The runner returns a failed receipt rather than throwing away negative evidence when a control fails.

## Reference implementations

`src/product/customer-local-reference-plugins.ts` provides two safe local reference shapes:

- `map-direct`: a map-backed metadata/lease provider with direct in-process transports;
- `callback-queued`: a separately identified callback-shaped provider with an asynchronous queued transport boundary.

Both use distinct action and observer endpoints, identities, credentials and implementations. Both are local deterministic fixtures with network-shaped request/response contracts; neither contacts an external service or proves real TLS behavior.

`src/product/run-customer-local-plugin-conformance.ts` is the zero-spend CLI hook. It runs both shapes and emits sanitized JSON receipts to stdout.

## Deterministic results

- Two reference bundles passed 21/21 controls each.
- Joined target: 9 test files, 51 tests passed, 0 failed.
- The exact passing callback-shaped bundle was joined into the real CF-029 qualification gate against a reviewed binding declaration.
- Seeded secret canaries were absent from receipts, JSON exports, raw SQLite pages, logs, events and snapshot projections.
- Deliberately inconsistent provider metadata and shared transport implementations produced failed receipts.
- Expired, source-drifted, implementation-drifted and tampered receipts were rejected.
- CLI receipts contained zero failed checks and zero seeded canaries.
- Repository-wide TypeScript typecheck passed.
- `git diff --check` passed for this work.

No paid/model call, external network, container, customer credential or customer data was used.

## Reusable versus environment-specific work

Reusable now:

- plugin contract and integrity model;
- one-read non-enumerable lease object;
- redacted receipt and canary scanner;
- fail-closed frozen conformance runner;
- CF-029 receipt-to-runtime bridge;
- reference test fixtures and CLI;
- restart/rotation/revocation/concurrency/lost-response controls.

Still environment-specific:

- real secret manager integration and its process/crash memory guarantees;
- provider-specific authentication and lease semantics;
- OS core-dump, swap, tracing and crash-report policy;
- real DNS/TLS/certificate/proxy/firewall behavior;
- transport-specific timeouts, rate limits, idempotency and reconciliation;
- customer logging/observability sinks and retention policy;
- deployment packaging, permissions and operator procedures;
- real customer authority, security review and activation.

## Strongest accurate claim

Capability Factory now has local provider-neutral conformance machinery that can qualify a customer-local secret-provider plus separate action and observer transport plugins, keep seeded secret values out of tested durable artifacts, and expose CF-029 inputs only when an exact integrity-bound plugin bundle passes the frozen controls.

This does not prove production secret security, real TLS, external availability, customer deployment, authority, activation, or universal capability acquisition.
