# Capability Resolution Compiler — zero-API implementation plan

Status: private planning document for review. No implementation or product
evidence is claimed by this document.

## Objective

Move Capability Factory from selecting a completely predeclared workflow to
compiling a new bounded capability-resolution graph from smaller trusted
building blocks.

The intended progression is:

```text
ordinary goal
  -> trusted observations and policy
  -> proposed work graph
  -> static safety/type/authority compilation
  -> capability route acquisition
  -> typed artifact flow
  -> independent leaf and aggregate verification
  -> parent-goal completion or exact handoff
```

The model, when later enabled, may propose intent and references. It may not
invent executable authority, credentials, runtime enablement, trusted evidence
or completion.

## Current-state audit

### What exists

- `TrustedUniversalGoalPreparer` lets a planner select one complete trusted
  workflow key.
- `TrustedUniversalCompositionPreparer` lets a planner select one complete
  predeclared DAG key.
- The universal coordinator independently checks coverage, authority, risk,
  verification and recovery for every route.
- The composition coordinator executes a bounded DAG and requires all leaves
  plus an aggregate external-state check before completing the parent.
- The verifier factory compiles a trusted declarative outcome contract against
  a separately registered observer.
- Durable composition jobs preserve and replay one exact plan without model
  replanning.
- Eight bounded runtime families are enabled behind distinct evidence labels.

### Manual assumptions still hidden inside the system

1. Trusted code supplies the complete workflow/DAG rather than smaller action
   primitives.
2. Work-item gaps and authority envelopes are already written for each case.
3. Route factories and most manifests are manually connected to each work
   item.
4. The current composition representation has dependencies but no typed
   artifact bindings between leaf outputs and downstream inputs.
5. In the genuine tool-to-database example, the calculated quantity and the
   database input are separately prepared as the same value; the runtime does
   not actually pass the verified tool result into the database action.
6. Verifier contracts are trusted inputs. The factory selects and runs an
   observer but does not construct or adversarially qualify the contract.
7. Current benchmark cases are intentionally non-representative development
   evidence.

These are the next constraints to remove. Adding another runtime family first
would increase surface area without fixing the core autonomy gap.

## Decision 1 — compile from trusted primitives, not complete workflows

### Trusted action primitive

A primitive is smaller than a workflow and larger than raw code. It declares:

- stable action key and version;
- plain-English effect;
- target alias class;
- required typed inputs;
- produced typed outputs;
- maximum risk;
- required authority and approval classes;
- supported runtime-family candidates;
- available route-builder keys;
- required observation keys;
- verifier-template key;
- retry/idempotency requirements; and
- provenance and scope.

Example primitives might be:

- `inventory.read-shortage-v1`;
- `restock.calculate-quantity-v1`;
- `supplier.create-draft-order-v1`;
- `supplier.observe-draft-order-v1`; and
- `operator.request-missing-credential-v1`.

This does not predeclare the final workflow. The compiler may assemble a new
graph from the approved primitives when their types, evidence, authority and
policies permit it.

### Planner proposal

The proposal contains only:

- decision: compile, request information, policy denied or insufficient
  evidence;
- cited trusted evidence IDs;
- bounded work-item IDs;
- selected primitive keys;
- dependency edges;
- typed input bindings by reference;
- intended terminal outcome keys;
- summary and confidence.

It cannot contain:

- credential values;
- arbitrary code or SQL;
- invented target/action/runtime/verifier keys;
- authority grants;
- literal customer-state values copied from model output;
- a claim that external work completed; or
- unbounded loops or fan-out.

## Decision 2 — trusted static compiler owns execution truth

The compiler resolves the proposal against customer-local registries and either
produces a hashed executable plan or rejects it.

Mandatory checks:

1. immutable tenant, request, parent-goal and ordinary-goal identity;
2. every evidence reference exists and is permitted for planning;
3. every primitive key/version exists and is enabled;
4. graph contains 1–32 work items and is acyclic;
5. all dependencies refer to real work items;
6. all required inputs have exactly one trusted source;
7. every artifact type/schema matches its consumer;
8. secret-class values cannot become artifacts or model-visible literals;
9. every target, action, risk and approval is inside customer authority;
10. every leaf has at least one valid acquisition route or an explicit exact
    handoff;
11. every acting leaf has a pre-use verifier and independent external-outcome
    path;
