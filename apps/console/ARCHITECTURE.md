# ADR-001: one sanitized event path and authoritative command adapters

Status: accepted for the private local alpha.

## Decision

Both current product events and recorded sanitized traces enter a versioned
`ConsoleEvent` envelope. A sanitizer rejects unknown keys, secrets, raw authorization
material, unapproved prose, and payloads beyond the event-specific schema. Events are
inserted idempotently into a tenant-scoped append-only SQLite store. Deterministic read
projections feed the Fastify API and SSE stream. The browser receives projections only.

UI commands call controlled adapters. Capability status belongs to the product capability
store; policy authority belongs to the policy adapter; execution and outcome receipts
belong to their producers. The console records the resulting observable event and never
mutates projected run state. Alpha adapters are explicit local reference authorities,
designed to be replaced without changing the browser contract.

```
product core | sanitized recording
        ↓
ConsoleEvent v1 + strict sanitizer
        ↓
append-only tenant SQLite → deterministic projections → API/SSE → browser
        ↑
authoritative command adapter ← validated UI command
```

## Integrity rules

- `(tenantId, eventId)` is unique; duplicate delivery is a no-op.
- Every read includes a tenant predicate. Cross-tenant identifiers return not found.
- Recorded and live events share schemas and renderers; source metadata controls labels.
- Projection status is derived from event precedence, never accepted from browser input.
- A completion event requires a validated direct-outcome receipt and completed resumption.
- Replay fixtures carry a digest and are validated before ingestion.
- Secrets are represented only by configured alias names and availability booleans.
- Schema changes require a new `schemaVersion` and explicit migration/adapter.

## Additive goal-plan projection

Envelope version `1.0` now recognizes an additive set of strictly validated event types:
`goal.plan.proposed`, `goal.plan.validated`, `work-item.created`, `work-item.started`,
`work-item.completed`, `work-item.blocked`, and `goal.outcome.verified`. Their payloads are
flat, structured, event-specific, and reject unknown fields. This extends the event
vocabulary without changing the envelope or existing event meaning.

Stable IDs are derived from a versioned namespace plus tenant, parent goal, fixture entity,
and operation identity. Replaying the same accepted plan therefore produces idempotent
event insertion and the same work-item graph. Each work item carries a linked child run ID;
the parent projection reads only append-only events and never changes the child run.

Parent completion requires a separate aggregate receipt and still passes through the
existing completion guard: a passing outcome with zero incorrect side effects and
completed resumption. Capability-call success alone cannot complete the parent.

## Core interface requests

See `CORE_INTERFACE_REQUESTS.md`. Until those interfaces are stable, the console owns no
acquisition or safety semantics and integrates through versioned local adapters.
