import { createHash } from "node:crypto";
import { z } from "zod";

const identifier = z.string().min(1).max(180).regex(/^[a-zA-Z0-9_.-]+$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });

export const verifierTemplateControlIds = [
  "completed",
  "not-started",
  "partial",
  "incorrect",
  "duplicate",
  "stale",
  "collateral",
  "unknown",
  "unavailable",
  "lost-response-reconciliation",
  "adversarial-action-response",
] as const;

export type VerifierTemplateControlId = typeof verifierTemplateControlIds[number];

export const verifierOutcomeClassificationSchema = z.enum([
  "completed",
  "not-started",
  "partial",
  "incorrect",
  "duplicate",
  "stale",
  "collateral",
  "unknown",
  "unavailable",
]);
export type VerifierOutcomeClassification = z.infer<typeof verifierOutcomeClassificationSchema>;

export const verifierNextActionSchema = z.enum([
  "resume",
  "retry-after-authority-recheck",
  "quarantine",
  "handoff",
]);
export type VerifierNextAction = z.infer<typeof verifierNextActionSchema>;

const expectedVerdictSchema = z.object({
  classification: verifierOutcomeClassificationSchema,
  passed: z.boolean(),
  nextAction: verifierNextActionSchema,
  incorrectSideEffects: z.number().int().nonnegative(),
}).strict();
export type ExpectedVerifierTemplateVerdict = z.infer<typeof expectedVerdictSchema>;

const requiredSemantics: Readonly<Record<VerifierTemplateControlId, ExpectedVerifierTemplateVerdict>> = Object.freeze({
  completed: { classification: "completed", passed: true, nextAction: "resume", incorrectSideEffects: 0 },
  "not-started": { classification: "not-started", passed: false, nextAction: "retry-after-authority-recheck", incorrectSideEffects: 0 },
  partial: { classification: "partial", passed: false, nextAction: "quarantine", incorrectSideEffects: 0 },
  incorrect: { classification: "incorrect", passed: false, nextAction: "quarantine", incorrectSideEffects: 1 },
  duplicate: { classification: "duplicate", passed: false, nextAction: "quarantine", incorrectSideEffects: 1 },
  stale: { classification: "stale", passed: false, nextAction: "quarantine", incorrectSideEffects: 0 },
  collateral: { classification: "collateral", passed: false, nextAction: "quarantine", incorrectSideEffects: 1 },
  unknown: { classification: "unknown", passed: false, nextAction: "handoff", incorrectSideEffects: 0 },
  unavailable: { classification: "unavailable", passed: false, nextAction: "handoff", incorrectSideEffects: 0 },
  "lost-response-reconciliation": { classification: "completed", passed: true, nextAction: "resume", incorrectSideEffects: 0 },
  "adversarial-action-response": { classification: "unavailable", passed: false, nextAction: "handoff", incorrectSideEffects: 0 },
});

export interface VerifierTemplateQualificationCase {
  controlId: VerifierTemplateControlId;
  independentObservation: unknown;
  responseDisposition: "available" | "lost" | "not-applicable";
  actionResponse?: unknown;
  expected: ExpectedVerifierTemplateVerdict;
}

export interface VerifierTemplateQualificationCorpus {
  schemaVersion: "1.0";
  corpusVersion: string;
  cases: VerifierTemplateQualificationCase[];
}

export interface VerifierTemplateEvaluationInput {
  independentObservation: unknown;
  responseDisposition: VerifierTemplateQualificationCase["responseDisposition"];
  /**
   * Supplied only to prove that a template cannot turn an action response into
   * external proof. Production outcome verification must still use an
   * independent observation path.
   */
  actionResponse?: unknown;
}

export interface VerifierTemplateEvaluation extends ExpectedVerifierTemplateVerdict {
  observedStateDigest: string;
}

export interface VerifierTemplateCandidate {
  templateKey: string;
  templateVersion: string;
  runtimeFamily: string;
  implementationDigest: string;
  outcomeSchemaDigest: string;
  evaluate(input: VerifierTemplateEvaluationInput): VerifierTemplateEvaluation;
}

export interface VerifierTemplateControlResult {
  controlId: VerifierTemplateControlId;
  passed: boolean;
  expectedDigest: string;
  actualDigest?: string;
  detail: string;
}

