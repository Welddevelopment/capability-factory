import { createHash } from "node:crypto";
import { z } from "zod";

const identifier = z.string().min(1).max(180).regex(/^[a-zA-Z0-9_.-]+$/);
const pathSegment = z.union([identifier, z.number().int().nonnegative()]);

const baseCriterion = {
  key: identifier,
  observationKey: identifier,
  path: z.array(pathSegment).max(20),
};

export const outcomeCriterionSchema = z.discriminatedUnion("operator", [
  z.object({ ...baseCriterion, operator: z.literal("equals"), expected: z.unknown() }).strict(),
  z.object({ ...baseCriterion, operator: z.literal("not-equals"), expected: z.unknown() }).strict(),
  z.object({ ...baseCriterion, operator: z.literal("exists") }).strict(),
  z.object({ ...baseCriterion, operator: z.literal("absent") }).strict(),
  z.object({ ...baseCriterion, operator: z.literal("count-equals"), expected: z.number().int().nonnegative() }).strict(),
]);
export type OutcomeCriterion = z.infer<typeof outcomeCriterionSchema>;

export const trustedOutcomeContractSchema = z.object({
  schemaVersion: z.literal("1.0"),
  key: identifier,
  summary: z.string().trim().min(1).max(1_000),
  executionDriverId: identifier,
  criteria: z.array(outcomeCriterionSchema).min(1).max(64),
  incorrectSideEffectObservationKey: identifier,
  maximumIncorrectSideEffects: z.literal(0),
}).strict();
export type TrustedOutcomeContract = z.infer<typeof trustedOutcomeContractSchema>;

export interface UniversalObservationContext {
  tenantId: string;
  requestId: string;
  parentGoalId: string;
  operationKey: string;
}

export interface UniversalObservationAdapter {
  key: string;
  sourceId: string;
  priority: number;
  observationKeys: string[];
  /** Drivers that do not share the adapter's evidence path or result source. */
  independentFromDriverIds: string[];
  observe(context: UniversalObservationContext): Promise<Record<string, unknown>>;
}

export interface UniversalVerificationCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface UniversalOutcomeVerificationReceipt {
  schemaVersion: "1.0";
  verifierId: string;
  verifierVersion: "1.0";
  contractKey: string;
  contractHash: string;
  adapterKey: string;
  observationSource: string;
  independentFromExecution: true;
  passed: boolean;
  incorrectSideEffects: number;
  stateDigest: string;
  checks: UniversalVerificationCheck[];
  verifiedAt: string;
}

export type UniversalVerifierCompilation =
  | { status: "compiled"; verifier: CompiledUniversalOutcomeVerifier; checks: UniversalVerificationCheck[] }
  | { status: "rejected"; checks: UniversalVerificationCheck[] };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function includesAll(values: string[], required: string[]): boolean {
  return required.every((value) => values.includes(value));
}

function readPath(root: unknown, path: Array<string | number>): { exists: boolean; value: unknown } {
  let current = root;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length) return { exists: false, value: undefined };
      current = current[segment];
      continue;
    }
    if (!current || typeof current !== "object" || !(segment in current)) return { exists: false, value: undefined };
    current = (current as Record<string, unknown>)[segment];
  }
  return { exists: true, value: current };
}

function criterionCheck(criterion: OutcomeCriterion, observations: Record<string, unknown>): UniversalVerificationCheck {
  const rootPresent = Object.hasOwn(observations, criterion.observationKey);
  const observed = rootPresent
    ? readPath(observations[criterion.observationKey], criterion.path)
    : { exists: false, value: undefined };
  let passed = false;
  if (criterion.operator === "exists") passed = observed.exists;
  else if (criterion.operator === "absent") passed = !observed.exists;
  else if (criterion.operator === "equals") passed = observed.exists && canonical(observed.value) === canonical(criterion.expected);
  else if (criterion.operator === "not-equals") passed = observed.exists && canonical(observed.value) !== canonical(criterion.expected);
  else passed = observed.exists && Array.isArray(observed.value) && observed.value.length === criterion.expected;
  return {
    id: `criterion.${criterion.key}`,
    passed,
    detail: passed
      ? `Trusted observation satisfied ${criterion.operator}.`
      : `Trusted observation did not satisfy ${criterion.operator}; raw observed values are omitted.`,
  };
}

