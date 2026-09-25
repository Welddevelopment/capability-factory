# Screenshot provenance

These are actual browser screenshots of the existing Capability Factory operator
console, captured on 25 September 2026. They are cropped for readability; no
product text, result, status, or evidence was composited or changed.

## Route

Start `./scripts/run-broad-goal-recording-demo.sh` and open
`http://127.0.0.1:4317/playground?present=1`.

Select **Broad goal · complete aggregate verification**. The launcher supplies
the ordinary fictional order goal and an empty capability registry. The first
run acquires the East Industrial reference capability; subsequent runs reset
the fictional business state while preserving that registry.

Open the East Industrial work item to inspect the acquisition, pre-use test,
action, external-state check, and resumption event trail. Return to the playground
and submit again to see retained reuse and aggregate completion.

## What ran

- Existing local HTTP / SQLite fictional order world and real product coordinator.
- Deterministic reference planner and reference-built manifest; zero model calls.
- Actual pre-use capability probe, authority-bounded execution, separate
  external-state verification, and disk-backed retained reuse.
- First parent receipt: `playground-58dc56f3-2dbd-4fc0-8193-0749d49adfe5`.
- Displayed reuse parent: `playground-ff0fc16b-4b7a-4591-91da-83f1a6d96a43`.
- The first run and reuse run both completed seven required items with zero
  blocked items and zero incorrect side effects.

The screenshots are not frames from the older YC video and are not the separate
ERPNext/model-backed route. The README lists that evidence separately.

## Files

- `01-goal.png`: ordinary goal and selected scenario.
- `02-new-capability.png`: first-run East Industrial acquisition path.
- `03-acquire-and-test.png`: diagnosis, searches, construction and probe.
- `04-verify-and-resume.png`: execution, external check and resumption.
- `05-retained-reuse.png`: reused capability in fresh fictional business state.
- `06-goal-complete.png`: independently verified aggregate outcome.

Credential labels visible on the console are fictional aliases, not values.
