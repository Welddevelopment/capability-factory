# Product-shape options

Status: **private architecture checkpoint — implemented locally where stated, not a production claim**

## Plain-English recommendation

Build one shared acquisition-and-resumption core, then initially offer it in two ways:

1. a thin SDK inside the customer's agent tells Capability Factory exactly where the
   ordinary goal became blocked; and
2. a customer-hosted runner performs credentialed actions inside the customer's trusted
   environment.

Add a hosted control plane only for coordination, verified-capability metadata, safe
telemetry, updates, and managed exception handling. Customer secrets and consequential
actions should stay in the customer data plane by default.

This is the strongest current option because it preserves the magical autonomous journey
without asking an early customer to send every credential and private record to a new
company. The embedded mode remains useful for the fastest pilot. A fully hosted runtime
can remain an optional later path for low-risk systems.

## The product loop shared by every option

1. Receive the ordinary goal and precise blocked context from the customer's agent.
2. Diagnose the smallest missing ability.
3. Search the customer's retained verified capabilities.
4. Search trusted existing tools and providers.
5. Only if the residual is unsupported, build the smallest constrained capability.
6. Check it separately against customer-granted targets, credentials, methods, and write
   authority; then independently verify its behavior.
7. Execute inside a trusted runtime.
8. Inspect external state directly instead of trusting an agent's “done” message.
9. Resume the original goal and require actual goal completion.
10. Retain the verified capability or create a precise handoff when authority or evidence
    is missing.

The local reference implementation now represents all ten boundaries. Its product-only
structured draft format can express nested request bodies through map-free named nodes,
without changing the frozen historical evaluation transport. It does not yet
contain production model-based diagnosis, live provider adapters, remote tenancy,
production authentication, billing, or a managed operations service.

## Deployment choices

| Shape | What it means in plain English | Strength | Main risk | Current state |
|---|---|---|---|---|
| Embedded SDK | A software package runs the loop inside the customer's agent process. | Fastest integration and lowest infrastructure burden. | Language coupling, process privileges, and harder fleet-wide upgrades. | Runnable local reference path. |
| Customer-hosted sidecar | The agent calls a small local service running beside it. | Language-neutral and keeps secrets/actions in the customer's environment. | Customer must operate one more service. | Runnable local HTTP reference path. |
| Hybrid split plane | A hosted service coordinates; a customer runner executes locally. | Central updates and managed fallback without centralizing secrets. | Queue security, tenancy, version compatibility, and operational complexity. | Runnable in-memory contract and customer worker; not a hosted service. |
| Fully hosted runtime | Capability Factory stores credentials and performs actions in its cloud. | Simplest onboarding for some low-risk customers. | Highest trust, compliance, breach, and data-residency burden. | Design option only; not recommended as the default first shape. |

An **SDK** is a package developers add to their software. A **sidecar** is a small service
running beside the customer's agent. A **control plane** decides and coordinates work. A
**data plane** is the part that holds credentials and performs real actions.

## Three replaceable product hypotheses

### A. Unsupported-capability acquisition runtime

Search first; if nothing adequate exists, create and verify the minimum unsupported HTTP
capability. This preserves the narrow technical wedge, but creation alone is increasingly
commoditized. It is strongest only when attached to diagnosis, authority, verification,
resumption, and retention.

### B. Orchestration over trusted existing tools

Treat Nango, Composio, Pipedream, Paragon, customer-built tools, and other approved
sources as catalogs. Search them before building. Independently verify the selected tool
against the current task and policy rather than trusting catalog presence. This may solve
most gaps cheaply while reserving the factory for the genuinely unsupported residual.

The local core has a provider-neutral trusted-source interface and a passing proof that a
verified catalog result prevents the builder from running. No live commercial-provider
adapter exists yet.

### C. Independent outcome verification, recovery, and resumption

Even when an existing tool performs the action, verify the external result directly,
detect wrong or duplicate state, return precise repair context, and require the original
agent to continue and finish its goal. This may become the most valuable layer if founder
conversations show that teams can create connectors but cannot trust autonomous outcomes.

The local SDK requires a separate outcome receipt and treats “the action ran” without
goal completion as a handoff, not success.

## Decision gates

Do not choose the commercial product shape from architecture elegance alone. Founder
conversations should answer:

- In the last ten deployments, how often did a genuinely unsupported authenticated API
  block launch?
- Did an existing provider already cover it?
- Was the expensive part creation, orchestration, authentication, permissions,
  verification, maintenance, or recovery?
- Must credentials and execution remain in the customer environment?
- Would the team install an SDK, operate a sidecar, or require a managed hosted service?
- Who owns the budget, and is this unwanted overhead or core product IP?

Until those answers exist, keep A, B, and C composable and keep all market nouns outside
the shared core.
