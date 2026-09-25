# CF-039 durable evidence-derived family registry

Date: 2026-08-14
Status: **implemented and locally verified**

## Outcome

CF-039 adds a customer-local SQLite registry successor around the frozen CF-031/032 routing evidence without modifying either sealed campaign. Registry eligibility is derived only from the exact current CF-032 family conformance receipt plus a digest-valid family-native lifecycle/health receipt. Human metadata can propose context, including a `healthy` field, but it cannot establish eligibility or health.

Each versioned entry binds tenant, environment, family, candidate, source tier, opaque manifest and evidence references, capability version, qualification/conformance/lifecycle expiry, authority and credential requirements, observer availability, artifact input/output, dependencies, cost/latency/safety with provenance digests, route-affordance source digest, claims boundary, exact conformance receipt, and exact lifecycle receipt.

The service uses optimistic revisions and `BEGIN IMMEDIATE` transactions, append-only events, restart-stable SQLite state, transactional refresh rollback, immutable snapshot receipts, authenticated local request/CLI surfaces, and evidence-only import. Export removes human metadata and replaces tenant/environment identifiers with digests. Imports explicitly carry no eligibility or activation authority.

## Routing and execution boundary

Routing consumes only a persisted frozen snapshot receipt, never mutable registry rows. The route receipt is non-executing. Before an action, `recheckBeforeAction` requires the snapshot entry to remain byte-identical to the current entry and requires the exact current active, unexpired family-native lifecycle receipt. Drift or a post-snapshot revision therefore blocks action.

Refresh checks source-seal agreement, manifest identity, presence of current documentation/schema/provenance observations, qualification/conformance/lifecycle expiry, and current health. Drifted or expired entries become ineligible with explicit health. Quarantined, revoked and unknown lifecycle states never become eligible. Replacement requires a higher capability version; silent rollback is rejected.

## Adversarial coverage and measurements

The focused suite exercised three eligible native families—pinned document, signed message and scoped database—plus fake-family evidence rejection. It also exercised manual healthy metadata, re-signed lifecycle receipts, cross-family conformance, quarantined/revoked/unknown/expired/no-observer states, concurrent revision conflict, restart, higher-version replacement, rollback, circular dependencies, crash mid-refresh, source drift, exact documentation/schema/provenance/route drift, selective omission, stale snapshot execution, authenticated access, redacted export and evidence-only import.

Measured focused result:

- 7 registry scenarios passed.
- 3 native family entries became eligible from exact evidence.
- 5 explicitly unhealthy/expired/observer-missing state transitions remained ineligible.
- 3 entries were quarantined by the drift refresh.
- 1 conflicting revision was rejected.
- 1 higher-version replacement persisted across restart.
- 1 rollback and 1 circular-dependency update were rejected.
- 1 crash-mid-refresh rolled back atomically.
- 1 frozen snapshot route selected; post-refresh execution recheck blocked it.
- 1 fake-family path and evidence-only activation attempt were rejected.

Targeted CF-031/032/033/039 verification: 27 passed, 0 failed across 4 files. Strict repository TypeScript and diff checks passed. Final full repository suite: 655 passed, 0 failed and 60 skipped across 137 files.

## Claim boundary

This demonstrates local deterministic registry operations over fictional sealed evidence. It does not demonstrate a customer registry, production operation, universal family coverage, deployment, demand, or a formal production-readiness verdict. No queue edit, commit, network call, model call, spend, container, customer data, customer action, deployment or public claim occurred.
