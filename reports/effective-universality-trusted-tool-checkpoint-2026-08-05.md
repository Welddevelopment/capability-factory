# Effective-universality trusted-tool checkpoint — 2026-08-05

Status: private local implementation checkpoint. It does not authorize a public product,
customer, security, production, package-installation, arbitrary-code or universality claim.

## What changed

The seventh enabled runtime-family route is now a deliberately narrow trusted-tool and residual
compute experiment:

- the accepted artifact is pinned by SHA-256, version, exact export and byte ceiling;
- preflight parses the actual WebAssembly module and refuses every host import;
- the guest therefore receives no filesystem, network, process, environment, host-call,
  credential or WASI capability;
- execution occurs in a dedicated worker with a hard timeout, memory ceilings and termination
  after each result;
- the only current input/output contract is a bounded list of integers to one integer result;
- a deterministic probe runs before use;
- an exact customer approval key is required before the real invocation;
- a separate verifier implementation checks the result after execution;
- failed outcome verification quarantines the retained capability;
- verified retention is tenant/need/artifact bound in a customer-local SQLite registry and is
  recovered by a fresh registry process; and
- the strict capability-mode router, complete-bundle factory and universal coordinator now bind
  `experimental-trusted-tool-actions` to `trusted-tool-code` without accepting a family choice
  from the caller.

This creates a useful high-floor code boundary: trusted or newly produced pure compute can be
executed without silently granting host powers. It is not a generic subprocess wrapper.

## Why this boundary was chosen

General package installation or arbitrary generated code would immediately introduce supply-
chain, filesystem, network, secret, process and persistence authority. A timeout alone would not
make those powers safe. Import-free WebAssembly provides a substantively stronger first floor:
the guest cannot call a capability that was never imported.

The ceiling remains open. Later, separately reviewed host capabilities could be introduced as
explicit imports, each with its own authority, verifier and recovery contract. This checkpoint
does not grant or imply any of them.

## Verification completed

- strict TypeScript compilation passed;
- direct artifact hash, import, export, input and verifier rejection checks passed;
- isolated probe and execution passed for a hand-authored addition module;
- exact-approval denial passed;
- first trusted use and fresh-registry retained reuse passed;
- strict shared mode-router execution passed;
- complete-bundle family binding and automatic coordinator selection passed;
- focused sidecar registry/job coverage passed; and
- the full ordinary regression passed **342 active checks across 67 files**, with 59 explicitly
  skipped environment/model/real-system checks unchanged.

No model call, API spend, customer data, external account, production service or public deploy
was used.

## Exact evidence boundary

Demonstrated locally:

- one import-free WebAssembly execution shape;
- pinned provenance and a no-host-import preflight;
- bounded integer input/output;
- deterministic pre-use probe;
- exact approval;
- separate result verification;
- tenant-scoped durable retention and reuse; and
- shared cross-mode routing and bundle identity.

Not demonstrated or claimed:

- general npm, Python, system-package or MCP installation;
- arbitrary generated JavaScript, Python, shell or native-code execution;
- filesystem, network, database, secret or host API access from the guest;
- automatic synthesis of WebAssembly from an ordinary goal;
- security against every runtime implementation vulnerability;
- customer compatibility, production isolation or production reliability; or
- evidence that this family resolves a representative share of real customer blockers.

## Next checkpoint

Implement multi-capability composition while preserving per-step authority and verification.
The aggregate parent goal must complete only when every required leaf outcome is independently
verified; partial, unknown or authority-blocked leaves must produce exact safe state rather than
a false parent completion.