export class CompiledUniversalOutcomeVerifier {
  readonly verifierId: string;
  readonly contractHash: string;

  constructor(
    readonly contract: TrustedOutcomeContract,
    readonly adapter: UniversalObservationAdapter,
    private readonly now: () => string,
  ) {
    this.contractHash = digest(contract);
    this.verifierId = `outcome-verifier-${this.contractHash.slice(0, 24)}`;
  }

  async verify(context: UniversalObservationContext): Promise<UniversalOutcomeVerificationReceipt> {
    let observations: Record<string, unknown>;
    try {
      observations = await this.adapter.observe(context);
    } catch {
      return this.receipt({}, 0, [{
        id: "observation.available",
        passed: false,
        detail: "The independent observation adapter could not establish external state.",
      }]);
    }
    const checks = this.contract.criteria.map((criterion) => criterionCheck(criterion, observations));
    const sideEffectValue = observations[this.contract.incorrectSideEffectObservationKey];
    const incorrectSideEffects = Number.isInteger(sideEffectValue) && Number(sideEffectValue) >= 0
      ? Number(sideEffectValue)
      : 1;
    checks.push({
      id: "incorrect-side-effects",
      passed: incorrectSideEffects === 0,
      detail: incorrectSideEffects === 0
        ? "Independent observation found no incorrect side effects."
        : "Independent observation found an incorrect or unestablished side-effect count.",
    });
    return this.receipt(observations, incorrectSideEffects, checks);
  }

  private receipt(
    observations: Record<string, unknown>,
    incorrectSideEffects: number,
    checks: UniversalVerificationCheck[],
  ): UniversalOutcomeVerificationReceipt {
    return {
      schemaVersion: "1.0",
      verifierId: this.verifierId,
      verifierVersion: "1.0",
      contractKey: this.contract.key,
      contractHash: this.contractHash,
      adapterKey: this.adapter.key,
      observationSource: this.adapter.sourceId,
      independentFromExecution: true,
      passed: checks.every((check) => check.passed) && incorrectSideEffects === 0,
      incorrectSideEffects,
      stateDigest: digest(observations),
      checks,
      verifiedAt: this.now(),
    };
  }
}

/**
 * Compiles a trusted outcome contract against a separately sourced observer.
 * It refuses to compile when the only available evidence is coupled to the
 * acting driver or cannot cover every required observation.
 */
export class UniversalVerifierFactory {
  constructor(
    private readonly adapters: UniversalObservationAdapter[],
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  compile(rawContract: unknown): UniversalVerifierCompilation {
    let contract: TrustedOutcomeContract;
    try {
      contract = trustedOutcomeContractSchema.parse(rawContract);
    } catch {
      return { status: "rejected", checks: [{ id: "contract.valid", passed: false, detail: "The trusted outcome contract failed strict validation." }] };
    }
    const required = [...new Set([
      ...contract.criteria.map((criterion) => criterion.observationKey),
      contract.incorrectSideEffectObservationKey,
    ])];
    const candidates = this.adapters
      .filter((adapter) => adapter.independentFromDriverIds.includes(contract.executionDriverId))
      .filter((adapter) => includesAll(adapter.observationKeys, required))
      .sort((left, right) => left.priority - right.priority || left.key.localeCompare(right.key));
    const adapter = candidates[0];
    const checks: UniversalVerificationCheck[] = [
      {
        id: "observer.independent",
        passed: Boolean(adapter),
        detail: adapter
          ? "The selected observation adapter is declared independent from the acting driver."
          : "No observation adapter is both independent from execution and complete for the outcome contract.",
      },
    ];
    if (!adapter) return { status: "rejected", checks };
    return { status: "compiled", verifier: new CompiledUniversalOutcomeVerifier(contract, adapter, this.now), checks };
  }
}

