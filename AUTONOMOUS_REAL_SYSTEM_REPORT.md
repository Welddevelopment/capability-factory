# Autonomous ordinary-goal-to-real-system report

Status: **private constrained local evidence — not held-out customer evidence, production reliability, or a formal final verdict**

Date: 2026-07-26 (Asia/Seoul)

## Result in plain English

The corrected frozen v2 campaign passed the first uninterrupted model-backed reference
loop from an ordinary goal through real disposable ERPNext state and retained reuse.

For the first fictional sales order, the system:

1. received the ordinary dispatch goal and trusted state/ability/authority observations;
2. diagnosed a genuine missing HTTP capability without receiving a prewritten
   `CapabilityNeed`;
3. selected the exact frozen four-action set: read the source order, reconcile an existing
   delivery record, create one if absent, and update the exact source order;
4. converted that diagnosis into a stable trusted registry key rather than trusting the
   model's proposed name;
5. generated a constrained declarative HTTP manifest;
6. independently tested that capability against a reset disposable ERPNext fixture;
7. restored the target fixture after the probe;
8. registered and executed the verified capability;
9. checked ERPNext's database directly and found exactly one intended write with zero
   incorrect side effects; and
10. resumed and completed the ordinary goal.

For a second fictional sales order, a new SDK/coordinator instance began from a second
ordinary goal. The model independently diagnosed the same exact four-action gap. The
stable key matched the retained capability, so the coordinator reused it rather than
calling the builder. The second direct database outcome again passed with exactly one
intended write, zero incorrect side effects, and completed resumption.

## Frozen v2 result

- Campaign: `autonomous-real-erpnext-2026-07-26T09-54-51-796Z`
- Protocol: `autonomous-real-erpnext-v2`
- Passed: yes.
- Safety failure: no.
- Build diagnosis: exact 4/4 frozen actions.
- Build capability source: built.
- Build direct outcome: passed, one intended write, zero incorrect side effects.
- Build resumption: completed.
- Second diagnosis: exact 4/4 frozen actions.
- Second capability source: reused.
- Second direct outcome: passed, one intended write, zero incorrect side effects.
- Second resumption: completed.
- Source hashes unchanged: yes.
- Model calls: 3 total — two diagnoses and one manifest draft.
- Cost: USD 0.098865.

The model-generated name was not used as registry identity. Both diagnoses resolved to the
same trusted key: `http-capability-dbe7c52651f32bfc9cf8`.

## V1 chronology preserved

V1 is invalid and remains preserved. Both diagnoses selected the exact action set, but the
first goal's three drafts exhausted the smaller structured-output window. The runner then
incorrectly attempted nominal reuse after a failed build, and its probe changed the active
fixture pointer before outcome verification. It produced no valid combined verdict and
cost USD 0.848281 across six calls.

The v2 repairs were generic:

- increase the product-only structured manifest output window to 16,000 tokens;
- restore the requested fixture after disposable probing;
- do not run reuse after a failed build;
- keep deterministic registry identity and trusted companion-action enforcement.

See `AUTONOMOUS_REAL_V1_INVALIDATION.md` for the exact invalidation boundary.

## Cumulative cost

- Earlier product model-to-real-system work: USD 3.2069855 across 26 calls.
- Standalone autonomous-diagnosis work: USD 0.307790 across 32 calls.
- Combined v1 and v2 work: USD 0.947146 across 9 calls.
- Preserved cumulative product-model work: **USD 4.4619215 across 67 calls**.

This remains below Joel's USD 23 preference.

## What this establishes

- The current reference layers can connect as one uninterrupted causal loop in this
  constrained local world: ordinary goal → diagnose exact missing capability → enforce
  authority and safety dependencies → build → independently probe → execute → independently
  verify external state → resume → retain → diagnose again → reuse → complete.
- Stable deterministic registry identity is sufficient for two independently worded model
  diagnoses to find the same retained capability.
- Required reconciliation can be enforced from trusted operation metadata rather than
  relying only on a prompt.
- A real application database can serve as an outcome authority independent of model
  self-report.

## What this does not establish

- ERPNext is a disposable local synthetic world, not a customer system or independent
  third-party test.
- The host supplied trusted observations, current API documentation metadata, credentials,
  and authority configuration. The system did not discover an arbitrary private system
  from scratch.
- One corrected build-and-reuse pair does not establish production reliability or that the
  loop will always work.
- It does not prove cross-product transfer, browser/device/account/code/human/physical
  acquisition modes, customer demand, willingness to pay, security at production scale,
  latency, margins, or a locked commercial beachhead.
- It does not replace or alter the historical Day 7 verdict and is not a formal final green
  verdict.

## Recommended next evidence

Do not simply rerun the same case many times. The next strongest technical evidence is a
frozen transfer to a materially different API/application world or a founder-supplied safe
representative workflow. In parallel, test production-shape concerns that this local case
does not cover: observation-adapter integrity, multi-tenant isolation, credential
provisioning, audit visibility, cancellation, concurrency, and recovery after partial
external failure.
