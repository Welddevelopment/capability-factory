# Real-browser capability confirmation

Date: 2026-07-27  
Candidate commit: `67d59cfc15508bd40da5d6cb1ed816264fcf9ad8`  
Branch: `codex/real-browser-capability`  
Result: **passed private local confirmation**

## Plain-English result

Capability Factory now has a second, deliberately separate experimental way to act. In addition to the supported constrained-HTTP MVP, it can use one previously reviewed browser capability to operate real Chromium against a fictional local web portal.

The browser route searches for a retained capability before a trusted source, verifies the controls in a read-only browser, checks real external state before acting, requires the exact customer-local approval and credential, performs at most one allowed write, verifies the database directly, resumes the original parent goal only after that independent check, and retains the capability for a fresh process.

This is a meaningful architectural expansion past direct HTTP APIs. It is not general browser automation: the system did not generate the workflow, did not use an arbitrary public website and did not run against a customer.

## Frozen candidate integrity

The confirmation controller began from a clean committed worktree and recorded:

- 165 tracked product, console and test files hashed before the run;
- the same Git commit before and after;
- no changed tracked hashes;
- a clean worktree after the run;
- zero model calls; and
- USD 0 paid API spend.

The successful run ID was `real-browser-confirmation-2026-07-27T11-33-58-580Z-1ae82ea8`. Raw logs and hashes remain in the ignored private artifact directory.

## Confirmation stages

1. Strict TypeScript checking passed.
2. Console JavaScript syntax validation passed.
3. The ordinary suite passed 197/197 active tests across 32 files; 38 explicitly opt-in tests remained skipped in that stage.
4. The separately enabled genuine disposable ERPNext and Gitea suites passed 24/24 tests across five files.
5. The zero-model simulated HTTP pilot completed its entire lifecycle: install, partial authority handoff, restart, exact continuation, reconciliation, 7/7 completion, parent resumption, backup, upgrade and safe deactivation, with zero incorrect side effects and no persisted raw secret.
6. The real-browser campaign passed 14/14 cases using Playwright Chromium.

## What the browser campaign covered

The campaign confirmed:

- trusted capability acquisition on first use;
- retained-capability reuse through a fresh SDK and registry process;
- parent-goal resumption only after direct external-state completion;
- already-completed replay without a duplicate write, current credential or repeated approval;
- no action when exact approval is absent;
- no action when the customer-local credential is absent;
- no browser opening when the customer-local kill switch is active;
- lost browser response reconciled from direct state without a second click;
- partial external state quarantined with parent resumption blocked;
- incorrect external state quarantined with parent resumption blocked;
- automatic reacquisition refused after quarantine;
- UI-contract drift failing closed;
- popup/new-page attempts failing closed;
- download attempts failing closed;
- redirect escape attempts failing closed;
- POST/write attempts during read-only capability verification failing closed;
- duplicate network write attempts failing closed even when the first business write completed;
- credential echo into observable page output failing closed; and
- absence of the raw credential from the experiment's persisted files.

Several related cases are parameterized inside the 14 test definitions, so the list of checked behaviours is longer than the top-level test count.

## Preserved development finding

An earlier development campaign exposed a real safety bug: if a page completed the intended database write and also opened a forbidden popup, the direct outcome verifier saw the intended result and the driver initially returned completion. The rule was corrected so a browser-policy violation can never be erased by a correct business side effect. The popup, download, redirect, duplicate-write and credential-echo cases now all fail closed, quarantine where appropriate and keep the parent goal blocked.

Two clean-commit controller attempts also stopped for environment-only reasons before the browser stage: the first used a Docker config without the Colima socket, and the second used a Docker config without the pinned Compose plugin. No product change followed. The successful unchanged run combined the repository's pinned Compose configuration with the existing healthy Colima socket.

## Safety and causal order

The confirmed order is:

1. validate the static capability and exact target contract;
2. verify the browser controls in a fresh read-only Chromium context;
3. independently reconcile the external operation key;
4. if already complete, resume without current authority or another browser action;
5. otherwise require current credential, approval and operational authority;
6. resolve the credential only at the customer-local browser boundary;
7. execute the bounded declarative flow under exact network and UI limits;
8. independently verify database state;
9. resume and retain only on `complete`; or
10. quarantine, report and hand off on a policy violation, partial, incorrect or unknown result.

## Exact evidence boundary

This confirmation supports:

> A separately constrained experimental browser driver can use a trusted retained browser capability to operate real Chromium against a disposable local portal, reconcile before acting, use exact customer-local authority, verify database state independently, resume the original goal and reuse the capability in a fresh process.

It does not support:

- including browser operation in the supported controlled-pilot MVP;
- autonomous generation of browser workflows;
- arbitrary website support;
- customer-system or real-world browser validation;
- reliability across UI frameworks, authentication, MFA or anti-bot systems;
- uploads, downloads, multi-page flows or automatic compensation;
- production readiness, formal security certification or commercial demand; or
- a formal final green verdict.

The supported pilot mode remains `constrained-http-api`. A real customer browser workflow would need its own reviewed adapter, authority model, direct verifier, acceptance campaign and activation approval.

## Recovery points

- Pre-browser HTTP MVP: `checkpoint/pre-real-browser-capability-2026-07-27`
- Browser candidate commit: `67d59cfc15508bd40da5d6cb1ed816264fcf9ad8`
- Confirmed browser checkpoint: `checkpoint/real-browser-capability-confirmed-2026-07-27`
