# Customer intake and onboarding

Status: **controlled-pilot workflow; completing a form does not authorize access or action**

## The intake has four gates

### 1. Is there a real problem?

Ask for one recent deployment, the ordinary customer goal, exact blocked action, system,
mechanism, engineer hours, delay, economic effect, workaround and whether the work is core IP
or unwanted overhead. Do not ask “Would you use Capability Factory?” before establishing this.

### 2. Can it be reproduced safely?

Require fictional/sandbox data, no production access or personal data, reset capability,
approved documentation, explicit allowed/forbidden actions, direct success state and a list of
collateral state that must remain unchanged.

### 3. Can the adapter be scaffolded?

The internal technical owner converts customer answers into aliases, documentation paths,
bounded operations and verifier keys. Credential values never enter the intake. The adapter
scaffold remains fail-closed until customer-local runtime wiring and all acceptance cases run.

### 4. Is there a real buying path?

Record willingness to discuss a paid sandbox, economic owner and contracting path. A strong
technical case with no buyer is a research conversation, not an active pilot.

## Recommended meeting flow

1. Spend the first 15 minutes reconstructing the last ten deployments and select one real
   blocker; do not pitch continuously.
2. Separate domain/product judgment from the residual authenticated HTTP implementation.
3. Sketch the ordinary goal, exact action and independent outcome check together.
4. Agree what must never change and which missing authority must stop execution.
5. Decide: disqualified, more evidence required, synthetic reproduction, or paid-pilot
   discussion.
6. Only after that, exchange approved documentation through the agreed channel and complete
   the technical adapter draft.

## Handoff into implementation

`PilotCustomerIntake` creates four separate readiness decisions. Only
`adapterScaffoldReady` permits `adapterIntakeFromCustomerIntake()` to produce the input for
`product:adapter:new`. The generated adapter still begins not ready; this transformation is
not acceptance evidence or customer activation.

The customer-facing version should be a guided call or secure form, not an emailed request
for credentials. Store only the agreed abstract workflow and aliases in CRM. Keep approved
documentation, security material and technical artifacts in the customer-controlled project
location.
