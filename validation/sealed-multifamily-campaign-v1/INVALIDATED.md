# Invalidated development rehearsal

The v1 seal is preserved but is not evidence for CF-006. Its first execution
correctly failed aggregate verification because the implementation emitted a
25-character padded field while the frozen oracle required 24 characters.

The generic formatter was repaired after that observation, so v1 necessarily
had an author bridge after unsealing. A fresh v2 campaign was sealed only after
the implementation and harness were stable. No v1 fixture, input, oracle, or
seal byte was changed.
