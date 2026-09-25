# CF-051 — progressive provider-work journey and typed evidence reuse

Date: 2026-08-14
Boundary: deterministic local development; no model/API spend, network access, customer data, deployment, or public claim

## Audit correction

The first CF-051 draft reused evidence only after the onboarding journey had already reached readiness. That saved a duplicate review, but it left CF-046 as a retrospective checklist. This was not a useful onboarding product path.

The corrected path now starts the provider-work board at the earliest defensible point: the exact append-only onboarding journey has reached CF-041 reviewed semantics after the CF-036 SDK work pack. The board can guide implementation from that point forward and then synchronize later trusted journey stages as they are produced.

## Progressive behavior implemented

`DurableCustomerLocalProviderWorkBoard` now:

- starts from an exact event-anchored CF-041 reviewed-semantics journey rather than requiring final readiness;
- treats the saved source event head as an immutable prefix member;
- accepts only monotonic append-only source extensions;
- rejects source-event deletion, rewriting, reordering, substitution, provider/work-pack changes, and same-length state changes;
- requires explicit source synchronization before new evidence can bind to a later checkpoint;
- preserves completed earlier task evidence across a later source append **only** when a
  task-specific typed validator proves that the exact saved evidence remains compatible;
- invalidates every untyped or validator-incompatible completion at the new frontier,
  including caller-shaped action-runtime and credentials/authority completions;
- continues to invalidate descendants only when the actual prerequisite task evidence is explicitly replaced;
- uses content-addressed pending release/readiness identities until those stages genuinely exist;
- renames the generic all-task state from `preparation-complete` to `evidence-collected-not-activated`, so caller-shaped JSON cannot be confused with activation or trusted preparation readiness.

Normal `start(...)` accepts only the exact `cf041-semantic-review` frontier. The old
later/final source path remains recoverable only through the separately named
`importRetrospective(...)` method, so a normal caller cannot silently turn a final journey
into a new implementation board.

The board now permanently records and digests its origin as either
`cf041-progressive` or `retrospective-import`, plus the exact imported stage and source-event
head. Those fields are present in the start input, first append-only event binding, every
snapshot, restart, and redacted export. A retrospective board therefore cannot later be
presented as if it causally began at CF-041.

## Typed reuse boundary

At the initial CF-041 checkpoint, exactly one task can be safely reused:

- `sdk-source-review`, from the exact persisted CF-036 four-role, one-to-one reviewed SDK mapping.

This reuse is not authorized by `executable`, `passed`, `independent`, or alias booleans. A task-specific validator checks the actual persisted CF-036 artifact and payload:

- artifact stage, payload digest, artifact digest, and cumulative lineage;
- self-digested work pack;
- exact provider and work-pack identity;
- exactly four required roles;
- one-to-one explicit reviews;
- exact method and SDK-provenance digests;
- conformance controls still explicitly `not-run`.

The reuse receipt records a content-addressed immutable source digest, producer-reference
digest, append-only journey validation-reference digest, and typed validation receipt
digest. The full typed validation envelope is persisted with the board evidence and is
revalidated against the exact source prefix, output artifact, output proof, validator ID
and validator version on every read—including after process restart. Application re-derives
the entire expected plan from the current source before writing anything. A caller who
changes and re-digests the wrapper JSON still cannot change the accepted semantic mapping.

The CF-051 validator is now part of a frozen built-in board registry, not a caller-supplied
trust root. The board persists and event-binds the registry pins and implementation digest.
A same-ID/version no-op validator and a same-ID/version swapped implementation are rejected
at construction; restart also requires the exact pinned built-in registry.

Artifact, proof, typed-envelope material, provider-work snapshots, and board events now live
in one durable SQLite database for the coordinated CF-051 path. Application uses one
coordinated state machine:

1. atomically stage the exact artifact/proof/envelope as `pending` while the board remains
   unchanged and incomplete;
2. validate those materials through the exact board/task/source/validator gates;
3. in one SQLite transaction, mark exactly two material rows `committed`, update the board
   snapshot, and append the completed evidence event.

No provisional board evidence/event is written. Normal board reads and exports therefore
cannot classify pending material as completed. Only the exact current coordinator process can
temporarily read its active pending stage for validation. A fresh process deletes abandoned
pending rows before serving reads and never exposes incomplete material.

The coordinator has a module-private construction path, a random durable store identity, and
module-private WeakMap bindings between the exact coordinator, board, and internal evidence
reader. Public stage/finalize/abort methods no longer exist. Caller-owned subclasses,
same-prototype plain objects, `Object.setPrototypeOf` forgeries, and substituted coordinator
objects are rejected before the plan or material is read.

