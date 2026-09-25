# Experimental bounded-document checkpoint — 2026-07-31

## Result

A distinct local experimental document mode now performs one real machine-readable PDF
workflow:

ordinary fulfilment goal → diagnose a missing PDF-order ability → retained search →
trusted-source search → construct a capability from a pinned template contract → parse a
real disposable PDF without a business write → require exact approval → reconcile customer
draft state → create one atomic draft → compare it with separate customer-side expected
fields → resume the parent goal → retain and fresh-process reuse.

Implementation:

- `src/experimental/document-driver.ts`
- `src/experimental/document-capability-sdk.ts`
- `src/experimental/document-registry.ts`
- `src/customer-world/pdf-order-world.ts`
- `src/customer-world/run-document-expansion.ts`

The implementation uses pinned `pdfjs-dist` for extraction and `pdf-lib` for disposable
fixture generation.

## Exact boundary

Supported document shape:

- one customer-local trusted-ingress PDF;
- one page;
- machine-readable text;
- one exact title and template version;
- explicit Document-ID, purchase-order number and ship-to code;
- allowlisted line items and bounded quantities/count/bytes;
- no embedded attachments or PDF JavaScript;
- one exact draft-order approval;
- one atomic JSON draft.

Duplicate identity derives from the PDF's immutable Document-ID. The source PDF stays
read-only. A separate verifier does not call the extraction parser; it compares the draft
with customer-side expected fixture data and the immutable source hash.

## Evidence

Focused deterministic suite:

- 2 test files passed;
- 11 checks passed;
- real PDF generation and PDF.js extraction;
- zero model/API calls and no external account, customer data or deployment.

Checks cover:

1. real no-write PDF probe;
2. construction, pre-use verification, action, independent outcome verification and resumption;
3. fresh-process retained reuse;
4. missing approval;
5. lost-response reconciliation and repeat-without-duplicate;
6. caller-chosen duplicate identity refusal;
7. missing trusted-ingress receipt;
8. changed source hash;
9. unapproved item/layout;
10. scanned/no-text and multi-page document refusal;
11. semantically altered output detection and quarantine;
12. post-write verifier loss preserving unknown/one-write state;
13. tenant registry separation;
14. target-alias and path traversal refusal.

These fourteen behaviors overlap within eleven test cases and are not independent
reliability trials.

The complete ordinary regression suite then passed 54 files and 285 checks, with 11 files
and 55 opt-in/environment-dependent checks skipped.

## Demo

`pnpm demo:document`

The demo performs first-run capability construction, then fresh-process retained reuse
with a simulated lost response. It prints the complete acquisition/resumption events and
the independently read drafts.

## Supported private statement

> A separate experimental local document mode can acquire and verify one pinned,
> one-page machine-readable PDF order capability, create exactly one independently checked
> customer-local draft, reconcile an uncertain response, resume the original goal and retain
> the capability for fresh-process reuse.

## Not supported

- arbitrary PDF or document understanding;
- scans, OCR, handwriting, tables with unknown layouts or multi-page files;
- model-based extraction or confidence scoring;
- invoices, contracts, legal/clinical judgment or general document actions;
- customer validation, pilot readiness, production reliability or a formal green verdict.
