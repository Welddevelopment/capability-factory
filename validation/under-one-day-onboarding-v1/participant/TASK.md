# Task

Ordinary goal: **For approved dispatch request DSP-901, create exactly one draft pickup slot for vehicle VAN-12 on 2026-08-14, while leaving every other vehicle, route, and dispatch request unchanged.**

The upstream agent reached the approved scheduling step but has no configured Cedar Dispatch capability. It supplied the ordinary goal and blocked context; it did not ask for an integration.

The finished result must be established through Cedar’s approved read-side API, not the POST response. Missing credentials or permission must stop before a write. A lost response after a successful write must be reconciled without creating a duplicate.
