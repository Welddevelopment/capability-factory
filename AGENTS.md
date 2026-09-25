# Capability Factory engineering guidance

This is the public current-source release of Capability Factory. Start with
README.md, docs/ARCHITECTURE_MAP.md and the relevant subsystem's tests.

Preserve the control-loop boundaries: models propose, trusted code validates,
authority is checked immediately before action, and separate observers verify
external outcomes. Never promote a proposal or a declared test to passing evidence.

Keep deterministic execution and model-backed evidence distinct. Paid campaigns
require explicit approval and bounded budgets. Local demos use fictional systems;
customer-production reliability and universal acquisition are not established.

Do not commit credentials, environment files, runtime databases or private user
information. Preserve failed test history and document changes to frozen protocols.

The public website is maintained separately. This repository contains the product,
evaluation machinery, product console and demo bank.
