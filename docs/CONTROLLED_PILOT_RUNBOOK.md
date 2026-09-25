# Controlled-pilot local runbook

Status: **private local MVP operator guide**

## Generic customer-local package bootstrap

The generic local package wraps the lifecycle manager with private secret files, a pinned
adapter-runtime digest, localhost-only defaults, fail-closed readiness checks and an
immutable sanitized evidence export:

```bash
pnpm pilot:package init --root /customer/path/cf-pilot --installation pilot-one --tenant customer-one --version 0.1.0 --adapter /customer/path/runtime.mjs
pnpm pilot:package ready --root /customer/path/cf-pilot
pnpm pilot:package serve --root /customer/path/cf-pilot
pnpm pilot:package evidence --root /customer/path/cf-pilot --report /customer/path/report.json --output /customer/path/evidence.json
```

The command prints secret file paths, never their values. Readiness fails if the copied
adapter changes, a secret is linked or becomes group/world readable, the installation is
inactive, or the local port is unavailable. Existing `pilot:lifecycle` commands remain the
versioned backup, upgrade, rollback and uninstall layer.

The copied adapter runtime must export `createPilotRuntime(context)`. The supplied context
contains customer-local operational controls and continuation signing; the adapter returns
its trusted descriptor/scope/runtime bindings and goal planner. The package then assembles
the validated-plan store, durable job queue and authenticated localhost sidecar itself.

This is a repository-distributed customer-local reference package. It is not yet a signed
binary, production container image, public cloud service, or proof that an unknown customer
environment can be activated without its separate adapter acceptance and security gates.

This starts the current constrained HTTP product path against genuine disposable local ERPNext with fictional data. It is not a production deployment and does not create a customer environment.

## Plain-English shape

One command starts two product surfaces:

- the **customer-local sidecar**, which keeps credentials, execution and direct verification beside the customer system; and
- the **operator console**, which submits a demo goal and shows the durable job, trusted plan, work items, capability build/reuse, independent outcome evidence and resumption.

The prompt box is a demo entry point. In a pilot, the ordinary goal would normally come from the customer's existing agent through the SDK or sidecar client.

## Requirements

- Node.js 24 or newer;
- pnpm 11.9.0 through Corepack or a compatible installed pnpm;
- Docker with Compose v2;
- enough local resources for the disposable ERPNext stack; and
- ports 8080, 4317 and 4321 available, or different console/sidecar ports configured.

## Install

From the repository root:

```bash
corepack enable
pnpm install --frozen-lockfile
cp config/pilot.env.example .env
```

Replace the example `CF_SIDECAR_TOKEN` in `.env` with a private random value of at least 16 characters. Replace `CF_CONTINUATION_AUTHORITY_SECRET` with a separate random value of at least 32 bytes. The first token authenticates local console-to-sidecar requests; the second signs exact customer approvals. Neither may be committed or reused for the other purpose.

The reference lifecycle manager can create and inspect a customer-local installation directory:

```bash
CF_PILOT_INSTALL_ROOT=/absolute/private/path pnpm pilot:lifecycle install \
  --id pilot-name --version 0.1.0 --mode customer-hosted-sidecar
CF_PILOT_INSTALL_ROOT=/absolute/private/path pnpm pilot:lifecycle inspect
```

It writes mode-0600 metadata and a mode-0700 data directory. It supports verified backup, upgrade with automatic rollback on migration failure, deactivation, reactivation and archive-before-delete uninstall. This is a local reference packaging path, not a signed production installer.

If Docker is installed outside the checkout, set `CF_DOCKER_BIN` and `CF_DOCKER_CONFIG` to those machine-local paths. This keeps the repository portable without copying credentials or executables into it. The pinned disposable Compose file is included at `fixtures/erpnext/compose.yml`; `CF_ERPNEXT_COMPOSE_DIR` may point to an explicitly reviewed replacement. The fixture binds to localhost only. If port 8080 is already owned by another isolated runtime, set both `CF_ERPNEXT_PORT` and the matching `CF_ERPNEXT_BASE_URL`, for example `18080` and `http://127.0.0.1:18080`; the doctor and test process must resolve the same explicit endpoint.

Start the disposable ERPNext fixture:

```bash
pnpm pilot:erpnext:up
```

The first container start may take several minutes because Docker must obtain the pinned ERPNext images and create the site. Wait until `${CF_ERPNEXT_BASE_URL:-http://127.0.0.1:8080}/api/method/ping` responds before continuing.

## Validate before starting

```bash
pnpm pilot:doctor
```

The doctor is read-only. It checks the local tool/runtime versions, private data directory, ERPNext health, adapter contract, hashed documentation, credential-alias resolution, direct verifier access and full executable acceptance-case coverage. Any failure blocks startup.

## Start and stop

Start the joined product:

```bash
pnpm pilot:start
```

Open `http://127.0.0.1:4317/playground`. Select **Customer-local durable sidecar** and submit the suggested fictional batch goal. Stop the product with `Ctrl+C`; durable job, plan, registry and console state remain in `CF_PILOT_DATA` for recovery.

