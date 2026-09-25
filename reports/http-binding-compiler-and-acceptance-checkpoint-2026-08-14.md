# Compiled HTTP binding pair and acceptance checkpoint — 2026-08-14

## Result

Capability Factory can now compile a clean Binding Factory v1 result into two
narrow, customer-local, acceptance-only adapters:

1. a constrained HTTP action adapter; and
2. a separately authenticated, independently implemented HTTP observation
   adapter.

The compiler preserves the exact declaration digests and reviewed server,
target, operation, method, request mapping, credential alias, authority,
identifier, freshness and outcome boundaries. Compilation cannot widen or
activate either adapter.

The generated observer passed the existing mandatory verifier-template
qualification controls. The compiled pair then completed the generic fixed
ten-case acceptance campaign with one durable restart reconciliation and zero
surviving incorrect effects.

This closes the local software gap identified by the fresh-start teardown for
the subset of constrained HTTP APIs covered by Binding Factory v1 primitives.
It does not establish customer-independent setup for arbitrary APIs.

## Action boundary

The compiled action adapter:

- accepts only the reviewed request mappings;
- supports only reviewed scalar workflow/context values and top-level JSON
  request fields;
- resolves a customer-local credential alias only at the final transport
  boundary;
- requires an exact, integrity-bound, unexpired runtime grant tied to the
  authority compilation, action declaration, target, operation, method, parent
  goal and work item;
- requires an approval reference when the reviewed write policy is
  approval-gated;
- carries the pre-action stable business key used for reconciliation; and
- marks its action response categorically ineligible as external proof.

No authority is inferred by the compiler. Compilation and acceptance leave the
adapter `activated: false`.

## Independent observer boundary

The compiled observer requires:

- a driver/source distinct from the action adapter;
- a distinct transport implementation digest;
- a separately scoped read credential alias;
- an explicit transport declaration that it is independent from the action
  driver;
- the exact reviewed GET/HEAD request bindings;
- a stable pre-action identifier;
- the reviewed result, outcome, not-started, duplicate and collateral checks;
  and
- the reviewed server freshness signal relative to a trusted operation-start
  boundary.

Unavailable credentials, unreviewed statuses, stale evidence, or any transport
failure produce an `unavailable` / handoff result rather than success. The
observer API has no action-response input, and the qualification corpus includes
the adversarial action-response control.

## Verifier-template qualification

The compiled observer was bound to:

- its implementation digest;
- its outcome-schema digest;
- the exact primitive-registry digest;
- the exact verifier-registry digest;
- the fixed negative-control corpus; and
- a bounded qualification lifetime.

All eleven mandatory controls passed:

- completed;
- not-started;
- partial;
- incorrect;
- duplicate;
- stale;
- collateral;
- unknown;
- unavailable;
- lost-response reconciliation; and
- adversarial action-response.

The qualification receipt remains local development evidence. It is not an
external audit or general verifier proof.

## Fixed ten-case acceptance

A new fictional Northstar order world exercised the compiled pair through the
generic executor's precommitted case order:

1. read-only happy path;
2. approved write;
3. fresh-process reuse;
4. missing credential with zero write;
5. missing permission with zero write;
6. lost-response reconciliation without a duplicate;
7. wrong/partial outcome rejection;
8. process restart with exact pair identity;
9. duplicate parent submission with one external write; and
10. conflicting parent reuse rejection without a second write.

The approved-write case deliberately committed and lost its response before a
durable result was recorded. The first executor process stopped at
`awaiting-reconciliation`. A new compiler/executor process then used the
independent observer, found the one correct external order, and recorded an
`interrupted-reconciliation` receipt without executing the action again.

Final campaign result:

- 10/10 cases passed;
- 10 hash-chained receipts;
- 1 interrupted case reconciled after restart;
- zero surviving incorrect effects; and
- durable replay preserved one attempt per case rather than rerunning the
  completed campaign.

## Supported and unsupported compilation

The compiler supports only the reviewed v1 declaration primitives:

- constrained GET/HEAD/POST/PUT/PATCH/DELETE operations;
- scalar path/query/header values;
- documented top-level JSON request fields;
- exact credential aliases;
- exact runtime grants;
- a stable identifier known before action;
- one non-paginated read observer;
- documented JSON result/freshness paths or a documented timestamp header; and
- the bounded predicate vocabulary emitted by Binding Factory v1.

Nested/compositional request schemas, arbitrary transformations, undocumented
fields, inferred credentials, inferred authority, pagination, response-derived
reconciliation IDs, arbitrary APIs and unqualified customer-specific logic
remain blocked. The factory reports the exact engineering work before the
compiler is eligible to run.

## Verification

- Strict TypeScript check — passed.
- Binding compiler, Binding Factory, OpenAPI normalizer, verifier-template
  qualification, and generic acceptance suites — 5 files, 24 tests passed.
- Paid/model calls — 0.
- API spend — USD 0.
- Network, container, customer and external activity — none.

## Files

- `src/product/http-binding-compiler.ts`
- `src/product/http-binding-factory.ts` (added bound reconciliation key and
  authority policy plus one confirmed predicate primitive)
- `test/product-http-binding-compiler.test.ts`
- `src/product/index.ts` (product export)

## Claim boundary

The strongest supported private statement is:

> For the constrained HTTP subset covered by the reviewed v1 primitives,
> Capability Factory can now generate declarations, compile them into separate
> customer-local action and independent-observer adapters, qualify the observer
> against mandatory negative controls, and run the pair through a restart-safe
> fixed acceptance campaign without surviving incorrect effects.

This is synthetic local development evidence. It does not support claims of
activation, production readiness, customer validation, human-independent
onboarding, arbitrary-API support, universal capability acquisition, or a
formal final green verdict.
