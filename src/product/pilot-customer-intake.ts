import { z } from "zod";
import { pilotAdapterIntakeSchema, type PilotAdapterIntake } from "./pilot-adapter-scaffold.js";

export const PILOT_CUSTOMER_INTAKE_SCHEMA_VERSION = "1.0" as const;
const bounded = z.string().trim().min(1).max(4_000);
const optionalBounded = z.string().trim().max(4_000);

export const pilotCustomerIntakeSchema = z.object({
  schemaVersion: z.literal(PILOT_CUSTOMER_INTAKE_SCHEMA_VERSION),
  company: z.object({ alias: z.string().min(3).max(160).regex(/^[a-z][a-z0-9_-]+$/), website: z.string().url(), stage: bounded, productSummary: bounded }).strict(),
  contacts: z.object({ technicalOwner: optionalBounded, economicOwner: optionalBounded, securityOwner: optionalBounded, incidentOwner: optionalBounded }).strict(),
  recentBlocker: z.object({ happenedInRealDeployment: z.boolean(), when: bounded, ordinaryGoal: bounded, exactBlockedAction: bounded, system: bounded, mechanism: z.enum(["authenticated-http-api", "browser", "edi-document", "database", "other"]), engineerHours: z.number().nonnegative().optional(), delayDays: z.number().nonnegative().optional(), economicEffect: bounded, currentWorkaround: bounded, strategicIpOrOverhead: z.enum(["strategic-ip", "mixed", "mostly-overhead", "unknown"]), existingToolAttempted: optionalBounded }).strict(),
  safeEnvironment: z.object({ available: z.boolean(), kind: z.enum(["synthetic-replica", "customer-sandbox", "none"]), production: z.literal(false), personalData: z.literal(false), resettable: z.boolean(), owner: optionalBounded }).strict(),
  authority: z.object({ allowedActionsKnown: z.boolean(), forbiddenActionsKnown: z.boolean(), credentialAliasesDefined: z.boolean(), credentialValuesIncluded: z.literal(false), approvalOwner: optionalBounded, revocationOwner: optionalBounded }).strict(),
  verification: z.object({ independentSourceAvailable: z.boolean(), sourceDescription: bounded, exactSuccessStateKnown: z.boolean(), collateralStateDefined: z.boolean() }).strict(),
  documentation: z.object({ available: z.boolean(), customerApprovedForLocalUse: z.boolean(), sourceDescription: bounded }).strict(),
  commercial: z.object({ willingnessToDiscussPaidPilot: z.enum(["yes", "no", "unknown"]), buyingOwnerKnown: z.boolean(), contractingPathAvailable: z.boolean(), notes: bounded }).strict(),
  adapterDraft: pilotAdapterIntakeSchema.optional(),
}).strict();

export type PilotCustomerIntake = z.infer<typeof pilotCustomerIntakeSchema>;

export interface PilotCustomerIntakeAssessment {
  discoveryReady: boolean;
  reproductionReady: boolean;
  adapterScaffoldReady: boolean;
  paidPilotDiscussionReady: boolean;
  missing: string[];
}

export function assessPilotCustomerIntake(raw: PilotCustomerIntake): PilotCustomerIntakeAssessment {
  const intake = pilotCustomerIntakeSchema.parse(raw); const missing: string[] = [];
  const discoveryReady = intake.recentBlocker.happenedInRealDeployment && intake.recentBlocker.mechanism === "authenticated-http-api"
    && Boolean(intake.contacts.technicalOwner) && (intake.recentBlocker.engineerHours !== undefined || intake.recentBlocker.delayDays !== undefined);
  if (!discoveryReady) missing.push("qualified-recent-http-blocker");
  const reproductionReady = discoveryReady && intake.safeEnvironment.available && intake.safeEnvironment.kind !== "none"
    && intake.safeEnvironment.resettable && intake.documentation.available && intake.documentation.customerApprovedForLocalUse
    && intake.verification.independentSourceAvailable && intake.verification.exactSuccessStateKnown && intake.verification.collateralStateDefined
    && intake.authority.allowedActionsKnown && intake.authority.forbiddenActionsKnown;
  if (!reproductionReady) missing.push("safe-reproduction-contract");
  const adapterScaffoldReady = reproductionReady && intake.authority.credentialAliasesDefined && Boolean(intake.adapterDraft);
  if (!adapterScaffoldReady) missing.push("adapter-scaffold-input");
  const paidPilotDiscussionReady = reproductionReady && intake.commercial.willingnessToDiscussPaidPilot === "yes"
    && intake.commercial.buyingOwnerKnown && intake.commercial.contractingPathAvailable && Boolean(intake.contacts.economicOwner);
  if (!paidPilotDiscussionReady) missing.push("paid-pilot-commercial-path");
  return { discoveryReady, reproductionReady, adapterScaffoldReady, paidPilotDiscussionReady, missing };
}

export function adapterIntakeFromCustomerIntake(raw: PilotCustomerIntake): PilotAdapterIntake {
  const intake = pilotCustomerIntakeSchema.parse(raw); const assessment = assessPilotCustomerIntake(intake);
  if (!assessment.adapterScaffoldReady || !intake.adapterDraft) throw new Error(`Customer intake cannot create an adapter scaffold: ${assessment.missing.join(", ")}`);
  return structuredClone(intake.adapterDraft);
}

