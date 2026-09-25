import { z } from "zod";
import {
  experimentalBrowserCapabilitySchema,
  experimentalBrowserLocatorSchema,
  type ExperimentalBrowserCapability,
  type ExperimentalBrowserLocator,
} from "./browser-driver.js";
import {
  buildBrowserCapabilityFromUiContract,
  trustedBrowserUiContractSchema,
  trustedBrowserUiContractHash,
  type BrowserCapabilityBuilder,
  type TrustedBrowserUiContract,
} from "./browser-ui-contract.js";

const modelLocatorSchema = z.object({
  kind: z.enum(["test-id", "label", "placeholder", "role"]),
  value: z.string().nullable(),
  role: z.enum(["button", "link", "textbox", "checkbox", "heading", "status", "main"]).nullable(),
  name: z.string().nullable(),
  exact: z.boolean(),
}).strict();

const modelStepSchema = z.object({
  kind: z.enum(["navigate", "assert-text", "assert-input-text", "read-text", "fill", "fill-secret", "click"]),
  path: z.string().nullable(),
  locator: modelLocatorSchema.nullable(),
  expectedText: z.string().nullable(),
  inputKey: z.string().nullable(),
  outputKey: z.string().nullable(),
  secretAlias: z.string().nullable(),
  effect: z.enum(["read", "session-auth", "write"]).nullable(),
  approvalKey: z.string().nullable(),
  sessionSecretAliases: z.array(z.string()),
}).strict();

/** OpenAI-compatible transport: every field is required, with null for fields a step does not use. */
export const modelBrowserCapabilityOutputSchema = z.object({
  schemaVersion: z.literal("0.4"),
  capabilityMode: z.literal("experimental-browser-actions"),
  id: z.string(),
  needKey: z.string(),
  targetAlias: z.string(),
  outcomeVerifierKey: z.string(),
  uiContractHash: z.string(),
  steps: z.array(modelStepSchema).min(1).max(24),
}).strict();

export type ModelBrowserCapabilityOutput = z.infer<typeof modelBrowserCapabilityOutputSchema>;

function locatorFromModel(raw: z.infer<typeof modelLocatorSchema>): ExperimentalBrowserLocator {
  if (raw.kind === "test-id") {
    return experimentalBrowserLocatorSchema.parse({ kind: raw.kind, value: raw.value });
  }
  if (raw.kind === "label" || raw.kind === "placeholder") {
    return experimentalBrowserLocatorSchema.parse({ kind: raw.kind, value: raw.value, exact: raw.exact });
  }
  return experimentalBrowserLocatorSchema.parse({
    kind: raw.kind,
    role: raw.role,
    ...(raw.name === null ? {} : { name: raw.name }),
    ...(raw.role === "main" ? {} : { exact: raw.exact }),
  });
}

function required<T>(value: T | null, field: string, kind: string): T {
  if (value === null) throw new Error(`Model browser ${kind} step requires ${field}.`);
  return value;
}

export function browserCapabilityFromModelOutput(raw: unknown): ExperimentalBrowserCapability {
  const output = modelBrowserCapabilityOutputSchema.parse(raw);
  const steps: ExperimentalBrowserCapability["steps"] = output.steps.map((step) => {
    if (step.kind === "navigate") {
      return { kind: step.kind, path: required(step.path, "path", step.kind) };
    }
    const locator = locatorFromModel(required(step.locator, "locator", step.kind));
    if (step.kind === "assert-text") {
      return { kind: step.kind, locator, expectedText: required(step.expectedText, "expectedText", step.kind) };
    }
    if (step.kind === "assert-input-text") {
      return { kind: step.kind, locator, inputKey: required(step.inputKey, "inputKey", step.kind) };
    }
    if (step.kind === "read-text") {
      return { kind: step.kind, locator, outputKey: required(step.outputKey, "outputKey", step.kind) };
    }
    if (step.kind === "fill") {
      return { kind: step.kind, locator, inputKey: required(step.inputKey, "inputKey", step.kind) };
    }
    if (step.kind === "fill-secret") {
      return { kind: step.kind, locator, secretAlias: required(step.secretAlias, "secretAlias", step.kind) };
    }
    const effect = required(step.effect, "effect", step.kind);
    return experimentalBrowserCapabilitySchema.shape.steps.element.parse({
      kind: step.kind,
      locator,
      effect,
      ...(step.approvalKey === null ? {} : { approvalKey: step.approvalKey }),
      ...(step.sessionSecretAliases.length === 0 ? {} : { sessionSecretAliases: step.sessionSecretAliases }),
    });
  });
  return experimentalBrowserCapabilitySchema.parse({
    schemaVersion: output.schemaVersion,
    capabilityMode: output.capabilityMode,
    id: output.id,
    needKey: output.needKey,
    targetAlias: output.targetAlias,
    outcomeVerifierKey: output.outcomeVerifierKey,
    uiContractHash: output.uiContractHash,
    steps,
  });
}

export interface BrowserCapabilityModelDraftInput {
  needKey: string;
  uiContractHash: string;
  trustedUiContract: TrustedBrowserUiContract;
  previousError?: string;
  previousDraft?: unknown;
}

export interface BrowserCapabilityModelDraftGateway {
  readonly modelLabel: string;
  draft(input: BrowserCapabilityModelDraftInput): Promise<unknown>;
  spentUsd?(): number;
}

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