Open `http://127.0.0.1:4317/operations` to inspect or change the real customer-local runtime mode. Mode changes use optimistic state checking, require a specific reason and typed confirmation, and enter the hash-chained operational audit. Open `http://127.0.0.1:4317/handoffs` for safe stops. **Acknowledge** records that an operator saw the stop but grants no authority. **Review exact action** is available only for an exact durable permission handoff with the signing authority configured; it issues a short-lived signed grant for that saved item and resumes without replanning.

Stop the disposable ERPNext containers without deleting their volumes:

```bash
pnpm pilot:erpnext:stop
```

Restart them with `pnpm pilot:erpnext:up`. The product's restart and reconciliation behavior must be tested before any controlled customer pilot.

### Continuing an authority handoff

A permission or credential handoff remains stopped until the customer-local authority issues a signed continuation grant for the exact blocked work item, saved plan, handoff digest and state version. The signing key is separate from the normal sidecar access token. The agent can carry the signed grant but cannot create or broaden it. On continuation, the scheduler reconciles external state before any possible write, reuses the unchanged validated plan and resumes the parent only after independent aggregate verification passes.

### Customer-local credentials

Production-style pilot configuration should leave the legacy inline `secrets` map empty and use a customer-local secret provider. Included reference providers resolve aliases from locked mode-0600 files, customer process environment variables, or an in-memory rotation adapter. Values are resolved only after policy checks at the final execution boundary. Manifests, plans, registries, sidecar jobs and reports contain aliases, not values.

### Operational stop and limits

`CustomerLocalOperationalControl` provides a persistent local kill switch (`running`, `draining`, `halted`), per-run and per-hour write-attempt limits, a daily model-spend ceiling, capability quarantine or revocation, redacted incident records, backup checks and a hash-chained audit export. `draining` permits reads but stops new writes; `halted` stops both. Unknown write outcomes raise an incident and must go through reconciliation instead of blind retry.

## Acceptance campaign

```bash
pnpm pilot:acceptance:erpnext
```

The fixed ten-case campaign saves one redacted JSON artifact per case plus a summary. It covers read-only use, approved write, fresh-process reuse, missing credentials, missing permission, lost-result reconciliation, partial-outcome rejection and cleanup, sidecar restart, duplicate submission and conflicting parent reuse.

A campaign pass is local development evidence only. It is not a customer result, general reliability percentage, formal security audit or production-readiness claim.

## Removing the local reference

`Ctrl+C` stops the product process. `pnpm pilot:erpnext:stop` stops the containers while preserving their volumes. Docker volume deletion and removal of `CF_PILOT_DATA` are intentionally not automated because they destroy evidence and local state; perform either only after selecting the exact target and deciding the evidence is no longer needed.

For a lifecycle-managed installation, create and verify a backup before upgrade:

```bash
CF_PILOT_INSTALL_ROOT=/absolute/private/path pnpm pilot:lifecycle backup --reason before-upgrade
CF_PILOT_INSTALL_ROOT=/absolute/private/path pnpm pilot:lifecycle verify --backup backup-id
CF_PILOT_INSTALL_ROOT=/absolute/private/path pnpm pilot:lifecycle upgrade --version 0.2.0
```

Uninstall requires an explicit archive outside the installation directory. Runtime state is removed only after every archived payload hash verifies:

```bash
CF_PILOT_INSTALL_ROOT=/absolute/private/path pnpm pilot:lifecycle uninstall \
  --archive /absolute/private/final-archive
```

### Full fictional rehearsal

The zero-model simulated pilot joins install, authenticated durable sidecar submission, an authority handoff, sidecar restart, signed continuation, reconciliation, independent verification, conflict rejection, backup, upgrade and deactivation:

```bash
CF_SIMULATED_PILOT_ROOT=/absolute/new/disposable/path pnpm pilot:simulate
```

This remains fictional local development evidence. It is not a customer deployment.

### Frozen local confirmation

After committing an intended candidate and confirming the genuine disposable ERPNext and Gitea stacks are healthy, run:

```bash
pnpm pilot:confirm
```

The controller refuses a dirty worktree, hashes the tracked product, console and test files, then runs type checking, console JavaScript validation, the ordinary suite, the opt-in genuine local-system suites and the full simulated controlled-pilot rehearsal. It checks that the commit and hashes did not change and writes ignored private logs plus `confirmation-report.json` under `artifacts/final-pilot-confirmation/`. This is a local unchanged-candidate confirmation, not customer or production evidence.

## Customer adaptation

For a real controlled pilot, do not reuse the fictional ERPNext credential aliases, scope or completion rules. Follow `docs/CUSTOMER_ADAPTER_KIT.md`, create a customer-specific adapter, run its read-only doctor and ten-case acceptance campaign in an approved sandbox, and agree the monitoring, stopping, retention and deletion rules first.
