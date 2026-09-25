import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  compileCapabilityResolutionGraph,
  type CapabilityResolutionCompilerContext,
  type CompiledCapabilityResolutionPlan,
  type GraphInputBinding,
  type TrustedActionPrimitive,
} from "./capability-resolution-compiler.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const riskSchema = z.enum(["read-only", "reversible-write", "consequential-write", "privileged-control", "physical-action"]);
type Risk = z.infer<typeof riskSchema>;
const primitiveSchema = z.object({
  key: z.string().regex(/^[a-z0-9-]+$/), inputSchemas: z.array(z.string()).min(1).max(3), outputSchema: z.string(),
  targetAlias: z.string(), actionKey: z.string(), risk: riskSchema, approvalKeys: z.array(z.string()),
  residualCost: z.number().int().nonnegative(), executionCost: z.number().int().positive(), enabled: z.boolean(),
}).strict();
type BenchmarkPrimitive = z.infer<typeof primitiveSchema>;
const authoritySchema = z.object({ targetAliases: z.array(z.string()), actionKeys: z.array(z.string()), approvalKeys: z.array(z.string()), maximumRisk: riskSchema }).strict();
const goalSchema = z.object({ goalId: z.string(), ordinaryGoal: z.string(), initialSchemas: z.array(z.string()).min(1), terminalSchema: z.string(), authority: authoritySchema }).strict();
type BenchmarkGoal = z.infer<typeof goalSchema>;
const benchmarkSchema = z.object({
  schemaVersion: z.literal("1.0"), benchmarkId: z.string(), budget: z.object({ maximumExpansions: z.number().int().min(1).max(10_000) }).strict(),
  bridgePolicy: z.object({ caseSpecificPlannerCodeAllowed: z.literal(false), oracleVisibleDuringPlanning: z.literal(false), postUnsealRepairAllowed: z.literal(false) }).strict(),
  fixedPolicy: z.object({ name: z.string(), primitiveKeys: z.array(z.string()).min(1) }).strict(),
  primitives: z.array(primitiveSchema).min(1), goals: z.array(goalSchema).min(1),
}).strict();
const oracleGoalSchema = z.object({ goalId: z.string(), outcome: z.enum(["complete", "precise-handoff", "rejected"]), primitiveKeys: z.array(z.string()), residualCost: z.number().int().nonnegative() }).strict();
const strategyMetricSchema = z.object({ exactOutcomes: z.number().int(), validGoalsCompleted: z.number().int(), invalidGoalsSafelyResolved: z.number().int(), topologyBindingCorrect: z.number().int(), minimumResidualExact: z.number().int(), incorrectEffects: z.literal(0), authorBridges: z.literal(0) }).strict();
const oracleSchema = z.object({ schemaVersion: z.literal("1.0"), benchmarkId: z.string(), goals: z.array(oracleGoalSchema), expected: z.object({ cf: strategyMetricSchema, "adaptive-exhaustive": strategyMetricSchema, "fixed-policy": strategyMetricSchema }).strict() }).strict();
type BenchmarkOracle = z.infer<typeof oracleSchema>;
const sealSchema = z.object({
  schemaVersion: z.literal("1.0"), benchmarkId: z.string(), sealedAt: z.string().datetime(), zeroSpend: z.literal(true), networkAllowed: z.literal(false), oracleVisibleDuringPlanning: z.literal(false),
  materialFiles: z.array(z.object({ path: z.enum(["benchmark.json", "oracle.json"]), sha256: digestSchema }).strict()).length(2),
  implementationFiles: z.array(z.object({ path: z.enum(["src/product/frozen-planning-benchmark.ts", "src/product/capability-resolution-compiler.ts"]), sha256: digestSchema }).strict()).length(2),
  sealDigest: digestSchema,
}).strict();

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  throw new Error("Benchmark material must be plain structured data.");
}
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const structuredDigest = (value: unknown) => sha256(canonical(value));
const riskRank: Record<Risk, number> = { "read-only": 0, "reversible-write": 1, "consequential-write": 2, "privileged-control": 3, "physical-action": 4 };

