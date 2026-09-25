# CF-012 — integrity-bound onboarding readiness receipt v1

Date: 2026-08-14

Evidence class: deterministic local synthetic development evidence
Spend / network / containers: none

## Result

Implemented one fail-closed receipt that joins the exact onboarding intake and durable preparation revision to reviewed HTTP binding declarations, the compiled action/observer pair, the observer qualification receipt, and the fixed ten-case generic acceptance evidence chain.

The receipt has only one successful state: `synthetic-acceptance-complete-activation-blocked`. It cannot express or grant activation. It always records:

- `activated: false`;
- `humanIndependentOnboardingProved: false`;
- `customerEvidence: false`;
- `productionReady: false`;
- activation authority `not-established`.

Customer-supplied form fields that say “verified,” “ready,” or “activated” are retained only as `customer-declaration-only`; they cannot change any readiness field.

## Integrity chain

The builder verifies:

1. the exact intake digest and durable snapshot digest;
2. session, tenant, adapter identity, snapshot revision, and caller-provided expected digests;
3. binding-factory result integrity and declaration-to-authority provenance;
4. compiled-pair integrity and exact declaration identity;
5. all mandatory verifier-template controls, registry identity, and current qualification lifetime;
6. compiled-pair identity in the generic acceptance declaration and binding digests;
7. the fixed ten-case order, exactly one passing receipt per case, zero surviving incorrect side effects, and the complete hash chain;
8. campaign revision, latest receipt hash, and freshness at evaluation time.

Cross-session reuse, stale snapshot or campaign revisions, mutated evidence, broken receipt chains, stale evidence, and expired verifier qualification fail closed.

## Truthful responsibility split

The receipt preserves the existing preparation record’s separation between customer/engineer-supplied scope, documentation, credentials aliases, authority, outcome and reset facts; Capability Factory’s proposals/scaffolds; and the limited parts independently executed or qualified in the local synthetic environment.

It separately names remaining bespoke work and unsupported semantics. Important remaining work includes real customer-local transport and observer review, credential resolution, exact activation authority, a fresh-engineer comparison, and a controlled customer workflow. Unsupported v1 semantics include pagination, post-action-only identifiers, undocumented HTTP operations, non-HTTP capability modes, and automatic compensation.

## Adversarial validation

Focused deterministic tests passed 4/4:

- valid exact artifact chain issues a non-activating receipt;
- cross-session, stale-revision, mutated-evidence, and stale-evidence attacks are rejected;
- fabricated customer `verified`, `productionReady`, and `activated` flags remain declarations while activation stays false;
- post-issuance mutation invalidates the receipt digest.

Strict TypeScript typecheck passed. No paid call, external request, container, deployment, customer action, or public claim occurred.

## Claim boundary

This supports: “Capability Factory can produce one integrity-bound local readiness receipt across the exact preparation, binding, verifier-qualification, and synthetic ten-case acceptance artifacts, while keeping customer declarations and activation authority separate.”

It does not support independent human onboarding, customer activation, customer evidence, production readiness, universal capability coverage, or authority to act.
