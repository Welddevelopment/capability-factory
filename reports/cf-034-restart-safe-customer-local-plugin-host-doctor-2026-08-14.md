# CF-034 — Restart-safe customer-local plugin host and doctor

Date: 2026-08-14
State: deterministic local host/doctor machinery complete; no authority, activation, production-security or customer claim

## Purpose

CF-030 can determine whether one in-process credential/transport plugin bundle conforms to the frozen local controls. CF-034 packages that machinery into a restart-safe customer-local host so stale or changed plugins cannot silently continue supplying CF-029 inputs.

## Host boundary

`src/product/customer-local-plugin-host.ts` adds:

- a declarative manifest containing explicit bundle and loader identities;
- source-package, provider, resolver, action/observer implementation and reviewed-profile pins;
- an in-process allowlisted loader registry supplied by the host application;
- no filesystem module discovery, dynamic arbitrary-code installation, network fetch or package installation;
- fresh CF-030 conformance before a bundle becomes available in each process;
- an exact passing-receipt bridge to CF-029 and the existing onboarding-sidecar runtime-resolver interface;
- short-lived per-call leases through the existing CF-030 process-local resolver;
- SQLite persistence for metadata, redacted receipts, quarantine reasons, imports and append-only host events;
- no persisted secret values or active leases;
- durable quarantine and restart state;
- a structured offline doctor;
- redacted, tenant-bound, manifest-bound, integrity-bound, explicitly non-authorizing evidence export/import.

## Restart behavior

The host never treats a receipt from a previous process as current execution readiness.

- A clean restart changes a previously conformant persisted bundle to `reload-required`.
- A persisted `loading` state indicates an interrupted load/doctor boundary and becomes `quarantined` on restart.
- A fresh load reconstructs the bundle through the exact allowlisted loader, checks all pins, reruns CF-030 and only then exposes CF-029 inputs.
- Concurrent load requests for one bundle share one in-flight conformance operation.

Imported evidence remains evidence only. It cannot populate the in-process active-bundle map, satisfy the fresh-conformance control, grant authority or activate a plugin.

## Doctor output

For each bundle, the doctor reports:

- manifest and loader identity;
- source-package, provider, resolver and transport pins;
- current conformance receipt/control/expiry status;
- fresh-this-process posture;
- exact alias, scope, revision, expiry and revocation posture;
- action/observer separation and reachability;
- receipt/event/artifact redaction scan;
- usability for CF-029;
- exact blockers and remediation class;
- explicit `executionAuthorityEffect: none` and `activationEffect: none`.

The doctor quarantines on changed code/config/source, missing loader, expired receipt, credential rotation or revocation, transport unavailability/misrouting/drift, action/observer sharing, or a crash inside credential/transport inspection.

## Reference manifest and interfaces

`createReferencePluginHostManifest` supplies two declarative entries over the CF-030 local references:

- `reference-map-direct-bundle`;
- `reference-callback-queued-bundle`.

Each entry contains 14 explicit identity/boundary fields. The runtime loader remains a separately supplied allowlisted function, not a path interpreted from the manifest.

`hostedOnboardingCompilationRuntimeResolver` implements the existing `OnboardingCompilationRuntimeResolver` contract. A joined test used a hosted, exact Northstar-shaped bundle and proved that the resolver is unavailable before conformance and returns exact CF-029 inputs afterward.

`createCustomerLocalPluginHostSidecar` adds four authenticated local routes:

- `POST /v1/plugins/:bundleId/load`;
- `GET /v1/plugins/:bundleId/doctor`;
- `GET /v1/evidence/export`;
- `POST /v1/evidence/import`.

There is no activation route.

`src/product/run-customer-local-plugin-host.ts` is the offline CLI. It takes an explicit local SQLite path and optional tenant ID, loads both reference bundles, prints doctor reports and emits the redacted evidence export.

## Measured local setup surface

For the two bundled reference plugins:

- 1 integrity-bound declarative host manifest;
- 2 allowlisted loader registrations;
- 2 × 14 pinned manifest fields;
- 1 customer-local SQLite state path;
- 1 local access token for the optional sidecar;
- minimum steady-state API sequence per bundle: 1 load request and 1 doctor read;
- 21 CF-030 conformance controls per bundle;
- 5 doctor control groups plus exact blockers/remediation classes;
- 0 external service calls;
- 0 model calls;
- 0 plugin-specific executable code added beyond the existing CF-030 reference plugins.

Real provider/transport plugins still require their own allowlisted loader adapter and declarative manifest entry. The host does not generate those environment-specific bindings.

## Adversarial and joined evidence

The focused host suite covered:

- both reference bundles reaching conformant/usable state;
- eight concurrent load callers producing one actual load;
- clean restart requiring fresh conformance;
- interrupted-load restart quarantine;
- missing loader;
- loader crash containing a seeded canary;
- source/code/config drift;
- credential rotation;
- credential revocation;
- receipt expiry;
- observer transport unavailability;
- credential-doctor crash containing a seeded canary;
- action/observer implementation sharing even when repinned;
- redacted tenant-bound export/import;
- imported evidence remaining non-authorizing;
- raw SQLite canary absence;
- authenticated host-sidecar routes and absence of activation;
- exact existing onboarding-sidecar runtime resolver integration.

Final verification:

- repository-wide TypeScript typecheck passed;
- focused host target passed 13 tests with 0 failures, including imported shared fixture controls;
- joined CF-029/030/034 and onboarding regression target passed 10 files and 64 tests with 0 failures;
- `git diff --check` passed;
- no external network, model, container, customer credential or customer data was used.

## Reusable versus environment-specific work

Reusable:

- manifest and loader contract;
- digest pinning;
- restart state machine;
- conformance gating;
- quarantine/event persistence;
- doctor structure and remediation classes;
- evidence export/import integrity and tenant boundary;
- authenticated local routes;
- CF-029/onboarding-sidecar resolver join;
- two reference manifest entries and CLI.

Environment-specific:

- real provider SDK/process integration;
- local package installation and update policy outside this host;
- filesystem ownership and OS service supervision;
- OS memory, swap, tracing, crash-report and core-dump controls;
- real DNS/TLS/proxy/firewall behavior;
- transport-specific availability and reconciliation probes;
- secret-manager IAM, rotation and incident procedures;
- customer security/legal review and activation authority.

## Strongest accurate claim

Capability Factory now has a restart-safe local host and doctor that loads only explicitly allowlisted, digest-pinned customer-local plugin bundles, reruns the frozen conformance controls before each process can expose CF-029 inputs, persists only redacted metadata/evidence, and quarantines drift or unsafe runtime posture.

This is local host/doctor machinery. It is not production secret security, external TLS validation, customer deployment, authority, activation or universal capability acquisition.