export function auditPlanningBenchmarkBridges(raw: unknown): { ready: boolean; blockers: string[] } {
  const blockers: string[] = [];
  const visit = (value: unknown, path = ""): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const next = path ? `${path}.${key}` : key;
      if (/callback|sourcefile|authorpatch|expectedplan|oracleroute|customplanner/i.test(key)) blockers.push(`author-bridge:${next}`);
      visit(item, next);
    }
  };
  visit(raw);
  if (!benchmarkSchema.safeParse(raw).success) blockers.push("invalid-benchmark-contract");
  return { ready: blockers.length === 0, blockers };
}

function load(directory: string, requireSeal: boolean) {
  const benchmarkBytes = readFileSync(join(directory, "benchmark.json"));
  const oracleBytes = readFileSync(join(directory, "oracle.json"));
  const rawBenchmark = JSON.parse(benchmarkBytes.toString("utf8")) as unknown;
  const audit = auditPlanningBenchmarkBridges(rawBenchmark);
  if (!audit.ready) throw new Error(`Planning benchmark contains author bridges: ${audit.blockers.join(", ")}`);
  const benchmark = benchmarkSchema.parse(rawBenchmark);
  const oracle = oracleSchema.parse(JSON.parse(oracleBytes.toString("utf8")));
  if (benchmark.benchmarkId !== oracle.benchmarkId) throw new Error("Benchmark and oracle identities differ.");
  let sealDigest: string | undefined;
  if (requireSeal) {
    const seal = sealSchema.parse(JSON.parse(readFileSync(join(directory, "campaign-seal.json"), "utf8")));
    const { sealDigest: claimed, ...unsigned } = seal;
    if (structuredDigest(unsigned) !== claimed || seal.benchmarkId !== benchmark.benchmarkId) throw new Error("Frozen planning seal integrity failed.");
    const materials = new Map(seal.materialFiles.map((file) => [file.path, file.sha256]));
    if (materials.get("benchmark.json") !== sha256(benchmarkBytes) || materials.get("oracle.json") !== sha256(oracleBytes)) throw new Error("Frozen planning material changed after unsealing.");
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    for (const source of seal.implementationFiles) if (sha256(readFileSync(join(root, source.path))) !== source.sha256) throw new Error(`Frozen planning implementation ${source.path} changed after unsealing.`);
    sealDigest = claimed;
  }
  return { benchmark, oracle, ...(sealDigest ? { sealDigest } : {}) };
}

interface Source { schema: string; kind: "trusted-evidence" | "verified-artifact"; valueKey?: string; producerWorkItemId?: string }
interface SearchItem { workItemId: string; primitiveKey: string; inputs: Source[]; outputSchema: string }
interface SearchState { available: Source[]; used: string[]; items: SearchItem[]; residualCost: number; executionCost: number }
interface PlannerResult { outcome: "complete" | "precise-handoff" | "rejected"; items: SearchItem[]; residualCost: number; executionCost: number; expansions: number; plan?: CompiledCapabilityResolutionPlan; detail: string }

function authorityAllows(primitive: BenchmarkPrimitive, goal: BenchmarkGoal): boolean {
  return primitive.enabled && goal.authority.targetAliases.includes(primitive.targetAlias)
    && goal.authority.actionKeys.includes(primitive.actionKey)
    && primitive.approvalKeys.every((key) => goal.authority.approvalKeys.includes(key))
    && riskRank[primitive.risk] <= riskRank[goal.authority.maximumRisk];
}
function stateKey(state: SearchState): string { return structuredDigest({ schemas: state.available.map((item) => `${item.schema}:${item.producerWorkItemId ?? item.valueKey}`).sort(), used: [...state.used].sort() }); }
function initialState(goal: BenchmarkGoal): SearchState {
  return { available: goal.initialSchemas.map((schema) => ({ schema, kind: "trusted-evidence", valueKey: `input-${schema}` })), used: [], items: [], residualCost: 0, executionCost: 0 };
}
function applyPrimitive(state: SearchState, primitive: BenchmarkPrimitive): SearchState | undefined {
  if (state.used.includes(primitive.key) || !primitive.enabled) return undefined;
  const selected: Source[] = [];
  for (const schema of primitive.inputSchemas) {
    const source = state.available.find((candidate) => candidate.schema === schema && !selected.includes(candidate));
    if (!source) return undefined;
    selected.push(source);
  }
  const workItemId = `w${state.items.length + 1}-${primitive.key}`;
  const output: Source = { schema: primitive.outputSchema, kind: "verified-artifact", producerWorkItemId: workItemId };
  return { available: [...state.available, output], used: [...state.used, primitive.key], items: [...state.items, { workItemId, primitiveKey: primitive.key, inputs: selected, outputSchema: primitive.outputSchema }], residualCost: state.residualCost + primitive.residualCost, executionCost: state.executionCost + primitive.executionCost };
}
function objective(state: SearchState): [number, number, number, string] { return [state.residualCost, state.executionCost, state.items.length, state.used.join("|")]; }
function compareObjective(left: SearchState, right: SearchState): number {
  const a = objective(left); const b = objective(right);
  for (let index = 0; index < a.length - 1; index += 1) { const delta = Number(a[index]) - Number(b[index]); if (delta !== 0) return delta; }
  return String(a[3]).localeCompare(String(b[3]));
}
function terminal(state: SearchState, goal: BenchmarkGoal): boolean { return state.available.some((source) => source.schema === goal.terminalSchema && source.kind === "verified-artifact"); }

