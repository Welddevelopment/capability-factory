# Failed v1 chronology

CF-053 v1 was invalidated before candidate execution.

1. V1 was handed to the runner with both reconciliation methods still naming their
   action-plane credential aliases.
2. After handoff, the fixture author corrected exactly those two fields so reconciliation
   used the observer-side alias required by CF-052's role policy.
3. The runner compared raw bytes with the handed-off v1 seal and correctly stopped:
   - `grid-curtailment.json` changed from
     `932ef063c08e405720b0980afe4f8b42c7fa6aa915f33a61d3e082049df808a7` to
     `23fae4d39eefbc9bb5f8d18249bd0a364c2e8038b13280bfeeeda74a3ebac4d3`.
   - `polar-calibration.json` changed from
     `6ca97461ba17d88c86ae64b0843658269a71a6bc54ffdfc8f45fadb71d11eac4` to
     `d6630a1a5cc1291caebbc5fed95649cb43927a4f40f17a7e8dca53cc7d59194a`.
4. Updating v1's seal after the handoff did not repair that chronology. No v1 transfer
   result counts.
5. V2 is a separate freeze created only after both corrections and this chronology were
   final. The v2 runner must verify every raw-byte digest before reading an input.

No candidate execution, authority grant, business write, model call, external-network call,
customer claim, or activation resulted from v1.

