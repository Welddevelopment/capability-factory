# Capability health and drift

Retention only creates recurring value if a capability remains trustworthy after its first
successful use. The customer-local health layer therefore treats every retained capability
as a versioned dependency, not a permanent truth.

For each active capability it:

1. obtains the current trusted documentation hash;
2. quarantines the capability if that source changed or is unavailable;
3. otherwise performs an independent capability probe and validates the full receipt;
4. records a persistent assessment and the workflows that depend on the capability; and
5. leaves healthy capabilities active while preventing quarantined ones from automatic reuse.

A replacement must preserve the tenant and need, use a distinct ID and higher semantic
version, and pass independent verification against the current documentation. Only then is
it activated; the prior version remains quarantined and its workflow dependencies are
carried forward for visibility.

`runOnce()` is deterministic and inspectable. `start()` can schedule it at a minimum
one-minute interval, skips overlapping runs, and never silently promotes an unverified
replacement. This is local product infrastructure, not evidence of real customer drift,
an SLA, autonomous repair in production, or validated recurring willingness to pay.