export interface VerifierTemplateQualificationReceipt {
  schemaVersion: "1.0";
  status: "qualified";
  templateKey: string;
  templateVersion: string;
  runtimeFamily: string;
  implementationDigest: string;
  outcomeSchemaDigest: string;
  primitiveRegistryDigest: string;
  verifierRegistryDigest: string;
  corpusVersion: string;
  corpusDigest: string;
  oracleDigest: string;
  qualifiedAt: string;
  expiresAt: string;
  controls: VerifierTemplateControlResult[];
  qualificationDigest: string;
}

export interface VerifierTemplateQualificationReference {
  templateKey: string;
  templateVersion: string;
  implementationDigest: string;
  outcomeSchemaDigest: string;
  qualificationDigest: string;
}

export type VerifierTemplateQualificationResult =
  | { status: "qualified"; receipt: VerifierTemplateQualificationReceipt }
  | { status: "rejected"; controls: VerifierTemplateControlResult[]; errors: string[] };

function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Qualification material must not contain non-finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Qualification material must contain only plain structured values.");
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  throw new Error("Qualification material must not contain functions, symbols or bigint values.");
}

export function verifierQualificationDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function expectedFor(controlId: VerifierTemplateControlId): ExpectedVerifierTemplateVerdict {
  return { ...requiredSemantics[controlId] };
}

function sameVerdict(left: ExpectedVerifierTemplateVerdict, right: ExpectedVerifierTemplateVerdict): boolean {
  return canonical(left) === canonical(right);
}

function validateCorpus(corpus: VerifierTemplateQualificationCorpus): string[] {
  const errors: string[] = [];
  if (corpus.schemaVersion !== "1.0") errors.push("The qualification corpus schema version is unsupported.");
  if (!identifier.safeParse(corpus.corpusVersion).success) errors.push("The qualification corpus version is invalid.");
  const counts = new Map<VerifierTemplateControlId, number>();
  for (const testCase of corpus.cases) {
    counts.set(testCase.controlId, (counts.get(testCase.controlId) ?? 0) + 1);
    const required = expectedFor(testCase.controlId);
    if (!expectedVerdictSchema.safeParse(testCase.expected).success || !sameVerdict(testCase.expected, required)) {
      errors.push(`Control ${testCase.controlId} does not use the mandatory fail-closed oracle.`);
    }
    if (testCase.controlId === "lost-response-reconciliation" && testCase.responseDisposition !== "lost") {
      errors.push("The lost-response control must explicitly remove the action response.");
    }
    if (testCase.controlId === "lost-response-reconciliation" && testCase.actionResponse !== undefined) {
      errors.push("The lost-response control cannot retain the action response.");
    }
    if (testCase.controlId === "adversarial-action-response"
      && (testCase.actionResponse === undefined || testCase.responseDisposition !== "available")) {
      errors.push("The adversarial action-response control must include an available misleading action response.");
    }
  }
  for (const controlId of verifierTemplateControlIds) {
    if ((counts.get(controlId) ?? 0) !== 1) errors.push(`Control ${controlId} must appear exactly once.`);
  }
  if (corpus.cases.length !== verifierTemplateControlIds.length) errors.push("The qualification corpus contains extra or missing controls.");
  return errors;
}

function receiptUnsigned(receipt: VerifierTemplateQualificationReceipt): Omit<VerifierTemplateQualificationReceipt, "qualificationDigest"> {
  const { qualificationDigest: _qualificationDigest, ...unsigned } = receipt;
  return unsigned;
}

export function verifierTemplateReceiptDigest(receipt: VerifierTemplateQualificationReceipt): string {
  return verifierQualificationDigest(receiptUnsigned(receipt));
}

export function qualificationReference(
  receipt: VerifierTemplateQualificationReceipt,
): VerifierTemplateQualificationReference {
  return {
    templateKey: receipt.templateKey,
    templateVersion: receipt.templateVersion,
    implementationDigest: receipt.implementationDigest,
    outcomeSchemaDigest: receipt.outcomeSchemaDigest,
    qualificationDigest: receipt.qualificationDigest,
  };
}

