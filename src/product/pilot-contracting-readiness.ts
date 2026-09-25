import { z } from "zod";

export const PILOT_CONTRACTING_READINESS_SCHEMA_VERSION = "1.0" as const;
const bounded = z.string().trim().min(1).max(2_000);

export const pilotContractingReadinessSchema = z.object({
  schemaVersion: z.literal(PILOT_CONTRACTING_READINESS_SCHEMA_VERSION),
  assessedAt: z.string().datetime(),
  founderAge: z.number().int().min(13).max(120),
  parentOrGuardianInvolved: z.boolean(),
  qualifiedUkLegalAdviceReceived: z.boolean(),
  qualifiedUkTaxAdviceReceived: z.boolean(),
  contractingParty: z.object({ kind: z.enum(["unresolved", "adult-sole-trader", "parent-or-guardian-entity", "existing-company", "professionally-advised-other"]), legalName: bounded, registrationOrTaxReference: bounded, authorizedSigner: bounded, signerAuthorityConfirmed: z.boolean() }).strict(),
  intellectualProperty: z.object({ existingIpOwnerIdentified: z.boolean(), newIpTermsDefined: z.boolean(), customerInputsLicenceDefined: z.boolean(), openSourceReviewComplete: z.boolean() }).strict(),
  money: z.object({ bankAccountConfirmed: z.boolean(), invoiceIssuerConfirmed: z.boolean(), paymentProvider: bounded, adultRepresentativeConfirmedWhereRequired: z.boolean(), currencyAndTaxTreatmentReviewed: z.boolean(), recordKeepingOwner: bounded }).strict(),
  legalDocuments: z.object({ pilotOrderReviewed: z.boolean(), confidentialityPathReviewed: z.boolean(), dataProtectionRolesReviewed: z.boolean(), liabilityAndTerminationReviewed: z.boolean(), publicityConsentSeparate: z.literal(true) }).strict(),
  insurance: z.object({ requirementAssessed: z.boolean(), cyberStatus: z.enum(["not-assessed", "not-held-disclosed", "held-and-verified"]), professionalIndemnityStatus: z.enum(["not-assessed", "not-held-disclosed", "held-and-verified"]) }).strict(),
  educationAndWork: z.object({ currentSchoolObligationsReviewed: z.boolean(), post16EducationOrTrainingPathReviewed: z.boolean(), workloadPlanRecorded: z.boolean(), guardianApproved: z.boolean() }).strict(),
  notes: bounded,
}).strict();

export type PilotContractingReadiness = z.infer<typeof pilotContractingReadinessSchema>;

export function assessPilotContractingReadiness(raw: PilotContractingReadiness): { readyToSignAndCollectPayment: boolean; blockers: string[] } {
  const value = pilotContractingReadinessSchema.parse(raw); const blockers: string[] = [];
  if (!value.parentOrGuardianInvolved) blockers.push("parent-or-guardian-involvement");
  if (!value.qualifiedUkLegalAdviceReceived || !value.qualifiedUkTaxAdviceReceived) blockers.push("professional-uk-advice");
  if (value.contractingParty.kind === "unresolved" || !value.contractingParty.signerAuthorityConfirmed) blockers.push("contracting-party-and-signatory");
  if (!Object.values(value.intellectualProperty).every(Boolean)) blockers.push("intellectual-property-terms");
  if (!value.money.bankAccountConfirmed || !value.money.invoiceIssuerConfirmed || !value.money.adultRepresentativeConfirmedWhereRequired || !value.money.currencyAndTaxTreatmentReviewed) blockers.push("banking-payment-and-tax");
  if (!Object.values(value.legalDocuments).every(Boolean)) blockers.push("customer-legal-documents");
  if (!value.insurance.requirementAssessed || value.insurance.cyberStatus === "not-assessed" || value.insurance.professionalIndemnityStatus === "not-assessed") blockers.push("insurance-assessment");
  if (!Object.values(value.educationAndWork).every(Boolean)) blockers.push("education-and-work-plan");
  return { readyToSignAndCollectPayment: blockers.length === 0, blockers };
}

