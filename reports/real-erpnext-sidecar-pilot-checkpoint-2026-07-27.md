# Genuine ERPNext durable-sidecar checkpoint — 2026-07-27

Status: **private local product-development evidence**

This checkpoint joins previously separate product pieces. It does not claim a customer deployment, production reliability, held-out market validation, a formal security review, or support beyond constrained HTTP APIs.

## Plain-English result

One ordinary batch instruction entered through the authenticated local sidecar:

> Convert every approved material request in the current test batch into exactly one draft Purchase Order, record each order reference on its source request, and leave every other record unchanged.

Trusted code limited the instruction to three fictional approved Material Requests in a genuine disposable local ERPNext 16 installation. The coordinator produced three bounded jobs. The first job acquired and verified the missing procurement capability. The next two found and reused the retained capability. All three exact external outcomes passed direct ERPNext database verification, the aggregate outcome passed with zero incorrect side effects, and the original parent goal resumed.

## Joined path exercised

1. Authenticated `POST /v1/goal-jobs` submission.
2. Immediate durable job receipt.
3. Trusted customer adapter scope and authority resolution.
4. Validated three-item plan.
5. First work item: constrained capability build.
6. Candidate capability probe against a separate disposable ERPNext Material Request.
7. Probe verification and exact probe-state restoration without resetting parent progress.
8. Real ERPNext read, reconciliation search, Purchase Order creation and source Material Request update.
9. Independent item-level direct database verification.
10. Fresh work items reused the retained verified capability twice.
11. Independent aggregate direct database verification.
12. Parent goal resumption and durable completed status/event.

## Exact deterministic result

- Sidecar job: completed.
- Parent goal: completed and resumed.
- Work items: 3/3 completed.
- Capability paths: one build, then two retained reuses.
- Intended ERPNext business writes: 6 total — one Purchase Order and one source-record update per request.
- Incorrect side effects: 0.
- Retained capability records: 1 active record with two recorded reuses.
- Paid model calls: 0. The planner and builder were deterministic for this integration checkpoint so wiring and external-state failures could be isolated.

## Regression checks

- Focused adapter/sidecar/coordinator/scheduler group: 24/24 passed when localhost access was allowed.
- New genuine ERPNext durable-sidecar test: 1/1 passed.
- Existing real ERPNext dispatch integration/product group: 7/7 passed.
- Existing real ERPNext procurement confirmation group: 6/6 passed.
- Strict TypeScript checking passed.

## New adapter behavior

The genuine ERPNext adapter uses the versioned controlled-pilot adapter contract. Its descriptor contains aliases and documentation hashes rather than credential values. Execution and secret resolution remain customer-local. Each write is declared as reconcile-before-retry and each operation names its independent verifier.

The ERPNext fixture now contains a separate probe Material Request. Candidate verification can perform a genuine disposable API write, inspect database state, and restore only the probe. It does not reset or erase an active parent job's business progress.

## Important limitations

- This is a fictional local ERPNext environment, not a customer's system.
- The broad-goal plan and manifest builder were deterministic in this checkpoint; model-backed final confirmation remains a later gate.
- Only one ERP application and one procurement workflow were exercised.
- The sidecar still uses a local shared token and local SQLite rather than production identity or remote infrastructure.
- Customer-specific adapter acceptance, installation rehearsal, console-sidecar integration and the frozen final readiness campaign remain incomplete.
- The result supports “joined local MVP behavior,” not “production-ready” or “it will always work.”
