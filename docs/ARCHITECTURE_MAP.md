# Capability Factory architecture map

Written 2026-08-16 from a read of the root harness modules — `worker`, `factory`,
`manifest`, `runtime`, `registry`, `verifier`, `tool-host`, `evaluation`, `freeze`.
**Structure only — no results, no verdict, no spend.** Those rot; they live in
`DAY7_REPORT.md`, `reports/`, and the engineering queue.

Purpose: let a fresh session start work without re-deriving the system.

## The one-paragraph version

An acting model receives an ordinary business goal. When it hits an operation it
cannot perform, it searches a registry of verified capabilities; failing that, it
searches service documentation and asks a **factory** to write a strict
**declarative manifest** describing the missing HTTP actions. The manifest is
validated, then probed against the real service by an **independent verifier**. Only
if it passes is it registered and installed. The worker then resumes the original
goal, and an **outcome verifier reads the database directly** to decide whether the
external world actually changed correctly.

**The model never gets network or shell access.** It emits data; a trusted runtime
interprets that data.

## Layout — two eras, both live

| Path | Files | Lines | What |
|---|---|---|---|
| `src/*.ts` (root) | 24 | 5,270 | **The original kill-test harness.** Still the smallest complete expression of the loop. |
| `src/product/` | 178 | 43,360 | The productization arc — coordination, onboarding, authority, recovery, lifecycle, and evidence |
| `src/customer-world/` | 77 | 26,456 | Customer-shaped environments and end-to-end demonstrations |
| `src/experimental/` | 32 | 8,971 | Explicitly bounded capability-family routes that remain below constrained-HTTP maturity |

**Read the root first.** It is small, complete, and the concepts in `product/`
are extensions of it. `product/` filenames often map to work-item ids
(`capability-resolution-compiler.ts`, `cf062-frozen-benchmark-runner.ts`,
`customer-local-http-authority-trust.ts`), so the engineering queue is the index.
The operator-facing surfaces live separately under `apps/console/` and
`apps/demo-bank/`; the latter currently indexes fourteen concrete demo routes.

## The loop, module by module

**`worker.ts` — `AutonomousWorker`** (92 lines, read it first)

Turn loop against OpenAI Responses, chained with `previous_response_id`.
`parallel_tool_calls: false`. Tool definitions come from the host.

- No function calls returned → status `completed`, `finalAnswer` set
- Host sets status `handed_off` → returns immediately with the handoff reason
- Wall-clock past `runTimeoutMs` → `timed_out`
- Turn cap exhausted → `failed`

Task state is persisted every turn via `TaskStateStore`. That persistence is what
makes fresh-session reuse possible.

**`factory.ts` — `ManifestGenerator`**

The build-and-repair loop. Asks the model for a manifest under a Zod-enforced
response format, then:

1. Parse against `capabilityManifestOutputSchema`
2. `runtime.validateManifest()` — static trust checks
3. `verifyCapability()` — real probes against the service
4. On failure, feed back **the exact failed check ids and details** as
   `previousValidationErrors`, plus the previous draft, and retry

It counts **two distinct failure kinds separately**: `incomplete` (model output
truncated — retried with "return one compact, complete manifest without padding")
and `validation`/semantic. Both are capped by `EXPERIMENT_LIMITS.maxRepairs`.

**`manifest.ts` — the contract**

Everything is `.strict()` — no unknown keys anywhere. Notable constraints:

- `actions`: 1–8, names match `^[a-z][a-z0-9_]{2,63}$`
- `inputSchema`: `additionalProperties: false`, and **every declared property must
  be listed as required**
- `request`: enumerated method, `pathTemplate` must start with `/`, separate
  query/header/body templates
- `response.acceptedStatuses`: 2xx only; `outputPointers` are JSON pointers
- `safety`: `idempotency` none|required, `timeoutMs` 100–10,000,
  `maxResponseBytes` ≤ 1,000,000
- `auth`: discriminated union `none | apiKey | bearer` — carries a
  **`secretAlias`, never a secret value**
- `provenance`: 64-hex `documentationHash`, model, ISO `createdAt`

**`runtime.ts` — `CapabilityRuntime`, the trust boundary**

Enforced at **two** points, which is the important design choice:

*Statically, in `validateManifest`:*
- base URL alias must resolve to an approved localhost target
- target may not contain credentials, query, or fragment
- action paths may not contain query, fragment, or backslash
- route must be allowlisted; **method + route** must be allowlisted together
- **any non-GET action must set `idempotency: "required"`** — writes cannot opt out
- sensitive auth headers must come from a secret alias, not a literal
- unknown secret alias is rejected

*At execution, on the rendered URL:*
- rendered route escaping the approved origin → `CapabilityExecutionError("allowlist")`
- rendered path and method re-checked against the allowlist
- idempotency key injected when required
- secret resolved by alias at request time; missing → `CapabilityExecutionError("credential")`

