# Core interface requests

These are requests for later shared-core coordination, not console-local redefinitions.

1. Emit a stable run envelope carrying `tenantId`, `runId`, `requestId`, source, and an
   approved ordinary-goal summary.
2. Emit diagnosis and search-stage facts separately: diagnosis decision/checks, retained
   search result, trusted-source search result, and unsupported-residual build decision.
3. Expose immutable capability-verification, execution, outcome, reconciliation, and
   resumption receipt references suitable for tenant-authorized console reads.
4. Provide authoritative capability commands for quarantine, revoke, and reverify with
   optimistic version checks and resulting audit events.
5. Provide a versioned authority-policy adapter with validate/test/activate and active
   version reads.
6. Persist a stable handoff envelope and continuation relationship without altering the
   stopped run.
7. Expose environment health without secret retrieval: runner version, mode, target and
   credential-alias availability, verifier readiness, and acceptance-test result.
8. Define a versioned optional customer-agent plan envelope for customers that already
   decompose broad goals: stable work-item identity, trusted dependency contract, required
   completion criteria, and parent correlation. This must not make Capability Factory the
   planner or allow plan data to grant authority.
9. Define a product-owned aggregate outcome-verifier interface that can evaluate required
   child outcomes against trusted external state and return complete, partially complete,
   blocked, or unknown without relying on child execution success.
10. Emit stable child-run correlation (`parentGoalId`, `workItemId`, `groupId`) in shared
    audit metadata once the coordinator interface exists. Until then these fields remain
    explicitly sourced from the console's deterministic reference adapter.
