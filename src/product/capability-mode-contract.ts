import { z } from "zod";
import { broadGoalRequestSchema } from "./broad-goal-sdk.js";

export const CAPABILITY_MODE_SCHEMA_VERSION = "1.0" as const;

export const capabilityModeSchema = z.enum([
  "constrained-http-api",
  "experimental-browser-actions",
  "experimental-file-transfer-actions",
  "experimental-inbox-message-actions",
  "experimental-document-actions",
  "experimental-database-actions",
  "experimental-trusted-tool-actions",
  "experimental-agent-delegation-actions",
]);
export type CapabilityMode = z.infer<typeof capabilityModeSchema>;

export const capabilityModeMaturitySchema = z.enum([
  "working-local-pilot-mvp",
  "experimental-local",
]);
export type CapabilityModeMaturity = z.infer<typeof capabilityModeMaturitySchema>;

const identifier = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/);
const fileAlias = z.string().min(1).max(180)
  .regex(/^[a-zA-Z0-9_.-]+$/)
  .refine((value) => !value.includes(".."), "File alias must not contain path syntax.");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const ordinaryGoal = z.string().trim().min(1).max(4_000);
const approvals = z.array(identifier).max(32);

export const browserModeRequestSchema = z.object({
  tenantId: identifier,
  requestId: identifier,
  parentGoalId: identifier,
  ordinaryGoal,
  needKey: identifier,
  uiContractHash: digest,
  operationKey: identifier,
  input: z.record(identifier, z.string().max(2_000)),
  approvals,
}).strict();

export const fileTransferModeRequestSchema = z.object({
  tenantId: identifier,
  requestId: identifier,
  parentGoalId: identifier,
  ordinaryGoal,
  needKey: identifier,
  contractHash: digest,
  operationKey: identifier,
  inputFileAlias: fileAlias,
  expectedInputSha256: digest,
  approvals,
  simulateLostResponseAfterCommit: z.boolean().optional(),
}).strict();

export const inboxMessageModeRequestSchema = z.object({
  tenantId: identifier,
  requestId: identifier,
  parentGoalId: identifier,
  ordinaryGoal,
  needKey: identifier,
  contractHash: digest,
  operationKey: identifier,
  inputMessageAlias: fileAlias,
  expectedMessageSha256: digest,
  approvals,
  simulateLostResponseAfterCommit: z.boolean().optional(),
}).strict();

export const documentModeRequestSchema = z.object({
  tenantId: identifier,
  requestId: identifier,
  parentGoalId: identifier,
  ordinaryGoal,
  needKey: identifier,
  contractHash: digest,
  operationKey: identifier,
  inputDocumentAlias: fileAlias,
  expectedDocumentSha256: digest,
  approvals,
  simulateLostResponseAfterCommit: z.boolean().optional(),
}).strict();

export const databaseModeRequestSchema = z.object({
  tenantId: identifier,
  requestId: identifier,
  parentGoalId: identifier,
  ordinaryGoal,
  needKey: identifier,
  contractHash: digest,
  operationKey: identifier,
  input: z.record(identifier, z.string().max(2_000)),
  approvals,
  simulateLostResponseAfterCommit: z.boolean().optional(),
}).strict();

export const trustedToolModeRequestSchema = z.object({
  tenantId: identifier,
  requestId: identifier,
  parentGoalId: identifier,
  ordinaryGoal,
  needKey: identifier,
  contractHash: digest,
  operationKey: identifier,
  toolId: identifier,
  toolVersion: fileAlias,
  values: z.array(z.number().int()).min(1).max(16),
  approvals,
}).strict();

export const agentDelegationModeRequestSchema = z.object({
  tenantId: identifier,
  requestId: identifier,
  parentGoalId: identifier,
  ordinaryGoal,
  needKey: identifier,
  contractHash: digest,
  operationKey: identifier,
  delegateId: identifier,
  delegateVersion: identifier,
  taskKey: identifier,
  input: z.record(identifier, z.string().max(2_000)),
  approvals,
  simulateLostResponseAfterCommit: z.boolean().optional(),
}).strict();

export const capabilityModeEnvelopeSchema = z.discriminatedUnion("capabilityMode", [
  z.object({
    schemaVersion: z.literal(CAPABILITY_MODE_SCHEMA_VERSION),
    capabilityMode: z.literal("constrained-http-api"),
    request: broadGoalRequestSchema,
  }).strict(),
  z.object({
    schemaVersion: z.literal(CAPABILITY_MODE_SCHEMA_VERSION),
    capabilityMode: z.literal("experimental-browser-actions"),
    request: browserModeRequestSchema,
  }).strict(),
  z.object({
    schemaVersion: z.literal(CAPABILITY_MODE_SCHEMA_VERSION),
    capabilityMode: z.literal("experimental-file-transfer-actions"),
    request: fileTransferModeRequestSchema,
  }).strict(),
  z.object({
    schemaVersion: z.literal(CAPABILITY_MODE_SCHEMA_VERSION),
    capabilityMode: z.literal("experimental-inbox-message-actions"),
    request: inboxMessageModeRequestSchema,
  }).strict(),
  z.object({
    schemaVersion: z.literal(CAPABILITY_MODE_SCHEMA_VERSION),
    capabilityMode: z.literal("experimental-document-actions"),
    request: documentModeRequestSchema,
  }).strict(),
  z.object({
    schemaVersion: z.literal(CAPABILITY_MODE_SCHEMA_VERSION),
    capabilityMode: z.literal("experimental-database-actions"),
    request: databaseModeRequestSchema,
  }).strict(),
  z.object({
    schemaVersion: z.literal(CAPABILITY_MODE_SCHEMA_VERSION),
    capabilityMode: z.literal("experimental-trusted-tool-actions"),
    request: trustedToolModeRequestSchema,
  }).strict(),
  z.object({
    schemaVersion: z.literal(CAPABILITY_MODE_SCHEMA_VERSION),
    capabilityMode: z.literal("experimental-agent-delegation-actions"),
    request: agentDelegationModeRequestSchema,
  }).strict(),
]);
export type CapabilityModeEnvelope = z.infer<typeof capabilityModeEnvelopeSchema>;

export const capabilityModeDescriptorSchema = z.object({
  capabilityMode: capabilityModeSchema,
  label: z.string().min(1).max(120),
  driverVersion: z.string().min(1).max(120),
  maturity: capabilityModeMaturitySchema,
  configured: z.boolean(),
  claimBoundary: z.string().min(1).max(500),
}).strict();
export type CapabilityModeDescriptor = z.infer<typeof capabilityModeDescriptorSchema>;

export const capabilityModeResultSchema = z.object({
  capabilityMode: capabilityModeSchema,
  status: z.enum([
    "completed",
    "partially-complete",
    "blocked",
    "failed",
    "unknown",
    "handoff",
    "plan-rejected",
  ]),
  parentResumed: z.boolean(),
  parentCompleted: z.boolean(),
  summary: z.string().min(1).max(1_000),
  acquisitionPath: z.string().min(1).max(120).optional(),
  capabilityId: z.string().min(1).max(240).optional(),
}).strict();
export type CapabilityModeResult = z.infer<typeof capabilityModeResultSchema>;

export function capabilityModeIdentity(envelope: CapabilityModeEnvelope): {
  tenantId: string;
  parentGoalId: string;
  requestId: string;
} {
  return {
    tenantId: envelope.request.tenantId,
    parentGoalId: envelope.request.parentGoalId,
    requestId: envelope.request.requestId,
  };
}
