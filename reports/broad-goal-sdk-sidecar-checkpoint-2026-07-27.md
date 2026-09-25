# Broad-goal SDK and sidecar checkpoint — 2026-07-27

Private development record. This does not claim production readiness or customer deployment.

## Plain-English result

The broad-goal system now has one shared product entrance. A customer can either install it directly inside their agent through the SDK, or run it as a separate authenticated local sidecar. Both routes call the same trusted planning, scheduling, capability-acquisition, verification, and resumption core.

The SDK and sidecar are alternatives:

- **SDK:** the customer puts Capability Factory directly inside their agent process.
- **Sidecar:** the customer’s agent sends the same request to a separate local Capability Factory process.

The console also uses this shared SDK route. It no longer reaches the coordinator through a separate demo-only shortcut.

## What was added

- `BroadGoalCoordinatorSdk.completeGoal` for one broad parent goal.
- A strict request contract containing goal identity, trusted-scope key, ordinary goal, and visibility mode—but no credential values or authority grants.
- A trusted scope resolver outside model control.
- An immutable validated-plan store.
- Scope-digest checks before restart.
- Atomic create-if-absent plan saving, preventing silent concurrent replacement.
- `POST /v1/goals` on the authenticated localhost sidecar.
- `CapabilityFactorySidecarClient.completeGoal` for the same operation.
- Console routing through the shared broad-goal SDK.

## Safety behaviour checked

- A direct SDK request and sidecar request both completed the seven-job reference goal.
- The direct request built the missing capability; the later sidecar request reused it.
- Both paths independently verified the complete external result and resumed the parent goal.
- A lost response retried with the exact saved validated plan and did not call the planner again.
- The retry produced no duplicate purchase.
- Missing or mismatched trusted scope stopped with zero writes.
- Changed trusted permissions stopped the old saved plan with zero new writes.
- An authority-limited run completed six independent jobs, blocked one, made no incorrect side effect, and did not claim parent completion.
- Missing authentication, wrong authentication, malformed requests, and an unconfigured broad-goal route were rejected.
- Saved plans contain safe credential aliases such as `supplier_east_key`, but not the actual local secret value.

## Test result

- Focused SDK, sidecar, console, architecture, and containment tests: 53/53 passed.
- Complete ordinary local suite: 160 passed, 13 explicitly skipped genuine-ERPNext tests, 0 failures.
- No paid model calls were needed for this implementation checkpoint.

## Still not built

- A durable networked control-plane queue; the current split-plane queue is in memory.
- A long-running asynchronous sidecar job API with polling or streaming.
- A safe way to add a newly granted approval to an existing blocked parent plan.
- Production authentication, TLS termination, installation packages, upgrades, migrations, monitoring, or support tooling.
- A real customer system or customer deployment.

The strongest next product step is to choose whether the first pilot should use the embedded SDK or local sidecar, then make that one path installable and long-running before building the more complicated remote split-plane system.
