# Demo-bank screenshots

These are unaltered browser captures of Capability Factory's newer 14-route demo
bank at `http://127.0.0.1:4340/?all=1`. They were captured on 25 September 2026
from the existing local application, using a 1220 × 1000 browser viewport and
element screenshots of the complete demo cards.

The cards display preserved genuine execution results. Capturing them did not
execute a new campaign, make a model call, or manufacture result data. These are
not the older seven-item Agent Playground and are not frames from the YC video.

## Capture-to-evidence mapping

| Image | Route | Displayed evidence |
|---|---|---|
| `reliability-v3.png` | Autonomous reliability campaign R1–R8 | Genuine model-backed ERPNext campaign, 23 August 2026; eight cases passed |
| `ledger-to-world.png` | Ledger to the World | Genuine deterministic five-leg pipeline, 24 August 2026; all five legs passed |
| `six-refusals.png` | Six Refusals | Genuine deterministic six-family adversarial run, 24 August 2026; all six checks passed |

The corresponding original local evidence paths are:

- `artifacts/reliability-campaign/autonomous-reliability-v3-2026-08-23T22-48-21-528Z/result.json`
  and its per-case results.
- `artifacts/ledger-to-world/takes/2026-08-24T02-05-31-887Z/result.json`.
- `artifacts/six-refusals/takes/2026-08-24T01-43-44-054Z/result.json`.

These generated run directories are not bundled into this source release.
The checked-in images preserve the displayed receipts; cloning the source does
not automatically recreate historical results.

## Open and reproduce

From the repository root after installing the project dependencies:

```bash
pnpm demo:bank
```

Open `http://127.0.0.1:4340/?all=1`. The default route without `?all=1`
shows five selected demos; the full bank exposes fourteen.

The bank source at `apps/demo-bank/server.ts` records each route's command,
prerequisites, output directory and cost boundary. Opening the page does not
execute a route. Inspect the prerequisites before running: the ERP routes need
the disposable ERPNext environment, and native routes additionally need the
Dealer Desk app and macOS Accessibility permission. Missing prerequisites stop
the route instead of producing a substitute result.

Use the explicit preflight or run controls only when their dependencies are
available. Paid model-backed takes require confirmation. A deterministic
preflight is not evidence that the corresponding paid model path has run.

## Interpretation boundaries

- R1–R8 includes model-backed acquisition, reuse, repair and recovery, plus a
  deterministic unsafe-proposal refusal. It is local fictional ERP evidence.
- Ledger to the World is a trusted-script composition of separately verified
  legs, not one model autonomously planning all five. Its paid drafting variant
  has not run; the ERP/native legs are deterministic in either variant.
- The ERP leg acts on a seeded Material Request. The native leg records the first
  audited ledger line; this is not identical full-order replication across both
  systems.
- Native desktop execution is a disabled research route, not a supported family.
- Six Refusals is deterministic and uses no model calls.
- Visible addresses and identifiers are fictional fixture values, not customer
  identities or credential values.