function allowedContractValues(contract: TrustedBrowserUiContract) {
  const auth = contract.authentication.kind === "session-form" ? contract.authentication : undefined;
  return {
    paths: new Set([...(auth ? [auth.path] : []), contract.workPage.path]),
    locators: new Set([
      ...(auth ? auth.assertions.map((item) => canonical(item.locator)) : []),
      ...(auth ? auth.fields.map((item) => canonical(item.locator)) : []),
      ...(auth ? [canonical(auth.submit)] : []),
      ...contract.workPage.assertions.map((item) => canonical(item.locator)),
      ...contract.workPage.fields.map((item) => canonical(item.locator)),
      canonical(contract.workPage.submit),
      canonical(contract.workPage.confirmation.locator),
    ]),
    inputKeys: new Set([
      ...(auth ? auth.fields.filter((item) => item.source === "input").map((item) => item.inputKey) : []),
      ...contract.workPage.fields.filter((item) => item.source === "input").map((item) => item.inputKey),
      ...(contract.workPage.confirmation && "expectedInputKey" in contract.workPage.confirmation
        ? [contract.workPage.confirmation.expectedInputKey]
        : []),
    ]),
    secretAliases: new Set([
      ...(auth ? auth.fields.filter((item) => item.source === "secret").map((item) => item.secretAlias) : []),
      ...contract.workPage.fields.filter((item) => item.source === "secret").map((item) => item.secretAlias),
    ]),
  };
}

function assertCandidateBoundToContract(
  candidate: ExperimentalBrowserCapability,
  contract: TrustedBrowserUiContract,
): void {
  if (
    candidate.id !== contract.capabilityId
    || candidate.needKey !== contract.needKey
    || candidate.targetAlias !== contract.targetAlias
    || candidate.outcomeVerifierKey !== contract.outcomeVerifierKey
    || candidate.uiContractHash !== contract.contractHash
  ) {
    throw new Error("The model browser candidate changed trusted capability identity or provenance.");
  }
  const allowed = allowedContractValues(contract);
  for (const step of candidate.steps) {
    if (step.kind === "navigate" && !allowed.paths.has(step.path)) {
      throw new Error(`The model browser candidate invented a path: ${step.path}`);
    }
    if ("locator" in step && !allowed.locators.has(canonical(step.locator))) {
      throw new Error("The model browser candidate invented an untrusted locator.");
    }
    if ((step.kind === "fill" || step.kind === "assert-input-text") && !allowed.inputKeys.has(step.inputKey)) {
      throw new Error(`The model browser candidate invented an input key: ${step.inputKey}`);
    }
    if (step.kind === "fill-secret" && !allowed.secretAliases.has(step.secretAlias)) {
      throw new Error(`The model browser candidate invented a secret alias: ${step.secretAlias}`);
    }
    if (step.kind === "click" && step.effect === "write" && step.approvalKey !== contract.workPage.approvalKey) {
      throw new Error("The model browser candidate changed the trusted write approval.");
    }
    if (step.kind === "click" && step.effect === "session-auth") {
      for (const secretAlias of step.sessionSecretAliases ?? []) {
        if (!allowed.secretAliases.has(secretAlias)) {
          throw new Error(`The model browser candidate invented a session credential alias: ${secretAlias}`);
        }
      }
    }
  }
  const deterministicMinimum = buildBrowserCapabilityFromUiContract(contract);
  if (canonical(candidate.steps) !== canonical(deterministicMinimum.steps)) {
    throw new Error("The model browser candidate did not preserve the complete minimum trusted UI sequence.");
  }
}

/**
 * Optional model-backed translator from one hashed, customer-trusted UI contract
 * to the same constrained browser manifest used by the deterministic builder.
 * It cannot discover hosts, paths, controls, credentials, approvals, or verifiers.
 */
export class StructuredModelBrowserCapabilityBuilder implements BrowserCapabilityBuilder {
  readonly builderId: string;

  constructor(
    private readonly gateway: BrowserCapabilityModelDraftGateway,
    private readonly contracts: TrustedBrowserUiContract[],
    private readonly maxAttempts = 2,
  ) {
    this.builderId = `model-browser-builder-${gateway.modelLabel}`.replaceAll(/[^a-zA-Z0-9_.-]/g, "-");
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
      throw new Error("Model browser construction attempts must be between one and three.");
    }
  }

  async build(needKey: string, uiContractHash: string): Promise<ExperimentalBrowserCapability | null> {
    const contract = this.contracts.find((candidate) =>
      candidate.needKey === needKey && candidate.contractHash === uiContractHash,
    );
    if (!contract) return null;
    trustedBrowserUiContractSchema.parse(contract);
    const { contractHash, ...withoutHash } = contract;
    if (trustedBrowserUiContractHash(withoutHash) !== contractHash) {
      throw new Error("The model browser builder rejected a tampered trusted UI contract.");
    }
    let previousError: string | undefined;
    let previousDraft: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const draft = await this.gateway.draft({
          needKey,
          uiContractHash,
          trustedUiContract: contract,
          ...(previousError ? { previousError, previousDraft } : {}),
        });
        previousDraft = draft;
        const candidate = browserCapabilityFromModelOutput(draft);
        assertCandidateBoundToContract(candidate, contract);
        return candidate;
      } catch (error) {
        previousError = error instanceof Error ? error.message : String(error);
      }
    }
    throw new Error(`Model browser construction failed after ${this.maxAttempts} bounded attempts: ${previousError ?? "unknown error"}`);
  }
}
