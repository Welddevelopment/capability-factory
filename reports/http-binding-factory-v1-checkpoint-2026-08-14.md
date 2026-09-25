# Constrained HTTP Binding Factory v1 checkpoint — 2026-08-14

## Result

Capability Factory now has an additive, provider-neutral, fail-closed **Binding
Factory v1** for the supported constrained HTTP mode. Starting from an intact,
server-reviewed normalized OpenAPI artifact, an intact review-required
authority compilation, and explicit request/outcome facts, it can produce two
separate digest-bound declarations:

1. a constrained HTTP write/action declaration; and
2. an independently authenticated HTTP GET/HEAD observer declaration.

The factory produces declarations only when the existing reusable primitives
are sufficient. Every generated declaration remains `proposal-only`,
`executable: false`, `qualified: false`, and `activated: false`.

This closes part of the fresh-start teardown's repeated specification gap. It
does **not** yet generate a qualified customer-local runtime implementation or
a passing observer implementation.

## What is bound

The action declaration is bound to:

- one exact reviewed server URL and normalized-material digest;
- one exact target, operation ID, HTTP method and path;
- one documented credential alias, never its value;
- confirmed workflow-input or trusted-context request mappings;
- documented 2xx status codes; and
- mandatory reconcile-before-retry / no-blind-retry behavior.

The observer declaration is separately bound to:

- a driver and source distinct from the action driver;
- a separately scoped, documented, reviewed read credential alias;
- one exact GET/HEAD operation and its documented parameters;
- a stable business identifier known before execution;
- a documented result path and freshness source;
- confirmed success, not-started, duplicate and collateral-effect rules; and
- an explicit rule that the action response is ineligible as external proof.

Both declarations commit to the normalized OpenAPI artifact, normalization
receipt, authority compilation, confirmed facts and exact operation pointer.
Mutation is detected by intrinsic declaration and result digests.

## Fail-closed boundaries exercised

Binding generation stops with exact engineering work when:

- the selected operation is absent, ambiguous, or the wrong read/write class;
- a required request or observer parameter is unbound;
- a request body needs nested/compositional translation outside v1;
- a mapping targets an undocumented field or parameter;
- a credential alias is absent from either documentation or reviewed authority;
- an action lacks an exact target/method/operation authority rule;
- a read observer lacks an exact reviewed read rule;
- observer pagination semantics are present but not proved;
- the stable identifier is not available before the action;
- the result, predicate, duplicate-key, or freshness path is undocumented;
- no explicit 2xx status is documented;
- a workflow attempts to populate a credential-bearing header; or
- normalized inputs, authority, generated declarations, or output receipts are
  mutated after review.

Strict schemas reject additional action-response material. Approved documents
containing credential-shaped values are rejected by the normalizer, and the
binding factory repeats the alias-only boundary across its complete input.

## Minimal onboarding projection

The factory exposes a deliberately non-authorizing onboarding projection. A
clean result can say `binding-declarations-ready`, but:

- `acceptanceReviewDigestsEligible` remains false;
- the authority-runtime binding digest remains null;
- the observation-adapter binding digest remains null; and
- the next gates name compilation, customer-local binding and mandatory
  verifier-template negative-control qualification.

This prevents a generated declaration from being reused as though it were an
implemented or qualified binding.

The output records structural automation only: the number of confirmed fact
leaves and generated declaration leaves. It records zero executable code lines,
zero qualification controls, no human active time, and no human study. These
figures measure declaration reduction, not onboarding time saved.

## Verification

- `pnpm typecheck` — passed under the pinned Node runtime.
- Focused Binding Factory + OpenAPI normalizer + verifier-template tests — 3
  files, 13 tests passed.
- Paid/model calls — 0.
- API spend — USD 0.
- Network, container, customer and external activity — none.

## Files

- `src/product/http-binding-factory.ts`
- `test/product-http-binding-factory.test.ts`
- `src/product/index.ts` (public product export only)

## Remaining exact gap

The highest-value remaining implementation step is a trusted compiler from
these declarations into customer-local action and observation adapters, followed
by qualification against the fixed negative controls and then the generic
ten-case acceptance executor. That compiler must not widen the reviewed server,
operation, request mapping, credential, authority, identifier, freshness or
outcome semantics.

## Claim boundary

The strongest supported private statement is:

> For a narrow, explicitly reviewed constrained-HTTP case, Capability Factory
> can now turn approved OpenAPI material and confirmed request, authority and
> outcome facts into separate, provenance-bound action and independent-observer
> declarations, while stopping precisely when reusable primitives are
> insufficient.

This does not support saying that bindings are executable, independently
qualified, activated, production-ready, customer-proven, arbitrary-API
compatible, or shown to reduce a fresh engineer's onboarding time.
