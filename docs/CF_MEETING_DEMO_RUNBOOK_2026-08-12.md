# Capability Factory meeting demo runbook

Status: **verified locally on 2026-08-12; deterministic fictional constrained-HTTP route**

## Start

From `/Users/joeljeon/Desktop/Capability Factory`:

```bash
./scripts/run-broad-goal-recording-demo.sh
```

Open `http://127.0.0.1:4317/playground`.

Every launch creates a new preserved session directory. The first run receives a fresh capability registry. The second run resets the fictional business state while retaining only the capability verified in the first run. Do not use the normal console development command for this demo.

Before beginning, visibly confirm:

- goal: `Complete every fictional order due by 21:00 today, and place one safe restock for every required item that is short.`
- fixture: `Fictional order operations · due before 21:00`;
- scenario: `Broad goal · complete aggregate verification`;
- boundary: `HTTP local pilot MVP · adjacent modes experimental`.

## Two-to-three-minute sequence

### 0:00–0:25 — ordinary goal

Stay on **Agent Playground**.

Say: “Agents usually begin work with a fixed set of abilities. Capability Factory lets an agent discover that a required ability is missing, acquire the smallest safe one, and continue the original job.”

Point out that the prompt is a demo entrance. In ordinary use, the same goal comes from the customer’s existing agent through the SDK or local sidecar. Click **Run through agent simulator** once.

### 0:25–0:55 — the completed parent goal

On the parent run, pause on:

- `Overall independently verified result`;
- `7 required / 7 satisfied / 0 blocked / 0 incorrect`;
- Order 1042: `None`;
- Order 1048: `Existing Ability`;
- East Industrial: `New Capability`.

Say: “One broad goal became seven bounded pieces of work. Some needed no action, one used an existing ability, and East Industrial exposed a genuinely missing ability.”

Open the East Industrial work-item run.

### 0:55–1:50 — acquisition, authority, and proof

Move steadily through these visible labels:

1. `Customer authority checked` — permissioned target, credential aliases, methods, and write policy;
2. `Blocker diagnosed` — `missing-capability`;
3. `Retained capability search` — `no-active-match`;
4. `Trusted source search` — `no-verified-match`;
5. `Unsupported residual constructed` — constrained declarative HTTP manifest;
6. `Capability independently verified` — `passed: true`;
7. `Trusted execution completed` — `executionPath: new-capability`;
8. `External outcome independently verified` — `incorrectSideEffects: 0`;
9. `Original goal resumed` — `completed: true`.

Say: “I did not ask it to build an integration. The working agent diagnosed the gap, searched for a trusted existing route, constructed only the unsupported HTTP residual, tested it before use, acted inside the configured authority, checked the real resulting state separately, and resumed the original goal.”

### 1:50–2:30 — retained reuse and climax

Return to **Agent Playground**. The goal and complete-authority scenario are restored. Say: “Now I reset the fictional business world but keep the verified capability.” Click once and wait for the new parent run.

Pause on East Industrial: `Retained Reuse`. If useful, open it and show:

- `Retained capability search` — `verified-match` with one candidate;
- no `Unsupported residual constructed` event;
- external-outcome verification and original-goal resumption still occur.

Finish on the second parent’s `7 required / 7 satisfied / 0 blocked / 0 incorrect` summary.

Say: “The climax is not connector generation. The agent acquired what it was missing, retained it, and completed the original job.”

## What is live versus preserved

Live and deterministic:

- every click creates a new run against a fresh fictional local business state;
- the first take starts with a fresh capability registry and performs the acquisition path;
- the second take keeps that registry and demonstrates real retained reuse;
- work-item and aggregate results are generated through the local product coordinator and console event path.

Preserved/replayed:

- the sidebar includes one older recorded reference run; do not select it;
- the fallback images below are screenshots captured from the genuine verified local session, not a fabricated or manually assembled run.

## Offline fallback

If the live route cannot be restored immediately, open these locally in order:

1. `reports/assets/meeting-demo-2026-08-12/00-clean-playground.jpg`
2. `reports/assets/meeting-demo-2026-08-12/01-first-run-parent-new-capability.jpg`
3. `reports/assets/meeting-demo-2026-08-12/03-first-run-acquisition-evidence.jpg`
4. `reports/assets/meeting-demo-2026-08-12/02-retained-reuse-parent.jpg`

One-sentence recovery:

> “The live local console has failed to start cleanly, so I’ll show the preserved evidence from the same genuine deterministic route rather than improvise or misrepresent a run.”

## Truthful claims

Safe:

- working local pilot MVP for constrained HTTP APIs;
- ordinary goal inside a predefined trusted scope;
- missing-capability diagnosis, trusted/retained search, constrained construction, pre-use verification, explicit authority, separate external-state verification, resumption, retention, and fresh-world reuse;
- fictional local development environment with no customer data;
- the prompt box is a demonstration entrance to the same coordinator path, while a real integration supplies goals through the SDK or sidecar.

Avoid:

- arbitrary goals or systems;
- no-setup or universal capability acquisition;
- production readiness or reliability;
- customer deployment, customers, revenue, or validated demand;
- claiming every capability mode has constrained-HTTP quality;
- claiming the fallback screenshots are a live run.

## Verification receipt

The 2026-08-12 clean session demonstrated:

- first parent: 7/7 satisfied, 0 blocked, 0 incorrect;
- East first run: new capability, separate pre-use and post-action verification, and resumption;
- second parent: retained reuse, 7/7 satisfied, 0 blocked, 0 incorrect;
- retained child: `verified-match`, no residual construction, external verification, and resumption.

The session’s underlying evidence was preserved by the launcher in its printed temporary session directory. The repository fallback images are presentation artifacts only; product evidence remains the run/event data.
