# CF-053 frozen provider-family transfer inputs v2

These files freeze CF-053's corrected unfamiliar inputs and oracle before the transfer runner is
executed. They are deliberately data-only and grant no execution authority, credential,
customer acceptance, activation, or public claim.

The two supported families are materially different while remaining inside CF-052's strict
declarative subset:

- `polar-calibration.json` uses a string request identity plus numeric and boolean fields,
  with a maintenance scheduling write plane and a separately authenticated compliance-log
  observer plane.
- `grid-curtailment.json` uses a numeric event identity plus string and boolean fields, with
  a grid dispatch write plane and a separately authenticated settlement-ledger observer
  plane.

`nested-freight-stop.json` is an intentionally unsupported control. Its required nested
shipment-line collection is outside the flat required primitive subset and must stop before
candidate generation, transport launch, authority, or any business write.

`expectations.json` is the precommitted oracle. `freeze-seal.json` pins the exact raw bytes
of every input and expectation file. Any byte change invalidates this freeze and requires a
new version rather than rewriting the result.

This v2 supersedes invalid v1 before any candidate execution. V1 was handed off and then
its two supported inputs were corrected, so the runner rejected that post-freeze mutation.
V2 starts a separate freeze only after those corrections were complete.
