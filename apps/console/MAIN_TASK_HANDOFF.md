# Capability Factory Console — handoff to the main technical task

Date: 2026-07-27

## Start condition — do not interrupt the current task

Do **not** begin this handoff while the main technical task is still working on its current
objective. Finish that objective first, report its result to Joel, and wait until Joel
explicitly confirms that he is happy for the main task to move on to the Console.

Only after both conditions are true should the main task adopt, run, inspect, or integrate
this work:

1. the current main-task objective is genuinely complete; and
2. Joel explicitly confirms that the main task should now proceed with the Console.

This handoff is queued work, not permission to interrupt, replace, or silently broaden the
main task's current objective.

## Objective

Adopt and finish verification of the Capability Factory Console as a real private-alpha
product surface. It is an operator console and developer integration tool, not a public
website, end-user chat application, production system, or evidence claim.

The implementation is located at:

`apps/console/`

It was deliberately isolated from the still-changing shared product core through a
versioned console-local adapter. Do not move console data into a second source of truth and
do not redefine acquisition, execution, recovery, authority, or verification semantics.

## Required reads before acting

Read these files completely:

1. Repository `AGENTS.md`.
2. `apps/console/PRODUCT_UX_SPEC.md`.
3. `apps/console/ARCHITECTURE.md`.
4. `apps/console/CORE_INTERFACE_REQUESTS.md`.
5. `apps/console/shared/contracts.ts`.
6. Everything under `apps/console/server/`, `apps/console/frontend/`, and
   `apps/console/test/`.
7. The current versions of shared-core files and recovery/incident contracts changed by
   the main task since this handoff was written.

For visual work, load and follow the installed `gpt-taste` skill, while preserving the
brief's precedence: this must remain a dense operational product interface, not become an
AIDA marketing page.

## What is implemented

### Product and architecture

- Three operator personas and exact journeys.
- Route map, screen acceptance criteria, and safe-command inventory.
- Architecture decision record for one sanitized live/replay event path.
- Explicit requests for shared-core interfaces that were intentionally not invented in
  the console.

### Console event path

- Versioned `ConsoleEvent` v1 envelope containing:
  - `eventId`;
  - `schemaVersion`;
  - `tenantId`;
  - `runId`;
  - `requestId`;
  - event type;
  - `occurredAt`;
  - sanitized payload; and
  - sensitivity classification and source metadata.
- Strict sanitization boundary rejecting secret-shaped keys and values.
- Bounded approved strings and alias-only arrays.
- Digest validation for the recorded fixture.
- Idempotent `(tenantId, eventId)` insertion.
- Tenant-scoped append-only SQLite persistence.
- Deterministic run, handoff, and capability projections.
- Completion projection requires all three facts:
  - a completion claim;
  - a passing independent outcome with zero incorrect side effects; and
  - completed resumption.

### API and live updates

- Fastify API.
- Server-Sent Events stream.
- Runs list and deep Run Inspector.
- Recorded and live paths rendered through the same API and UI.
- Recorded replay is clearly labelled and cannot masquerade as live.
- Deterministic Agent Playground path requiring no paid model call.
- Complete deterministic journey and zero-write permission-handoff journey.

### Operator surfaces

- `/runs` and `/runs/:runId`.
- `/handoffs`.
- `/capabilities`.
- `/environments`.
- `/policies`.
- `/playground`.

### Safe commands

- Acknowledge a handoff without rewriting the stopped run.
- Quarantine and revoke through the local capability authority adapter with optimistic
  version checks.
- Create, validate, acceptance-test, and activate narrow versioned policies.
- Activation is rejected unless the unchanged policy version passed acceptance testing.
- Run an environment acceptance test.
- Start a deterministic simulator run.

There is no manifest editor, manual outcome override, direct run-status mutation, blind
retry of ambiguous writes, or quarantine restoration without reverification.

### Interface direction

- Dense, calm evidence hierarchy.
- Persistent navigation grouped by operator job.
- Run list and causal evidence rail.
- Explicit status text plus accessible colors.
- Keyboard focus states, reduced-motion handling, loading/error/reconnect/empty states.
- Desktop, small-laptop, and mobile responsive rules are implemented in CSS.
- No fake charts, vanity metrics, customer logos, fabricated use, decorative AI imagery,
  or marketing-page structure.

## Truthful fixture and claim boundary

The included recorded fixture is a rigorously scoped sanitized local reference derived
from the current product schemas. It is labelled:

> Recorded run

and:

> Constrained local run · fictional data · genuine disposable ERPNext installation

It must not be presented as live, customer evidence, production reliability, a generality
result, or a formal green verdict. Do not add exact private evaluation counts or paid-run
metrics without Joel's separate evidence approval.

## Checks already completed

The following checks passed in the delegated console task:

- Strict TypeScript checking of console server/shared files.
- Eight console tests across three files:
  - sanitization and secret-shaped-data rejection;
  - replay digest manipulation detection;
  - duplicate event delivery;
  - cross-tenant store separation;
  - forged-completion projection containment;
  - recorded/live shared rendering path;
  - permission handoff before execution; and
  - rejection of untested policy activation.
- Frontend JavaScript syntax check.
- `git diff --check`.

The delegated task could not run the normal repository commands because dependency
installation and localhost startup were rejected by that task's safety reviewer. A
temporary verification configuration used the already-installed dependencies in the
primary checkout; do not treat that as a substitute for the normal checks below.

## First actions after Joel authorizes the transition

