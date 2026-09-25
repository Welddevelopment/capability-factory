# CF-044 registry-snapshot mixed-family execution

Date: 2026-08-14
Status: **passed local fictional campaign**
Corpus seal: `3b9399f2dfa4988d390cf74deaaf8f74a41afbf624805d292a4737ae3a072343`
Campaign receipt: `729a3878345a2e20d89c1b0d67defe0701427b8f4c961e95c8ef2c7322f23cec`

## Outcome

CF-044 joins the actual CF-039 `DurableFamilyRegistry` snapshot, route and `recheckBeforeAction` methods to the sealed CF-033 mixed-family native receipt path. It does not change CF-007/008/009/031/032/033/038/039 or their seals.

The synthetic goal/schedule corpus was frozen before execution. Its three cases cover a clean snapshot with lost-response/restart, a post-plan database quarantine with no replacement, and a separately qualified higher-version database replacement. Every route comes from a persisted immutable CF-039 snapshot receipt. Immediately before each CF-044 effect, execution requires the exact current entry and its exact active unexpired family-native lifecycle receipt.

CF-033 still runs each family-native fictional world and supplies the sealed independently verified native completions. CF-044’s customer-local effect ledger is a separate deterministic boundary: a native completion can affect it only after the registry recheck, and work-item identity makes restart/lost-response replay idempotent.

## Results

- Clean snapshot/restart: completed, 3 writes, 1 parent resumption.
- Quarantine without replacement: precise handoff, 2 preceding writes, database write blocked, 0 parent resumptions.
- Qualified replacement: completed, 3 writes, 1 parent resumption, new snapshot and explicit v1→v2 lineage.
- Aggregate: 8 intended writes, 1 blocked write, 2 parent resumptions, 0 retries.
- Registry-health, cross-family and evidence-substitution attack checks: 6 blocked before action.
- Stale, unauthorized and cross-family actions: 0.
- Accepted evidence substitutions: 0.
- Second parent resumptions: 0.

The replacement is not silently substituted into the old plan. The old snapshot fails its current-entry recheck; a higher-version lifecycle receipt is separately admitted to CF-039, a new snapshot is persisted, routing is repeated, and lineage binds the old snapshot, new snapshot, family, versions and replan reason. Without that replacement the route stops at a precise handoff.

## Verification

- CF-044 focused suite: 5 passed, 0 failed.
- Determinism: isolated executions produced the same campaign receipt.
- Frozen-corpus drift test: modified schedules fail closed.
- Targeted CF-033/038/039/044: 22 passed, 0 failed across 4 files.
- Full repository suite with local-loopback permission: 661 passed, 0 failed, 60 skipped across 139 files.
- Diff check passed.
- Repository-wide TypeScript was attempted but is currently blocked by an unrelated concurrent `test/product-customer-local-onboarding-journey-actual-output.test.ts` exact-optional-property assignment of `undefined`. CF-044 produced no TypeScript diagnostic.

## Claim boundary

This is local deterministic fictional registry/executor evidence. The sealed CF-033 native worlds run in isolated local test state; CF-044 records separate coordinator effects after CF-039 rechecks. It is not a customer workload, production system, universal reliability result, deployment, demand evidence or formal production-readiness verdict. No network, model, spend, container, customer data, customer action, queue change, review, commit, deployment or public claim occurred.
