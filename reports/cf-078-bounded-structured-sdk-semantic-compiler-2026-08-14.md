# CF-078 — Bounded structured SDK semantic compiler

Date: 2026-08-14  
State: additive local structured-contract compilation complete; no arbitrary-SDK, customer, activation or production claim

## Why this slice exists

The existing CF-037/CF-052 SDK route intentionally accepted only required flat primitive parameters. Real SDK actions commonly accept a fixed request object containing nested objects and homogeneous lists. Simply allowing arbitrary JavaScript objects would have reopened custom code, hidden authentication fields, unbounded payloads and ambiguous serialization.

CF-078 adds a separate versioned compiler rather than silently changing the meaning of the frozen flat compiler and its historical evidence.

## Implemented boundary

`src/product/customer-local-sdk-structured-semantic-compiler.ts` accepts:

- the exact integrity-valid CF-036 SDK work pack;
- a separately content-addressed approved structured-schema index bound to the same provider, SDK source digest and reviewed local source location;
- an explicit semantic contract whose pinned parameter metadata exactly equals that approved index;
- owner/engineer-confirmed expressions for every fixed object field and bounded array source;
- the existing separate action, no-write probe, reconciliation-readback and independent-observer roles;
- separate credential aliases and exact non-admin scopes;
- explicit stable identity, idempotency, reconcile-before-retry, independent outcome, freshness and policy rules.

The schema subset is deliberately finite:

- primitive strings, numbers and booleans;
- fixed non-empty objects with required properties and `additionalProperties: false`;
- homogeneous arrays with an explicit `maximumItems` between 1 and 100;
- at most four schema levels, 64 schema nodes and 24 properties per object;
- top-level provider arrays only where the reviewed SDK declares `Array<string>`; richer arrays can appear inside a pinned fixed request object.

There is no evaluator, generated function body, dynamic import, arbitrary transform, custom authentication, optional-parameter omission policy, union, recursion, streaming or pagination widening.

## Joined fictional route

One fresh fictional supplier SDK used the new path with four separately reviewed methods:

1. an action accepted a fixed `request` object;
2. the object contained a nested supplier object and a maximum-20 homogeneous list of line objects;
3. the no-write probe accepted the exact order reference;
4. reconciliation and the independently authenticated observer accepted a fixed query object containing the reference plus a maximum-8 homogeneous string list of requested observation fields.

The compiler first returned non-executable acceptance-only adapters. A separate local acceptance receipt then bound all ten mandatory case identifiers, zero incorrect side effects and two distinct content-addressed action/observer binding identities. The fictional route built the exact nested action payload, wrote through the action plane, reconciled through the read side, independently observed the external outcome and classified it complete. The action and observer used distinct methods, aliases, scopes and binding digests.

This receipt is intentionally labelled fictional local acceptance. It grants neither customer execution authority nor activation.

## Fail-closed controls

The focused suite rejects or stops before transport for:

- arrays over their approved bound;
- extra nested object properties;
- zero/unbounded array limits;
- authentication-shaped payload fields or source keys;
- admin/wildcard authority widening;
- a custom executable-transform discriminator;
- union declarations in the reviewed SDK method;
- recursive/cyclic schema material;
- mutated structured-schema indexes;
- structured indexes substituted to a different source location;
- conflated action and observer binding identities;
- incomplete or tampered mandatory acceptance evidence.

## Verification

- CF-078 focused suite: 10/10 passed.
- Repository strict TypeScript: passed.
- No model calls, external network, package installation, container, customer credential, customer data or spend.

A wider historical SDK regression run was also attempted. It produced 53 passing and 6 failing checks. One failure is the known sandbox denial for a localhost child-process listener. Five older signed-host checks reached their historical `usableForCf029` assertion as false. Those files do not consume the new additive CF-078 compiler, but the noisy run is not counted as green evidence and the host-state failures remain a separate diagnostic item.

## Exact remaining work

- The approved structured-schema index is trusted upstream material. CF-078 validates its digest and exact relationship to the reviewed work pack but does not itself parse arbitrary raw SDK packages or prove that a normal engineer produced the index correctly.
- The structured contract was assembled by a deterministic fixture. The durable CF-041 question/review workflow does not yet generate this richer contract without hand construction.
- Real provider serialization, custom authentication, optional fields, unions, recursion, streaming, pagination and provider-specific transforms remain unsupported.
- The local invoker and world are fictional. Real provider binding qualification, customer-environment conformance, mandatory real acceptance, authority attachment, signed release and activation remain separate gates.
- No setup-time, customer value, production reliability or broad SDK coverage claim is established.

## Strongest accurate claim

Capability Factory can now compile an explicitly reviewed SDK contract containing fixed nested objects and size-bounded homogeneous arrays from pinned provider metadata, construct the exact payload without arbitrary code, and exercise it through separate action and independent-observer bindings in a fictional local acceptance route. Unsupported or unsafe shapes fail closed, and the result remains non-activating.
