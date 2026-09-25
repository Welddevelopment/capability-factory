# Effective-universality durable composition checkpoint — 2026-08-05

## Why this checkpoint exists

The first composition implementation could safely execute a trusted bounded
multi-capability graph, but it lived inside one request. A process interruption
could therefore lose the parent execution context even when individual
capability drivers had durable safeguards. This checkpoint makes the parent
composition itself a customer-local durable job.

## Implemented behavior

- A SQLite-backed job store persists the exact ordinary-goal submission,
  selected trusted composition, complete bounded plan, aggregate verifier
  identity and their hashes before execution.
- The parent goal is the idempotency boundary. An exact duplicate returns the
  existing job without another planner/preparer call. A changed request under
  the same parent identity is rejected.
- A worker claims one queued job, increments its bounded attempt counter and
  executes the persisted plan through the existing composition coordinator.
- Interrupted `running` jobs are either requeued or moved to
  `unresolved-safe` at the configured recovery ceiling.
- Recovery never asks a model to reinterpret or rebuild the plan. It validates
  the stored plan digest and resolves the stored verifier identity against the
  current trusted registry before any leaf can run.
- Missing or changed verifier identity, corrupted plan state and execution
  errors fail closed as `unresolved-safe`; they cannot become parent
  completion.
- Job and append-only event queries are tenant-scoped.
- The authenticated customer-local sidecar exposes submit, lookup and event
  endpoints. The TypeScript client exposes start, lookup, event and bounded
  polling methods.

## Focused failure checks

Seven focused tests cover:

1. normal persistence and completion;
2. exact duplicate idempotency without repeated preparation;
3. conflicting request rejection;
4. interrupted-process recovery without replanning;
5. fail-closed verifier-registry drift;
6. bounded recovery ceiling and tenant isolation;
7. corrupted stored-plan refusal plus authenticated sidecar/event behavior.

## Regression result

- strict TypeScript compilation: passed;
- full repository suite: **72 files passed, 11 skipped; 366 tests passed, 59
  skipped**.

Skipped tests retain their existing environment or opt-in boundaries and are
not counted as passes.

## Evidence boundary

This is local product-foundation evidence. It does not prove production crash
recovery, distributed coordination, arbitrary multi-system workflows,
customer deployment, general reliability or effective universality. The
composition preparer still selects from trusted predeclared graphs, and the
experimental runtime families retain separate evidence and maturity labels.
Only the constrained-HTTP mode retains the existing working-local-pilot-MVP
description.

No model call, paid API, external account, customer system, public deployment
or public claim was used or changed in this checkpoint.