export function qualifyVerifierTemplate(input: {
  candidate: VerifierTemplateCandidate;
  corpus: VerifierTemplateQualificationCorpus;
  primitiveRegistryDigest: string;
  verifierRegistryDigest: string;
  qualifiedAt: string;
  expiresAt: string;
}): VerifierTemplateQualificationResult {
  const errors = validateCorpus(input.corpus);
  for (const [name, value] of [
    ["template key", input.candidate.templateKey],
    ["template version", input.candidate.templateVersion],
    ["runtime family", input.candidate.runtimeFamily],
  ] as const) {
    if (!identifier.safeParse(value).success) errors.push(`The ${name} is invalid.`);
  }
  for (const [name, value] of [
    ["implementation", input.candidate.implementationDigest],
    ["outcome schema", input.candidate.outcomeSchemaDigest],
    ["primitive registry", input.primitiveRegistryDigest],
    ["verifier registry", input.verifierRegistryDigest],
  ] as const) {
    if (!digestSchema.safeParse(value).success) errors.push(`The ${name} digest is invalid.`);
  }
  if (!timestampSchema.safeParse(input.qualifiedAt).success || !timestampSchema.safeParse(input.expiresAt).success) {
    errors.push("Qualification timestamps must be explicit ISO-8601 timestamps.");
  } else {
    const lifetime = Date.parse(input.expiresAt) - Date.parse(input.qualifiedAt);
    if (lifetime <= 0) errors.push("Qualification expiry must follow qualification time.");
    if (lifetime > 90 * 24 * 60 * 60 * 1_000) errors.push("Verifier-template qualification cannot remain valid for more than 90 days.");
  }

  const controls: VerifierTemplateControlResult[] = [];
  if (errors.length === 0) {
    for (const controlId of verifierTemplateControlIds) {
      const testCase = input.corpus.cases.find((candidate) => candidate.controlId === controlId)!;
      const observationDigest = verifierQualificationDigest(testCase.independentObservation);
      const expectedDigest = verifierQualificationDigest(testCase.expected);
      try {
        const actual = input.candidate.evaluate({
          independentObservation: testCase.independentObservation,
          responseDisposition: testCase.responseDisposition,
          ...(testCase.actionResponse !== undefined ? { actionResponse: testCase.actionResponse } : {}),
        });
        const { observedStateDigest, ...verdict } = actual;
        const actualVerdict = expectedVerdictSchema.parse(verdict);
        const actualDigest = verifierQualificationDigest(actualVerdict);
        const passed = observedStateDigest === observationDigest && sameVerdict(actualVerdict, testCase.expected);
        controls.push({
          controlId,
          passed,
          expectedDigest,
          actualDigest,
          detail: passed
            ? "The template matched the mandatory oracle using the independent observation digest."
            : "The template diverged from the mandatory oracle or did not bind its verdict to the independent observation.",
        });
      } catch (error) {
        controls.push({
          controlId,
          passed: false,
          expectedDigest,
          detail: `The template failed closed during qualification: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }
  if (errors.length > 0 || controls.some((control) => !control.passed)) return { status: "rejected", controls, errors };

  const corpusDigest = verifierQualificationDigest(input.corpus.cases.map((testCase) => ({
    controlId: testCase.controlId,
    independentObservation: testCase.independentObservation,
    responseDisposition: testCase.responseDisposition,
    ...(testCase.actionResponse !== undefined ? { actionResponse: testCase.actionResponse } : {}),
  })));
  const oracleDigest = verifierQualificationDigest(input.corpus.cases.map((testCase) => ({
    controlId: testCase.controlId,
    expected: testCase.expected,
  })));
  const unsigned: Omit<VerifierTemplateQualificationReceipt, "qualificationDigest"> = {
    schemaVersion: "1.0",
    status: "qualified",
    templateKey: identifier.parse(input.candidate.templateKey),
    templateVersion: identifier.parse(input.candidate.templateVersion),
    runtimeFamily: identifier.parse(input.candidate.runtimeFamily),
    implementationDigest: digestSchema.parse(input.candidate.implementationDigest),
    outcomeSchemaDigest: digestSchema.parse(input.candidate.outcomeSchemaDigest),
    primitiveRegistryDigest: digestSchema.parse(input.primitiveRegistryDigest),
    verifierRegistryDigest: digestSchema.parse(input.verifierRegistryDigest),
    corpusVersion: identifier.parse(input.corpus.corpusVersion),
    corpusDigest,
    oracleDigest,
    qualifiedAt: timestampSchema.parse(input.qualifiedAt),
    expiresAt: timestampSchema.parse(input.expiresAt),
    controls,
  };
  return {
    status: "qualified",
    receipt: { ...unsigned, qualificationDigest: verifierQualificationDigest(unsigned) },
  };
}

function registryKey(reference: Pick<VerifierTemplateQualificationReference, "templateKey" | "templateVersion">): string {
  return `${reference.templateKey}@${reference.templateVersion}`;
}

/**
 * Trusted, customer-local registry of verifier templates that survived the
 * mandatory negative controls. Registering a receipt never executes or grants
 * authority; the durable executor checks the receipt before any action.
 */
export class VerifierTemplateQualificationRegistry {
  private readonly receipts = new Map<string, VerifierTemplateQualificationReceipt>();

  constructor(receipts: VerifierTemplateQualificationReceipt[] = []) {
    for (const receipt of receipts) this.register(receipt);
  }

  register(receipt: VerifierTemplateQualificationReceipt): void {
    if (receipt.schemaVersion !== "1.0" || receipt.status !== "qualified") throw new Error("Verifier-template receipt is not qualified.");
    for (const value of [receipt.templateKey, receipt.templateVersion, receipt.runtimeFamily, receipt.corpusVersion]) identifier.parse(value);
    for (const value of [
      receipt.implementationDigest,
      receipt.outcomeSchemaDigest,
      receipt.primitiveRegistryDigest,
      receipt.verifierRegistryDigest,
      receipt.corpusDigest,
      receipt.oracleDigest,
      receipt.qualificationDigest,
    ]) digestSchema.parse(value);
    timestampSchema.parse(receipt.qualifiedAt);
    timestampSchema.parse(receipt.expiresAt);
    const lifetime = Date.parse(receipt.expiresAt) - Date.parse(receipt.qualifiedAt);
    if (lifetime <= 0 || lifetime > 90 * 24 * 60 * 60 * 1_000) throw new Error("Verifier-template receipt has an invalid qualification lifetime.");
    if (verifierTemplateReceiptDigest(receipt) !== receipt.qualificationDigest) throw new Error("Verifier-template qualification receipt failed its integrity check.");
    if (receipt.controls.length !== verifierTemplateControlIds.length
      || verifierTemplateControlIds.some((controlId) => {
        const matches = receipt.controls.filter((control) => control.controlId === controlId);
        const requiredDigest = verifierQualificationDigest(expectedFor(controlId));
        return matches.length !== 1
          || !matches[0]!.passed
          || matches[0]!.expectedDigest !== requiredDigest
          || matches[0]!.actualDigest !== requiredDigest;
      })) {
      throw new Error("Verifier-template qualification receipt does not contain every passing mandatory control.");
    }
    const key = registryKey(receipt);
    const existing = this.receipts.get(key);
    if (existing && existing.qualificationDigest !== receipt.qualificationDigest) {
      throw new Error(`Verifier template ${key} already has a different qualification receipt.`);
    }
    this.receipts.set(key, structuredClone(receipt));
  }

  snapshotDigest(): string {
    return verifierQualificationDigest([...this.receipts.values()]
      .map((receipt) => receipt.qualificationDigest)
      .sort());
  }

  assertQualified(input: {
    reference: VerifierTemplateQualificationReference;
    runtimeFamily: string;
    primitiveRegistryDigest: string;
    verifierRegistryDigest: string;
    now: string;
  }): VerifierTemplateQualificationReceipt {
    const receipt = this.receipts.get(registryKey(input.reference));
    if (!receipt) throw new Error(`Verifier template ${registryKey(input.reference)} is not qualified.`);
    if (verifierTemplateReceiptDigest(receipt) !== receipt.qualificationDigest) throw new Error("Verifier-template qualification receipt was mutated.");
    if (receipt.qualificationDigest !== input.reference.qualificationDigest
      || receipt.implementationDigest !== input.reference.implementationDigest
      || receipt.outcomeSchemaDigest !== input.reference.outcomeSchemaDigest) {
      throw new Error("Verifier template identity changed after qualification.");
    }
    if (receipt.runtimeFamily !== input.runtimeFamily) throw new Error("Verifier template is qualified for a different runtime family.");
    if (receipt.primitiveRegistryDigest !== input.primitiveRegistryDigest
      || receipt.verifierRegistryDigest !== input.verifierRegistryDigest) {
      throw new Error("Verifier template is not qualified for the current primitive and verifier registries.");
    }
    const now = Date.parse(timestampSchema.parse(input.now));
    if (now < Date.parse(receipt.qualifiedAt)) throw new Error("Verifier-template qualification is not active yet.");
    if (now >= Date.parse(receipt.expiresAt)) throw new Error("Verifier-template qualification has expired.");
    return structuredClone(receipt);
  }
}