From the actual current Capability Factory working tree:

```sh
pnpm install
pnpm console:test
pnpm typecheck
pnpm console:dev
```

The console defaults to:

`http://127.0.0.1:4317/runs`

Environment variables:

- `CF_CONSOLE_PORT` — local port, default `4317`.
- `CF_CONSOLE_DB` — SQLite event-store path, default
  `apps/console/.data/console.sqlite`.

Do not run ERPNext or paid models merely to validate the console. The initial browser pass
uses the included recorded fixture and deterministic playground path.

## Mandatory browser verification

Use the in-app Browser workflow. Inspect every implemented route at both widths:

- small laptop: approximately `1366 × 768`;
- mobile: approximately `390 × 844`.

At minimum verify:

1. `/runs`
   - recorded label is unmistakable;
   - the complete causal chain is readable;
   - scope language remains visible;
   - filtering and run selection work;
   - the inspector does not overflow.
2. `/handoffs`
   - empty state works before a handoff;
   - create a permission-handoff Playground run;
   - reason, missing authority, zero-write language, and acknowledgement render correctly;
   - acknowledging does not change the original run.
3. `/capabilities`
   - filters work;
   - verification receipt and action summary are readable;
   - quarantine/revoke confirmation and stale-version behavior work;
   - no manifest-edit affordance exists.
4. `/environments`
   - aliases and availability are visible without secret values;
   - acceptance-test command updates the authoritative adapter result;
   - setup information is understandable.
5. `/policies`
   - create a read-only draft;
   - validate, test, then activate it;
   - verify activation is impossible before testing;
   - confirm the prior active version is preserved as superseded.
6. `/playground`
   - simulator explanation uses the intended wording;
   - the input label is “Ordinary goal given to the simulated customer agent”;
   - action is “Run through agent simulator”;
   - completion opens in the same Run Inspector;
   - permission scenario performs no execution event.
7. Event stream and resilience
   - connection status is understandable;
   - refresh/restart reproduces persisted projections;
   - browser reconnection does not duplicate events;
   - empty, error, and loading states remain usable.

Inspect browser console errors and failed network requests. Fix every material visual,
responsive, accessibility, or interaction defect before reporting completion.

## Shared-core synchronization

The main technical task has been changing execution-recovery and incident contracts. After
the standalone console passes browser verification:

1. Compare the latest shared-core event and receipt shapes with
   `CORE_INTERFACE_REQUESTS.md`.
2. Add a versioned adapter from current product events into `ConsoleEvent`; do not import
   console types into the core merely for convenience.
3. Map only truthful facts. Adapter-level events may represent missing higher-level stages
   only when their source is identifiable as `console-adapter`.
4. Preserve runtime, outcome-verifier, capability-store, and policy-store ownership.
5. Add contract tests for every newly mapped core event.
6. Do not change core acquisition or safety semantics just to make the UI simpler.

If a stable core interface is still missing, update `CORE_INTERFACE_REQUESTS.md` with the
exact type and behavioral need and continue with independent console work.

## ERPNext integration — later coordinated phase

Do not start or reconfigure ERPNext, run paid models, or create a new evidence campaign as
part of the initial console verification.

When Joel separately approves synchronized ERPNext integration:

- ingest a frozen, reviewed, sanitized run through the same `ConsoleEvent` renderer;
- prepare before/after external evidence and safe local record links;
- never send raw credentials, secret values, unapproved customer prose, or opaque model
  content to the browser;
- preserve the exact constrained-local scope label; and
- keep replay visibly recorded.

## Additional security/integrity coverage to add

The current suite establishes the vertical slice, not the complete Stage 12 campaign. Add
tests for:

- stale policy versions after an intervening draft change;
- revoked capability reuse rejection through the authoritative adapter;
- partial SSE streams and reconnect cursors;
- restart/reprojection using a file-backed test database;
- unsupported handoff resolution types;
- approval resolution creating a linked continuation;
- capability status divergence between projection history and authority adapter;
- forged or out-of-order completion events at ingestion boundaries;
- browser responses containing prohibited keys or secret-shaped values; and
- tenant-scoped command authorization once real authentication exists.

## Known alpha limitations

- The authority adapters are explicit in-process local references, not production stores.
- There is no real authentication or RBAC UI.
- SSE has no production transport authentication or durable distributed cursor.
- Policy storage is in-memory in the reference adapter.
- Environment health is a local reference, not a managed fleet health service.
- Handoff acknowledgement is implemented; full typed resolution and linked continuation
  creation still need coordinated core support.
- Capability reverification is intentionally absent until a genuine authoritative command
  exists.
- The deterministic Playground validates integration flow, not model performance.

## Repository discipline

- Preserve unrelated dirty changes; substantial product-reference work was already
  uncommitted when the console task began.
- Do not stage, commit, push, publish, deploy, or create external accounts unless Joel
  explicitly asks.
- Do not modify the public website repository.
- Do not start the historical evaluation harness or alter frozen evidence.
- Do not run paid model calls.
- Do not expose exact private evidence counts through the UI.

## Completion report to Joel

When this handoff is complete, report:

- routes inspected and viewport sizes;
- defects found and fixes made;
- final typecheck and test results;
- whether normal localhost launch works from the repository scripts;
- which shared-core events are genuinely integrated versus adapter-derived;
- remaining core interface requests and alpha limitations; and
- confirmation that no ERPNext, paid model, publishing, deployment, commit, or push action
  occurred without separate authorization.