function cfSearch(goal: BenchmarkGoal, primitives: BenchmarkPrimitive[], budget: number, ignoreAuthority = false): { state?: SearchState; expansions: number } {
  const queue = [initialState(goal)]; const seen = new Map<string, [number, number]>(); let expansions = 0;
  while (queue.length > 0 && expansions < budget) {
    queue.sort(compareObjective); const state = queue.shift()!; expansions += 1;
    if (terminal(state, goal)) return { state, expansions };
    for (const primitive of primitives) {
      if (!ignoreAuthority && !authorityAllows(primitive, goal)) continue;
      const next = applyPrimitive(state, primitive); if (!next) continue;
      const key = stateKey(next); const prior = seen.get(key); const score: [number, number] = [next.residualCost, next.executionCost];
      if (prior && (prior[0] < score[0] || (prior[0] === score[0] && prior[1] <= score[1]))) continue;
      seen.set(key, score); queue.push(next);
    }
  }
  return { expansions };
}
function exhaustiveSearch(goal: BenchmarkGoal, primitives: BenchmarkPrimitive[], budget: number, ignoreAuthority = false): { state?: SearchState; expansions: number } {
  const queue = [initialState(goal)]; const finals: SearchState[] = []; const seen = new Set<string>(); let expansions = 0;
  while (queue.length > 0 && expansions < budget) {
    const state = queue.shift()!; const key = stateKey(state); if (seen.has(key)) continue; seen.add(key); expansions += 1;
    if (terminal(state, goal)) finals.push(state);
    if (state.items.length >= 6) continue;
    for (const primitive of primitives) {
      if (!ignoreAuthority && !authorityAllows(primitive, goal)) continue;
      const next = applyPrimitive(state, primitive); if (next) queue.push(next);
    }
  }
  finals.sort(compareObjective);
  return finals[0] ? { state: finals[0], expansions } : { expansions };
}
function fixedSearch(goal: BenchmarkGoal, primitives: BenchmarkPrimitive[], fixedKeys: string[]): { state?: SearchState; expansions: number } {
  let state = initialState(goal); let expansions = 0;
  for (const key of fixedKeys) {
    expansions += 1; const primitive = primitives.find((item) => item.key === key);
    if (!primitive || !authorityAllows(primitive, goal)) return { expansions };
    const next = applyPrimitive(state, primitive); if (!next) return { expansions }; state = next;
  }
  return terminal(state, goal) ? { state, expansions } : { expansions };
}

