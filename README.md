# Capability Factory

**Infrastructure for AI agents that can resolve missing abilities while they work.**

Most deployed agents begin a task with a fixed set of tools. When the task reaches
an API, portal, document, message, database, or external service they were not
configured to use, they stop or hand the problem back to an engineer.

Capability Factory explores a different operating model:

```text
ordinary goal
  -> diagnose the exact missing capability
  -> search retained and trusted capabilities first
  -> construct only the unsupported residual
  -> verify the candidate before use
  -> check credentials, permission, approval, and policy
  -> execute inside bounded authority
  -> verify the real external outcome independently
  -> recover, quarantine, or hand off precisely when necessary
  -> resume the original goal
  -> retain the verified capability for future reuse
```

The result: an agent can expand what it can do while working toward the original
goal—and keep that ability for the next task.

[Website](https://capability-factory-website.vercel.app) ·
[How it works](#how-it-works) ·
[Architecture](docs/ARCHITECTURE_MAP.md) ·
[Demo bank](#the-demonstration-bank)

## Why this matters

More capable models can reason about work that their configured tools cannot
complete. Capability Factory makes resolving that gap part of execution itself.
The agent should discover what is missing, acquire the smallest trustworthy
ability, and continue—without sending the user away to commission another
integration.

The long-term target is effectively universal resolution of authorized digital
work across a finite set of trusted runtime families. The hard part is binding
each new action to the right authority, observable outcome, and recovery rules.
This repository implements that control loop and explores how far it can extend.

## How it works

The **14-route demo bank** shows the acquisition loop, retained reuse,
cross-system workflows, and recovery in real local systems. The screenshots below
are actual saved-run panels, captured on 25 September 2026. Each route identifies
how it was executed.

### 1. Give the agent a goal—not an integration specification

> Prepare sales order SO-REAL-0002 for dispatch today with ParcelFlow Standard
> Overnight. Record tracking PF-SO-REAL-0002 and label LABEL-SO-REAL-0002, and do
> not alter any other order.

In the model-backed ERPNext route, the agent discovers that its configured
inventory cannot complete this goal. CF searches for a retained or trusted
capability, constructs the missing constrained HTTP manifest from approved
documentation, and probes it before business use. Trusted code checks authority;
a separate observer checks the actual ERP state after execution. The original
goal resumes, and the verified capability is retained.

The same campaign then demonstrates **fresh-process reuse**, repair of a rejected
candidate, and recovery after a write succeeds but its reply is lost. CF checks
the ERP state before retrying, finds the existing delivery record, completes the
source update, and avoids creating a duplicate.

![Actual model-backed ERPNext demo results: acquisition, fresh-process reuse, repair, reconciliation and authority checks](docs/images/demo-bank/reliability-v3.png)

*Model-backed local ERPNext campaign, recorded 23 August 2026: eight cases passed.
The screenshot is the bank's genuine saved result, captured 25 September.*

### 2. Carry verified work across different kinds of systems

The **Ledger to the World** route extends the story beyond one API. A signed order
notice is authenticated, its pinned PDF is parsed, and each line enters a reviewed
database ledger. Independently verified ledger state then gates a procurement
action in disposable ERPNext and a bounded action in a native macOS Dealer Desk
app. Each leg checks its result through a separate observation channel.

```text
signed order notice → pinned PDF → reviewed ledger
                                       ↓
                              verified ledger state
                                       ↓
                          ERPNext + native Dealer Desk
```

This demonstrates a shared safety and verification approach across distinct
execution mechanisms—not just another generated connector.

![Actual five-leg demo: signed notice, pinned PDF, reviewed database, real ERPNext and native macOS action, with independent checks](docs/images/demo-bank/ledger-to-world.png)

*Genuine deterministic trusted-script pipeline, recorded 24 August 2026; its paid
model-drafting route has not run. The ERP leg uses a seeded Material Request;
the native leg records the first audited ledger line. Native desktop execution
remains a disabled research route, not a supported pilot mode.*

### 3. Expand what the agent can do—not what it is allowed to do

The acquisition loop operates inside explicit boundaries. In **Six Refusals**,
the same bank challenges six families with tampered documents, duplicate signed
messages, unapproved database writes, unsafe computation, an undeclared desktop
control, and a restricted ERP credential.

Each request is refused for the expected reason. Business actions receive
independent external-state checks; WebAssembly receives structural, behavioural
and isolation checks. These controls allow useful autonomous execution without
letting a generated capability grant itself permission.

![Actual six-family adversarial demo results: all six refusal checks passed](docs/images/demo-bank/six-refusals.png)

*Deterministic local run recorded 24 August 2026; zero model calls. All examples
use fictional local data, not customer-production systems.*

### Explore the full bank

```bash
pnpm demo:bank
```

Open **`http://127.0.0.1:4340/?all=1`** for all fourteen routes, including browser
discovery, EDI, signed delegation, and **One Goal, Many Hands**—dependency-ordered
work across three families followed by retained plan and capability reuse.

[Demo catalogue and evidence states](#the-demonstration-bank) ·
[Screenshot provenance and reproduction](docs/images/demo-bank/README.md)

## Current system

The repository has grown far beyond its original API feasibility test. It now
contains:

- a **working local pilot MVP for constrained HTTP APIs**;
- **seven additional experimental local capability routes** behind one shared,
  evidence-bounded coordinator;
- an embedded TypeScript SDK, an authenticated customer-local sidecar, and a
  dependency-free Python client;
- broad-goal decomposition, durable jobs, exact handoffs, restart recovery,
  retained reuse, capability lifecycle controls, and external-state
  reconciliation;
- an adapter and onboarding system that turns approved API material, explicit
  authority, and an observable business outcome into reviewed runtime and
  verifier contracts;
- a private operator console for runs, handoffs, capabilities, environments,
  policies, onboarding, and evidence; and
- a bank of **14 concrete demonstrations**, ranging from first-time HTTP
  acquisition to browser discovery, documents, signed messages, databases,
  WebAssembly, delegation, mixed-family workflows, and adversarial refusal.

All current evidence is local and fictional. The system has not been validated
inside a customer production environment, and the experimental routes do not
share the maturity of constrained HTTP.

## What a capability is

A capability is not merely generated code or an integration definition. In this
system it is a bound package of:

1. **Manifest** — what operation exists, what inputs it accepts, and what target
   it may address.
2. **Runtime** — trusted machinery that can execute that family of operation.
3. **Authority** — credentials, permissions, approvals, limits, and policy.
4. **Verifier** — an independent way to determine whether the intended real
   outcome occurred.
5. **Recovery semantics** — how to reconcile an uncertain result, prevent a
   duplicate, quarantine a broken route, or stop safely.
6. **Evidence and identity** — provenance, versioning, qualification, retention,
   revocation, and reuse history.

The model may propose bounded declarative data. It does not receive unrestricted
shell or network access, it cannot grant itself authority, and it cannot certify
its own success.

## Capability families

| Family | Present role | Current maturity |
|---|---|---|
| Constrained HTTP APIs | Declarative API capabilities built from trusted documentation | Working local pilot MVP |
| Authenticated browser actions | Contract-bound or discovered UI operations in real Chromium | Experimental local |
| Files and EDI | Bounded file exchange and authenticated EDIFACT transport | Experimental local |
| Signed messages and inbox actions | Authenticated message ingestion, mapping, replay refusal | Experimental local |
| Pinned documents | Machine-readable operations against approved document layouts | Experimental local |
| Scoped database actions | Reviewed single-statement operations with separate observers | Experimental local |
| Trusted compute / WebAssembly | Pinned, import-restricted computation with behavioural probes | Experimental local |
| Signed delegation | Bounded work delegated to an enrolled external service with signed receipts | Experimental local |

Native desktop UI machinery also exists as a disabled research route. It is not
counted as a supported family because its trust-boundary decision remains open.

## The demonstration bank

The demo bank contains fourteen concrete routes. Start with the original ERP
acquisition or browser discovery for the clearest model-backed story. Explore
the multi-family routes for the broader system and the refusal gauntlets for
the controls that make autonomous execution possible.

| Demo | What it demonstrates | Evidence state |
|---|---|---|
| Original ERPNext acquisition | Build one constrained procurement capability, verify it, then reuse it in a fresh process | Model-backed confirmation passed |
| Autonomous reliability R1-R8 | Acquisition, reuse, repair, lost-response reconciliation, authority stops, and unsafe-proposal refusal | Same preregistered model-backed protocol passed twice |
| Browser discovery | Observe a real local UI read-only, plan from opaque controls, perform one bounded write, verify through a separate API, then reuse | Model-backed confirmation passed |
| Browser contract | Translate a hash-pinned UI contract into a constrained browser capability and verify the real result separately | Model-backed confirmation passed |
| Reviewed database contract | Draft a bounded transaction shape while trusted code owns tenancy, allowlists, approval, and observation | Deterministic preflight; paid model path not run |
| Files / EDI | Draft a partner contract, import one bounded EDIFACT order, reject replay, and verify the database directly | Deterministic preflight; paid model path not run |
| Signed messages | Draft a message-to-action mapping while trusted code verifies signatures, timestamps, and durable replay identity | Deterministic preflight; paid model path not run |
| Pinned documents | Draft a manifest for an approved PDF layout, parse under a pin, execute with approval, and verify independently | Deterministic preflight; paid model path not run |
| WebAssembly gate gauntlet | Accept a pinned safe module; reject imports, stop infinite execution, and catch wrong behaviour | Deterministic, zero-model run passed |
| Six refusals | Six capability families each receive an adversarial request and refuse it for the correct reason with zero side effects | Deterministic, zero-model run passed |
| Signed delegation | Draft a bounded delegation contract, verify signed receipts, detect tampered persisted evidence, and quarantine reuse | Deterministic preflight passed; paid model path not run |
| Paper to ledger | One goal crosses signed message, pinned document, and reviewed database families | Deterministic reference run passed; paid model path not run |
| Ledger to the world | Extend the verified pipeline into a real disposable ERP and a native macOS app | Deterministic reference run passed; paid model path not run |
| One goal, many hands | Decompose one prose goal into dependency-ordered work across three capability families, then reuse the retained plan and contracts | Deterministic reference run passed; paid model path not run |

Start the bank locally with:

```bash
pnpm demo:bank
```

Then open `http://127.0.0.1:4340`. The default page presents the selected five
demos. Add `?all=1` to inspect the full board. Free preflights never trigger a
paid model call; live buttons require an explicit confirmation.

## Strongest evidence

### Targeted acquisition campaign

A frozen, preregistered campaign passed all five cases and all eight model-backed
runs with zero incorrect side effects. It covered build and reuse across two
authentication types, handoff where no compatible product existed, refusal
without write permission, and structured-error recovery.

### Autonomous reliability protocol

An eight-case preregistered protocol on a genuine disposable local ERP system
passed twice under the same preregistered protocol. It covered:

- capability acquisition from an ordinary goal;
- fresh-process retained reuse;
- a materially different workflow;
- bounded repair after a failed verification;
- reconciliation after a write succeeded but its response was lost;
- safe stops for a missing credential and missing permission; and
- refusal of an unsafe proposal.

Both runs completed with zero safety failures. These are frozen local cases with
fictional data: they demonstrate the mechanism and its safety behaviour, not
statistical reliability or generality.

### Adversarial refusal

The six-refusals gauntlet drives hostile inputs through six distinct capability
families in one deterministic run. Each family must reject the request for its
documented reason, and a separate observation channel verifies that no prohibited
side effect occurred.

## Architecture

```text
Existing agent / operator
        |
        v
Goal + blocked-context contract
        |
        v
Trusted planning and capability-family routing
        |
        +----> retained capability search
        +----> trusted existing source search
        +----> smallest unsupported residual
        |
        v
Candidate qualification -----> fail / repair / quarantine
        |
        v
Live authority check at the action boundary
        |
        v
Customer-local action runtime
        |
        v
Independent read-only outcome observer
        |
        +----> completed: resume + retain
        +----> not started: bounded retry policy
        +----> partial / incorrect / unknown: stop, incident, handoff
```

The design keeps several identities separate:

- what the model proposed;
- what a reviewer confirmed;
- what trusted code compiled;
- what authority permitted at the moment of action;
- what the action runtime reported; and
- what an independent observer found in the external system.

That separation is the core safety property. A convincing action response is not
proof that the world changed correctly.

## Repository map

| Path | Purpose |
|---|---|
| `src/` | Original compact acquisition harness and frozen experiment machinery |
| `src/product/` | Coordinator, onboarding, authority, lifecycle, sidecar, verification, packaging, and evidence systems |
| `src/customer-world/` | Disposable customer-shaped systems and end-to-end demonstrations |
| `src/experimental/` | Explicitly bounded capability-family drivers that have not been promoted to HTTP maturity |
| `apps/console/` | Private operator console and demonstration entrance |
| `apps/demo-bank/` | Launcher, preflight controls, scoreboards, and preserved demo history |
| `clients/python/` | Dependency-free Python client for the customer-local sidecar |
| `validation/` | Frozen provider families and onboarding comparison packages |
| `development/` | Preserved development freezes and adversarial iterations |
| `docs/` | Architecture, product contracts, operating runbooks, and claim boundaries |
| `reports/` | Sanitized technical checkpoints; raw artifacts remain ignored |

For a deeper map, read [`docs/ARCHITECTURE_MAP.md`](./docs/ARCHITECTURE_MAP.md).

## Quick start

### Requirements

- Node.js 24+
- pnpm 11+
- an OpenAI API key only for commands that explicitly execute a model-backed run
- Docker/Colima only for demonstrations that use the disposable ERPNext or Gitea
  environments

### Install and verify

```bash
pnpm install
pnpm typecheck
pnpm test
```

### Start the operator console

```bash
pnpm console:dev
```

### Run the broad-goal recording environment

```bash
./scripts/run-broad-goal-recording-demo.sh
```

Open `http://127.0.0.1:4317/playground`. The route creates a fresh fictional
business world, demonstrates first-time capability acquisition, then resets the
world while retaining the verified capability so reuse can be shown honestly.

### Inspect the original experiment

```bash
pnpm eval:dev --case cold-shipment
pnpm eval:freeze
pnpm eval:heldout
pnpm eval:edge
```

The original kill test remains preserved because failures and frozen evidence
should not be rewritten when the product improves. Its historical verdict is an
audit record, not the current product headline.

## Safety invariants

1. **The model proposes data, not unrestricted code.** Bounded structured output
   is compiled and interpreted by trusted runtimes.
2. **Authority is external to capability generation.** Missing credentials,
   permission, approval, or human judgment cause an exact stop.
3. **Secrets remain behind aliases or customer-local handles.** They are not
   embedded in manifests or evidence.
4. **Every consequential write is bounded and reconciled.** The system checks
   external state before retrying an uncertain result.
5. **The action path cannot certify itself.** Independent read-only observers
   determine the outcome.
6. **Capability identity is durable.** Registration, qualification, versioning,
   revocation, quarantine, replacement, and reuse are explicit.
7. **Evidence types remain separate.** Deterministic plumbing, model-backed
   behaviour, individual capability families, and customer validation are never
   merged into one score.
8. **Failures remain visible.** Frozen campaigns and superseded attempts are
   preserved rather than silently replaced by later successes.

## Evidence discipline

Paid campaigns are preregistered, source-frozen, budget-capped in code, and
settled per call in a durable ledger. Deterministic tests prove trusted machinery;
they are not relabelled as evidence that a model made the correct decision.
Conversely, a model-backed pass does not make an experimental capability family
production-ready.

Raw artifacts, secrets, local databases, and customer-shaped state are ignored by
Git. Sanitized reports are the repository's durable evidence surface.

## Current evidence boundary

Evidence comes from local fictional systems, including genuine disposable
ERPNext and Gitea installations. Constrained HTTP is the most mature route;
the other families are experimental. Customer production use, arbitrary-system
support, and setup by an independent engineer remain to be established.

The repository demonstrates that a bounded version of the full loop can be made
real: diagnose, acquire, verify, act, inspect the world independently, recover
safely, resume, and retain. The remaining question is how far that loop can be
generalized while preserving the authority and evidence boundaries that make it
trustworthy.

## Build trajectory and wider direction

Joel Jeon began Capability Factory at 15. The initial constrained-HTTP MVP was
built in six calendar days; the broader runtime families, onboarding, reliability
and operational work in this repository came afterwards. The six-day claim
belongs to that first MVP, not the entire present system.

Capability Factory is the capability-acquisition layer of a wider research and
product direction:

- [Dynamic Agent Specialisation](https://github.com/Welddevelopment/dynamic-agent-specialisation)
  constructs, compares and retains specialist agents.
- [Agent Fleet Brain](https://github.com/Welddevelopment/agent-fleet-brain)
  explores how a changing workforce of agents can pursue a broad goal together.

CF supplies the roads; DAS builds the workers; Fleet Brain coordinates the work.
They are separate repositories with separate evidence. The eventual vision is
a workforce that can acquire both the right specialist and the right capability
as new work arrives; a production integration of all three is not claimed here.

## Recommended reading

1. [`docs/ARCHITECTURE_MAP.md`](./docs/ARCHITECTURE_MAP.md) — system map and
   invariants.
2. [`docs/CONTROLLED_PILOT_MVP_CONTRACT.md`](./docs/CONTROLLED_PILOT_MVP_CONTRACT.md)
   — the constrained-HTTP product boundary.
3. [`docs/EFFECTIVE_UNIVERSALITY_ARCHITECTURE_2026-08-05.md`](./docs/EFFECTIVE_UNIVERSALITY_ARCHITECTURE_2026-08-05.md)
   — the broader capability-family architecture.
4. [`docs/CF_ONBOARDING_CLAIM_AND_RESPONSIBILITY_LEDGER_2026-08-12.md`](./docs/CF_ONBOARDING_CLAIM_AND_RESPONSIBILITY_LEDGER_2026-08-12.md)
   — what the system automates and what still belongs to engineers or customers.
5. [`AUTONOMOUS_RELIABILITY_CAMPAIGN_REPORT.md`](./AUTONOMOUS_RELIABILITY_CAMPAIGN_REPORT.md)
   — the frozen reliability evidence.
6. [`reports/website-safe-checkpoint-2026-08-24.md`](./reports/website-safe-checkpoint-2026-08-24.md)
   — the current external-claim boundary.
