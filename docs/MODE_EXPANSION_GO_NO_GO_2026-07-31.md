# Capability-mode expansion go/no-go — 2026-07-31

## Decision

Do not add trusted package/tool installation or direct database actions in this pass.

This is a product-priority decision, not a claim that either mode is impossible or unimportant
to the long-term vision.

## Census signal

The 235-organization ideal-buyer ledger contains approximately:

- 7 package/tool-relevant rows; and
- 10 database-relevant rows.

After correcting for companies where integration, tool generation, database operation or
implementation is already the product, the clean current build-gated unlock is only roughly:

- 1 package/tool case; and
- 2 database cases.

Named package/tool examples are dominated by adjacent capability/integration competitors such
as IncidentFox, Kestrel, Assemble, Parahelp and Trig. Named database examples include adjacent
or implementation-heavy companies such as Trig, Rebolt and Dataleap. Building these modes
would not turn those organizations into clean first buyers.

## Risk/architecture test

### Trusted package/tool installation

An honest implementation would need all of:

- a strict package and version allowlist;
- immutable provenance and artifact hashes;
- dependency and transitive-dependency inspection;
- isolated installation and execution;
- no install scripts by default;
- capability/OS/network/filesystem restrictions;
- rollback and quarantine;
- signature and publisher policy;
- vulnerability policy and update handling; and
- independent verification of both installation safety and useful outcome.

That is a materially wider software-supply-chain surface than the current bounded drivers.
The current lead unlock does not justify implementing a weak approximation.

### Direct database actions

An honest implementation would need all of:

- separate read and write credentials;
- exact schema/view/procedure allowlists;
- parameterized operations only;
- row/tenant scope controls;
- transaction, timeout and resource limits;
- pre/post state verification;
- duplicate and uncertain-commit reconciliation;
- rollback/compensation rules;
- sensitive-column and export controls; and
- database-specific operational hardening.

A narrow stored-procedure driver is technically feasible, but current public prospect evidence
does not establish that it reopens enough clean first-pilot buyers to outrank shared product
hardening.

## Reopening conditions

Reconsider package/tool mode if at least one high-quality prospect has a current workflow
blocked specifically on installing a trusted package/tool and the required package provenance,
permissions, verifier and rollback can be bounded.

Reconsider database mode if at least one high-quality prospect supplies a safe disposable
workflow restricted to a reviewed view or stored procedure, with scoped credentials and an
independent verifier, or if the corrected census identifies several clean prospects excluded
only by this mechanism.

## Next action

Improve the shared customer-local package across existing modes: exact backup/restore,
deactivation, sanitized immutable evidence/support exports, recovery validation and activation
readiness. These improvements remove packaging and security objections across more prospect
classes without adding an unjustified authority surface.

