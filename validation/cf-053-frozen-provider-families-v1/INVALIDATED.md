# INVALIDATED

CF-053 v1 must not be used as evidence.

After v1 was handed to the runner, two supported source files were changed to correct their
reconciliation credential aliases. The runner correctly detected the raw-byte mutation:

- `grid-curtailment.json`: handed-off seal `932ef063c08e405720b0980afe4f8b42c7fa6aa915f33a61d3e082049df808a7`;
  changed bytes `23fae4d39eefbc9bb5f8d18249bd0a364c2e8038b13280bfeeeda74a3ebac4d3`.
- `polar-calibration.json`: handed-off seal `6ca97461ba17d88c86ae64b0843658269a71a6bc54ffdfc8f45fadb71d11eac4`;
  changed bytes `d6630a1a5cc1291caebbc5fed95649cb43927a4f40f17a7e8dca53cc7d59194a`.

Exact cause: both reconciliation methods initially named the action-plane credential alias.
They were corrected to the observer-side alias required by CF-052's role policy, but the
correction happened after the freeze was handed off. Updating the v1 seal afterward did not
repair the chronology; it instead proved that v1 was no longer a valid pre-run freeze.

The runner stopped before using the mutated inputs. No v1 transfer result is valid. The
final corrected inputs are separately frozen under
`validation/cf-053-frozen-provider-families-v2/`.

