# Local product-reference quickstart

Status: **developer reference — not a published SDK**

The current TypeScript reference is exported from `src/product/index.ts`. It is designed
to make the product boundaries testable before packaging or hosting decisions are locked.

## What a customer agent supplies

- `BlockedGoalContext`: the ordinary goal and precise point where the agent stopped;
- `CapabilityNeed`: the smallest diagnosed missing ability and current documentation hash;
- `AuthorityEnvelope`: customer-configured targets, credential aliases, HTTP methods, and
  write approval policy; and
- `runtimeProfile`: a local identifier used by trusted code to resolve credentials and
  network policy. It is not a credential.

## What the integrator supplies

- a `CapabilityBuilder` for the unsupported residual;
- zero or more `TrustedCapabilitySource` adapters searched before building;
- a `CapabilityVerifier` separate from the builder;
- a tenant-scoped capability store;
- a runtime resolver that holds real secrets locally;
- an optional audit event sink; and
- a workflow with execute, direct-outcome-verification, and original-goal-resume steps.

## One-call journey

The agent calls `CapabilityFactorySdk.completeBlockedGoal(request, workflow)`. A successful
result means all of the following occurred:

1. a retained or trusted existing capability was found, or an unsupported residual was built;
2. authority and capability verification passed;
3. the authorized action plan ran;
4. direct external-state verification passed with zero incorrect side effects; and
5. the original goal resumed and completed.

Anything less returns a structured handoff. In particular, a connector action returning
HTTP 200 is not treated as proof that the business outcome or original goal succeeded.

## Deployment adapters

- Use `CapabilityFactorySdk` directly for an embedded proof or earliest pilot.
- Use `createCapabilitySidecar` plus `CapabilityFactorySidecarClient` for a
  language-neutral customer-hosted local service. The reference binds to localhost and
  requires a shared local access token; production packaging needs stronger workload
  identity and token rotation.
- Use `InMemoryControlPlaneQueue` and `CustomerDataPlaneWorker` only to exercise the hybrid
  contract. Replace the in-memory queue with authenticated, durable infrastructure before
  any real use.

The hybrid reference withholds the ordinary goal and blocked prose from the control-plane
job, resolves the full request locally by ID, and sends back only a minimal completion or
handoff receipt. Detailed action outputs remain in the customer data plane.

`StructuredManifestBuilder` represents the unsupported-residual build boundary. Its
gateway receives the diagnosed need, authority aliases, and current documentation—not the
ordinary goal or secret values. Its product-only recursive template format supports nested
objects and arrays while using named-entry arrays rather than dynamic map schemas.
