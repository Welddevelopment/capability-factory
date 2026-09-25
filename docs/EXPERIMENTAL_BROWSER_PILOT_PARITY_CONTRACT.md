# Experimental browser pilot parity contract

Status: **private hardening contract; not a supported product claim**

## Objective

Bring the isolated `experimental-browser-actions` route materially closer to the engineering quality of the constrained-HTTP pilot MVP without pretending that the two modes have equal evidence.

Parity here means that the browser route uses the same high-level product disciplines:

- ordinary goal rather than a manually requested integration;
- trusted scope and authority outside model control;
- retained search before trusted discovery before minimum construction;
- separate pre-use capability verification and post-use outcome verification;
- reconciliation before retry;
- exact handoff and signed continuation;
- durable customer-local jobs and restart recovery;
- adapter preflight and precommitted acceptance;
- operator visibility and auditability; and
- an unchanged frozen campaign.

Parity does **not** mean the browser mode has the HTTP mode's breadth, transfer history, model evidence, customer readiness or commercial validation.

## Protected baseline

- Pre-browser HTTP checkpoint: `checkpoint/pre-real-browser-capability-2026-07-27`
- First confirmed real-browser checkpoint: `checkpoint/real-browser-capability-confirmed-2026-07-27`
- Hardening branch: `codex/browser-pilot-hardening`

The hardening branch may be abandoned without changing either confirmed checkpoint.

## Required engineering gates

### 1. Claim and mode boundary

- Browser remains a distinct mode with its own manifest, registry, executor, verifier and evidence.
- `constrained-http-api` remains the supported controlled-pilot MVP mode.
- No test may silently classify browser evidence as HTTP evidence or vice versa.

### 2. Constrained browser representation

- Locators are declarative and restricted to exact test IDs or accessibility semantics.
- Network access has exact origin, path, method, purpose and request-count limits.
- Session authentication is distinguished from a business write.
- A capability may contain at most one consequential business write.
- No arbitrary CSS, XPath, page JavaScript, shell, upload, download or unconstrained navigation exists.

### 3. Acquisition path

- Search the tenant registry first.
- Search one or more policy-approved trusted sources second.
- Construct only the unsupported residual from a trusted bounded UI contract third.
- A constructed capability must pass the same pre-use verification as a catalog capability.
- The ordinary goal and secret values must not be copied into the builder input.

### 4. Broad-goal coordination

- One ordinary goal can compile into several bounded work items.
- Every item is tied to trusted coverage, entities, systems, authority and completion criteria.
- Ordering is conservative and explicit.
- The parent resumes only after every required item has independently verified completion.

### 5. Authority, credential and stop controls

- Customer scope controls targets, credential aliases and approved actions.
- Missing authority stops before a business write.
- A customer-local halt stops before a browser opens.
- Secrets resolve only at the final browser boundary and never persist in plans, events, reports or registries.
- A signed continuation is bound to the exact saved plan, work item, handoff and state version.

### 6. Recovery

- Every business action has a stable operation key.
- External state is reconciled before execution and before any possible retry.
- Completed state resumes without repeating credentials, approval or the action.
- Partial, incorrect, unknown or policy-violating state blocks blind retry and quarantines the capability.
- Automatic compensation is not implied.

### 7. Experimental adapter kit

- A versioned descriptor declares targets, UI-contract hashes, operations, credentials, verifiers and acceptance cases.
- Preflight rejects missing coverage, unsafe request purposes, secret literals, inconsistent hashes and unbounded writes.
- The executable acceptance harness covers ten precommitted cases and aborts on a surviving incorrect side effect.

### 8. Durable installation shapes

- The same trusted core is callable through an embedded SDK and authenticated customer-hosted sidecar.
- Browser jobs survive sidecar restart and preserve stable identity and append-only status history.
- Duplicate parent submissions are idempotent; conflicting reuse is rejected.
- Retry is bounded and allowed only when reconciliation makes it safe.

### 9. Operator surface

- Real browser runs project sanitized plans, work items, acquisition paths, capability verification, execution, outcome verification, handoffs and parent completion into the private console.
- The console cannot grant authority merely by acknowledging an alert.
- Credential values and raw page contents are not projected.

### 10. Transfer evidence

- The same driver and control loop must operate at least two materially different disposable UI contracts.
- At least one should be a pinned third-party application rather than a custom test portal if its interface can be constrained without weakening the driver.
- Transfer must preserve direct external verification and zero surviving incorrect side effects.

### 11. Reliability evidence

- Fixed deterministic fault cases cover network loss, duplicate submission, stale UI, denied authority, credential loss, session-auth failure, policy escape and wrong/partial outcomes.
- Multi-tenant isolation, restart recovery and bounded-volume behavior receive separate checks.
- Earlier failures remain in chronology.

### 12. Frozen confirmation

- The candidate begins from a clean committed worktree.
- Relevant tracked files are hashed before and after.
- Type checking, ordinary HTTP regressions, genuine HTTP-system tests, browser adapter acceptance, durable browser sidecar, console projection, transfer and reliability stages pass under one unchanged commit.
- Model calls and API spend are recorded separately.

## Acceptance-case minimum

The browser adapter must execute these cases in fixed order:

1. read-only happy path;
2. approved business write;
3. fresh-process retained reuse;
4. missing credential;
5. missing permission or approval;
6. lost-response reconciliation;
7. wrong or partial external outcome;
8. sidecar restart;
9. duplicate submission; and
10. conflicting parent reuse.

Additional driver-level cases do not replace these product-level cases.

## Public and application boundary

Until the frozen gate passes, the only defensible browser statement remains the first checkpoint's narrow local result.

Even after all gates pass, the strongest possible wording is still bounded:

> We built a separate experimental browser capability route that applies the same authority, verification, recovery, resumption and retention disciplines as the constrained-HTTP MVP in disposable local environments.

Do not describe it as supported browser automation, autonomous arbitrary-site operation, a customer deployment, production readiness, a security certification or a formal final green verdict.
