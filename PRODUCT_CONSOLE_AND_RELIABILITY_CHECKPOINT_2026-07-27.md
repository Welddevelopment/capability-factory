# Product console and reliability checkpoint — 2026-07-27

Status: **private local development checkpoint — not a public evidence claim**

## Implemented

- The product SDK inspects independent external state after execution errors instead of
  retrying blindly.
- It classifies the external state as completed, not started, partial, incorrect, or
  unknown; quarantines failed or ambiguous capabilities; blocks automatic retry; and
  emits a redacted incident with the required recovery class.
- A completed external outcome after a lost execution response may continue only through
  an explicit verified-state resumption hook that cannot repeat the write.
- The product does not yet perform automatic compensating actions. Reversal remains a
  separately defined, verified, and authorized capability.
- An audit-oriented reliability campaign controller now enforces passing deterministic
  preflight, immutable R1–R8 definitions, source hashing, spend checks before calls,
  immutable per-case results, redaction, and fail-closed finalization.
- The real zero-cost dry run passed and froze eight cases plus 26 protocol/source/test
  hashes. Paid mode remains intentionally locked until all eight execution adapters are
  wired.
- The private console is implemented under `apps/console/` with Runs, Handoffs,
  Capabilities, Environments, Policies, and Agent Playground routes.
- It uses a versioned sanitized event envelope, tenant-scoped append-only SQLite history,
  deterministic projections, SSE updates, and authority command adapters. Replay and live
  paths use the same renderer.
- The Playground clearly says it is an integration simulator, not the normal end-user
  interface. It can show a verified deterministic completion, a zero-write permission
  handoff, or a partial-outcome incident with quarantine and blocked retry.

## Verification

- Strict TypeScript: passed.
- Ordinary combined suite: 110 passed; 13 opt-in real-ERPNext tests skipped as designed.
- Genuine disposable ERPNext suite: 13/13 passed separately after the local stack was
  restarted.
- Console-specific suite: 10/10 passed.
- Zero-cost reliability dry run: passed; paid calls 0.
- Browser inspection: all six routes checked at desktop and 390 × 844 mobile widths with
  no horizontal overflow; completion, permission handoff, acknowledgement, and partial
  outcome incident flows were exercised; no browser warnings or errors remained.
- A browser-found replay duplication bug was fixed by assigning stable event IDs. The
  recorded run remained at 12 events across a real second console restart.

## Boundaries

- No formal final green verdict.
- No production-readiness, customer, traction, general reliability, cross-system, or
  universal capability-acquisition claim.
- The console is a private alpha local reference. Its current authority and environment
  adapters are not production backends.
- The partial-outcome Playground path is a deterministic recovery fixture, not a real
  customer incident.
- No new paid model call was made in this checkpoint.

## Next technical steps

1. Wire the eight paid campaign case adapters into the frozen controller without changing
   their preregistered expected outcomes.
2. Add direct sanitized mapping from stable shared-core run and incident envelopes into
   `ConsoleEvent` rather than relying on console-local deterministic adapters.
3. Re-run deterministic preflight and create a new final freeze after that wiring changes
   the currently hashed source.
4. Only then run the bounded paid R1–R8 campaign under the USD 5 additional ceiling.
5. Add a second genuinely different application/system only after the current campaign
   and interface boundary are stable; do not call same-application procurement proof
   cross-system transfer.
