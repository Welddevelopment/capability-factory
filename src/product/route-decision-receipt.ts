import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const riskSchema = z.enum(["read-only", "reversible-write", "consequential-write", "privileged-control", "physical-action"]);
type Risk = z.infer<typeof riskSchema>;
const primitiveSchema = z.object({
  key: z.string(), inputSchemas: z.array(z.string()).min(1), outputSchema: z.string(), targetAlias: z.string(), actionKey: z.string(),
  risk: riskSchema, approvalKeys: z.array(z.string()), residualCost: z.number().int().nonnegative(), executionCost: z.number().int().positive(), enabled: z.boolean(),
}).strict();
type Primitive = z.infer<typeof primitiveSchema>;
const authoritySchema = z.object({ targetAliases: z.array(z.string()), actionKeys: z.array(z.string()), approvalKeys: z.array(z.string()), maximumRisk: riskSchema }).strict();
const goalSchema = z.object({ goalId: z.string(), ordinaryGoal: z.string(), initialSchemas: z.array(z.string()), terminalSchema: z.string(), authority: authoritySchema }).strict();
type Goal = z.infer<typeof goalSchema>;
const benchmarkSchema = z.object({
  schemaVersion: z.literal("1.0"), benchmarkId: z.string(), budget: z.object({ maximumExpansions: z.number().int().positive() }).strict(),
  bridgePolicy: z.object({ caseSpecificPlannerCodeAllowed: z.literal(false), oracleVisibleDuringPlanning: z.literal(false), postUnsealRepairAllowed: z.literal(false) }).strict(),
  fixedPolicy: z.object({ name: z.string(), primitiveKeys: z.array(z.string()) }).strict(), primitives: z.array(primitiveSchema), goals: z.array(goalSchema),
}).strict();

const goalResultSchema = z.object({
  goalId: z.string(), outcome: z.enum(["complete", "precise-handoff", "rejected"]), primitiveKeys: z.array(z.string()), residualCost: z.number().int().nonnegative(),
  planCost: z.number().int().nonnegative(), latencyProxyExpansions: z.number().int().nonnegative(), planDigest: digestSchema.optional(), incorrectEffects: z.literal(0), authorBridges: z.literal(0),
}).strict();
const strategySchema = z.object({ strategy: z.enum(["cf", "adaptive-exhaustive", "fixed-policy"]), metrics: z.record(z.string(), z.number()), goals: z.array(goalResultSchema) }).strict();
const benchmarkReceiptSchema = z.object({
  schemaVersion: z.literal("1.0"), benchmarkId: z.string(), status: z.literal("passed"), sealDigest: digestSchema,
  registryDigest: digestSchema, contextBudgetEqual: z.literal(true), strategies: z.array(strategySchema).length(3), modelCalls: z.literal(0), paidSpendUsd: z.literal(0), receiptDigest: digestSchema,
}).strict();

