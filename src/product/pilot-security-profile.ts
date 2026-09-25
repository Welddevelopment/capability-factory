import { z } from "zod";

export const PILOT_SECURITY_PROFILE_SCHEMA_VERSION = "1.0" as const;
const bounded = z.string().trim().min(1).max(2_000);
const identifier = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_.-]+$/);

export const pilotSecurityProfileSchema = z.object({
  schemaVersion: z.literal(PILOT_SECURITY_PROFILE_SCHEMA_VERSION),
  engagementId: identifier,
  environment: z.object({ execution: z.literal("customer-local"), sidecarExposure: z.literal("localhost-only"), productionAccess: z.literal(false), personalDataAllowed: z.literal(false), fictionalOrSandboxDataOnly: z.literal(true) }).strict(),
  credentials: z.object({ externalCredentialValuesLeaveCustomerBoundary: z.literal(false), requestsContainAliasesOnly: z.literal(true), owner: bounded, rotationProcedure: bounded, revocationProcedure: bounded }).strict(),
  model: z.object({ enabled: z.boolean(), provider: bounded, modelId: bounded, seesCredentialValues: z.literal(false), allowedContext: z.array(z.enum(["ordinary-goal", "bounded-documentation", "failed-checks", "synthetic-records"])), providerRetentionStatement: bounded, customerApproved: z.boolean() }).strict(),
  network: z.object({ targetAliases: z.array(identifier).min(1).max(16), redirectsBlocked: z.literal(true), localhostControlBoundary: z.literal(true), arbitraryEgressAllowed: z.literal(false) }).strict(),
  controls: z.object({ declarativeHttpOnly: z.literal(true), arbitraryGeneratedCodeExecution: z.literal(false), leastPrivilegeMethods: z.literal(true), writeIdempotencyOrReconciliation: z.literal(true), independentCapabilityVerification: z.literal(true), independentOutcomeVerification: z.literal(true), blindRetryBlocked: z.literal(true), redactedAudit: z.literal(true), customerHaltControl: z.literal(true), responseAndTimeLimits: z.literal(true), acceptanceCampaignRequired: z.literal(true) }).strict(),
  retention: z.object({ runtimeStateDays: z.number().int().nonnegative().max(3_650), auditDays: z.number().int().nonnegative().max(3_650), evidenceDays: z.number().int().nonnegative().max(3_650), deletionOwner: bounded, deletionProcedure: bounded }).strict(),
  incident: z.object({ customerContact: bounded, capabilityFactoryContact: bounded, haltProcedure: bounded, unknownOutcomeProcedure: bounded, notificationTargetHours: z.number().positive().max(720) }).strict(),
  assurance: z.object({ penetrationTestCompleted: z.boolean(), securityCertification: z.boolean(), cyberInsuranceConfirmed: z.boolean(), formalSla: z.boolean(), statement: bounded }).strict(),
  customerApprovals: z.object({ technical: z.boolean(), security: z.boolean(), dataOwner: z.boolean(), incidentOwner: z.boolean() }).strict(),
  evidenceReferences: z.array(z.string().min(1).max(1_000)).min(1).max(64),
}).strict();

export type PilotSecurityProfile = z.infer<typeof pilotSecurityProfileSchema>;

export function assessPilotSandboxSecurity(raw: PilotSecurityProfile): { ready: boolean; blockers: string[] } {
  const profile = pilotSecurityProfileSchema.parse(raw);
  const blockers: string[] = [];
  if (!profile.model.customerApproved) blockers.push("model-context-not-approved");
  if (/pending|unknown|tbd|to be confirmed/i.test(`${profile.model.provider} ${profile.model.modelId} ${profile.model.providerRetentionStatement}`)) blockers.push("model-disclosure-incomplete");
  if (!Object.values(profile.customerApprovals).every(Boolean)) blockers.push("customer-security-approvals");
  if (!profile.credentials.owner.trim() || !profile.incident.customerContact.trim()) blockers.push("security-owners");
  if (profile.retention.runtimeStateDays === 0 && profile.retention.auditDays === 0 && profile.retention.evidenceDays === 0) blockers.push("retention-not-defined");
  return { ready: blockers.length === 0, blockers };
}

