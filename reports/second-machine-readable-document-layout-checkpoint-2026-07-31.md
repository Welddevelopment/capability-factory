# Second machine-readable document layout checkpoint — 2026-07-31

## Result

The experimental document mode now supports two separate pinned one-page machine-readable PDF
order layouts:

- v1 labelled-list purchase order; and
- v2 tabular purchase order.

The v2 layout has a different title, template marker, identity labels, table header, row
grammar, control-total rule and completion marker. It is not accepted by the v1 contract and
the v1 layout is not accepted by the v2 contract.

## Demonstrated loop

The v2 table-layout route demonstrated:

1. trusted-ingress hash binding for the exact PDF;
2. retained and trusted-source search;
3. minimum capability construction from the pinned v2 template contract;
4. real machine-readable PDF parsing in a disposable no-write probe;
5. exact approval enforcement;
6. operation identity derived from immutable document identity;
7. one exclusive customer-local draft write;
8. independent verification against separate fixture ground truth;
9. original-goal resumption;
10. retained reuse on a second document;
11. lost-response reconciliation without a duplicate; and
12. fail-closed rejection of a structurally valid v1 PDF presented under the v2 contract,
    before any write.

The v2 route also completed as a durable document-mode job through the shared customer-local
package and sidecar.

## Validation

- Strict TypeScript check passed.
- Affected document, package and shared-boundary regression passed: 18/18.

## Evidence boundary

This is fictional local experimental evidence. Both layouts are generated, known, one-page and
machine-readable. This is not optical character recognition (OCR), scanned-document support,
unknown-layout inference, arbitrary PDFs, handwriting, tables spanning pages, semantic
judgment, regulated-data approval, customer evidence or production document automation.

## GTM implication

This removes the narrow objection that current PDF evidence depends on one exact labelled-list
layout. It makes document-heavy discovery and synthetic proof more credible for order,
procurement and back-office workflows. It does not remove the need to obtain a representative
customer document, agree ground truth and authority, or validate the buyer.