Static validation is not trusted to cover templating. **The rendered request is
checked again.** That is what stops a path template from smuggling an escape.

**`registry.ts` — `CapabilityRegistry`**

JSON-file store. `register` re-parses through the schema and stamps
`testStatus: "passed"` — the caller is responsible for only registering verified
manifests. `search` is naive term-overlap scoring over id/service/description/action
names. `install` increments `installCount`, and increments `reuseCount` when the
capability had already been installed once — **that counter is where "reuse"
evidence comes from.**

**`verifier.ts`** — independent capability verification (probes before registration)
and outcome verification. The outcome verifier reads SQLite directly rather than
believing the worker.

**`freeze.ts` / `verdict.ts`** — freeze records commit SHA, lockfile hash, prompts,
generator/verifier hashes, model settings and limits. `verdict.ts` locks the colour
immutably before baseline or reporting.

## Three traps this map originally missed

Found by a cold session actually using the map for a real change. Each would have
produced a half-applied edit.

**1. The product era keeps its OWN copy of the action safety schema.**
`src/product/builder.ts` imports from `../manifest.js` — but
`productCapabilityDraftSchema` re-declares the safety bounds by hand (line ~98),
and that copy is what gets sent to the model as a strict response format via
`src/product/openai-draft-gateway.ts`. **Change a bound in `manifest.ts` alone and
the product-era model can still emit the old value**; it only fails later on
re-parse, surfacing as a confusing repair-loop error rather than a constraint the
model ever saw. Mirror safety-bound changes in both.

**2. Stored manifests are re-parsed on EVERY read, and one bad record throws for
the whole file.** `src/product/store.ts` (twice), `src/registry.ts`, and
`src/product/catalog.ts` all run `capabilityManifestSchema.parse` at read time. So
**tightening the schema retroactively bricks existing stored registries** — not
just new manifests. This is the strongest argument for putting a new constraint in
`runtime.ts` rather than the schema: a runtime check rejects at build and execute
time without making a customer's stored records unreadable.

**3. "Check both static and rendered" is right for routes, wrong as a blanket
rule.** Routes and methods are templated, so the rendered request must be
re-checked. A non-templated scalar — a timeout, a byte cap — is read once from the
same object validation already parsed. Adding a second check there is dead code.
Apply the two-point rule to anything **templated**; once is enough for a scalar.

**Also worth knowing before editing `src/manifest.ts`:** `src/freeze.ts` hashes it
as `manifestSchemaHash` and lists it in `frozenFiles`. It has stayed
byte-identical to the Day 7 freeze while `runtime.ts` has already drifted. Editing
it spends provenance you still have. (Verify with a fresh hash comparison before
relying on this — it is only true until someone edits it for another reason.)

## Where to make a change

| Change | Touch |
|---|---|
| Worker behaviour or turn handling | `src/worker.ts` |
| Manifest shape or a new field | `src/manifest.ts` (schema) **and** `src/runtime.ts` (enforcement) |
| A new trust check | `src/runtime.ts` — add it to **both** static and rendered paths |
| Repair strategy | `src/factory.ts` |
| Prompts | `src/prompts.ts` |
| Limits, model, effort | `src/config.ts` (`EXPERIMENT_LIMITS`) |
| Scenario or world | `src/scenario.ts`, `src/company-server.ts`, `src/database.ts` |
| Evaluation flow | `src/evaluation.ts` |
| Productization work | `src/product/<work-item>.ts`, named after the queue id |

## Invariants — do not break these

1. **The model emits data, never code.** No arbitrary generated code, no shell, no
   raw network. A manifest is interpreted by a trusted runtime.
2. **Secrets live behind aliases.** A manifest naming a secret value is a defect.
3. **Every write is idempotent.** Non-GET without `idempotency: required` is
   rejected at validation.
4. **Allowlist is checked twice** — declared and rendered.
5. **The worker cannot certify itself.** Outcome verification reads the database.
6. **Registration requires a passing probe.**
7. **Freeze covers prompts, verifiers, model settings and the lockfile.** Nothing
   changes after freeze.
8. The verdict is immutable once locked.

## Reading order for deeper work

The project's own recommended order, still accurate:
`config` → `evaluation` → `prompts` → `worker` → `tool-host` → `factory` →
`manifest` → `runtime` → `verifier` → tests.

## Before writing anything external

`AGENTS.md` is the authority for claims, and it requires a fresh **website-safe
synchronization checkpoint** before any external material about what exists now,
maturity, evidence, architecture or gaps. Check its date before drafting — not
after.

## Freshness

Refreshed against 194 commits and 998 tracked files. The root harness has been
structurally stable since July; `product/`, `customer-world/`, and the demo bank
carry the later system. If the directory table above is materially wrong,
re-read. Never add results here.
