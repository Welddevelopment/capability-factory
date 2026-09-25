# Broad-goal private demo recording runbook

## Recording purpose and claim boundary

This is the shoot-ready route for the private approximately 90-second Daniel Gross demo. Its job is to show one clear product idea and one real causal chain, not every product feature.

Persistent on-screen boundary:

> Local fictional environment · constrained-HTTP MVP

Safe closing line:

> I built this demoable system in seven days.

The recording visibly demonstrates a live fictional local run. It does not demonstrate customer deployment, production reliability, arbitrary APIs, browser capability acquisition, or universal autonomous capability acquisition.

## Start a clean recording session

From the repository root:

```bash
./scripts/run-broad-goal-recording-demo.sh
```

Open:

```text
http://127.0.0.1:4317/playground
```

The launcher creates a new preserved session directory every time. The first run starts with a fresh capability registry. The second run creates fresh fictional business state while keeping only the verified capability registry from the first run. Stopping and relaunching gives a clean retake without deleting the prior session directory or its evidence.

Do not use the ordinary `console:dev` command for this recording: it can inherit earlier capability state and turn the first East Industrial result into `Retained Reuse`.

## Pre-recording check

Before recording, confirm all four visible facts:

1. The prompt is exactly: `Complete every fictional order due by 21:00 today, and place one safe restock for every required item that is short.`
2. The fixture is `Fictional order operations · due before 21:00`.
3. The selected scenario is `Broad goal · complete aggregate verification`.
4. The left rail says `Local fictional environment · constrained-HTTP MVP`.

If any differs, stop the process and relaunch instead of improvising.

## Exact 90-second choreography

The underlying run completes in about three seconds on the current Mac. The time allocations below are narration choices, not system wait requirements.

### 0–10 seconds — thesis and ordinary goal

Stay on Agent Playground at the top of the page.

Say:

> Agents can reason broadly, but in production they usually act through abilities chosen before the task. Capability Factory lets an agent discover and acquire the missing ability while pursuing the original goal.

Pause on the prompt. The prompt box is visibly labelled as a demo entry point; in ordinary use the same goal comes from the customer's existing agent.

### 10–17 seconds — begin one broad goal

Say:

> Here I give the agent one ordinary goal: complete every fictional order due by nine and safely restock every item that is short.

Click `Run through agent simulator` once. Wait about three seconds until the Runs view appears. Do not click again while the button says `Executing verified local plan…`.

### 17–29 seconds — parent plan and complete result

At the top of the selected parent run, pause on:

- the original goal;
- trusted scope, authority, and trusted validation;
- `Overall independently verified result`;
- `7 required / 7 satisfied / 0 blocked / 0 incorrect`.

Say:

> Capability Factory turns that into seven bounded jobs, checks authority and ordering, and verifies every result against external state. This run finishes seven of seven with zero blocked and zero incorrect.

### 29–39 seconds — diverse handling and East Industrial

Scroll down in the right-hand inspector by roughly one viewport until `East Industrial restock` is visible. Do not scroll the left run list.

Pause briefly on:

- Order 1042: `None` because the outcome was already satisfied;
- Order 1048: `Existing Ability`;
- East Industrial: `New Capability`.

Say:

> Different items resolve differently. One was already satisfied, others use configured abilities, but East Industrial needs an ability the agent does not have.

Click the `Open work-item run` link inside the open East Industrial section.

### 39–64 seconds — the acquisition loop

On the East Industrial child run, the inherited scroll position normally lands near the middle of the evidence rail. Scroll upward about half a viewport if needed so `Blocker diagnosed` is visible. Move downward steadily through these exact labels:

1. `Blocker diagnosed`
2. `Retained capability search` — `no-active-match`
3. `Trusted source search` — `no-verified-match`
4. `Unsupported residual constructed`
5. `Capability independently verified` — `passed: true`
6. `Trusted execution completed`
7. `External outcome independently verified` — `incorrectSideEffects: 0`
8. `Original goal resumed`

Say:

> I never asked it to build an integration. It diagnosed the missing ability, searched retained and trusted options first, then constructed only the unsupported HTTP residual. It independently tested that capability before use, executed within authority, checked the real resulting state, and resumed the original goal.

Do not linger on IDs, hashes, timestamps, or the recorded fixture in the left list.

### 64–78 seconds — real retention and reuse

Click `Agent Playground` in the left rail. The same goal and complete-authority scenario are restored automatically.

Say:

> Now I reset the fictional business world, but keep the capability it just verified.

Click `Run through agent simulator` once and wait about three seconds. Scroll down in the right inspector to the already-open `East Industrial restock` section. Pause on `Retained Reuse`.

Say:

> This time East Industrial is retained reuse. It does not rebuild the capability.

Opening the second East work-item run is optional. If opened, its evidence contains `Retained capability search`, execution, outcome verification, and resumption, and contains no `Unsupported residual constructed` event.

### 78–90 seconds — return to the product climax

If the East child was opened, use Browser Back once to return to the second parent run. Scroll to the top of the right inspector and finish on:

`7 required / 7 satisfied / 0 blocked / 0 incorrect`.

Say:

> The point is not connector generation. The point is that the agent acquires what it is missing and continues the original job. This is a local constrained-HTTP MVP, and I built this demoable system in seven days.

## Honest visible proof versus narrated vision

Visibly demonstrated in this recording:

- one ordinary broad goal becoming seven trusted work items;
- already-satisfied, existing-ability, newly acquired, and retained-reuse paths;
- retained-store and trusted-source search decisions;
- constrained HTTP residual construction;
- capability verification before execution;
- authority-bounded execution;
- direct external-outcome verification;
- original-goal resumption and aggregate 7/7 completion;
- fresh-world reuse without rebuilding.

Vision only, if mentioned at all:

- the same control loop acquiring modes beyond constrained HTTP APIs;
- general operation across arbitrary customer systems;
- production or customer-deployed reliability.

Do not show or discuss the lost-response demo, signed continuation, browser experiments, SDK-versus-sidecar packaging, raw test counts, or a limitations catalogue in this recording.

## Retake and failure procedure

- Wrong first-run label (`Retained Reuse` instead of `New Capability`): stop the launcher and start it again. You used inherited state or submitted twice.
- Accidental partial-authority scenario: stop and relaunch; do not edit the result into the recording.
- Double-click or unclear run selection: stop and relaunch for a clean visual chronology.
- Port 4317 already in use: stop the older console process first. If that is unsafe, launch with `CF_DEMO_CONSOLE_PORT=4318 ./scripts/run-broad-goal-recording-demo.sh` and open the matching port.
- A run does not reach the Runs view within ten seconds: stop recording, preserve the process output, and relaunch. Do not narrate around an unexplained failure.

Every relaunch creates a new session directory and prints its exact path. Prior session evidence remains recoverable; the launcher never resets or deletes it.
