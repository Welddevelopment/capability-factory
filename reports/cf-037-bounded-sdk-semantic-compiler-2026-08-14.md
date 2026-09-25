# CF-037 — Bounded provider-SDK semantic compiler

Date: 2026-08-14
State: deterministic local acceptance-only semantic compilation complete; no arbitrary-SDK or customer-readiness claim

## Purpose

CF-036 reduced an unfamiliar provider SDK to a provenance-bound implementation work pack, but deliberately left nine semantic decisions to an engineer. CF-037 adds a strict declarative layer for those decisions. It can produce and exercise bounded provider adapters when every consequential fact is explicitly confirmed, without evaluating generated code or importing an arbitrary package.

## Declarative semantic boundary

`src/product/customer-local-sdk-semantic-compiler.ts` requires an integrity-bound contract for all nine CF-036 blocker classes:

1. exact parameter mappings and bounded scalar conversion;
2. separate credential aliases and exact action/observer scopes;
3. stable external identity and conflict rejection;
4. idempotency identity and conflict fields;
5. reconcile-before-retry with blind retry forbidden;
6. separate reconciliation and independently authenticated observer roles;
7. outcome predicates, duplicate checks, collateral-state checks and freshness;
8. explicit complete-pagination policy for readback and observation;
9. bounded timeouts, request rates, attempts and classified error names.

Every fact carries an engineer/owner confirmation, timestamp and source pointer. The compiler rejects missing required SDK parameters, duplicate mappings, ambiguous predicates, stale provider/work-pack identities, shared action/observer credentials, action/observer method conflation, unsafe retry policy, incomplete pagination, injection-shaped material and expired contracts.

The expression surface is intentionally small: read a named scalar from workflow input or trusted context and apply identity/string/number/boolean conversion. It contains no `eval`, dynamic import, package loading, object traversal, authority inference or credential values.

## Execution gates

Compilation returns adapters whose four methods all fail closed. They become executable only when attached to:

- the exact semantic contract and CF-036 work pack;
- a runtime implementation digest matching the compiled adapter;
- a current integrity-valid CF-030 conformance receipt;
- a current integrity-valid CF-029 qualification receipt;
- all mandatory acceptance cases with zero incorrect side effects;
- an acceptance evidence digest binding the exact contract, work pack, implementation, CF-030 receipt and CF-029 receipt.

The generated semantic JSON is included in the existing CF-035 deterministic source/release digest and static file allowlist. The release exercise produced a detached Ed25519 signature, verified it, loaded the plugin through CF-034, then demonstrated that restart changes the doctor state to reload-required until fresh conformance is run.

No semantic contract, conformance receipt, qualification receipt or acceptance receipt grants execution authority or activation by itself.

## Runtime behavior exercised

Two fictional provider worlds were exercised:

- `aurora-semantic`, using the map/direct reference shape;
- `mistral-semantic`, using the callback/queued reference shape.

For both, the same compiler generated the bounded action, no-write probe, reconciliation and independent-observer adapter behavior. The tests demonstrated:

- action execution using the exact reviewed SDK method and scope;
- independent outcome checks for the business predicate, exactly-one duplicate constraint, collateral-state invariant, server-side freshness and pagination completeness;
- lost-response recovery through observer-side reconciliation rather than blind action retry;
- idempotent retained reuse without a second external record;
- observer credential revocation failing closed;
- incomplete pagination classifying the outcome as unknown;
- duplicate, collateral and stale evidence being rejected rather than passed;
- action-response data not serving as external proof.

The provider invocation primitives are fictional local test worlds. They are the explicitly allowed world-specific layer, not evidence that arbitrary real SDKs can already be executed without provider-specific implementation.

## Adversarial controls

The joined tests reject or detect:

- wrong/cross-provider contract identity;
- stale work-pack or method substitution;
- missing or duplicate required parameter mappings;
- shared action and observer credentials;
- action/observer method conflation;
- scope widening by the runtime;
- stable-ID collision in the fictional world;
- blind-retry weakening;
- incomplete pagination policy and incomplete observed pagination;
- missing or ambiguous outcome predicates;
- duplicate external records;
- collateral-state changes;
- stale observation evidence;
- revoked observer credentials;
- mismatched runtime implementation digest;
- fake or cross-boundary acceptance evidence;
- injection-shaped semantic material;
- release mutation and restart-stale host state through the inherited CF-034/035 controls.

## Verification

- Repository-wide TypeScript typecheck: passed.
- Joined CF-029/030/034/035/036/037 and onboarding target: 10 files, 75 tests, 0 failures.
- `git diff --check`: passed.
- Paid model calls, network calls, package installs, containers, customer credentials and customer data: none.

## Remaining bespoke work

For a real provider, an engineer still must confirm the exact installed SDK metadata and semantic contract, supply a customer-local invoker for the reviewed methods, prove credential and transport bindings through CF-029/030, and execute the mandatory acceptance campaign. Unsupported conversions, nested/provider-specific objects, streaming or asynchronous job completion, package installation, SDK version drift and provider-specific rate/error semantics remain explicit work rather than generated defaults.

## Strongest accurate claim

Capability Factory can now compile an explicitly confirmed, bounded provider-SDK semantic contract into acceptance-only action, probe, reconciliation and independent-observer adapters; those adapters remain non-executable until exact local conformance, binding qualification and digest-bound mandatory acceptance evidence are attached.

This does not establish arbitrary-SDK support, zero-engineer onboarding, production reliability, customer validation or permission to activate a pilot.