const bindingSchema = z.object({ inputSchema: z.string(), sourceKind: z.enum(["trusted-input", "verified-artifact"]), sourceId: z.string() }).strict();
const candidateItemSchema = z.object({ ordinal: z.number().int().positive(), primitiveKey: z.string(), outputSchema: z.string(), bindings: z.array(bindingSchema) }).strict();
const candidateGateSchema = z.object({
  typedFeasible: z.boolean(), toolAvailable: z.boolean(), verifierAvailable: z.boolean(), authorityAllowed: z.boolean(),
  failureCodes: z.array(z.enum(["tool-disabled", "verifier-unavailable", "authority-target", "authority-action", "authority-approval", "authority-risk"])),
}).strict();
const candidateSchema = z.object({
  candidateId: z.string(), topology: z.array(candidateItemSchema).min(1), terminalSchema: z.string(), gates: candidateGateSchema,
  residualCost: z.number().int().nonnegative(), executionCost: z.number().int().positive(), eligible: z.boolean(),
}).strict();
const reasonSchema = z.object({
  code: z.enum(["selected-minimum-objective", "authority-required", "no-typed-route", "tool-or-verifier-unavailable"]),
  detail: z.enum([
    "Selected the eligible typed route with minimum residual cost, then execution cost, then topology size and stable identity.",
    "A typed route exists with enabled tools and verifiers, but exact current authority is unavailable.",
    "No typed route reaches the terminal schema within the enabled frozen registry and search budget.",
    "A typed route exists only through a disabled tool or unavailable verifier surface.",
  ]),
}).strict();
const counterfactualSchema = z.object({
  strategy: z.enum(["adaptive-exhaustive", "fixed-policy"]), outcome: z.enum(["complete", "precise-handoff", "rejected"]),
  primitiveKeys: z.array(z.string()), residualCost: z.number().int().nonnegative(), executionCost: z.number().int().nonnegative(),
  expansions: z.number().int().nonnegative(), planDigest: digestSchema.optional(),
}).strict();
const routeDecisionSchema = z.object({
  schemaVersion: z.literal("1.0"), receiptId: z.string(), benchmarkId: z.string(), goalId: z.string(),
  source: z.object({ benchmarkDigest: digestSchema, benchmarkExecutionReceiptDigest: digestSchema, registryDigest: digestSchema }).strict(),
  sanitizedContext: z.object({ initialSchemaKeys: z.array(z.string()), terminalSchemaKey: z.string(), authorityEnvelopeDigest: digestSchema }).strict(),
  search: z.object({ strategy: z.literal("cf"), maximumExpansions: z.number().int().positive(), usedExpansions: z.number().int().nonnegative(), candidateEnumerationExpansions: z.number().int().nonnegative(), exhausted: z.boolean() }).strict(),
  candidates: z.array(candidateSchema), selectedCandidateId: z.string().optional(), outcome: z.enum(["compiled", "precise-handoff", "rejected"]),
  selectedPath: z.array(candidateItemSchema).optional(), compiledPlanDigest: digestSchema.optional(), residualCost: z.number().int().nonnegative(), executionCost: z.number().int().nonnegative(),
  reasons: z.array(reasonSchema).min(1), counterfactuals: z.array(counterfactualSchema).length(2), secretValuesExposed: z.literal(false), oracleAnswersExposed: z.literal(false), receiptDigest: digestSchema,
}).strict();
export type RouteDecisionReceipt = z.infer<typeof routeDecisionSchema>;

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  throw new Error("Route-decision material must be plain structured data.");
}
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const structuredDigest = (value: unknown) => sha256(canonical(value));
const riskRank: Record<Risk, number> = { "read-only": 0, "reversible-write": 1, "consequential-write": 2, "privileged-control": 3, "physical-action": 4 };

interface AvailableSource { schema: string; sourceKind: "trusted-input" | "verified-artifact"; sourceId: string }
interface CandidateState { available: AvailableSource[]; used: string[]; topology: z.infer<typeof candidateItemSchema>[]; residualCost: number; executionCost: number }

function authorityFailures(primitive: Primitive, goal: Goal): z.infer<typeof candidateGateSchema>["failureCodes"] {
  const failures: z.infer<typeof candidateGateSchema>["failureCodes"] = [];
  if (!goal.authority.targetAliases.includes(primitive.targetAlias)) failures.push("authority-target");
  if (!goal.authority.actionKeys.includes(primitive.actionKey)) failures.push("authority-action");
  if (!primitive.approvalKeys.every((key) => goal.authority.approvalKeys.includes(key))) failures.push("authority-approval");
  if (riskRank[primitive.risk] > riskRank[goal.authority.maximumRisk]) failures.push("authority-risk");
  return failures;
}

