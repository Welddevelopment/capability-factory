# Customer adapter kit

Status: **private controlled-pilot developer guide**

## What the adapter does

The reusable Capability Factory core cannot invent a customer's systems, permissions or definition of success. A customer adapter supplies those trusted facts while keeping credentials and execution inside the customer-controlled environment.

The adapter does not generate integrations itself. It connects five customer-specific pieces to the shared product:

1. trusted scope — which records, systems and completion conditions belong to the ordinary goal;
2. local credential aliases — names the runtime can resolve without exposing secret values;
3. workflows — the bounded reads and writes that may be attempted;
4. execution — the customer-local runtime and scheduler implementation; and
5. independent verification — direct inspection of external state rather than trusting an agent or API success response.

## Required module shape

An adapter module exports `pilotAdapter` or a default object implementing `ControlledPilotAdapter` from `src/product/pilot-adapter.ts`.

Its descriptor contains only IDs, aliases, documentation hashes, operation boundaries and required acceptance-case names. It must not contain credential values or production data. Runtime functions resolve real configuration locally.

The descriptor explicitly declares `capabilityMode: "constrained-http-api"`. This is the only implemented acquisition driver. A future browser or code driver must use a separate trusted adapter contract.

## Create a fail-closed scaffold

Begin with a local intake JSON rather than copying a previous customer adapter. The intake
contains only aliases, operation boundaries, verifier keys and relative paths to customer-
reviewed documentation. It must never contain a credential value.

An example is available at `examples/pilot-adapter-intake.example.json`. Create a new
scaffold with:

```bash
pnpm product:adapter:new -- \
  --input examples/pilot-adapter-intake.example.json \
  --documentation-root examples \
  --output customer-adapters/example-order-pilot
```

The command refuses to overwrite an existing directory. Documentation must be a regular
local file below the declared documentation root; absolute paths, directory traversal,
symbolic links, empty files and files above 10 MB are rejected. The command copies the
reviewed documentation, records one SHA-256 hash per source and an aggregate lock, and
generates:

- the validated alias-only adapter descriptor;
- read-before-write and reconcile-before-retry operation boundaries;
- independent-verifier outcome patterns;
- all ten acceptance cases marked `not-run`;
- a customer-specific information and authority checklist; and
- an adapter module whose preflight deliberately fails until scope, runtime and verifier
  wiring are implemented.

Scaffolding is preparation, not evidence. Never turn the generated failed checks into
hard-coded passes or describe the generated acceptance matrix as executed.

## Preflight

Run a deterministic, non-model preflight before starting the sidecar:

```bash
pnpm product:adapter:check -- path/to/customer-pilot-adapter.ts
```

The command rejects missing scope/workflow declarations, duplicate aliases, unknown documentation hashes, writes without reconcile-before-retry handling, incomplete acceptance coverage, an incorrect data boundary, and obvious credential literals.

The adapter's own `preflight()` must be read-only. It should check local service availability, documentation versions, target allowlists, credential-alias resolution and verifier access without making a consequential write.

## Mandatory acceptance cases

Every adapter must implement and later pass:

1. read-only happy path;
2. one approved write;
3. fresh-process capability reuse;
4. missing credential with zero writes;
5. missing permission with zero writes;
6. lost-response reconciliation without a duplicate;
7. wrong or partial external outcome rejected;
8. sidecar restart during a parent job;
9. duplicate parent submission; and
10. conflicting reuse of a parent ID.

Declaring these cases in the descriptor does not mean they passed. The final readiness campaign must save the actual evidence.

An executable `PilotAdapterAcceptanceHarness` is a separate object from the descriptor. Its `run()` method must return the exact case ID, pass/fail status, intended and incorrect side-effect counts, explicit checks, saved artifact references and completion time. `runPilotAdapterAcceptance()` executes the ten cases in the fixed order and immediately stops if any incorrect side effect remains. A later success can never cancel an earlier safety failure.

Use `validatePilotAdapterAcceptanceHarness()` to distinguish an adapter that merely declares the required cases from one that can actually run them. Until the executable harness exists and passes, the `adapter-kit` and `frozen-readiness-campaign` MVP gates remain open.

## Safe construction order

1. Add the descriptor using aliases and documentation hashes only.
2. Implement read-only `preflight()` checks.
3. Implement the trusted scope resolver.
4. Implement the local runtime resolver and workflows.
5. Implement direct external-state verifiers.
6. Connect the adapter with `createControlledPilotSdk()`.
7. Implement the executable acceptance harness and save every result artifact.
8. Run deterministic adapter acceptance before using a model.
9. Only then run the frozen model-backed readiness campaign.

## Boundary that must remain true

The model may propose how to divide an ordinary goal and may draft the smallest constrained HTTP capability. It cannot add systems, records, credentials, permissions, operations or completion criteria. Those facts come from the adapter and are checked by trusted code.