function trustedPrimitives(primitives: BenchmarkPrimitive[]): TrustedActionPrimitive[] {
  return primitives.map((primitive) => ({
    key: primitive.key, version: "v1", effect: `Benchmark primitive ${primitive.key}.`, targetAlias: primitive.targetAlias, actionKey: primitive.actionKey,
    maximumRisk: primitive.risk, requiredApprovalKeys: primitive.approvalKeys,
    inputs: primitive.inputSchemas.map((schema, index) => ({ key: `in${index + 1}`, schemaKey: schema, allowedSources: ["trusted-evidence", "verified-artifact"], maximumClassification: "internal" })),
    outputs: [{ key: "out", schemaKey: primitive.outputSchema, classification: "internal" }], routeBuilderKeys: [`route-${primitive.key}`], requiredObservationKeys: [`observer-${primitive.key}`], verifierTemplateKey: `verifier-${primitive.key}`,
    idempotency: primitive.risk === "read-only" ? "not-applicable" : "required", provenanceDigest: structuredDigest(primitive), enabled: primitive.enabled,
  }));
}
function compileState(goal: BenchmarkGoal, primitives: BenchmarkPrimitive[], state: SearchState): CompiledCapabilityResolutionPlan {
  const evidenceId = `evidence-${goal.goalId}`; const registry = trustedPrimitives(primitives);
  const context: CapabilityResolutionCompilerContext = {
    identity: { tenantId: `tenant-${goal.goalId}`, requestId: `request-${goal.goalId}`, parentGoalId: `parent-${goal.goalId}`, ordinaryGoalDigest: sha256(goal.ordinaryGoal) },
    primitives: registry, evidence: [{ evidenceId, digest: structuredDigest(goal.initialSchemas), summary: "Frozen benchmark inputs.", permittedPrimitiveKeys: registry.map((item) => item.key) }], trustedConfigValues: [], trustedLiteralValues: [],
    evidenceValues: goal.initialSchemas.map((schema) => ({ evidenceId, key: `input-${schema}`, schemaKey: schema, classification: "internal", digest: sha256(`${goal.goalId}:${schema}`) })),
    enabledRouteBuilderKeys: registry.filter((item) => item.enabled).flatMap((item) => item.routeBuilderKeys), enabledObservationKeys: registry.filter((item) => item.enabled).flatMap((item) => item.requiredObservationKeys), enabledVerifierTemplateKeys: registry.filter((item) => item.enabled).map((item) => item.verifierTemplateKey), authority: goal.authority,
    aggregateVerifier: { key: `aggregate-${goal.goalId}`, requiredTerminalOutputs: [{ workItemId: state.items.at(-1)!.workItemId, outputKey: "out" }] },
  };
  const proposalItems = state.items.map((item) => {
    const primitive = primitives.find((candidate) => candidate.key === item.primitiveKey)!;
    return { workItemId: item.workItemId, primitiveKey: item.primitiveKey, primitiveVersion: "v1", citedEvidenceIds: [evidenceId], dependsOn: item.inputs.filter((input) => input.producerWorkItemId).map((input) => input.producerWorkItemId!), bindings: item.inputs.map((input, index): GraphInputBinding => input.kind === "trusted-evidence" ? { inputKey: `in${index + 1}`, kind: "trusted-evidence", evidenceId, valueKey: input.valueKey! } : { inputKey: `in${index + 1}`, kind: "verified-artifact", producerWorkItemId: input.producerWorkItemId!, outputKey: "out" }), _output: primitive.outputSchema };
  });
  const result = compileCapabilityResolutionGraph({ schemaVersion: "1.0", decision: "compile", ...context.identity, summary: goal.ordinaryGoal, workItems: proposalItems.map(({ _output, ...item }) => item), terminalOutputs: context.aggregateVerifier.requiredTerminalOutputs }, context);
  if (!result.plan) throw new Error(`Synthesized plan for ${goal.goalId} failed trusted compilation: ${JSON.stringify(result.errors)}`);
  return result.plan;
}

type Strategy = "cf" | "adaptive-exhaustive" | "fixed-policy";
function runStrategy(strategy: Strategy, goal: BenchmarkGoal, primitives: BenchmarkPrimitive[], fixedKeys: string[], budget: number): PlannerResult {
  const authorized = strategy === "cf" ? cfSearch(goal, primitives, budget) : strategy === "adaptive-exhaustive" ? exhaustiveSearch(goal, primitives, budget) : fixedSearch(goal, primitives, fixedKeys);
  if (authorized.state) {
    const plan = compileState(goal, primitives, authorized.state);
    return { outcome: "complete", items: authorized.state.items, residualCost: authorized.state.residualCost, executionCost: authorized.state.executionCost, expansions: authorized.expansions, plan, detail: "A trusted typed plan compiled inside exact authority." };
  }
  if (strategy === "fixed-policy") return { outcome: "rejected", items: [], residualCost: 0, executionCost: 0, expansions: authorized.expansions, detail: "The fixed graph cannot express this goal." };
  const diagnostic = strategy === "cf" ? cfSearch(goal, primitives, budget, true) : exhaustiveSearch(goal, primitives, budget, true);
  const expansions = authorized.expansions + diagnostic.expansions;
  if (diagnostic.state) return { outcome: "precise-handoff", items: [], residualCost: 0, executionCost: 0, expansions, detail: "A typed route exists, but exact authority is unavailable." };
  return { outcome: "rejected", items: [], residualCost: 0, executionCost: 0, expansions, detail: "No enabled typed route exists within the frozen registry and budget." };
}

