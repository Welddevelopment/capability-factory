import { z } from "zod";
import { CUSTOMER_PILOT_ACTIVATION_GATES, type CustomerPilotActivationGate, type ReadinessEvidence } from "./pilot-readiness.js";

export const PILOT_ENGAGEMENT_SCHEMA_VERSION = "1.0" as const;

const identifier = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_.-]+$/);
const bounded = z.string().trim().min(1).max(2_000);
const money = z.object({ currency: z.string().length(3).regex(/^[A-Z]{3}$/), amount: z.number().nonnegative(), basis: z.enum(["one-time", "monthly", "per-run"]), status: z.enum(["hypothesis", "customer-agreed"]) }).strict();
const activationEvidence = z.object({ gate: z.enum(CUSTOMER_PILOT_ACTIVATION_GATES), status: z.enum(["passed", "failed", "not-run"]), summary: bounded, artifactReferences: z.array(z.string().min(1).max(1_000)) }).strict();

export const pilotEngagementSchema = z.object({
  schemaVersion: z.literal(PILOT_ENGAGEMENT_SCHEMA_VERSION),
  engagementId: identifier,
  companyAlias: identifier,
  status: z.enum(["internal-draft", "customer-review", "agreed", "active", "completed", "stopped"]),
  phase: z.enum(["discovery", "synthetic-reproduction", "customer-sandbox"]),
  qualification: z.object({
    recentBlockedDeployment: z.boolean(),
    authenticatedHttpResidual: z.boolean(),
    economicImpactDescribed: z.boolean(),
    buyVsBuildUnknownOrFavorable: z.boolean(),
    technicalOwnerNamed: z.boolean(),
    economicOwnerNamed: z.boolean(),
    detail: bounded,
  }).strict(),
  workflow: z.object({
    ordinaryGoal: bounded,
    missingAction: identifier,
    targetAliases: z.array(identifier).min(1).max(8),
    allowedActions: z.array(identifier).min(1).max(24),
    forbiddenActions: z.array(identifier).min(1).max(48),
    completionSummary: bounded,
  }).strict(),
  environment: z.object({
    kind: z.enum(["synthetic-local", "customer-sandbox"]),
    fictionalDataOnly: z.boolean(),
    productionAccess: z.literal(false),
    personalDataAllowed: z.literal(false),
  }).strict(),
  owners: z.object({ technical: bounded.optional(), economic: bounded.optional(), security: bounded.optional(), incident: bounded.optional() }).strict(),
  commercial: z.object({ setup: money, recurring: money, paymentPathConfirmed: z.boolean(), contractingPathConfirmed: z.boolean() }).strict(),
  successCriteria: z.object({
    originalGoalCompleted: z.literal(true),
    independentExternalVerification: z.literal(true),
    incorrectSideEffects: z.literal(0),
    duplicateWrites: z.literal(0),
    unauthorizedWrites: z.literal(0),
    freshProcessReuse: z.literal(true),
    safeMissingAuthorityHandoff: z.literal(true),
    customerConfirmsRepresentative: z.boolean(),
  }).strict(),
  measurement: z.object({ baselineEngineerHours: z.number().nonnegative().optional(), baselineDelayDays: z.number().nonnegative().optional(), targetEngineerHoursSaved: z.number().nonnegative().optional(), targetDelayDaysSaved: z.number().nonnegative().optional(), notes: bounded }).strict(),
  stopConditions: z.array(bounded).min(5).max(32),
  activationEvidence: z.array(activationEvidence).max(CUSTOMER_PILOT_ACTIVATION_GATES.length),
}).strict();

export type PilotEngagement = z.infer<typeof pilotEngagementSchema>;

export interface PilotEngagementAssessment {
  discoveryReady: boolean;
  reproductionReady: boolean;
  activationReady: boolean;
  blockers: string[];
}

export function assessPilotEngagement(raw: PilotEngagement): PilotEngagementAssessment {
  const engagement = pilotEngagementSchema.parse(raw);
  const blockers: string[] = [];
  const qualification = engagement.qualification;
  const discoveryReady = qualification.recentBlockedDeployment && qualification.authenticatedHttpResidual
    && qualification.economicImpactDescribed && qualification.technicalOwnerNamed;
  if (!discoveryReady) blockers.push("discovery-qualification");
  const reproductionReady = discoveryReady && engagement.environment.fictionalDataOnly
    && engagement.workflow.allowedActions.length > 0 && engagement.workflow.forbiddenActions.length > 0;
  if (!reproductionReady) blockers.push("synthetic-reproduction-scope");
  const evidence = new Map<CustomerPilotActivationGate, ReadinessEvidence>(engagement.activationEvidence.map((item) => [item.gate, item]));
  const allActivationGates = CUSTOMER_PILOT_ACTIVATION_GATES.every((gate) => {
    const item = evidence.get(gate);
    return item?.status === "passed" && item.artifactReferences.length > 0;
  });
  const customerTerms = engagement.commercial.setup.status === "customer-agreed"
    && engagement.commercial.recurring.status === "customer-agreed"
    && engagement.commercial.paymentPathConfirmed && engagement.commercial.contractingPathConfirmed;
  const owners = Boolean(engagement.owners.technical && engagement.owners.economic && engagement.owners.security && engagement.owners.incident);
  const activationReady = reproductionReady && engagement.environment.kind === "customer-sandbox"
    && engagement.successCriteria.customerConfirmsRepresentative && allActivationGates && customerTerms && owners
    && ["agreed", "active"].includes(engagement.status);
  if (!allActivationGates) blockers.push("customer-activation-gates");
  if (!customerTerms) blockers.push("commercial-and-contracting-path");
  if (!owners) blockers.push("named-customer-owners");
  if (!engagement.successCriteria.customerConfirmsRepresentative) blockers.push("customer-representativeness");
  return { discoveryReady, reproductionReady, activationReady, blockers: [...new Set(blockers)] };
}