12. all consequential writes have idempotency/reconciliation rules;
13. the aggregate completion contract covers every required terminal outcome;
14. failure policy is explicit;
15. no work item can report parent completion directly; and
16. compiled plan, primitive registry and verifier registry are versioned and
    hashed before execution.

The model is therefore useful for semantic decomposition, but a malformed or
overambitious proposal cannot become executable.

## Decision 3 — typed verified artifacts, not generic shared memory

### Artifact contract

An upstream leaf may publish a `VerifiedArtifact` only after its own outcome
check passes. The artifact contains:

- artifact ID and version;
- tenant, parent-goal and producer work-item identity;
- schema key/version and content digest;
- classification: public, internal, confidential or restricted;
- provenance/evidence receipt digest;
- allowed consumer work-item IDs;
- expiry and reuse policy;
- redacted summary; and
- either encrypted customer-local content or a customer-local reference.

Credential and secret values are never valid artifacts.

### Input bindings

Downstream inputs may reference only:

- trusted configuration;
- a fresh trusted external observation;
- a verified upstream artifact; or
- a bounded literal declared by trusted policy.

Model-proposed literal business values are not executable inputs.

### Execution change required

Current routes contain fully materialized envelopes before execution. Dataflow
v2 instead needs a two-stage leaf:

1. compile an immutable route template before execution;
2. after dependencies finish, resolve and validate artifact bindings, then
   materialize the exact envelope.

Durability must persist:

- compiled graph digest;
- completed leaf receipts;
- verified artifact metadata/digests;
- materialized envelope digest for any started leaf; and
- aggregate-verification state.

Recovery may reconcile and continue the stored graph. It may not ask a model to
reinterpret completed or started work.

## Decision 4 — verifier construction is separate from execution planning

### Verifier proposal input

- trusted outcome specification;
- primitive effect and forbidden effects;
- available observation-adapter descriptors;
- before-state observation keys;
- required terminal outcomes; and
- customer policy.

### Candidate verifier contract

The candidate may select only supported declarative checks. The first version
should support:

- equals/not-equals;
- exists/absent;
- exact count;
- unique-by key;
- numeric bounds;
- before/after delta;
- set inclusion/exclusion; and
- relational equality between two observation paths.

Arbitrary verifier code generation is outside v1.

### Independence checks

An observer's claim of independence is not enough. Registry metadata should
record:

- observation source and credential alias;
- transport/process boundary;
- code and schema digest;
- acting drivers from which it is independent;
- writable versus read-only access;
- observation coverage; and
- review/version status.

The compiler rejects a verifier when execution and observation depend on the
same uncorroborated result source.

### Mandatory negative controls

Before activation, the candidate verifier must reject synthetic mutations for:

- no action occurred;
- partial action;
- duplicate action;
- wrong target;
- wrong value;
- stale prior success;
- correct primary record plus an unexpected side effect;
- executor self-report says success but external state disagrees; and
- observer unavailable or ambiguous.

A verifier that misses one mandatory mutation is rejected or requires human
review. Passing mutations is development evidence, not proof against every
real-world failure.

## Decision 5 — deterministic work precedes paid model work

No API call is required for checkpoints A–E below. A deterministic proposal
fixture stands in for the future model and exercises the exact same strict
schema and compiler boundary.

### Checkpoint A — compiler contracts and static rejection

Build:

- primitive registry contract;
- graph-proposal schema;
- compiled-plan schema;
- static compiler;
- deterministic proposal adapter;
- plan hashing/versioning; and
- adversarial mutation tests.

Finish condition:

- valid graphs compile deterministically;
- unknown keys, cycles, missing inputs, authority escalation, secret flow,
  missing verification and uncovered terminal outcomes all fail closed;
- current coordinator behavior remains unchanged.

Estimated engineering range: 4–8 hours.

### Checkpoint B — typed artifact flow and durable execution v2

Build:

- verified-artifact schema/store;
- schema registry and binding resolver;
- route-template materialization;
- artifact-aware DAG executor;
- exact retry/recovery state; and
- tenant/redaction tests.

Finish condition:

- a real upstream verified result becomes the downstream input;
- changing or corrupting the artifact/digest prevents execution;
- restart resumes without replanning or duplicate writes.

Estimated engineering range: 6–12 hours.

### Checkpoint C — verifier factory v2

Build:

- outcome-specification schema;
- extended declarative criteria;
- observer provenance registry;
- candidate compiler;
- negative-control generator and scorer; and
- qualification receipt.

