# CF-008 discovered failure preserved

## CF-008-F1 — malformed seal-loader expression before freeze

The first implementation check did not start a campaign. The clean-family
seal loader was missing one closing parenthesis around the nested
`JSON.parse(readFileSync(...))` expression, so the TypeScript transform stopped
with `Expected ")" but found ";"`.

Minimal fix: close the parse expression. No trust, replay, action, verifier,
recovery, lifecycle or acceptance assertion was removed. The declarative
family and implementation were frozen and sealed only after the source parsed
and passed the strict TypeScript check.
