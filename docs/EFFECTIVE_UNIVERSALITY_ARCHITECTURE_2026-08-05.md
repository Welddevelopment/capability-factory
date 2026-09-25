# Effective universality architecture

Status: private implementation plan and evolving local architecture. This is not a public
product claim, customer result, production-readiness statement or 99.9% reliability result.

## Target

Capability Factory should correctly resolve or precisely hand off 99.9% of **eligible
capability gaps**, while separately reporting the fraction completed fully autonomously and
never turning an unknown result into a silent completion.

Eligible means:

- the requested work is digitally executable;
- the desired outcome is sufficiently specified;
- the relevant customer policy permits considering the action;
- the external result can be independently observed; and
- the task is inside an explicitly configured trust boundary.

Missing legal authority, credentials, approval, physical access or genuinely human judgment
is not an acquisition failure. It must produce a precise handoff and must not be counted as
autonomous completion.

The initial measurable universe is authorized software-accessible digital work. Human
delegation, devices and physical action remain explicit future runtime families so the
architecture does not cap the long-term ceiling.

## High floor, uncapped ceiling

The dependable floor is:

1. diagnose the precise capability gap;
2. distinguish a missing capability from missing authority or information;
3. search retained capabilities;
4. search trusted existing tools;
5. compose existing capabilities when the composition is bounded;
6. construct the smallest manifest inside a trusted runtime;
7. use an isolated residual sandbox only when the bounded runtimes cannot represent the work;
8. verify candidate fitness before use;
9. execute within exact authority;
10. inspect external state independently;
11. reconcile, quarantine, recover or hand off without a blind retry;
12. resume the original goal; and
13. retain the proven capability with its complete evidence and scope.

The uncapped ceiling includes generated runtime extensions, autonomous verifier construction,
cross-mode composition, unknown-protocol discovery, richer browser perception, self-repair,
delegation and later device or physical action. Ceiling experiments must remain additive and
cannot weaken the floor or inherit its evidence label.

## Fundamental object: capability bundle

A capability bundle is the minimum complete unit of trustworthy acquired ability. It contains:

- the selected runtime family and exact driver version;
- the bounded action manifest reference and digest;
- required target, secret aliases, approvals and risk ceiling;
- a pre-use verifier and an independent external-outcome verifier;
- idempotency, reconciliation, retry and quarantine rules;
- trusted-source provenance and source hashes; and
- retention identity, scope and version.

Credential values and customer payloads are deliberately absent. A manifest or generated code
fragment without the other bundle layers is not a complete Capability Factory capability.

## Runtime families

The canonical registry currently contains fifteen families:

1. service APIs and remote procedure calls;
2. authenticated browser and web UI;
3. native desktop and mobile UI;
4. files, object storage and EDI;
5. messaging, inboxes and event streams;
6. documents, spreadsheets and media;
7. databases, search and data warehouses;
8. trusted tools, packages and isolated residual code;
9. operating systems, command line and remote shell;
10. cloud, infrastructure and administrative control planes;
11. identity, accounts, credentials and permissions;
12. agent and digital-service delegation;
13. human delegation;
14. mobile, device and IoT control; and
15. physical and robotic action.

An `extension.*` family ID can represent a genuinely new mechanism without widening an
existing driver. Merely registering a family is not implementation evidence. Every descriptor
has an enabled flag, maturity and explicit claim boundary.

The eight currently enabled architectural routes are service API, browser, file/EDI, signed
message, pinned machine-readable document, reviewed database operation and import-free pinned
WebAssembly compute, plus signed agent/service delegation. Only the constrained HTTP
implementation keeps the existing working-local-pilot-MVP label. The other seven remain
experimental local routes.

## Hybrid acquisition hierarchy

The coordinator ranks acquisition sources in this order:

1. retained;
2. trusted existing;
3. composed;
4. built manifest;
5. sandboxed residual; and
6. delegated.

Priority inside a source class is a trusted customer-local policy decision. The model cannot
grant authority, enable a runtime family, change the ordinary goal or convert an unavailable
verifier into a valid one.

## Universal coordinator

The new coordinator accepts an ordinary goal plus a trusted diagnosed gap and customer-local
prepared route candidates. The external customer-agent entrance contains no runtime family or
capability-mode field. Trusted customer-local preparation supplies the gap, authority and
bounded route candidates.

A route is eligible only when all of the following hold:

- family, mode and capability bundle agree;
- family is registered and enabled;
- tenant, request, parent goal and ordinary goal identity are unchanged;
- all required actions and targets are covered;
- all required independent observations are available;
- targets, actions, credentials and approvals are inside customer authority;
- route risk is below both task and customer ceilings;
- recovery requires reconciliation and forbids blind retry; and
- the bundle passes strict schema validation.

The coordinator reports autonomous completion only when the selected mode reports completion,
the original parent goal resumed, and the parent goal completed. Handoff or blocked states are
reported separately. Failed or unknown states remain unresolved-safe and are never silently
promoted to completion.

## Multi-capability composition

A trusted composition may express a bounded dependency graph of capability leaves. The planner
can select only a predeclared composition key. Customer-local trusted configuration owns every
work item, dependency, diagnosed gap, authority envelope, route factory, failure policy and the
independent aggregate verifier.

Every leaf still passes through the universal coordinator and retains its own runtime family,
capability bundle, permissions, pre-use verifier, outcome verifier and recovery rules. A blocked
or unresolved dependency prevents downstream execution. Independent leaves may continue only
when the trusted composition explicitly selects that policy. The original broad goal completes
only if every required leaf completes and a separate aggregate external-state contract passes.

The composition now also has a customer-local durable job form. It persists and hashes the exact
trusted plan and aggregate-verifier identity before execution, rejects conflicting use of the
same parent identity, and recovers an interrupted job without asking a model to re-plan. Changed
verifier identity, corrupted plan state and exhausted recovery attempts fail closed. This still
does not claim distributed coordination, general inter-leaf dataflow, arbitrary workflow
synthesis or customer production operation.

## Implementation sequence

Dependency order:

1. universal contracts, registry and metrics;
2. universal coordinator and ordinary-goal sidecar entrance;
3. trusted cross-mode diagnosis and route preparation;
4. migrate enabled modes to complete bundle production;
5. verifier factory and observation-adapter registry;
6. scoped database family;
7. trusted-tool and isolated residual-code family;
8. signed agent/service delegation;
9. cross-mode composition and customer-local exact-plan durability;
10. frozen development gate and honest benchmark accounting; and
11. customer-specific activation and external validation.

The remaining registered families are deliberately not enabled merely to increase a coverage
count. Native UI requires a real OS accessibility/isolation boundary and separate state
observer. Shell and cloud administration require materially stronger isolation, scoped real
control planes and consequential-operation policy. Identity cannot manufacture authority.
Human delegation requires an actual accountable human workflow, while devices and physical
action require hardware-specific safety systems. These stay as explicit architectural slots
until their safety and verification requirements can be met honestly.

The frozen local development gate currently selects nineteen committed test files. It covers
all eight enabled families and ordinary-goal entry, route selection, authority, pre-use and
outcome verification, recovery, retention, composition, durability and claim accounting. A
clean gate is only a local development result; it is permanently marked non-representative.

Benchmark design can proceed in parallel. Customer pilots do not need to wait for every family.

## Evidence discipline

The target is not evidence. Current implementation does not establish effective universality,
99.9% reliability, customer compatibility or production readiness. A defensible 99.9% statement
would require a representative denominator, frozen unseen cases, thousands of trials, preserved
failures, statistical bounds and real external/customer evidence. Autonomous completion and
correct handoff must always remain separate metrics.
