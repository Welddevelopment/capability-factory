import type { ConsoleEvent, RunSource } from "../shared/contracts.js";
import { makeConsoleEvent, recordingDigest, stableConsoleId } from "../shared/contracts.js";

const TENANT = "local-alpha";
const scope = "Constrained local run · fictional data · genuine disposable ERPNext installation";

function event(runId: string, requestId: string, type: ConsoleEvent["type"], seconds: number, payload: Record<string, unknown>, source: ConsoleEvent["sensitivity"]["source"] = "sanitized-recording") {
  return makeConsoleEvent({ tenantId: TENANT, runId, requestId, type,
    eventId: stableConsoleId("recorded-fixture-event-v1", runId, type, String(seconds)),
    occurredAt: new Date(Date.UTC(2026, 6, 26, 10, 14, seconds)).toISOString(), payload,
    sensitivity: { classification: "tenant-confidential", source, sanitized: true } });
}

export function recordedFixture() {
  const runId = "recorded-erpnext-dispatch";
  const requestId = "recorded-request-01";
  const events = [
    event(runId, requestId, "goal.received", 0, { source: "recorded-run", workflow: "Fictional dispatch readiness", goal: "Prepare the approved fictional order for dispatch and record the verified delivery reference.", scope }),
    event(runId, requestId, "diagnosis.completed", 2, { decision: "acquire-capability", summary: "The configured agent lacks the minimum documented ERP actions required to complete this goal.", evidence: ["source order inspected", "configured abilities enumerated"] }),
    event(runId, requestId, "search.retained.completed", 3, { result: "not-found", candidates: 0 }),
    event(runId, requestId, "search.trusted.completed", 4, { result: "unsupported-residual", candidates: 0 }),
    event(runId, requestId, "build.completed", 8, { result: "candidate-created", format: "constrained declarative HTTP manifest", attempts: 1 }),
    event(runId, requestId, "authority.checked", 9, { passed: true, targetAliases: ["customer_erp"], credentialAliases: ["erp_api_key"], methods: ["GET", "POST", "PUT"], writeAuthority: "preauthorized" }),
    event(runId, requestId, "capability.verification.completed", 13, { passed: true, verifier: "disposable ERPNext capability probe", checks: ["required actions", "target and method policy", "probe state", "duplicate prevention"] }),
    event(runId, requestId, "execution.completed", 16, { capabilityId: "http-capability-dbe7c52651f32bfc9cf8", receipt: "execution-receipt-recorded-01", actionsCompleted: 4 }),
    event(runId, requestId, "outcome.verification.completed", 18, { passed: true, verifier: "direct external-state verifier", intendedWrites: 1, incorrectSideEffects: 0, checks: ["one matching delivery record", "source order updated", "no duplicate record"] }),
    event(runId, requestId, "resumption.completed", 20, { completed: true, summary: "The simulated customer agent resumed and completed the original fictional goal." }),
    event(runId, requestId, "capability.retained", 21, { capabilityId: "http-capability-dbe7c52651f32bfc9cf8", origin: "built", documentationHash: "sha256:recorded-docs", actions: ["read_order", "find_delivery", "create_delivery", "update_order"], verifiedAt: "2026-07-26T10:14:13.000Z" }),
    event(runId, requestId, "run.completed", 22, { outcome: "completed", claimBoundary: scope }),
  ];
  return { events, digest: recordingDigest(events) };
}

export function playgroundEvents(runId: string, requestId: string, goal: string, mode: "complete" | "permission-handoff", source: RunSource = "agent-playground") {
  const at = (offset: number) => new Date(Date.now() + offset).toISOString();
  const make = (type: ConsoleEvent["type"], offset: number, payload: Record<string, unknown>) => makeConsoleEvent({
    tenantId: TENANT, runId, requestId, type, occurredAt: at(offset), payload,
    sensitivity: { classification: "tenant-confidential", source: "console-adapter", sanitized: true },
  });
  const common = [
    make("goal.received", 0, { source, workflow: "Agent Playground acceptance workflow", goal }),
    make("diagnosis.completed", 10, { decision: mode === "complete" ? "acquire-capability" : "request-permission", summary: mode === "complete" ? "The simulated customer agent sent blocked context through the Capability Factory SDK contract." : "The required write is outside the selected read-only policy." }),
  ];
  if (mode === "permission-handoff") return [...common,
    make("authority.checked", 20, { passed: false, writeAuthority: "denied", methods: ["GET"] }),
    make("handoff.created", 30, { handoffId: `handoff-${requestId}`, reason: "permission", missing: "Write authority for the approved action", summary: "Stopped before acquisition or execution. No business write was attempted." }),
  ];
  return [...common,
    make("search.retained.completed", 20, { result: "not-found", candidates: 0 }),
    make("search.trusted.completed", 30, { result: "unsupported-residual", candidates: 0 }),
    make("build.completed", 40, { result: "deterministic-reference-candidate", format: "constrained declarative HTTP manifest", attempts: 1 }),
    make("authority.checked", 50, { passed: true, targetAliases: ["fictional_erp"], credentialAliases: ["erp_sandbox_key"], methods: ["GET", "POST"], writeAuthority: "preauthorized" }),
    make("capability.verification.completed", 60, { passed: true, verifier: "deterministic local acceptance verifier", checks: ["schema", "authority", "disposable probe"] }),
    make("execution.completed", 70, { capabilityId: "playground-reference-capability", receipt: `receipt-${requestId}`, actionsCompleted: 2 }),
    make("outcome.verification.completed", 80, { passed: true, verifier: "deterministic fictional-state verifier", intendedWrites: 1, incorrectSideEffects: 0, checks: ["intended state exists", "no duplicate state"] }),
    make("resumption.completed", 90, { completed: true, summary: "The simulated customer agent resumed and completed the ordinary goal." }),
    make("capability.retained", 100, { capabilityId: "playground-reference-capability", origin: "built", documentationHash: "sha256:playground-docs-v1", actions: ["read_state", "create_approved_record"], verifiedAt: at(60) }),
    make("run.completed", 110, { outcome: "completed" }),
  ];
}
