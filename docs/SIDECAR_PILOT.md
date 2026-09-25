# Capability Factory sidecar — controlled pilot guide

This is a private pilot guide, not a production-readiness claim.

## What is ready

The local TypeScript reference can now:

- accept a broad goal through authenticated local HTTP;
- return a durable job ID immediately;
- save the job and exact validated plan locally;
- run jobs one at a time;
- report queued, running, completed, partial, blocked, failed, unknown, handoff, or rejected status;
- continue a job that was running when the sidecar stopped;
- prevent duplicate submission for the same parent goal;
- limit restart/retry attempts;
- use the normal Capability Factory build, verification, execution, outcome-checking, retention, and resumption core; and
- expose liveness and readiness checks.

No credential value or authority grant is accepted in the broad-goal HTTP request. Those come from the trusted customer-side adapter.

## What still depends on the pilot company

The reusable sidecar cannot know a customer’s systems in advance. Before a real pilot, we still need to add a small customer adapter that defines:

1. Which orders, records, or other entities belong to the requested goal.
2. Which systems contain them.
3. Which operations those systems document.
4. Which credentials already exist locally.
5. Which reads and writes the customer has approved.
6. How to check the real outcome without trusting the agent’s own success message.
7. Which writes can be safely reconciled after a lost response.

This is customer-specific configuration and verification work. It is not permission for the model to invent scope or authority.

## Run the fictional reference safely

Requirements:

- Node.js 24 or newer.
- `pnpm`.
- A private sidecar token containing at least 16 characters.

Start the local reference:

```bash
CF_SIDECAR_TOKEN="replace-with-a-private-local-token" \
CF_REFERENCE_COMPLETE_AUTHORITY=1 \
pnpm run product:sidecar:reference
```

Defaults:

- Address: `http://127.0.0.1:4321`
- Data: `artifacts/sidecar-reference/`
- Scope key: `fictional-order-operations-2100-v1`
- Concurrency: one broad goal at a time
- Retry limit: three attempts

The server binds to `127.0.0.1`. Do not expose this development reference directly to the public internet.

## Main HTTP flow

1. `POST /v1/goal-jobs` with the sidecar token and broad-goal request.
2. Receive a durable job ID.
3. Poll `GET /v1/goal-jobs/:jobId?tenantId=...`.
4. Treat `queued` and `running` as unfinished.
5. Treat `unknown` as requiring inspection. Do not assume the write did not happen.
6. Use `POST /v1/goal-jobs/:jobId/retry` only for an interrupted job with no result. The saved plan and scheduler perform reconciliation before another write.

The TypeScript thin client provides the matching methods:

- `startGoal`
- `getGoalJob`
- `waitForGoalJob`
- `retryGoalJob`
- `getGoalJobEvents`

The event history is append-only and records queueing, execution, restart recovery, retry,
completion, partial completion, blocks, failures, unknown outcomes, handoffs, and plan
rejection without copying the ordinary goal or credential data into each event.

The older synchronous `completeGoal` method remains useful for small local tests, but long-running pilot work should use durable jobs.

## Pilot security minimum

Before connecting any real write action:

- run the sidecar on the customer’s machine, private container network, or private development environment;
- use a fresh private access token and keep it outside source control;
- start with read-only scope;
- add the smallest possible write permission only after the read path passes;
- use sandbox or disposable customer test data;
- give every write a stable idempotency key;
- build an external-state verifier independent of the agent and action response;
- test lost responses and prove no duplicate write occurs;
- test missing credentials and missing approval;
- confirm logs, job records, and console events contain aliases rather than credential values;
- agree who receives handoffs and who can approve consequential actions; and
- define how the pilot is stopped and how local data is deleted or retained.

## Required acceptance run

For the first real pilot adapter, run at least:

1. Read-only happy path.
2. One approved write with exact external verification.
3. Fresh-process reuse of the verified capability.
4. Missing credential: stop with zero writes.
5. Missing permission: stop with zero writes.
6. Lost response: inspect before retry and create no duplicate.
7. Wrong or partial external outcome: do not claim completion.
8. Sidecar restart during a running parent job.
9. Duplicate submission of the same parent goal.
10. A different request attempting to reuse the same parent ID.

## Important current limits

- This is a controlled local pilot reference, not a production service.
- Authentication is one local shared token, not a full company identity system.
- The durable job database is local SQLite.
- Jobs run one at a time.
- The sidecar does not yet stream live events to the client.
- A blocked plan cannot yet accept a new approval and continue under a new validated plan version.
- Packaging, automatic upgrades, remote monitoring, formal security review, and customer support operations are not complete.
- The current reference customer world is fictional. A real pilot still requires the customer adapter and its acceptance tests.
