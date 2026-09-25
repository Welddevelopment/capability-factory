# Lost-response reconciliation demo

This is a private local demo route for the genuine disposable ERPNext fixture. It is not a
customer run or production-reliability claim.

## What the fault means

On the first approved Material Request, ERPNext genuinely commits the Purchase Order, but the
caller deliberately discards the response. Capability Factory therefore cannot safely assume
either that the write failed or that it succeeded. Before any retry, it reads external ERPNext
state, requires exactly one matching Purchase Order, refuses to repeat the create, records a
sanitized reconciliation receipt, completes the source-record update, and independently checks
the final database state.

The fault is deterministic, applies only to the first trusted batch item, and is disabled in
normal runs unless `CF_DEMO_LOST_RESPONSE=1` is explicitly set.

## Start a clean take

Start the disposable ERPNext stack on a port not used by another local container runtime:

```bash
DOCKER_HOST=unix:///Users/joeljeon/.colima/hardening/docker.sock \
CF_DOCKER_BIN="/Users/joeljeon/Desktop/Capability Factory/.local-tools/bin/docker" \
CF_DOCKER_CONFIG="/Users/joeljeon/Desktop/Capability Factory/.local-tools/docker-config" \
CF_ERPNEXT_PORT=18080 \
pnpm pilot:erpnext:up
```

Then start a fresh sidecar and console take:

```bash
DOCKER_HOST=unix:///Users/joeljeon/.colima/hardening/docker.sock \
CF_DOCKER_BIN="/Users/joeljeon/Desktop/Capability Factory/.local-tools/bin/docker" \
CF_DOCKER_CONFIG="/Users/joeljeon/Desktop/Capability Factory/.local-tools/docker-config" \
CF_ERPNEXT_PORT=18080 \
CF_CONSOLE_PORT=4317 \
CF_SIDECAR_PORT=4321 \
pnpm demo:erpnext:reconciliation
```

Open `http://127.0.0.1:4317/playground`. Keep the prefilled broad procurement goal, submit the
customer-local durable sidecar job, open the first work item, and show the `Execution reconciled`
event. Return to the parent run for the 3 required / 3 satisfied / 0 blocked / 0 incorrect result.

The demo launcher creates fresh private local state and fresh local credentials for every take.
That prevents a prior recording from turning the first item into retained reuse.

## Accurate narration

> The ERP write has actually committed, but its response is lost. A normal blind retry could
> create a duplicate. Capability Factory inspects the ERP state directly, finds exactly one
> matching order, refuses to repeat the create, and continues. It then independently verifies
> the final external result before the parent goal can complete.

Do not say that a language model wrote the capability in this route. The current local builder is
deterministic and reference-backed. The honest claim is that the product diagnosed the missing
ability within a predefined trusted scope, constructed the constrained HTTP residual, verified
it, recovered from an uncertain write result, resumed the original goal, and reused the retained
capability for the remaining work items.
