# Customer-local multi-mode boundary checkpoint — 2026-07-31

## Result

The customer-local sidecar and private operator console now expose five explicitly separate
capability modes through one authenticated boundary:

- `constrained-http-api`;
- `experimental-browser-actions`;
- `experimental-file-transfer-actions`;
- `experimental-inbox-message-actions`; and
- `experimental-document-actions`.

This is shared routing and operational packaging, not merged capability evidence. HTTP keeps
the maturity label `working-local-pilot-mvp`; the other four remain
`experimental-local`.

## Safety design

The entry contract is a strict discriminated union. Trusted planning must provide the exact
mode name. The router never infers a driver from untrusted payload fields.

For every request:

1. the selected mode determines one strict request schema;
2. unknown fields and cross-mode payloads are rejected;
3. only an explicitly registered driver may run;
4. the normalized result must identify the same mode;
5. one tenant/parent-goal identity is bound to one immutable request digest and mode;
6. cross-tenant job lookup returns no record; and
7. restart recovery reopens the same durable job under the same mode.

The mode registry exposes each driver's version, configuration state, evidence boundary and
maturity. It does not expose credential values, raw payloads or private evaluation artifacts.

## Product surfaces

New product modules:

- `src/product/capability-mode-contract.ts`
- `src/product/capability-mode-router.ts`
- `src/product/capability-mode-jobs.ts`

Extended product surfaces:

- authenticated sidecar registry and durable mode-job routes;
- thin sidecar client registry/job/event methods;
- console `/api/capability-modes` projection; and
- operator-facing Mode registry view.

## Verification

Focused sidecar and console checks passed 15/15. They cover:

- authenticated registry access;
- all five explicit modes;
- one HTTP maturity label and four experimental labels;
- durable submission and terminal projection;
- tenant isolation;
- immutable parent-goal mode binding;
- unknown-field refusal;
- mode/payload-confusion refusal;
- append-only mode job events; and
- fresh-process recovery through the same mode.

The full ordinary local regression passed:

- 55 test files;
- 289 checks;
- 11 environment-gated files and 55 checks skipped.

TypeScript strict typechecking and `git diff --check` also passed. The console view was
inspected in a real local browser; the final five-card grid has no empty cell and keeps the
HTTP-versus-experimental distinction visible above the fold.

## GTM implication

This removes one shared packaging and product-clarity blocker across the five already-built
mode surfaces. It makes a multi-mechanism founder conversation more concrete without
claiming a general capability platform.

It does **not** remove:

- customer-local browser runtime packaging;
- a held-out browser/portal workflow;
- authenticated network file transport;
- a second genuinely different file contract;
- arbitrary PDFs, OCR or unknown layouts;
- regulated-data approval, enterprise security review or identity/account authority;
- customer workflow evidence, willingness to pay or production reliability.

The next highest-value reversible phase is browser packaging plus a distinct held-out local
portal workflow.

## Claim boundary

Supported private statement:

> The local product now has one authenticated, durable customer-local sidecar and console
> boundary for five explicitly separate modes. Routing fails closed, mode identity survives
> restart, and the console preserves each mode's distinct maturity and evidence boundary.

Not supported:

- automatic mode diagnosis at this boundary;
- universal or production multi-mode support;
- equal maturity across modes;
- customer deployment or customer validation;
- external security approval; or
- a formal final green verdict.
