# CF-080 — Pinned structured SDK schema extraction

Date: 2026-08-14  
State: strict local normalized-metadata extractor complete; no arbitrary-package parser, customer or execution claim

## Purpose

CF-078 could validate and compile a structured schema index, and CF-079 could ask a reviewer for all case-specific mappings. The index itself was still supplied as an already structured trusted object. CF-080 removes that hand-transcription step for one explicit normalized source format.

## Input boundary

`src/product/customer-local-sdk-structured-schema-extractor.ts` consumes exact local JSON bytes whose SHA-256 must equal:

- the caller's expected source digest;
- the CF-036 work-pack SDK source digest;
- every selected role's reviewed provenance digest.

The local source path must also equal every reviewed role's exact source location. The normalized source describes provider identity, reviewed method identity, parameters, source pointers and a strict JSON-Schema-like subset. The extractor does not fetch packages, execute SDK code, resolve remote references or trust documentation prose.

Every work-pack parameter needs one exact engineer review binding role, parameter, method digest and expected schema pointer. Only after those reviews pass does the extractor emit the `approved: true` CF-078 schema index. “Approved” here means exact local source review, not execution, authority, provider correctness or customer activation.

## Supported source subset

- primitive `string`, `number` and `boolean`;
- fixed objects with `additionalProperties: false`;
- every object field explicitly required;
- homogeneous arrays with one item schema and explicit `maximumItems` from 1 to 100;
- a maximum depth inherited from CF-078;
- exact method and parameter identity matching the CF-036 work pack.

Every emitted schema node and property carries an engineer-confirmed source pointer. The final index binds the byte digest, provider, local reference, method digest, declared type, parameter pointer, exact extracted schema and review identity.

## Joined exercise

One fresh pinned normalized supplier-SDK source was built from exact local bytes. The work pack was rebound to that byte digest, four exact parameter reviews were supplied, and the extractor produced four pinned structured parameter schemas. The extracted index then replaced the earlier fixture-authored index and compiled through CF-078 without changing the structured expressions.

This shows the source-bytes → reviewed schema index → structured compiler join for the strict local format. It does not show arbitrary TypeScript package or provider documentation parsing.

## Fail-closed controls

The extractor rejects:

- `$ref`/reference-shaped schemas;
- union or missing types;
- optional/missing required object fields;
- `additionalProperties: true`;
- missing or invalid array bounds;
- authentication-shaped payload fields;
- custom transform/unknown schema fields;
- selected method substitution;
- changed source bytes under the old digest;
- local source path substitution;
- stale schema-review source pointers;
- work-pack/source/provider/cardinality mismatch.

The negative cases deliberately recomputed and rebound the mutated source byte digest into the work pack where appropriate. They therefore test semantic rejection rather than merely failing the outer hash check.

## Verification

- Joined CF-078/079/080 focused suite: 23/23 passed.
- Strict repository TypeScript: passed.
- No model calls, network, package installation, customer credentials, customer data or spend.

## Remaining gaps

- The normalized local metadata file must still be produced from the provider SDK/package. CF-080 does not parse arbitrary TypeScript declarations, language SDKs, remote documentation or package graphs.
- A human still approves every exact parameter/schema pointer and supplies workflow mappings through CF-079.
- Optional fields, discriminated unions, references, custom types, pagination, streaming, transforms and custom authentication remain unsupported.
- The extractor does not prove provider runtime behavior, independent observation, authority, conformance, real mandatory acceptance or customer activation.
- No fresh-human setup-time or customer evidence exists.

## Strongest accurate claim

Capability Factory can now derive the exact bounded CF-078 structured schema index from byte-pinned local normalized SDK metadata and explicit per-parameter reviews, preserving source provenance for every node and refusing unsafe or ambiguous schema features before compilation.