function enumerateCandidates(goal: Goal, primitives: Primitive[], maximumExpansions: number): { candidates: z.infer<typeof candidateSchema>[]; expansions: number; exhausted: boolean } {
  const initial: CandidateState = {
    available: goal.initialSchemas.map((schema) => ({ schema, sourceKind: "trusted-input", sourceId: `input:${schema}` })),
    used: [], topology: [], residualCost: 0, executionCost: 0,
  };
  const queue = [initial]; const seen = new Set<string>(); const candidates: z.infer<typeof candidateSchema>[] = []; let expansions = 0;
  while (queue.length > 0 && expansions < maximumExpansions) {
    const state = queue.shift()!; const stateDigest = structuredDigest({ used: state.used, available: state.available });
    if (seen.has(stateDigest)) continue; seen.add(stateDigest); expansions += 1;
    const terminal = state.available.some((source) => source.schema === goal.terminalSchema && source.sourceKind === "verified-artifact");
    if (terminal) {
      const usedPrimitives = state.used.map((key) => primitives.find((primitive) => primitive.key === key)!);
      const failureCodes = [...new Set(usedPrimitives.flatMap((primitive) => [
        ...(!primitive.enabled ? ["tool-disabled" as const, "verifier-unavailable" as const] : []),
        ...authorityFailures(primitive, goal),
      ]))].sort();
      const toolAvailable = usedPrimitives.every((primitive) => primitive.enabled);
      const verifierAvailable = toolAvailable;
      const authorityAllowed = usedPrimitives.every((primitive) => authorityFailures(primitive, goal).length === 0);
      const unsigned = { topology: state.topology, terminalSchema: goal.terminalSchema, gates: { typedFeasible: true, toolAvailable, verifierAvailable, authorityAllowed, failureCodes }, residualCost: state.residualCost, executionCost: state.executionCost, eligible: toolAvailable && verifierAvailable && authorityAllowed };
      candidates.push({ candidateId: `candidate-${structuredDigest(unsigned).slice(0, 24)}`, ...unsigned });
      continue;
    }
    if (state.topology.length >= 6) continue;
    for (const primitive of primitives) {
      if (state.used.includes(primitive.key)) continue;
      const selected: AvailableSource[] = [];
      for (const schema of primitive.inputSchemas) {
        const source = state.available.find((candidate) => candidate.schema === schema && !selected.includes(candidate));
        if (source) selected.push(source);
      }
      if (selected.length !== primitive.inputSchemas.length) continue;
      const ordinal = state.topology.length + 1; const itemId = `w${ordinal}-${primitive.key}`;
      const item = { ordinal, primitiveKey: primitive.key, outputSchema: primitive.outputSchema, bindings: selected.map((source) => ({ inputSchema: source.schema, sourceKind: source.sourceKind, sourceId: source.sourceId })) };
      queue.push({ available: [...state.available, { schema: primitive.outputSchema, sourceKind: "verified-artifact", sourceId: itemId }], used: [...state.used, primitive.key], topology: [...state.topology, item], residualCost: state.residualCost + primitive.residualCost, executionCost: state.executionCost + primitive.executionCost });
    }
  }
  const deduplicated = [...new Map(candidates.map((candidate) => [candidate.candidateId, candidate])).values()]
    .sort((left, right) => left.residualCost - right.residualCost
      || left.executionCost - right.executionCost
      || left.topology.length - right.topology.length
      || left.topology.map((item) => item.primitiveKey).join("|").localeCompare(right.topology.map((item) => item.primitiveKey).join("|"))
      || left.candidateId.localeCompare(right.candidateId));
  return { candidates: deduplicated, expansions, exhausted: queue.length > 0 };
}

function readSources(materialDirectory: string, benchmarkReceiptPath: string) {
  const benchmarkBytes = readFileSync(join(materialDirectory, "benchmark.json"));
  const benchmark = benchmarkSchema.parse(JSON.parse(benchmarkBytes.toString("utf8")));
  const benchmarkReceipt = benchmarkReceiptSchema.parse(JSON.parse(readFileSync(benchmarkReceiptPath, "utf8")));
  if (benchmark.benchmarkId !== benchmarkReceipt.benchmarkId) throw new Error("Benchmark execution receipt belongs to a different benchmark.");
  if (structuredDigest(benchmark.primitives) !== benchmarkReceipt.registryDigest) throw new Error("Benchmark primitive registry changed after the planning receipt.");
  const { receiptDigest, ...unsigned } = benchmarkReceipt;
  if (structuredDigest(unsigned) !== receiptDigest) throw new Error("Benchmark execution receipt failed its integrity check.");
  return { benchmark, benchmarkDigest: sha256(benchmarkBytes), benchmarkReceipt };
}

