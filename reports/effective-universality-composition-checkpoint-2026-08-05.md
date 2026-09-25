# Effective-universality composition checkpoint — 2026-08-05

Status: private local implementation checkpoint. This report does not authorize a customer,
production, effective-universality, 99.9%-reliability or general-workflow claim.

## What changed

### 1. Trusted multi-capability preparation

One ordinary goal can now select a bounded trusted composition without exposing a runtime-family
choice to the caller. A model-compatible planner may select only a predeclared composition key
and cite existing customer-local observations. Trusted code owns:

- the work-item dependency graph;
- every diagnosed capability gap;
- every authority envelope;
- every route factory and complete capability bundle;
- the stop-all versus continue-independent policy; and
- the independent aggregate external-state verifier.

Invented compositions, invented evidence and omitted required evidence are rejected before
execution.

### 2. Dependency-safe execution

Each leaf runs through the existing universal coordinator and keeps its own family, mode,
permissions, verifier and recovery contract. The composition coordinator:

- validates unique work/request identities;
- rejects unknown dependencies, self-dependencies and cycles;
- runs dependencies in deterministic topological order;
- never executes a dependent leaf whose prerequisite did not independently complete;
- optionally continues only independent leaves when the trusted policy allows it;
- preserves leaf handoff and unresolved states; and
- refuses parent completion unless all required leaves completed.

### 3. Separate aggregate verification

Even all-green leaves are insufficient. A separately configured external-state verifier must
pass after the leaves. A failed, malformed or unavailable aggregate check produces
`unresolved-safe`, keeps the original parent incomplete and can quarantine every participating
bundle.

### 4. Genuine local two-mode route

A disposable local composition joined two real experimental drivers:

1. a pinned import-free WebAssembly tool calculated and independently verified a fictional
   restock quantity; then
2. the reviewed SQLite database driver created exactly one approved restock draft; then
3. a separate read-only database connection joined the verified compute result to the exact
   persisted draft and found zero incorrect side effects.

The parent completed only after both leaves and the aggregate verifier passed. This demonstrates
real local cross-mode dependency handling and aggregate checking. It does **not** yet demonstrate
general dynamic dataflow between arbitrary capabilities: the bounded trusted workflow supplied
the database input, while the aggregate verifier proved it matched the independently verified
compute result.

### 5. Customer-local surface

The authenticated sidecar now exposes `/v1/universal-compositions`, and the thin localhost
client exposes runtime-family discovery, ordinary universal resolution and universal composition
methods. The submitted customer goal contains no capability mode. The server rejects any trusted
preparation that changes tenant, request, parent-goal or ordinary-goal identity.

### 6. Composition-aware benchmark accounting

The benchmark can now freeze and hash an exact case set, run every case in fixed order, preserve
executor errors in the denominator, attach one case to multiple runtime families and precommit
expected leaf and aggregate states. A green parent with a skipped leaf or missing aggregate check
is classified as a silent false completion and fails the campaign.

The existing statistical discipline remains: a small synthetic all-pass run is only a development
result. It cannot establish 99.9% reliability without a representative denominator and thousands
of preserved trials.

## Verification completed

- strict TypeScript compilation passed;
- focused dependency, handoff, aggregate-failure, cycle and identity tests passed;
- trusted composition proposal/evidence rejection tests passed;
- authenticated sidecar and framework-neutral client execution passed;
- the genuine local trusted-tool → reviewed-database composition passed; and
- the full ordinary regression passed **352 active checks across 70 files**, with 59 explicitly
  skipped model/real-system/environment checks unchanged.

No model call, API spend, customer data, external service, paid account or public deployment was
used.

## Exact remaining limitations

- composition execution is synchronous and not yet a durable restart-recoverable job;
- arbitrary inter-leaf value passing and schema adaptation are not implemented;
- planners cannot synthesize a new safe DAG outside trusted templates;
- no representative or held-out multi-family case distribution exists;
- no customer workflow, customer credentials or customer production environment was used;
- adjacent enabled modes retain separate experimental evidence and do not inherit HTTP maturity;
- family registration is not family implementation; and
- this checkpoint does not move the product to a formal final-green verdict.

## Next safe work

Add one bounded signed agent/service-delegation route, then freeze a multi-family development
campaign covering autonomous completion, correct authority handoff, verifier rejection,
dependency blocking, recovery and unsupported-family cases. Higher-authority native UI, shell,
cloud, identity, device and physical families should remain disabled unless a real isolation,
authority and independent-verification boundary is implemented.
