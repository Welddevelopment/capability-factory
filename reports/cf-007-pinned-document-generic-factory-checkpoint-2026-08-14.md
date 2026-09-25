# CF-007 — pinned machine-readable document generic factory

Date: 2026-08-14

Status: local frozen clean-family checkpoint complete

## Result

CF-007 raises the existing bounded document mode through one generic factory and one executed acceptance campaign. The factory accepts approved PDF bytes only with an exact SHA-256 pin, explicit approval time, freshness bound and one declared supported layout. It produces a provenance-bound proposal and existing experimental document manifest without performing a business write.

The action runtime is separate. It requires exact tenant, parent, plan, work-item, target, action and approval authority with a live expiry. Completion comes only from a separate external-state observation against a frozen oracle. Parser output and action response are never used as completion proof.

This is local fictional evidence. It is not arbitrary PDF support, OCR, handwriting recognition, customer use or production reliability.

## Exact contracts and layouts

Two genuinely different one-page, text-layer PDF contracts were frozen:

1. `east-labeled-order@1.0.0` — `labeled-envelope-v1`
   - `Template-Version: 1`
   - labeled `Document-ID`, `PO-Number` and `Ship-To` fields
   - repeated `Line: n | SKU | quantity` rows
   - exact `END ORDER` terminator
2. `north-controlled-table@2.0.0` — `controlled-table-v2`
   - `Template Version / 2`
   - slash-delimited order identity fields
   - explicit `# | SKU | Units` table header
   - row-count `Control Total`
   - exact `DOCUMENT COMPLETE` terminator

Each contract froze three deterministic approved byte variants and hashes: valid base, malformed envelope and ambiguous identity. The factory dispatches only to the two already-declared generic parser layouts in the bounded document driver. No OCR or arbitrary layout inference was added.

## Frozen campaign

- Contracts/layouts: **2**
- Frozen declarative cases: **38** (19 per contract)
- Fixed ten-case acceptance cases executed: **20** (10 per contract)
- Additional fault cases: **18**
- Passing cases: **38/38**
- Generated proposals/manifests: **28/28**
- Factory-stage fail-closed cases before proposal: **10**
- Case-specific executable files added after freeze: **0**
- Handwritten reusable source files: **2**

The fixed acceptance contract was adapted as follows:

- read-only happy path generated a proposal with zero writes;
- approved write executed and independently verified one draft;
- fresh-process reuse closed and reopened the CF-020 lifecycle before exact continuation;
- missing credential represented a missing/mismatched approved document pin;
- missing permission removed exact document authority;
- lost response reconciled external state after commit;
- wrong/partial outcome quarantined without another write;
- restart closed/reopened the customer-local action store before observation;
- duplicate submission reused one idempotency key and produced one write; and
- conflicting parent reuse failed exact authority binding.

Additional cases covered changed pin, malformed layout, ambiguous identity, stale approval, duplicate external outcome, collateral outcome, incorrect outcome, unknown outcome and verifier unavailability for both layouts.

## Effects

- Business action writes: **10**
- Parent resumptions: **10**
- Exact retained lifecycle continuations: **10**
- Unsafe recovery quarantines: **8**
- Incorrect side effects surviving: **0**
- Model calls: **0**
- Paid spend: **$0**

The ten writes are fictional SQLite document-draft records in isolated temporary/customer-local campaign stores. They are not customer or external-system actions.

## Joined controls

- CF-005 verifier-template qualification ran separately for each contract. All mandatory controls passed, including lost-response reconciliation and adversarial action-response rejection.
- CF-016 bound each recovery decision to the exact document proposal, capability material, plan, work item, family and state version. Completed outcomes resumed; partial/incorrect/duplicate/collateral outcomes quarantined; unknown/unavailable outcomes handed off.
- CF-020 retained only verified completion, registered the exact workflow dependency and allowed continuation only through the current active non-stale version. Fresh-process reuse reopened the durable lifecycle database.
- Parent resumption used CF-016's one-time digest-bound resumption receipt after external outcome evidence.

## Preserved failure and fix

The first frozen run failed closed at `approved-write`: the proposal used document-specific key names when hashing capability material, while CF-020 recomputed its shared documentation/schema/provenance tuple. The values were identical but the semantic digest was not.

The fix changed only the proposal digest vocabulary to `documentationDigest`, `schemaDigest` and `provenanceDigest`. No lifecycle assertion was removed. The new family was resealed before the successful run. The failure is preserved in `validation/cf-007-pinned-document-clean-family-v1/DISCOVERED_FAILURES.md`.

## Reusable versus case-specific composition

Handwritten reusable code:

- `src/product/pinned-document-factory.ts`: pin/freshness checks, proposal/manifest generation, exact authority, customer-local action state and independent observation classification.
- `src/product/pinned-document-clean-family.ts`: generic fixture rendering, verifier qualification, acceptance/recovery/lifecycle orchestration and seal enforcement.

Frozen declarative material supplies both contracts, document fields, byte pins, expected statuses and fault states. There are no per-contract parser callbacks, action callbacks or verifier callbacks after freeze. Both contracts traverse the same factory, action runtime, outcome classifier, acceptance executor, recovery coordinator and lifecycle.

## Verification

- Frozen CF-007 tests: **3/3 passed**.
- Strict repository TypeScript check: passed.
- Targeted document/acceptance/verifier/recovery/lifecycle validation: **8 files / 41 tests passed**.
- Frozen family, factory and campaign implementation hashes are checked before execution.
- Diff check is run at final handoff.

No queue edit, commit, network, model, paid call, container, customer data or customer action was used. Existing historical document and sealed campaign sources were not modified.

## Remaining boundary

The factory supports only the two explicit one-page machine-readable text layouts above. It does not infer schemas, discover unknown templates, read scans, perform OCR, handle handwriting, accept multi-page documents, reason over arbitrary tables or prove general document universality. The external outcome oracle is frozen fictional campaign material; real onboarding would require a customer-local independently owned oracle/verifier and fresh acceptance evidence for that exact contract. Each layout retains its own verifier qualification and evidence; passing one does not strengthen the other.