Typed CF-051 evidence is also rejected by the board's ordinary public `complete(...)` method.
That means the authenticated sidecar and CLI evidence routes cannot bypass the coordinator,
even when a caller supplies a syntactically shaped typed envelope. The internal typed path
requires the live WeakMap binding, the same non-null durable store identity, an active atomic
stage, exact artifact/proof URIs, the exact plan digest and envelope, and exactly two pending
rows before the single completion transaction can begin.

Finally, CF-051 is not a retrospective reuse mechanism. Prepare, apply, and the built-in
validator all require `originMode=cf041-progressive`, imported stage
`cf041-semantic-review`, and the exact event whose append detail identifies the CF-041
frontier. A final-stage retrospective board is rejected rather than reinterpreted as causal
evidence reuse.

No generic JSON evidence is automatically reused for any other task. The remaining 13 tasks stay explicit:

| Residual class | Count | What remains |
| --- | ---: | --- |
| Engineer | 7 | Six executable implementation tasks plus signed release |
| Customer | 1 | Explicit credentials/authority confirmation |
| Independent proof | 5 | Negative controls, conformance, qualification, mandatory acceptance, host doctor |
| Total | 13 | Activation remains false |

This is intentional. CF-041 reviewed intent is not executed code. CF-037 acceptance-only compilation is not runtime or mandatory acceptance. Earlier CF-030/029/035/034 artifacts do not automatically prove a future residual implementation graph. Customer authority and executed mandatory acceptance remain explicit.

## Genuine staged actual-output route

The genuine Zephyr route now performs this sequence:

1. Produce real local CF-027, CF-026, CF-036, and CF-041 outputs.
2. Start the provider-work board while the journey is still at CF-041.
3. Apply the typed CF-036 reviewed-source reuse; 1 task is complete and 13 remain.
4. On a separate legacy board, complete generic SDK review, action runtime, observer, and
   credentials/authority tasks using caller-shaped material before the source grows.
5. Restart the onboarding journey and append CF-037, CF-030, CF-029, CF-035, CF-034, and readiness evidence.
6. Read the typed board before synchronization and verify the earlier typed evidence still exists.
7. Synchronize both boards to the final event head.
8. Verify the typed SDK review remains complete, while every generic legacy completion is
   invalidated because no task-specific typed validator proved compatibility. Residual
   owners remain unchanged and activation remains false.
9. Close both board and material store, construct genuinely new instances, then revalidate
   the persisted envelope and exact durable material/proof binding across restart.

## Adversarial coverage

Targeted attacks reject:

- stage/digest relabeling;
- truncated or changed source-event history;
- source rewrite/deletion/substitution rather than append;
- cross-provider reuse;
- stale/revoked readiness material;
- partial mandatory acceptance masquerading as complete, even after receipt re-digestion;
- proof-class conflation, even after proof re-digestion;
- an action response presented as proof, even after proof re-digestion;
- a source event change between planning and application;
- same-ID/version no-op and swapped validator substitution;
- injected crashes before stage, after stage, before the atomic transaction commit, and
  immediately after the atomic commit;
- abandoned pending durable evidence after fresh-process recovery;
- subclass and `Object.setPrototypeOf` board/coordinator forgeries;
- direct-constructor/map-reader, authenticated sidecar, and CLI attempts to submit typed
  evidence without the live atomic coordinator;
- retrospective/final-stage imports attempting to invoke CF-051 reuse;
- generic completed action-runtime and credentials/authority claims surviving a later
  source append without exact task-specific typed validators;
- normal board start from a final journey without the explicitly named retrospective import;
- retrospective origin being erased across restart or redacted export;
- typed validation mutation, source-prefix substitution, output substitution, or missing/
  changed validator after restart.

## Verification

- Targeted Vitest: 2 files, 12 tests passed.
- Repository-wide TypeScript: `tsc --noEmit` passed.
- Paid/model calls: 0.
- Network/customer data: 0.
- Execution authority effect: none.
- Activation effect: none.

## Product conclusion

CF-051 now changes the product path rather than merely auditing it afterward. An engineer can receive the exact implementation board once the provider semantics are reviewed, begin work, and carry legitimate task evidence forward as the trusted onboarding chain grows. The system removes one proven duplicate review today, but refuses to cosmetically erase the remaining code, customer authority, or independent proof work.

## Atomicity result

The coordinated CF-051 path now has no cross-database completion window. Before the atomic
transaction, recovery sees an unchanged incomplete board and removes pending material. After
the atomic transaction, recovery sees both committed content-addressed materials and the
completed board event. Crash injection at every phase verifies there is never a readable
completed board that references pending or missing material.
