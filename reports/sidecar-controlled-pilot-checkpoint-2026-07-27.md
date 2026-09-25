# Sidecar controlled-pilot checkpoint — 2026-07-27

Private development record. “Controlled-pilot substrate” means reusable local machinery exists; it does not mean Capability Factory can be connected safely to an unknown customer without an adapter and acceptance work.

## Plain-English result

The sidecar can now accept a long-running broad goal without forcing the customer to keep one HTTP request open. It immediately returns a job ID, stores the job locally, runs it in the background, and lets the customer check the result later.

If the process stops while a job is running, the new process can recover it. Capability Factory then uses the exact saved plan and the restart-safe scheduler, so it reconciles external state instead of blindly repeating work.

## Implemented

- Authenticated `POST /v1/goal-jobs` submission.
- Durable customer-local SQLite job storage.
- Stable, idempotent job IDs derived from tenant and parent goal.
- Rejection when a different request tries to reuse an existing parent ID.
- One-at-a-time execution for conservative first-pilot operation.
- `GET` status lookup scoped by tenant and job ID.
- Client polling with a bounded timeout.
- Recovery of a job left running by process interruption.
- Maximum attempt limits.
- Manual retry only for an interrupted/unknown job that has no result.
- Liveness and readiness endpoints.
- Append-only local job events for queue, execution, recovery, retry, completion, partial completion, block, failure, unknown result, handoff, and plan rejection.
- Thin-client methods: `startGoal`, `getGoalJob`, `waitForGoalJob`, `retryGoalJob`, and `getGoalJobEvents`.
- A runnable fictional local reference sidecar.
- A pilot guide and customer-adapter acceptance checklist in `docs/SIDECAR_PILOT.md`.

## Verification

- Focused sidecar/SDK/console/architecture/containment group: 58/58 passed.
- Complete ordinary local suite: 165 passed, 13 explicitly skipped genuine-ERPNext tests, 0 failures.
- Manual localhost reference smoke test:
  - `/health`: OK.
  - `/ready`: ready.
  - durable job submission returned immediately as queued;
  - status later became completed;
  - seven of seven jobs completed;
  - one missing capability was built and verified;
  - parent goal resumed;
  - zero incorrect side effects.
- No paid model calls were used for this checkpoint. The runnable reference uses the deterministic fictional planner.

## Important boundary

The sidecar is now prepared for a **controlled adapter pilot**, not a drop-in production deployment.

A real pilot still needs:

1. A named company and safe workflow.
2. Its exact trusted scope and authority configuration.
3. A customer-local credential resolver.
4. A customer-system executor.
5. A separate external-state verifier.
6. Lost-response and duplicate-prevention acceptance tests.
7. Agreement on installation, token handling, data retention, handoffs, and stopping the pilot.

Still absent: production identity, TLS/network exposure, packaged installation, automatic upgrades, remote operations, live event streaming, plan-version continuation after new approval, formal security review, and customer evidence.
