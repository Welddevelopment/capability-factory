# CF-015 frozen fair planning benchmark

Date: **2026-08-14**

Status: **passed as bounded deterministic local planning evidence; no customer, production, general-superiority or public claim**

## Question tested

Can Capability Factory diagnose route availability, synthesize typed topology
and bindings, choose the minimum unsupported residual, and distinguish an
authority blocker from a true no-route rejection on unfamiliar goals—without
beating a tool-deprived strawman?

The frozen benchmark gives all strategies the same 11-primitive registry,
typed initial evidence, authority envelope, enabled route/verifier surfaces,
ordinary goal context, deterministic compiler and 256-state-expansion budget.
The score oracle is separate and unavailable during planning.

## Benchmark family

Six frozen goals cover:

- a valid two-step linear route;
- a valid four-step fork/join route;
- a valid competing-route case where a two-step retained route has residual
  cost 0 and a direct constructed route has residual cost 2;
- a route that exists structurally but lacks privileged authority, requiring a
  precise handoff;
- an unsatisfied terminal schema, requiring rejection; and
- a route present in the registry but disabled by trusted policy, requiring
  rejection.

The valid synthesized states are passed through the real Capability Resolution
Compiler; topology, typed bindings, enabled routes, verifiers and authority must
therefore compile rather than merely match a list.

## Compared strategies

1. **CF bounded search:** deterministic cost-guided search ordered by residual
   cost, execution cost and stable primitive identity, followed by trusted
   compilation. If exact-authority search fails, a separate no-authority
   diagnostic determines handoff versus no route.
2. **Adaptive exhaustive baseline:** deterministic breadth-first enumeration of
   the same typed state space, collecting all reachable terminal states inside
   the same budget and selecting the minimum residual/execution objective.
3. **Same-tool fixed policy:** the complete registry remains available, but the
   planner can invoke only its preconfigured `normalize-a → archive-a` graph.
   This is a fixed graph/policy comparison, not a missing-tool baseline.

No model was needed: the exhaustive baseline already answers whether CF loses
correctness to a strong adaptive planner in this bounded setting.

## Sealed result

### Capability Factory

- exact outcomes: **6/6**;
- valid goals completed: **3/3**;
- invalid goals safely resolved: **3/3**;
- topology and typed bindings correct: **6/6**;
- minimum residual exact: **3/3 valid goals**;
- total residual cost: **0**;
- total valid-plan execution-cost proxy: **9**;
- latency proxy: **23 state expansions**;
- incorrect effects: **0**;
- author bridges: **0**.

### Adaptive exhaustive baseline

- exact outcomes: **6/6**;
- valid goals completed: **3/3**;
- invalid goals safely resolved: **3/3**;
- topology and typed bindings correct: **6/6**;
- minimum residual exact: **3/3 valid goals**;
- total residual cost: **0**;
- total valid-plan execution-cost proxy: **9**;
- latency proxy: **30 state expansions**;
- incorrect effects: **0**;
- author bridges: **0**.

CF and exhaustive search produced identical primitive sequences and identical
compiled plan digests for all valid goals. CF's 23 versus 30 expansions is a
small deterministic latency proxy, not evidence of broad performance
superiority.

### Same-tool fixed policy

- exact outcomes: **3/6**;
- valid goals completed: **1/3**;
- invalid goals safely resolved exactly: **2/3**;
- topology/binding score: **3/6**;
- minimum residual exact: **1/3 valid goals**;
- total completed-plan cost: **2**;
- latency proxy: **8 fixed-policy steps**;
- incorrect effects: **0**;
- author bridges: **0**.

The fixed policy completed its configured linear route and correctly rejected
the two true no-route cases. It could not synthesize the fork/join graph or the
alternative zero-residual route, and it misclassified the authority-only
blocker as unsupported rather than producing a precise handoff.

## Seal and evidence

- seal digest:
  `c07c456910cadcb4cad75d2143d9c2b0a89110e830bce00b21c7185f35069942`
- primitive-registry digest:
  `33ed1347375a7bb988a1f3701ee63ab98965b97db4cbd9154f2b3e94f49b3472`
- benchmark hash:
  `4ea58a9b8b1f16482a9f5a4ed2b3ff730b2f0ecabb99cc11ca8a6b5a209bfae0`
- oracle hash:
  `d668fc71bf775c1e90e61c779e87f2b84d1a4f36e75289f47a908b358fbd0cbc`
- planner implementation hash:
  `89fcee9563225d2a4406b0d46f7f74dcf3e68abe6fd35699d700503ca3e035b5`
- compiler hash:
  `d744765a482c05f2bedaf179db7a9602da99bc037c768b69da64bbc25b5148a8`
- receipt internal digest:
  `fcf79940f481e920d3c4948bf9c1a8be716edaf168e5f32da5b3d38816903a5f`
- receipt file SHA-256:
  `47ffa47359251580c703c80921978e3608152cf8a5d96ceb70b9ee1b3429fc6e`
- private receipt:
  `output/cf-015-frozen-planning-benchmark-v1/execution-receipt.json`.

No material or source bound by the counted seal changed after unsealing.

## Validation and boundaries

- strict TypeScript typecheck: passed;
- focused CF-015, CF-014, compiler, prior-seal integrity, durable executor,
  verified-artifact and verifier-qualification suite: **29/29 passed across
  7/7 files**;
- seal tamper test: passed by failing closed;
- author-bridge callback/expected-route tests: passed;
- `git diff --check`: passed;
- model calls and paid spend: **0 / USD 0**;
- network, containers, external systems, customers, deployment and public
  action: **0**.

This proves parity with exhaustive search only on a small, bounded, typed,
deterministic registry. It does not establish arbitrary ordinary-language
planning, large-registry search quality, learned route diagnosis, runtime
execution reliability, production latency, or superiority over adaptive agents.
The latency proxy is expansion count, not measured wall-clock service latency.
Larger and less neatly typed families may make exhaustive search infeasible and
may expose different CF search errors.
