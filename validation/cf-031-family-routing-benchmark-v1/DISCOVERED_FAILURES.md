# CF-031 discovered failures preserved

## CF-031-F1 — two opaque fixture digests had invalid lengths

The first registry load failed closed because two late fixture candidates used
short placeholder digests. They were replaced with exact 64-character opaque
digests and the registry was resealed. No digest validation was weakened.

## CF-031-F2 — evidence maturity accidentally resolved semantic ambiguity

The first ambiguous-operation run selected pinned-document because maturity was
used as a late objective tie-breaker. Both candidates had the same operation,
artifact contract, source tier, safety, latency and cost, so that choice would
have hidden a real cross-family semantic ambiguity. Ambiguity detection was
changed to run before evidence-maturity tie-breaking when no family constraint
is supplied. The benchmark now produces a precise handoff and was resealed.
