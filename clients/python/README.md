# Python sidecar client

This dependency-free client lets an existing Python agent submit its ordinary goal to the
customer-local sidecar and receive status/event callbacks. It does not embed Capability
Factory, receive the customer's API credentials, or widen the trusted scope.

```python
from capability_factory import CapabilityFactoryClient

client = CapabilityFactoryClient("http://127.0.0.1:4317", open("/customer/path/cf-pilot/secrets/sidecar-access-token").read().strip())
request = {
    "schemaVersion": "1.0",
    "tenantId": "customer_one",
    "parentGoalId": "restock-2026-07-29",
    "requestId": "agent-run-891",
    "scopeKey": "approved_restock_scope",
    "ordinaryGoal": "Restock every approved item below its threshold.",
    "visibility": "exceptions-only",
}
job = client.start_goal(request)
result = client.wait_for_goal_job(request["tenantId"], job["jobId"], on_status=lambda receipt: print(receipt["status"]))
```

The prompt originates in the customer's existing agent. The callbacks report durable
state; they do not authorize actions. A `handoff` or `blocked` result should be surfaced to
the customer's operator rather than automatically broadened or retried.
