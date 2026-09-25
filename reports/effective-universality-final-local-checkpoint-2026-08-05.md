# Effective-universality final local checkpoint — 2026-08-05

## Result in plain English

The approved non-customer implementation plan is complete. Capability Factory now has one
shared safety contract for eight locally enabled digital-action families, a trusted
ordinary-goal entrance that does not ask the caller to select a mode, a fail-closed coordinator,
bounded cross-mode composition, exact-plan durability and a frozen development gate.

This is a substantially broader and more coherent local capability substrate. It is **not**
evidence that Capability Factory resolves 99.9% of real work, works universally, is production
ready or has been validated by a customer.

## Requirement audit

| Approved requirement | Implemented state | Evidence boundary |
|---|---|---|
| Define every important runtime family | Fifteen canonical families plus `extension.*` slots are registered with risk, maturity, enablement and claim boundaries. | Registration is architecture, not implementation. |
| Use complete capability bundles | Runtime, manifest, authority, pre-use/outcome verification, recovery, provenance and retention are mandatory. | A valid bundle does not prove its driver against an unknown real system. |
| Preserve high floor and uncapped ceiling | Retained → trusted existing → composed → built manifest → sandboxed residual → delegated acquisition hierarchy; new families remain additive. | The ceiling is a design path, not current evidence. |
| Accept an ordinary goal without mode selection | Public submission contains no family/mode. A planner may select only a trusted workflow/composition key; trusted local code owns gaps, routes and authority. | Current planning evidence is deterministic/local; no broad semantic-understanding claim. |
| Independent verification | Candidate fitness and external outcome are separate contracts; aggregate composition completion requires a separate observer. | Real observer quality remains system- and customer-specific. |
| Add safe high-value runtime breadth | Enabled: constrained HTTP, browser, file/EDI, signed message, pinned document, reviewed database, import-free pinned WebAssembly and signed agent delegation. | Only constrained HTTP retains the working-local-pilot-MVP label; the other seven are experimental local. |
| Compose capabilities | Bounded trusted DAGs enforce dependencies, per-leaf authority and verification, safe skip policy and aggregate outcome proof. | One genuine local tool→database composition exists; arbitrary generated workflows and general dataflow do not. |
| Survive interruption | Durable composition jobs persist/hash exact plans, reject conflicts, recover without re-planning and fail closed on corruption/verifier drift/attempt ceilings. | Customer-local single-node reference, not distributed production coordination. |
| Honest reliability accounting | Benchmark runner preserves every frozen case/error in the denominator, detects false-green compositions and uses a conservative statistical lower bound. | Case representativeness is unproved; 99.9% is a target only. |
| Frozen cross-mode development gate | Nineteen committed files cover eight enabled families and ten mandatory concerns. Latest run: 19/19 files, 95/95 tests, zero selected skips. | Local development gate only; it is explicitly non-representative. |

## Latest verification

- strict TypeScript compilation: passed;
- frozen effective-universality gate: **19 files passed, 95 tests passed, zero
  selected skips**;
- final full repository regression: **73 files passed, 11 skipped; 367 tests passed, 59
  skipped**;
- focused durable-composition tests: **7/7 passed**.

The full-suite skips retain pre-existing opt-in/environment boundaries and are not counted as
passes. The frozen gate explicitly enabled only its disposable fictional localhost EDIFACT
transport so none of its selected cases was skipped.

## Why the other seven families remain disabled

- **Native UI:** browser evidence cannot honestly be relabelled as operating-system UI. A real
  accessibility/automation sandbox and separate observer are required.
- **Shell and cloud administration:** arbitrary command or control-plane access would widen the
  blast radius beyond the current isolation and policy model.
- **Identity/account workflows:** software cannot create legal authority; credentials and
  permissions must come from an authorized principal.
- **Human delegation:** current precise handoff is not a human workforce or accountable service.
- **Device/IoT and physical/robotic action:** these require hardware-specific safety envelopes,
  emergency stops and physical outcome sensing.

Enabling toy wrappers for these families would raise a mode count while lowering product truth.
They should be implemented only when the real boundary and verifier exist.

## What would be needed for the 99.9% target

The current benchmark code calculates that an all-success sample would need roughly three
thousand representative independent trials even before harder questions about case diversity,
correlation and deployment drift. The actual path requires:

1. a defensible real-work denominator;
2. frozen unseen cases across unrelated environments;
3. real customer authority and independent observers;
4. preserved failures and side effects;
5. thousands of trials with statistical bounds; and
6. continued separation of autonomous completion from correct handoff.

Until then the accurate statement is: the architecture and local development substrate for
effective-universality experiments exist across eight bounded families; effective universality
itself is not proved.

## Activity boundary

No customer system, customer data, external account, paid API, model call, public deployment or
public claim was used or changed in this work. Unrelated working-tree files were left untouched.
