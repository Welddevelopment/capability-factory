# Connecting an existing agent

The supported boundary is the authenticated localhost sidecar. Any language capable of
HTTP can use it; the TypeScript and dependency-free Python clients are convenience layers.

1. The customer's agent creates one ordinary-goal request with stable tenant, parent-goal,
   request, and trusted-scope identifiers.
2. `POST /v1/goal-jobs` persists the request before returning a job ID.
3. The agent polls the receipt and append-only events, or uses client callbacks.
4. A terminal result is either completion, a precise safe stop/handoff, a rejected plan,
   partial completion, failure, or unknown external state. Only completion means the
   original goal's verified criteria were satisfied.
5. Continuation requires a separate signed customer-local grant. Reusing the same parent
   goal is idempotent; changing the request under that ID is rejected.

The local access token authenticates the agent to its sidecar; it is not an external-system
credential. External credentials remain behind customer-local aliases. See
`docs/sidecar-openapi.json` for the language-neutral route contract.

Framework-specific packages should wait until customer conversations identify the real
agent stacks. The current thin boundary avoids forcing a LangChain, CrewAI, OpenAI Agents,
or other framework dependency prematurely.

## Minimal calls

The request body is identical across languages. Stable `tenantId` + `parentGoalId` values
make an exact resubmission duplicate-safe; changing the request under the same parent ID is
rejected.

### Raw HTTP

```sh
curl --fail-with-body http://127.0.0.1:4317/v1/goal-jobs \
  -H "Content-Type: application/json" \
  -H "X-Capability-Sidecar-Token: $CF_SIDECAR_TOKEN" \
  --data '{"schemaVersion":"1.0","tenantId":"customer_one","parentGoalId":"restock-2026-07-30","requestId":"agent-run-891","scopeKey":"approved_restock_scope","ordinaryGoal":"Restock every approved item below its threshold.","visibility":"exceptions-only"}'
```

Never put the token in the URL, request body, source control, chat, or support bundle. Read it
from the customer-local private file at process startup.

### TypeScript

```ts
import { CapabilityFactorySidecarClient } from "./src/product/client.js";

const client = new CapabilityFactorySidecarClient({
  baseUrl: "http://127.0.0.1:4317",
  accessToken: process.env.CF_SIDECAR_TOKEN!,
});
const started = await client.startGoal(request);
const terminal = await client.observeGoalJob(request.tenantId, started.jobId, {
  onStatus: (job) => console.log(job.status),
});
```

### Python

The dependency-free client and complete example are in
`clients/python/capability_factory.py` and `clients/python/README.md`.

## Operator decision tree

1. `/health` fails: the local process is not reachable. Check the container/process and the
   localhost port; do not widen network exposure.
2. `/ready` is degraded: stop new work and run `pnpm pilot:package doctor --root <pilot-state>`.
3. HTTP 401: reload or rotate only the sidecar access token. Do not substitute an external API credential.
4. `handoff` or `blocked`: surface the stated missing authority. Do not retry by broadening scope.
5. `unknown`: reconcile external state first. Never blindly resubmit a consequential action.
6. `failed` or `plan-rejected`: preserve events and export a sanitized support bundle; fix the
   adapter/plan through the trusted review path.
7. `completed`: trust it only because the result contains passed external-outcome evidence;
   the job status alone must not be manufactured by a caller.