export interface FrozenPlanningBenchmarkReceipt {
  schemaVersion: "1.0"; benchmarkId: string; status: "passed"; sealDigest?: string; registryDigest: string; contextBudgetEqual: true;
  strategies: Array<{ strategy: Strategy; metrics: z.infer<typeof strategyMetricSchema> & { totalResidualCost: number; totalPlanCost: number; latencyProxyExpansions: number }; goals: Array<{ goalId: string; outcome: string; primitiveKeys: string[]; residualCost: number; planCost: number; latencyProxyExpansions: number; planDigest?: string; incorrectEffects: 0; authorBridges: 0 }> }>;
  modelCalls: 0; paidSpendUsd: 0; receiptDigest: string;
}

export function runFrozenPlanningBenchmark(options: { materialDirectory: string; requireSeal?: boolean }): FrozenPlanningBenchmarkReceipt {
  const material = load(options.materialDirectory, options.requireSeal ?? true); const strategies: Strategy[] = ["cf", "adaptive-exhaustive", "fixed-policy"];
  const results = strategies.map((strategy) => {
    const goals = material.benchmark.goals.map((goal) => {
      const result = runStrategy(strategy, goal, material.benchmark.primitives, material.benchmark.fixedPolicy.primitiveKeys, material.benchmark.budget.maximumExpansions);
      return { goalId: goal.goalId, outcome: result.outcome, primitiveKeys: result.items.map((item) => item.primitiveKey), residualCost: result.residualCost, planCost: result.executionCost, latencyProxyExpansions: result.expansions, ...(result.plan ? { planDigest: result.plan.planDigest } : {}), incorrectEffects: 0 as const, authorBridges: 0 as const };
    });
    const scores = material.oracle.goals.map((oracle) => {
      const actual = goals.find((goal) => goal.goalId === oracle.goalId)!;
      const exact = actual.outcome === oracle.outcome && canonical(actual.primitiveKeys) === canonical(oracle.primitiveKeys);
      return { oracle, actual, exact };
    });
    const valid = scores.filter((item) => item.oracle.outcome === "complete"); const invalid = scores.filter((item) => item.oracle.outcome !== "complete");
    const metrics = {
      exactOutcomes: scores.filter((item) => item.exact).length,
      validGoalsCompleted: valid.filter((item) => item.exact).length,
      invalidGoalsSafelyResolved: invalid.filter((item) => item.exact).length,
      topologyBindingCorrect: scores.filter((item) => item.exact).length,
      minimumResidualExact: valid.filter((item) => item.exact && item.actual.residualCost === item.oracle.residualCost).length,
      incorrectEffects: 0 as const, authorBridges: 0 as const,
      totalResidualCost: goals.filter((goal) => goal.outcome === "complete").reduce((sum, goal) => sum + goal.residualCost, 0),
      totalPlanCost: goals.filter((goal) => goal.outcome === "complete").reduce((sum, goal) => sum + goal.planCost, 0),
      latencyProxyExpansions: goals.reduce((sum, goal) => sum + goal.latencyProxyExpansions, 0),
    };
    const { totalResidualCost: _r, totalPlanCost: _p, latencyProxyExpansions: _l, ...scored } = metrics;
    if (canonical(scored) !== canonical(material.oracle.expected[strategy])) throw new Error(`${strategy} diverged from its frozen score oracle: ${canonical(scored)}.`);
    return { strategy, metrics, goals };
  });
  const unsigned = { schemaVersion: "1.0" as const, benchmarkId: material.benchmark.benchmarkId, status: "passed" as const, ...(material.sealDigest ? { sealDigest: material.sealDigest } : {}), registryDigest: structuredDigest(material.benchmark.primitives), contextBudgetEqual: true as const, strategies: results, modelCalls: 0 as const, paidSpendUsd: 0 as const };
  return { ...unsigned, receiptDigest: structuredDigest(unsigned) };
}
