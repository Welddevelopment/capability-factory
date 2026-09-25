# Controlled-pilot hardening and isolated browser experiment

Date: 2026-07-27
Status: private local development checkpoint

## Plain-English result

The constrained HTTP product now has the main customer-independent mechanics needed for a controlled pilot rehearsal:

- a stopped goal can continue after the customer supplies an exact, signed permission grant;
- the grant survives a sidecar restart and cannot replace or broaden the saved plan;
- secrets can stay inside the customer environment and are resolved only at final execution;
- install, backup, migration, rollback, deactivation and archive-before-delete uninstall have machine-tested reference implementations;
- a customer-local kill switch, conservative usage limits, capability quarantine, incident records and tamper-evident audit export exist;
- one joined fictional pilot rehearsal passed from install through handoff, restart, continuation, verification, backup, upgrade and shutdown; and
- a separate experimental browser-driver contract exists without widening the supported HTTP runtime.

This materially strengthens the local MVP. It does not remove the need for a named customer workflow, customer-approved sandbox, customer-specific adapter, customer authority, or a real controlled pilot.

## 1. Resumable authority handoffs

Implemented in:

- `src/product/continuation.ts`
- `src/product/goal-scheduler.ts`
- `src/product/broad-goal-sdk.ts`
- `src/product/sidecar-jobs.ts`
- `src/product/sidecar.ts`
- `src/product/client.ts`

A continuation grant is bound to the tenant, parent goal, work item, immutable plan digest, exact handoff digest and exact saved-state version. It names the complete missing-authority set, records customer-local preconditions, expires, and is signed by a separate customer-local continuation authority. The ordinary sidecar token is not the signing key.

The scheduler authenticates the signature even on an idempotent replay. It then reopens only the blocked item, clears the stale terminal summary, reconciles external state before any possible write, preserves the saved plan, re-verifies every item and resumes the parent only when the aggregate outcome is clean.

## 2. Customer-local secrets

Implemented in `src/product/secrets.ts` and integrated into `src/runtime.ts`.

The runtime now supports scoped local providers backed by:

- customer process environment variables;
- mode-0600 regular files in an approved local directory; and
- a rotation-capable in-memory reference provider.

Each alias is restricted to explicit target, action and HTTP-method scope. Values are resolved after operational policy checks and immediately before the outgoing request. The existing inline secret map remains only for historical fixtures. A new test exposed that a custom header called `x-procurement-key` bypassed the generic trace pattern; the runtime now masks the exact manifest-declared authentication header regardless of its name.

## 3. Installation lifecycle

Implemented in `src/product/installation.ts` and exposed through `pnpm pilot:lifecycle`.

The reference manager supports:

- fresh install and inspection;
- schema-v1 to schema-v2 metadata migration after preserving the original state;
- SHA-256-manifested backups and verification;
- upgrade with automatic restore on migration failure;
- deactivation and reactivation; and
- uninstall only after a final archive outside the installation root is written and verified.

The durable sidecar job database now migrates explicitly to SQLite `user_version = 2` and adds continuation storage without deleting existing jobs.

This is reference local packaging, not a signed installer, managed update service or production deployment system.

## 4. Operational controls

Implemented in `src/product/operations.ts` and connected to the trusted HTTP runtime.

The customer-local controller provides:

- `running`, `draining` and `halted` modes;
- a kill switch checked before a secret is resolved or request is sent;
- conservative per-run and hourly write-attempt ceilings;
- a daily model-spend authorization ceiling;
- capability active, quarantined and revoked states;
- redacted incidents;
- explicit backup checks; and
- a hash-chained audit export with verification.

`draining` allows reads but blocks new writes. `halted` blocks all capability actions. Unknown external outcomes generate an incident and do not authorize blind retry.

## 5. Joined simulated pilot

Implemented in `src/product/run-simulated-pilot.ts` and exposed through `pnpm pilot:simulate`.

The deterministic, zero-model fictional rehearsal passed the following sequence:

1. Created a customer-local sidecar installation.
2. Submitted one ordinary broad goal through the authenticated durable sidecar.
3. Validated one seven-item plan.
4. Completed six items and stopped one exact regulated item with zero write attempts.
5. Shut down the first sidecar process.
6. Started a fresh sidecar process against the same durable state.
7. Accepted a customer-signed continuation grant.
8. Reconciled before acting, completed the seventh item, independently verified the aggregate state and resumed the parent.
9. Rejected a conflicting request trying to reuse the same parent goal ID.
10. Confirmed four correct fictional restocks and zero incorrect side effects.
11. Verified that the planner ran once and the saved plan was reused.
12. Verified that the raw local API secret did not enter persisted pilot artifacts.
13. Exported a valid audit chain, made and verified a backup, upgraded the installation and deactivated it.

This is a synthetic local rehearsal. It is not held-out customer evidence and does not establish production reliability.

## 6. Isolated browser experiment

Implemented in `src/experimental/browser-driver.ts`.

The experiment has its own manifest and driver. It is not added to `SupportedCapabilityMode`, which remains `constrained-http-api`. The experimental driver permits only:

- disposable localhost origins;
- exact allowlisted paths;
- named `data`/test-ID style targets rather than arbitrary CSS;
- declarative navigate, assert, read, fill and click steps;
- no generated JavaScript or arbitrary code;
- at most one consequential click;
- an exact write approval;
- independent reconciliation before opening the session; and
- independent external outcome verification after the click.

A lost browser response that is independently proven complete returns success without clicking again. A partial, incorrect or unknown result quarantines the capability and blocks blind retry.

The tests use a deterministic browser-session adapter because no local Chromium runtime was available. Therefore this proves the driver contract and safety flow, not a real browser engine or browser-based customer capability.

## Verification

The final ordinary regression command is:

```bash
pnpm test
```

The final post-documentation full run passed 194 tests across 32 files; 23 tests in five opt-in real-system files were skipped by the ordinary command. Strict TypeScript checking also passed. The signed-continuation targeted regression passed 9/9 before the full run.

No model calls were made and no API spend was incurred for this workstream.

## Evidence boundary and remaining work

Safe private statement now:

> In a fictional local controlled-pilot rehearsal, the current constrained HTTP product completed a broad goal across a durable sidecar restart and a cryptographically signed customer-authority handoff, with independent final-state verification, verified backup and safe shutdown.

Do not turn that into a customer, production, security-certification or general reliability claim.

Still required before activating a real customer pilot:

- a named customer and narrow workflow;
- an approved sandbox or synthetic replica;
- a customer-specific adapter and acceptance campaign;
- real least-privilege credentials and signing-key custody;
- an agreed operational/on-call, stopping, retention and deletion process;
- review of filesystem backup consistency for the customer's actual databases;
- production packaging, dependency provenance and update signing; and
- customer evidence that identifies whether HTTP, browser or another driver should be prioritized next.
