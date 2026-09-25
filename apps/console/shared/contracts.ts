import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const CONSOLE_SCHEMA_VERSION = "1.0" as const;

export const runSourceSchema = z.enum([
  "agent-playground",
  "coordinator-work-item",
  "embedded-sdk",
  "customer-sidecar",
  "recorded-run",
]);
export type RunSource = z.infer<typeof runSourceSchema>;

export const eventTypeSchema = z.enum([
  "goal.received", "diagnosis.completed", "search.retained.completed",
  "search.trusted.completed", "build.completed", "authority.checked",
  "capability.verification.completed", "execution.completed", "execution.failed",
  "execution.reconciled", "outcome.verification.completed", "resumption.completed",
  "capability.retained", "capability.quarantined", "capability.revoked",
  "handoff.created", "handoff.lifecycle.changed", "handoff.continuation.authorized", "run.completed",
  "environment.acceptance.completed", "policy.draft.created", "policy.validated",
  "policy.acceptance.completed", "policy.activated",
  "goal.plan.proposed", "goal.plan.validated", "work-item.created",
  "work-item.started", "work-item.completed", "work-item.blocked",
  "goal.outcome.verified",
  "sidecar.job.status",
  "operations.mode.changed", "operations.incident.created",
]);
export type ConsoleEventType = z.infer<typeof eventTypeSchema>;

export const classificationSchema = z.enum(["public-metadata", "tenant-confidential", "security-sensitive"]);

export const consoleEventSchema = z.object({
  eventId: z.string().uuid(),
  schemaVersion: z.literal(CONSOLE_SCHEMA_VERSION),
  tenantId: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/),
  runId: z.string().min(1).max(100),
  requestId: z.string().min(1).max(100),
  type: eventTypeSchema,
  occurredAt: z.string().datetime(),
  payload: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())])),
  sensitivity: z.object({
    classification: classificationSchema,
    source: z.enum(["product-core", "console-adapter", "sanitized-recording"]),
    sanitized: z.literal(true),
  }).strict(),
}).strict();
export type ConsoleEvent = z.infer<typeof consoleEventSchema>;

const forbiddenKey = /(secret|token|password|authorization|cookie|raw|prompt|model[_-]?content)/i;
const forbiddenValue = /(bearer\s+[a-z0-9._-]+|token\s+[a-z0-9._-]+|api[_-]?key\s*[:=])/i;

const planPayloadSchemas: Partial<Record<ConsoleEventType, z.ZodType<Record<string, unknown>>>> = {
  "goal.plan.proposed": z.object({ parentGoalId: z.string(), planVersion: z.number().int().positive(), fixture: z.string(), itemCount: z.number().int().nonnegative(), summary: z.string() }).strict(),
  "goal.plan.validated": z.object({ parentGoalId: z.string(), planVersion: z.number().int().positive(), passed: z.boolean(), validationReceipt: z.string(), checks: z.array(z.string()), checkCount: z.number().int().nonnegative().optional(), scope: z.string(), deadline: z.string(), targetAliases: z.array(z.string()), credentialAliases: z.array(z.string()), authorityState: z.string() }).strict(),
  "work-item.created": z.object({ parentGoalId: z.string(), planVersion: z.number().int().positive(), workItemId: z.string(), groupId: z.string(), groupLabel: z.string(), groupReason: z.string(), entityAlias: z.string(), workflowKey: z.string(), summary: z.string(), dependencies: z.array(z.string()), executionOrder: z.number().int().positive(), initialStatus: z.enum(["already-satisfied", "ready", "waiting"]), acquisitionPath: z.enum(["none", "existing-ability", "retained-reuse", "new-capability", "authority-handoff"]), childRunId: z.string(), required: z.boolean() }).strict(),
  "work-item.started": z.object({ parentGoalId: z.string(), workItemId: z.string(), operationId: z.string(), idempotencyKey: z.string(), startedAt: z.string().datetime() }).strict(),
  "work-item.completed": z.object({ parentGoalId: z.string(), workItemId: z.string(), operationId: z.string(), outcomeReceipt: z.string(), passed: z.boolean(), intendedWrites: z.number().int().nonnegative(), incorrectSideEffects: z.number().int().nonnegative(), completedAt: z.string().datetime() }).strict(),
  "work-item.blocked": z.object({ parentGoalId: z.string(), workItemId: z.string(), operationId: z.string(), handoffId: z.string(), reason: z.string(), missing: z.string(), writesAttempted: z.number().int().nonnegative(), blockedAt: z.string().datetime() }).strict(),
  "goal.outcome.verified": z.object({ parentGoalId: z.string(), planVersion: z.number().int().positive(), aggregateReceipt: z.string(), result: z.enum(["complete", "partially-complete", "blocked", "unknown"]), passed: z.boolean(), requiredItems: z.number().int().nonnegative(), completedItems: z.number().int().nonnegative(), alreadySatisfiedItems: z.number().int().nonnegative(), blockedItems: z.number().int().nonnegative(), failedItems: z.number().int().nonnegative(), unknownItems: z.number().int().nonnegative(), incorrectSideEffects: z.number().int().nonnegative(), verifiedAt: z.string().datetime(), summary: z.string() }).strict(),
};

export function sanitizePayload(input: Record<string, unknown>) {
  const output: Record<string, string | number | boolean | null | string[]> = {};
  for (const [key, value] of Object.entries(input)) {
    if (forbiddenKey.test(key)) throw new Error(`Forbidden console payload key: ${key}`);
    if (typeof value === "string") {
      if (forbiddenValue.test(value)) throw new Error(`Potential secret in console payload: ${key}`);
      if (value.length > 800) throw new Error(`Console payload string exceeds limit: ${key}`);
      output[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      output[key] = value;
    } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      if (value.length > 24 || value.some((item) => item.length > 160)) throw new Error(`Console payload array exceeds limit: ${key}`);
      output[key] = value;
    }
  }
  return output;
}

export function makeConsoleEvent(input: Omit<ConsoleEvent, "eventId" | "schemaVersion" | "payload"> & { eventId?: string; payload: Record<string, unknown> }): ConsoleEvent {
  const sanitized = sanitizePayload(input.payload);
  const payloadSchema = planPayloadSchemas[input.type];
  if (payloadSchema) payloadSchema.parse(sanitized);
  return consoleEventSchema.parse({
    ...input,
    eventId: input.eventId ?? randomUUID(),
    schemaVersion: CONSOLE_SCHEMA_VERSION,
    payload: sanitized,
  });
}

export function stableConsoleId(namespace: string, ...parts: string[]) {
  const digest = createHash("sha256").update([namespace, ...parts].join("\u001f")).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function recordingDigest(events: ConsoleEvent[]) {
  return createHash("sha256").update(JSON.stringify(events)).digest("hex");
}