function expectedReceipt(goal: Goal, benchmark: z.infer<typeof benchmarkSchema>, benchmarkDigest: string, benchmarkReceipt: z.infer<typeof benchmarkReceiptSchema>): RouteDecisionReceipt {
  const cf = benchmarkReceipt.strategies.find((strategy) => strategy.strategy === "cf")!.goals.find((item) => item.goalId === goal.goalId)!;
  const enumerated = enumerateCandidates(goal, benchmark.primitives, benchmark.budget.maximumExpansions);
  const eligible = enumerated.candidates.filter((candidate) => candidate.eligible);
  const authorityBlocked = enumerated.candidates.filter((candidate) => candidate.gates.typedFeasible && candidate.gates.toolAvailable && candidate.gates.verifierAvailable && !candidate.gates.authorityAllowed);
  const disabled = enumerated.candidates.filter((candidate) => !candidate.gates.toolAvailable || !candidate.gates.verifierAvailable);
  let outcome: RouteDecisionReceipt["outcome"]; let selected: z.infer<typeof candidateSchema> | undefined; let reasons: z.infer<typeof reasonSchema>[];
  if (eligible[0]) {
    outcome = "compiled"; selected = eligible[0]; reasons = [{ code: "selected-minimum-objective", detail: "Selected the eligible typed route with minimum residual cost, then execution cost, then topology size and stable identity." }];
  } else if (authorityBlocked[0]) {
    outcome = "precise-handoff"; selected = authorityBlocked[0]; reasons = [{ code: "authority-required", detail: "A typed route exists with enabled tools and verifiers, but exact current authority is unavailable." }];
  } else if (disabled[0]) {
    outcome = "rejected"; reasons = [{ code: "tool-or-verifier-unavailable", detail: "A typed route exists only through a disabled tool or unavailable verifier surface." }];
  } else {
    outcome = "rejected"; reasons = [{ code: "no-typed-route", detail: "No typed route reaches the terminal schema within the enabled frozen registry and search budget." }];
  }
  const mappedCfOutcome = cf.outcome === "complete" ? "compiled" : cf.outcome;
  if (outcome !== mappedCfOutcome || (outcome === "compiled" && selected && canonical(selected.topology.map((item) => item.primitiveKey)) !== canonical(cf.primitiveKeys))) throw new Error(`Rebuilt decision for ${goal.goalId} differs from the frozen CF benchmark result.`);
  const counterfactuals = (["adaptive-exhaustive", "fixed-policy"] as const).map((strategy) => {
    const result = benchmarkReceipt.strategies.find((item) => item.strategy === strategy)!.goals.find((item) => item.goalId === goal.goalId)!;
    return { strategy, outcome: result.outcome, primitiveKeys: result.primitiveKeys, residualCost: result.residualCost, executionCost: result.planCost, expansions: result.latencyProxyExpansions, ...(result.planDigest ? { planDigest: result.planDigest } : {}) };
  });
  const unsigned = {
    schemaVersion: "1.0" as const, receiptId: `route-decision-${goal.goalId}`, benchmarkId: benchmark.benchmarkId, goalId: goal.goalId,
    source: { benchmarkDigest, benchmarkExecutionReceiptDigest: benchmarkReceipt.receiptDigest, registryDigest: benchmarkReceipt.registryDigest },
    sanitizedContext: { initialSchemaKeys: [...goal.initialSchemas].sort(), terminalSchemaKey: goal.terminalSchema, authorityEnvelopeDigest: structuredDigest(goal.authority) },
    search: { strategy: "cf" as const, maximumExpansions: benchmark.budget.maximumExpansions, usedExpansions: cf.latencyProxyExpansions, candidateEnumerationExpansions: enumerated.expansions, exhausted: enumerated.exhausted },
    candidates: enumerated.candidates, ...(selected ? { selectedCandidateId: selected.candidateId } : {}), outcome,
    ...(outcome === "compiled" && selected ? { selectedPath: selected.topology, compiledPlanDigest: cf.planDigest } : {}),
    residualCost: selected?.residualCost ?? 0, executionCost: selected?.executionCost ?? 0, reasons, counterfactuals,
    secretValuesExposed: false as const, oracleAnswersExposed: false as const,
  };
  return routeDecisionSchema.parse({ ...unsigned, receiptDigest: structuredDigest(unsigned) });
}

export function createRouteDecisionReceipts(options: { materialDirectory: string; benchmarkReceiptPath: string }): RouteDecisionReceipt[] {
  const source = readSources(options.materialDirectory, options.benchmarkReceiptPath);
  return source.benchmark.goals.map((goal) => expectedReceipt(goal, source.benchmark, source.benchmarkDigest, source.benchmarkReceipt));
}

export function validateRouteDecisionReceipt(receipt: unknown, options: { materialDirectory: string; benchmarkReceiptPath: string }): RouteDecisionReceipt {
  const parsed = routeDecisionSchema.parse(receipt);
  const { receiptDigest, ...unsigned } = parsed;
  if (structuredDigest(unsigned) !== receiptDigest) throw new Error("Route-decision receipt failed its integrity check.");
  const source = readSources(options.materialDirectory, options.benchmarkReceiptPath);
  const goal = source.benchmark.goals.find((item) => item.goalId === parsed.goalId);
  if (!goal) throw new Error("Route-decision receipt names an unknown goal.");
  const expected = expectedReceipt(goal, source.benchmark, source.benchmarkDigest, source.benchmarkReceipt);
  if (canonical(parsed) !== canonical(expected)) throw new Error("Route-decision explanation does not rebuild deterministically from the frozen non-oracle sources.");
  return parsed;
}
