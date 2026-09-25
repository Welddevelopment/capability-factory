# CF-035 — Customer-local plugin scaffold and signed release/install workflow

Date: 2026-08-14
State: deterministic zero-spend local scaffold/release machinery complete; no fresh-human or production supply-chain claim

## Purpose

CF-030 defines plugin conformance and CF-034 hosts only allowlisted, pinned, freshly conformant bundles. CF-035 provides the missing engineer-facing path for creating a plugin project, building it reproducibly, releasing it with exact evidence, reviewing an install proposal and handing it to CF-034 without silently creating a usable or authorized plugin.

## Fail-closed scaffold

`src/product/customer-local-plugin-scaffold.ts` generates a self-contained TypeScript project from explicit metadata:

- tenant-independent plugin ID;
- provider class (`map-backed-local` or `callback-local`);
- distinct action and observer aliases;
- complete reviewed action and observer profile templates.

Generated files:

1. `src/contract.ts` — minimal local compile-time types;
2. `src/plugin.ts` — failing inspector, one-read lease, action, observer, probe and reconciliation stubs;
3. `scripts/doctor.ts` — proves the untouched scaffold remains fail-closed;
4. `test/conformance-map.json` — maps all 21 frozen CF-030 controls to `declared-not-run`;
5. `plugin-spec.json` — exact reviewed metadata;
6. `package.json` — private, no dependencies and no scripts;
7. `tsconfig.json` — fixed local deterministic build configuration;
8. `README.md` — explicit scaffold evidence boundary.

The generator never creates credential values, scopes that were not explicitly encoded by the reviewed profiles, shared action/observer implementations, authority, activation, a passing conformance state or a working transport. The stubs throw “implementation required” errors.

Identifiers and output paths are bounded. Absolute paths, `..`, injection-shaped IDs, shared aliases/implementations and secret-shaped metadata are rejected.

## Deterministic local build and release

The library typechecks through the already-installed TypeScript compiler API and emits locally without invoking package managers or package scripts. It rejects:

- dependencies or dev dependencies;
- any package script;
- changed/extended TypeScript configuration;
- unexpected project files;
- type errors;
- skipped output;
- byte-different repeat builds.

The release manifest binds:

- plugin and semantic release version;
- every source-file digest and aggregate source digest;
- every emitted build-file digest and aggregate build digest;
- provider and resolver implementation digests;
- action and observer transport/profile digests;
- source-package digest;
- frozen 21-control digest;
- creation and expiry;
- explicit zero authority/activation effects.

Detached Ed25519 signatures are optional at release time and mandatory when install policy requires them. Verification checks manifest integrity, manifest/signature binding, signer identity and the cryptographic signature.

## Install proposal

`proposePluginHostInstall` requires all of the following:

- exact phrase `INSTALL <plugin> <version> FOR <tenant>`;
- current untampered, unexpired release manifest;
- current source digest and deterministic build digest matching the released project;
- required valid detached signature and signer policy;
- exact passing current CF-030 receipt;
- healthy same-tenant CF-034 doctor report;
- no existing bundle or loader identity conflict.

It returns only a `reviewed-install-proposal` with a declarative CF-034 entry and integrity digest. It does not edit the host manifest, load code, grant authority or activate anything.

Changed source/build/config, stale release, cross-tenant reuse, invalid conformance, unhealthy doctor, unsigned/wrong-signer release or install conflict is rejected. CF-034 subsequently rechecks its own pins and reruns conformance on load and restart.

## CLI

`src/product/run-customer-local-plugin-scaffold.ts` provides three versioned local commands:

- `scaffold <metadata.json> <output-root>`;
- `build <project>`;
- `release <project> <release-input.json>`.

It uses only the existing local Node/TypeScript toolchain. It does not install packages, execute project scripts, fetch code or contact a network service.

## Two fresh generated projects

The frozen test created two fresh projects:

- `aurora-release-plugin` using the map-backed/direct reference shape;
- `mistral-release-plugin` using the callback/queued reference shape.

For each project:

1. scaffolded eight files with failing stubs;
2. confirmed all 21 controls were declared but not run;
3. added one fictional local implementation file outside the generator;
4. typechecked and built twice identically;
5. created the exact release manifest;
6. signed and verified with Ed25519;
7. ran all CF-030 conformance controls;
8. loaded and passed CF-034 doctor;
9. created a reviewed install proposal;
10. restarted the host, observed `reload-required`, and regained use only after fresh conformance.

Measured surface per project:

- generated files: 8;
- manually implemented files: 1;
- explicit scaffold decisions: 7;
- frozen conformance controls: 21;
- core workflow commands/API calls measured by the test: 9;
- environment-specific executable implementation was confined to the one fictional `src/plugin.ts` replacement and the already-existing explicit CF-034 loader.

The generated-line and manual-line totals are emitted as private deterministic test metrics. They are engineering measurements, not fresh-human usability evidence.

## Adversarial evidence

The focused tests covered:

- path traversal and absolute path attempts;
- identifier/template injection;
- shared alias and shared transport implementation;
- secret-shaped metadata;
- tampered release manifest;
- missing signature under required policy;
- wrong public key/signer;
- stale release;
- cross-tenant proposal reuse;
- source mutation after release;
- package-script abuse;
- dependency/build-control restrictions;
- install identity conflict;
- repeat-build determinism;
- restart requiring fresh conformance.

Final verification:

- repository-wide TypeScript typecheck passed;
- joined CF-029/030/034/035 and onboarding target passed 11 files and 69 tests with 0 failures;
- `git diff --check` passed;
- no network, model, container, customer credential or customer data was used.

## Remaining environment-specific work

- implement and review a real provider SDK boundary;
- implement real action and observer transports and no-write probes;
- define real reconciliation and idempotency behavior;
- choose and secure signing-key custody and rotation;
- package/distribute releases through an approved customer process;
- configure OS filesystem ownership, code signing/notarization where applicable, service supervision and rollback;
- validate actual dependency provenance if future plugins require approved dependencies;
- validate real DNS/TLS/proxy/firewall behavior;
- obtain customer security, legal, authority and activation approval;
- run a genuinely fresh engineer usability comparison.

## Strongest accurate claim

Capability Factory now has local deterministic machinery to scaffold a deliberately non-working customer-local plugin, typecheck and reproducibly build a completed local implementation, bind it into an expiring release manifest, optionally sign it with Ed25519, and create a CF-034 install proposal only after exact review, conformance and doctor gates pass.

This is local scaffold/release machinery. It is not fresh-human usability evidence, production package security, public distribution, customer deployment, authority or activation.
