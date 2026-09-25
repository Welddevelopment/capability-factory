# CF-032 discovered failure preserved

## CF-032-F1 — source-seal mutation lacked an expected-contract anchor

During pre-freeze review, changing a declaration's source-seal digest could
still satisfy the structural `implementation-sealed` control because the
replacement remained a well-formed digest. The kit therefore added the full
strict family-contract digest to every compatibility receipt. Mutations are
compared to that frozen contract identity, so a structurally plausible replaced
seal is detected without weakening the individual plane checks. The package
was sealed only after this correction.
