# Experimental browser discovery checkpoint — 2026-07-28

## Plain-English result

The browser experiment no longer requires a developer to describe every field and button in advance.

Inside a narrow customer-approved boundary, trusted local code can now open approved pages in read-only mode, identify their semantic controls, give a model only sanitized descriptions plus opaque control IDs, compile the returned plan back into trusted browser actions, verify the candidate without a business write, perform one specifically approved write, check the real external result independently, resume the original goal, and retain the capability for later reuse.

This is a meaningful improvement over the previous trusted-map browser candidate. It is not arbitrary web browsing. The customer still has to define the allowed local target, approved pages, ordinary inputs, credential aliases, exact write approval and independent verifier. Unknown authentication, human verification and boundary violations stop before business action.

## Frozen source candidate

- Branch: `codex/browser-discovery-hardening`
- Source commit: `6ca8b31ce77a28150b537eac87ea5870ac2a1974`
- Parent confirmed browser checkpoint: `74eee448cfdaa0de4eecc8f5f156931c9bd482f2`
- Capability mode remains experimental: `experimental-browser-actions`
- Supported pilot mode remains unchanged: `constrained-http-api`

## What was added

1. A versioned trusted discovery boundary defining:
   - approved localhost target and pages;
   - approved ordinary inputs and customer-local credential aliases;
   - one exact write approval;
   - a one-business-write ceiling;
   - an independent verifier key; and
   - the expected completion observation.
2. A trusted Playwright scanner that:
   - permits reads and separately approved session authentication during discovery;
   - blocks business writes, cross-origin traffic, unexpected requests, WebSockets, popups, downloads, uploads and dialogs;
   - extracts semantic controls without reading input values; and
   - produces stable control IDs and a hash of the observed UI contract.
3. Two bounded planners:
   - a conservative deterministic planner for fixed development checks; and
   - a model-backed planner that sees semantic descriptions and opaque control IDs, not raw selectors, credentials or live browser control.
4. A trusted compiler that rejects invented paths, invented controls, unapproved inputs or secrets, changed authority, controls used on the wrong page, and anything other than exactly one approved business write.
5. Drift handling:
   - a changed UI snapshot cannot silently reuse the old capability;
   - the old record is quarantined with a reason;
   - a newly discovered and independently verified version can supersede it; and
   - stable unchanged pages reuse the retained capability.
6. Authentication handling:
   - trusted customer-local form login can establish a session;
   - rejected credentials and expired sessions return a precise handoff with zero business writes;
   - MFA, CAPTCHA, security-key, SSO and unknown-auth signals stop before planning or execution.
7. Bounded multi-page workflows: the test portal uses three approved pages before one final write.
8. A genuine disposable Gitea transfer: trusted code handles the login boundary; the issue form itself is discovered; the created issue is checked through Gitea's API rather than trusting the page.

## Exact verification performed

### Ordinary regression suite

The exact committed candidate passed:

- strict TypeScript type checking;
- 34 active test files;
- 203/203 active ordinary tests;
- 55 opt-in tests skipped by their normal environment gates.

The new work did not regress the existing constrained-HTTP product core, broad-goal scheduler, SDK, durable sidecar, console, adapter kit, signed continuation, recovery, secrets, operational controls or historical evaluation infrastructure.

### Real-browser campaign

Six real-browser files passed 31/31 cases against the exact committed candidate. This combines:

- the earlier trusted browser capability;
- broad-goal browser execution;
- browser adapter acceptance;
- genuine Gitea trusted-map transfer;
- the new read-only discovery, multi-page construction, drift replacement and handoff cases; and
- the new genuine Gitea discovery transfer.

The discovery-specific portal and compiler subset passed 7/7. It covered build, direct verification, parent resumption, retained reuse, repairable UI drift, versioned replacement, MFA handoff, attempted write during discovery, invented paths, invented controls, changed authority, zero-write plans and tampered snapshots.

The genuine Gitea discovery test also deliberately replaced the correct password with a wrong value. The run stopped on the approved login page, returned an authentication handoff, created no matching issue and did not increment retained-capability reuse.

### Frozen model-backed confirmation

Protocol: `gitea-browser-discovery-model-confirmation-v1`

Artifact:

`artifacts/gitea-browser-discovery-model-confirmation/gitea-browser-discovery-model-confirmation-v1-2026-07-27T21-39-18-794Z/confirmation-report.json`

Result:

- passed on the first bounded model attempt;
- one model call;
- USD 0.042505;
- built-capability path completed;
- one intended Gitea issue write;
- zero incorrect side effects;
- direct Gitea API verification passed;
- parent resumed;
- fresh-process retained reuse completed;
- reuse made zero planner calls; and
- every frozen source hash and the Git commit remained unchanged.

The model selected among already observed semantic controls. It did not receive arbitrary browser control, credentials, raw selectors, permission to invent paths or permission to widen the write.

## Preserved development chronology

- Local port failures seen during one ordinary suite invocation were caused by the execution sandbox denying localhost binds. The identical suite passed without source changes once local binding was authorized; these were not product failures.
- The rejected-password case is an intentional negative control, not an unexpected failure. It demonstrates the zero-write handoff path.
- The model-backed discovery confirmation passed on its first paid attempt. No failed paid attempt was discarded.

## Evidence boundary

This checkpoint supports the private statement:

> A frozen local experimental browser candidate can discover semantic controls inside a predefined trusted boundary, construct and verify one constrained browser capability, perform one approved action, independently verify the external result, resume the goal, survive repairable UI drift through quarantine and replacement, and reuse the retained capability on a genuine disposable Gitea interface.

It does **not** establish:

- arbitrary-site autonomy;
- open-ended route discovery;
- browser support as a production or controlled-pilot capability;
- reliable handling of every SPA, iframe, shadow DOM, canvas UI or anti-bot system;
- autonomous resolution of CAPTCHA, MFA, SSO, security-key or account-creation gates;
- multiple consequential writes in one browser capability;
- customer-system validation;
- production reliability, security certification or commercial demand;
- parity with the mature constrained-HTTP path; or
- a formal final green verdict.

The next honest browser-development priorities are additional structurally different interface transfers, session-expiry and drift campaigns across those interfaces, broader read-only route discovery without broadening write authority, and a separately frozen acceptance campaign before any browser pilot-readiness claim.
