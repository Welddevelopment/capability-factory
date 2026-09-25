# CF-007 discovered failure preserved

## CF-007-F1 — document material digest vocabulary mismatch

The first frozen execution stopped at the first `approved-write` case before
retention. The document proposal bound the correct contract, manifest and
source-document hash values, but named them `contractDigest`, `manifestDigest`
and `approvedDocumentSha256` when calculating `capabilityMaterialDigest`.
CF-020 correctly recomputed the shared lifecycle vocabulary
`documentationDigest`, `schemaDigest`, `provenanceDigest`; the digests did not
match and retention failed closed.

Minimal fix: calculate the proposal material digest with the shared CF-020
field names while preserving the exact same values. No lifecycle check was
removed or weakened. The family and implementation were resealed before the
passing campaign was executed.
