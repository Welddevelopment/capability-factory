# Controlled-pilot MVP contract

Status: **private product completion contract**

## The claim this work is trying to earn

> Capability Factory is a working MVP ready for a tightly scoped, controlled pilot. It can run in a customer-controlled environment, connect to one approved HTTP-based workflow, accept an ordinary goal, execute the capability-acquisition loop, expose its progress and evidence, stop safely when authority is missing, and recover conservatively from interruption. It has been extensively tested locally, but has not yet been validated on a customer's real system.

“Ready for a controlled pilot” does not mean generally available, production-ready, independently audited, reliable across industries, or already proven with a customer.

## Current capability boundary

The only implemented acquisition mode is `constrained-http-api`: documented HTTP API actions represented as declarative data and performed by trusted runtime code.

This includes operations such as reading an order from an ERP and creating an approved purchase record through that ERP's documented API. It does not include browser operation, arbitrary generated code, package installation, account creation, devices, physical systems, or human/agent delegation.

An isolated `experimental-browser-actions` driver now exists as a private second-mode experiment. It operates real local Chromium against a disposable localhost portal, but remains limited to exact paths, methods, request ceilings, named test IDs, one explicitly approved write, pre-action reconciliation and independent post-action verification. It does not generate browser workflows and does not prove a customer workflow, arbitrary-site support or production browser reliability. It is not included in the supported MVP capability boundary.

Future modes should be separate trusted drivers beneath the shared control loop. The broad-goal coordinator, authority model, durable jobs, verification stages, recovery rules, audit trail, console and handoff semantics should remain shared. A future driver must have its own constrained representation, executor, verifier and safety policy; it must not make the HTTP manifest more permissive.

## MVP-readiness gates

The product may use the controlled-pilot MVP claim only when all eight gates pass with saved evidence:

1. **Claim boundary:** current behavior, local evidence, unsupported modes and remaining customer dependency are stated accurately.
2. **Adapter kit:** another engineer can define trusted scope, local credential aliases, workflows, execution and independent verification without changing the acquisition core.
3. **Joined real-system loop:** one ordinary goal completes through durable sidecar submission, planning, acquisition or reuse, genuine local ERP execution, independent verification, parent resumption and retention.
4. **Authority and secret boundary:** missing credentials or permission stop before writes; secret values remain customer-local and are absent from requests, plans, events and reports.
5. **Independent verification and recovery:** success depends on external state rather than the agent's claim; lost responses are inspected before retry and cannot create a duplicate.
6. **Durable operator path:** a real sidecar job is visible through the console, including progress, evidence, handoff and restart recovery.
7. **Install and clean start:** a new local environment can install, configure, validate, start, stop and remove the MVP through documented commands.
8. **Frozen readiness campaign:** the unchanged candidate passes the agreed happy, reuse, denial, wrong-outcome, lost-response, restart, duplicate-submission and tenant-boundary cases with zero incorrect side effects.

A failed or unrun gate means the claim has not yet been earned. Passing one gate cannot compensate for another missing gate.

## Customer-pilot activation gates

Even after the MVP is locally ready, a particular customer pilot must not start until all six customer-specific gates pass:

1. A named, narrow and safely testable workflow exists.
2. The customer approves a sandbox, disposable system or synthetic replica.
3. Least-privilege credentials are resolved locally without being copied into product requests or reports.
4. The customer supplies the exact scope, permissions and approval rules.
5. That customer's adapter passes the required acceptance campaign.
6. Both sides agree on monitoring, handoffs, stopping, data retention and deletion.

These gates cannot be satisfied by the local ERPNext reference alone.

## Deliberate non-goals for this phase

- Supported browser, arbitrary-code, package, device or physical-world capability modes. The isolated browser-driver experiment does not change this boundary.
- Public internet exposure of the development sidecar.
- A universal connector or arbitrary API claim.
- Production multi-region infrastructure, automatic upgrades or formal security certification.
- Customer, demand, revenue or reliability claims that do not yet exist.

## How expansion is contained

The browser experiment uses a separate manifest, registry, trusted executor, permission checks, verifier, recovery policy and acceptance campaign rather than widening the HTTP manifest. The constrained-HTTP route remains the supported pilot MVP. A customer-facing browser driver and representative workflow must still be selected from customer evidence and pass customer-specific activation gates.
