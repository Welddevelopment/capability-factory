# Experimental real-browser capability

Status: **private, local second-mode experiment**

This document describes a deliberately isolated browser capability driver. It does not widen the supported `constrained-http-api` MVP, and it does not establish general browser automation.

## Why this mode exists

The constrained HTTP mode can act only where a documented HTTP API is available and approved. Some real workflows expose the required action only through a web interface. The browser experiment asks a narrower question:

> Can the existing Capability Factory control loop safely operate one previously reviewed browser capability, verify the result outside the browser, resume the original goal, and retain that capability for reuse?

The answer is tested with real headless Chromium against a disposable localhost portal. The experiment uses no model and does not generate arbitrary browser workflows.

## Boundary

The mode identifier is `experimental-browser-actions`. It is separate from `constrained-http-api` in its manifest, registry, executor, verifier and tests.

The current browser manifest can describe only:

- one exact localhost navigation;
- bounded text assertions and reads;
- fills into named `data-testid` controls;
- customer-local secret fills by alias;
- read-only clicks; and
- at most one consequential click with one exact approval key.

Only bounded observations may follow the consequential click. The manifest cannot contain CSS selectors, XPath, JavaScript, shell commands, uploads, downloads, arbitrary origins, arbitrary URL parameters, multiple writes or credential values.

## End-to-end order

1. Receive an ordinary parent goal and identify the exact browser need.
2. Search the tenant's separate browser-capability registry for an active capability with the same need and UI-contract hash.
3. If no retained capability exists, search one trusted reviewed source. There is no generated-browser fallback in this experiment.
4. Validate the manifest against the target's exact paths, request methods, request ceilings and test IDs.
5. Open a fresh read-only Chromium context and verify that every required control exists and has the expected control type. POST requests are blocked during this gate.
6. Store the passing verification receipt with the manifest digest, UI-contract hash and driver version.
7. Before requesting current credentials or approval, read external state through the independent verifier.
8. If the operation is already complete, resume without opening an execution browser or repeating the write.
9. If the operation is cleanly not started, require the exact approval, required local secret aliases and customer-local operational authorization.
10. Resolve secret values only at the final browser boundary and open a fresh execution context.
11. Execute the bounded declarative steps. The network guard enforces exact origin, path, method and maximum-request counts.
12. Read the resulting SQLite state directly, outside Chromium. Browser text is not accepted as completion proof.
13. Resume the original parent goal only if the independent verifier returns `complete`.
14. Retain the verified capability for a later fresh process.
15. On partial, incorrect, unknown or policy-violating outcomes, block blind retry, quarantine the capability, record an incident and keep the parent goal blocked.

## Three different checks

### 1. Manifest and target validation

This proves that the proposed capability fits the static safety envelope. It checks the number and order of actions, unique output names, target allowlists, and the rule that only observations may follow a write.

### 2. Read-only capability verification

This launches real Chromium but forbids non-GET requests. It checks that the named controls exist, are unique and visible, and are editable or clickable where required. It deliberately does not perform the consequential action.

### 3. Independent outcome verification

After execution, a separate verifier reads the portal database directly. It classifies the operation as `complete`, `not-started`, `partial`, `incorrect` or `unknown`. The original goal resumes only after `complete`.

These gates are intentionally separate. A valid manifest does not prove that the UI still fits, and a successful browser click does not prove the business outcome.

## Browser containment

Each verification or execution opens a fresh Playwright Chromium browser and context with:

- no granted browser permissions;
- downloads disabled;
- service workers blocked;
- a fixed locale, timezone and viewport;
- exact localhost-origin enforcement;
- exact path and HTTP-method policies;
- per-request session ceilings;
- WebSockets blocked;
- popups and new pages blocked;
- downloads, file choosers and dialogs blocked;
- query strings and hashes rejected; and
- final redirect destinations checked again.

Controls are located only by exact `data-testid`. The driver requires exactly one visible match. There is no general DOM query or page-script interface.

## Credentials, permission and operational authority

The manifest stores only a secret alias. The actual value remains in a customer-local secret provider and is resolved only immediately before the execution browser uses it. Values are cleared from the in-memory resolution map after the session, are rejected if echoed into an observable output, and are scanned for absence from the experiment's persisted files.

Three different blockers remain distinct:

- **Capability missing:** no active retained capability and no matching trusted capability.
- **Credential or approval missing:** the capability exists, but the system lacks the authority needed for the action.
- **Operational stop:** the customer-local runtime is draining, halted, over budget, quarantined or revoked.

A customer halt is checked before even the read-only verification browser opens. A completed-operation reconciliation happens before current credentials or approval are requested, because no new action is required in that branch.

## Recovery and non-duplication

The operation key is stable. The direct verifier always checks it before action.

- If the state is already complete, execution returns success without a click.
- If the browser loses its response after the write but the direct verifier proves completion, the run completes without retry.
- If the state is partial, incorrect or unknown, the capability is quarantined and automatic retry is blocked.
- If the page performs an allowed business write while also violating the browser policy, the policy violation still blocks and quarantines the capability. A correct side effect cannot erase a containment failure.

Automatic compensation or reversal is not implemented.

## Disposable development world

`src/customer-world/browser-portal.ts` provides a fictional dealer-restock portal backed by SQLite. The ordinary goal creates one approved restock request and then resumes the parent inventory goal.

The portal includes controlled failure modes for:

- response loss after a completed write;
- partial and incorrect external outcomes;
- UI-contract drift;
- popup, download and redirect escape attempts;
- a write attempted during verification;
- duplicate network writes; and
- credential echo into visible output.

The independent verifier never reads the browser's success message. It queries SQLite and checks the exact operation key, reference, quantity, row count and aggregate state.

## Local commands

```bash
pnpm typecheck
pnpm exec vitest run test/experimental-browser-driver.test.ts
pnpm product:browser:test
pnpm product:browser:confirm
```

`product:browser:test` launches real Chromium. `product:browser:confirm` requires a clean committed worktree and reruns type checking, console syntax, the ordinary regression suite, genuine disposable HTTP-system suites, the simulated HTTP pilot and the real-browser campaign under one unchanged commit. It writes private ignored artifacts.

## What current evidence can support

Private local evidence may support this statement after an unchanged clean-worktree confirmation:

> Capability Factory has a separately constrained experimental browser driver. A trusted retained browser capability can operate real Chromium against a disposable local portal, reconcile before acting, use exact customer-local authority, verify database state independently, resume the original goal and be reused in a fresh process.

It cannot support any of these statements:

- browser operation is part of the supported controlled-pilot MVP;
- the system generates browser workflows;
- it can use arbitrary websites;
- it works across customer interfaces;
- it reliably handles login, MFA, anti-bot systems, uploads, downloads or multi-page flows;
- it is production-ready or security-certified; or
- browser support has a formal green verdict.

## Decision preserved for future work

This experiment validates the architectural shape, not the commercial priority. A real browser pilot driver should be selected only when a customer supplies a representative safe workflow. It should then receive its own adapter contract, permissions, verifier, acceptance campaign and activation gate rather than inheriting confidence from this fictional portal.