Finish condition:

- a verifier is activated only when it covers the outcome, is independently
  observable and rejects every mandatory negative control;
- unavailable independent proof produces a safe unresolved state or precise
  handoff, never completion.

Estimated engineering range: 6–15 hours.

### Checkpoint D — genuine three-family local world

Recommended first world:

1. pinned document capability extracts a fictional restock request;
2. isolated trusted tool calculates an approved quantity;
3. reviewed database capability creates one draft;
4. signed message capability emits a bounded notification only after the draft
   is independently observed.

The compiler receives smaller primitives, not a complete predeclared DAG. Data
must flow through verified artifacts rather than repeated hardcoded values.

Finish condition:

- ordinary goal compiles into the correct bounded graph;
- four leaf outcomes and one aggregate outcome pass;
- duplicate, wrong quantity, stale artifact, missing approval and response-loss
  variants resolve correctly;
- exact retained reuse works on a fresh business-state run.

Estimated engineering range: 4–10 hours after A–C.

### Checkpoint E — sealed deterministic development campaign

Generate/freeze cases across:

- different valid graphs;
- multiple valid orderings;
- impossible goals;
- ambiguous goals;
- missing primitives;
- missing authority;
- incompatible artifact schemas;
- verifier gaps;
- response loss and restart;
- adversarial instructions embedded in trusted-source text; and
- false-green executor reports.

Use property/metamorphic tests so equivalent reorderings preserve outcomes and
mutations cannot silently reduce the denominator.

Finish condition:

- zero silent false completions;
- zero surviving incorrect side effects;
- all blocked cases stop for the expected reason;
- failures remain preserved in the campaign report;
- campaign remains explicitly non-representative.

Estimated engineering range: 4–10 hours.

## Paid-model confirmation — deferred funding gate

No command should make a paid call merely because an API key exists. Require all
of:

- explicit opt-in environment flag;
- API key;
- fresh campaign ID/artifact directory;
- separate hard campaign budget;
- maximum calls and outputs; and
- preflight showing deterministic checkpoints A–E pass.

### Proposed first paid campaign

Stage M1 — visible smoke development:

- three non-sealed cases;
- one proposal call per case;
- no automatic repair loop;
- abort on any invented key, evidence or authority;
- proposed global ceiling: **$1.50**.

Stage M2 — sealed confirmation only if M1 is clean:

- twelve sealed goals across several graph shapes;
- maximum one initial proposal plus one structured repair for schema failure;
- preserve every attempt and failure;
- proposed additional ceiling: **$3.50**;
- maximum combined new spend: **$5.00**, unless Joel explicitly changes it.

Immediate campaign stop conditions:

- any unauthorized action reaches execution;
- any silent false completion;
- any incorrect side effect survives cleanup;
- the model invents authority/credentials and trusted validation accepts it;
- two invalid structured proposals;
- cost ceiling or call ceiling reached; or
- test-environment integrity becomes uncertain.

Model results measure semantic planning inside frozen fictional worlds. They do
not establish customer compatibility, population representativeness or 99.9%
reliability.

## Dependency order

```text
A: contracts/static compiler
      |
      +----> B: typed artifact dataflow/durability
      |
      +----> C: verifier factory v2
                 |
                 v
         D: genuine three/four-family world
                 |
                 v
         E: sealed deterministic campaign
                 |
                 v
         M1/M2: paid model confirmation
```

B and C can proceed in parallel after A. D requires both. E requires D. Paid
model work is deliberately last.

## Reversibility

- Keep current universal coordinator, synchronous composition and durable v1
  job paths unchanged as the protected baseline.
- Add compiler/dataflow v2 through new contracts and endpoints until it passes
  the frozen gate.
- Version stored graphs and artifacts; do not migrate v1 jobs in place.
- Every checkpoint receives focused tests, full regression and its own commit.
- If application/demo timing requires the old path, the current branch remains
  runnable without compiler v2.

## Explicitly deferred

- ninth runtime family;
- arbitrary shell or cloud administration;
- arbitrary verifier-code generation;
- general native-UI/device/physical control;
- distributed/cloud execution;
- performance scaling;
- production security certification; and
- any universality or reliability percentage claim.

These are not rejected forever. They simply do not remove the largest current
manual assumption as directly as the compiler, dataflow and verifier work.
