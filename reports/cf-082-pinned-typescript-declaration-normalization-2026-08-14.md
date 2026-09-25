# CF-082 — Pinned TypeScript declaration normalization

Date: 2026-08-14  
State: strict local `.d.ts` normalization complete; no arbitrary TypeScript, package, runtime or customer claim

## Purpose

CF-080 removed hand transcription after receiving normalized local metadata. CF-082 moves one source step earlier for a strict TypeScript declaration subset, while preserving a hard distinction between origin bytes and normalized output.

## Mechanism

`src/product/customer-local-sdk-typescript-declaration-normalizer.ts` parses exact local `.d.ts` bytes with the installed TypeScript parser. It accepts only explicitly reviewed:

- standalone `declare class` declarations;
- one unmodified, required, non-generic declaration per reviewed method;
- required non-rest/default-free parameters;
- primitive `string`, `number` and `boolean` fields;
- inline fixed type literals;
- homogeneous `Array<T>`/`T[]` fields with an explicit JSDoc `@maximumItems` from 1 to 100.

The normalizer emits the exact CF-080 metadata shape and a separate provenance receipt binding:

- origin `.d.ts` byte digest;
- normalized output byte digest;
- provider, module and local source identity;
- reviewed class/method identities;
- normalizer implementation digest;
- method and parameter counts;
- categorical non-executable/non-authorizing state.

The receipt does not claim the normalized output behaves correctly at runtime. The output remains input to CF-080's separate exact schema reviews.

## Source pointers

Normalized methods and parameters receive deterministic declaration pointers based on class, method, overload and parameter identity. Because the complete origin bytes are hashed in the receipt, the pointers do not pretend to be a substitute for source identity. The later CF-080 review binds each emitted parameter pointer again.

## Joined exercise

One pinned fictional supplier declaration contained four reviewed methods across three declared classes. The action accepted an inline object with a nested supplier and a JSDoc-bounded maximum-20 array of line objects. The two read surfaces used inline query objects with maximum-8 string arrays.

CF-082 produced four normalized methods and four parameters. A fresh work pack was rebound to the normalized output digest and exact generated pointers, then CF-080 extracted the four approved structured schemas from those bytes.

## Fail-closed controls

The focused suite rejects:

- any import or non-class top-level statement;
- named type references;
- optional fields;
- unions and intersections;
- arrays without an explicit safe `@maximumItems`;
- overloaded/ambiguous reviewed methods;
- authentication-shaped fields or recognized secret-shaped source text;
- generic or inherited classes;
- modified/static methods;
- method implementation bodies;
- unsupported top-level rich arrays, references, index signatures, method signatures and other type-literal members through the strict AST boundary.

## Verification

- Joined CF-078/079/080/081/082 focused suite: 35/35 passed.
- Strict repository TypeScript: passed before the final report checkpoint and is rerun in the final verification pass.
- No model calls, network, package installation, customer credentials, customer data or spend.

## Remaining gaps

- Only one strict `.d.ts` subset is supported. Real SDK packages often use imports, named interfaces, generics, overloads and re-export graphs; these remain explicit stops.
- Array bounds are not inferable from TypeScript itself and require a reviewed JSDoc annotation in this subset.
- The normalizer does not generate the complete CF-036 operational SDK index: return/error semantics, auth aliases, pagination, retry and idempotency still require separate reviewed metadata.
- No package installation, executable import, provider invocation, customer conformance, acceptance or activation is established.
- No fresh-human setup-time or arbitrary-SDK coverage claim exists.

## Strongest accurate claim

Capability Factory can now normalize a byte-pinned, explicitly reviewed strict TypeScript declaration subset into the source-grounded CF-080 structured metadata format, preserving origin/output provenance and failing closed on ambiguous or executable language features.
