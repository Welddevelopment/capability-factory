# CF-053 local declarative exact-record core — author-known development fixture

This directory is deliberately **not evidence** and is not an unseen provider-family case.
It exists only to develop and attack the provider-neutral CF-053 runner before any v3
held-out family is created or opened.

The fixture uses generic field names. The core is forbidden from containing fixture-specific
or future provider-specific field names. A later prospective transfer must freeze the core
and its implementation hashes before a separate author creates materially different cases.

Current private development checkpoint (2026-08-14):

- the production contract is derived from the exact durable CF-036 → CF-041 → CF-051 chain;
- a hand-authored contract can enter only the explicitly separate development boundary;
- the production registry accepts only the opaque derived-contract handle;
- trusted planning provisions the workspace issuer before the runtime candidate exists and
  anchors its public-key digest inside the immutable derived contract; runtime onboarding cannot
  mint a first trust root, and consistently replacing both plaintext root and pin still fails;
- the production authority broker revalidates the saved plan, reads the exact work-item set
  from that opaque durable trusted-workspace issuer, rejects later substitution,
  persists and rechecks the exact workspace signer pin across a fresh candidate/registry reopen, binds the
  candidate tenant plus reviewed action/observer methods and HTTP scopes, enforces bounded
  target/action/method/item/write/numeric/TTL policy, and returns only an opaque
  process-generation-bound grant;
- dependent-item authority is unavailable until the exact prerequisite item has accepted
  completion evidence;
- action and observer are separate child processes using the reviewed semantic role and
  predicate bindings; unsupported mappings fail closed;
- registry publication is SQLite-serialized, content addressed, staged, fsynced and atomic;
- process replacement uses SQLite pending/active/retired generations with one pending and one
  active generation per candidate/world, exact retired-predecessor CAS adoption, active-process
  closure before replacement, bounded retired history and explicit dead-launcher recovery;
- each child durably self-registers its PID, launch nonce, pinned source digest, token digest,
  loopback identity endpoint and a database-protected recovery credential before it can announce
  readiness; recovery after a real launcher `SIGKILL` challenges the exact live child identity
  before termination, selects pending versus active explicitly (with exact reservation or receipt
  identity where available), then deletes the exact pending reservation or retires the exact active
  receipt, and clears persisted recovery credentials when an active generation retires;
- startup removes only exact dead-owner `.stage` and world `.next` artifacts inside their
  bounded roots, leaving unrelated files untouched;
- the action child checks the active generation again immediately before a write;
- the durable world has pinned candidate/contract/world/parent-plan/stable-ID-set identities,
  bounded records, exact contiguous sequence/write/version invariants and unique fsynced atomic
  saves including directory persistence;
- parent admission calculates a conservative worst-case complete-world encoding and refuses
  a plan whose accepted inputs could exceed the 1 MiB durable-state limit mid-execution;
- request, response, launch stdout/stderr, input, contract, binding, registry and world sizes
  have explicit bounds; and
- the final parent result is freshly observed after item work rather than inferred from cached
  item receipts.

The old `provider-neutral-transfer-core` module name is now a deprecated compatibility
implementation detail. The canonical import surface is
`src/product/local-declarative-exact-record-core.ts`.

The current execution semantics are deliberately named
`local-declarative-exact-record-v1`. They execute one exact bounded record effect in the
disposable local world while binding reviewed action/observer identities, HTTP scopes,
serialization and verification predicates. This is not evidence that the reviewed provider
SDK method or a real provider transport executed. Until a real provider-operation compiler or
transport binding exists, CF-053 must not be described as provider-family execution or transfer.

The production-derived author-known path now covers two exact work items: first acquisition,
process closure and replacement, retained candidate reuse, direct item verification, a fresh
aggregate observer pass, and exactly one original-parent resume.

The focused author-known suite currently includes the genuine joined production-derived
path, saved-plan and trusted-input substitution, authority/body/contract/candidate/world and
cross-parent attacks, process replacement/adoption races and separate-process abandoned-launch
recovery, fresh-final-observation deletion, eight real worker-process
same/different registry acquisitions, exact orphan adoption, and missing/lying/+1 transport
framing controls. Passing this suite is development evidence only and is not the prospective
v3 transfer result.

`contract.json` remains an illustrative non-executable development input. It intentionally
omits the reviewed execution binding required by the current executable core and therefore
cannot be promoted to the production boundary.

Claim boundary: local fictional author-known development fixture only. It grants no customer,
provider, production, generality, activation, deployment, or public-claim evidence.
