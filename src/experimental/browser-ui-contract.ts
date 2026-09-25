import { createHash } from "node:crypto";
import { z } from "zod";
import {
  experimentalBrowserCapabilitySchema,
  experimentalBrowserLocatorSchema,
  type ExperimentalBrowserCapability,
  type ExperimentalBrowserLocator,
} from "./browser-driver.js";

export const TRUSTED_BROWSER_UI_CONTRACT_VERSION = "1.0" as const;

const identifier = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_.-]+$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

const assertionSchema = z.object({
  locator: experimentalBrowserLocatorSchema,
  expectedText: z.string().min(1).max(1_000),
}).strict();

const fieldSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("input"),
    locator: experimentalBrowserLocatorSchema,
    inputKey: identifier,
  }).strict(),
  z.object({
    source: z.literal("secret"),
    locator: experimentalBrowserLocatorSchema,
    secretAlias: identifier,
  }).strict(),
]);

export const trustedBrowserUiContractSchema = z.object({
  schemaVersion: z.literal(TRUSTED_BROWSER_UI_CONTRACT_VERSION),
  contractId: identifier,
  capabilityId: identifier,
  needKey: identifier,
  targetAlias: identifier,
  outcomeVerifierKey: identifier,
  authentication: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }).strict(),
    z.object({
      kind: z.literal("session-form"),
      path: z.string().startsWith("/").max(500),
      assertions: z.array(assertionSchema).min(1).max(8),
      fields: z.array(fieldSchema).min(1).max(8),
      submit: experimentalBrowserLocatorSchema,
      secretAliases: z.array(identifier).min(1).max(4),
    }).strict(),
  ]),
  workPage: z.object({
    path: z.string().startsWith("/").max(500),
    assertions: z.array(assertionSchema).min(1).max(8),
    fields: z.array(fieldSchema).min(1).max(16),
    submit: experimentalBrowserLocatorSchema,
    approvalKey: identifier,
    confirmation: z.union([
      z.object({
        locator: experimentalBrowserLocatorSchema,
        expectedText: z.string().min(1).max(1_000),
        outputKey: identifier.optional(),
      }).strict(),
      z.object({
        locator: experimentalBrowserLocatorSchema,
        expectedInputKey: identifier,
        outputKey: identifier.optional(),
      }).strict(),
    ]),
  }).strict(),
  contractHash: sha256,
}).strict();

export type TrustedBrowserUiContract = z.infer<typeof trustedBrowserUiContractSchema>;

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

export function trustedBrowserUiContractHash(
  contract: Omit<TrustedBrowserUiContract, "contractHash">,
): string {
  return createHash("sha256").update(canonical(contract)).digest("hex");
}

export function defineTrustedBrowserUiContract(
  contract: Omit<TrustedBrowserUiContract, "contractHash">,
): TrustedBrowserUiContract {
  return trustedBrowserUiContractSchema.parse({
    ...contract,
    contractHash: trustedBrowserUiContractHash(contract),
  });
}

function fillStep(field: z.infer<typeof fieldSchema>) {
  return field.source === "input"
    ? { kind: "fill" as const, locator: field.locator, inputKey: field.inputKey }
    : { kind: "fill-secret" as const, locator: field.locator, secretAlias: field.secretAlias };
}

/** Deterministic minimum capability construction from customer-trusted UI metadata. */
export function buildBrowserCapabilityFromUiContract(
  rawContract: TrustedBrowserUiContract,
): ExperimentalBrowserCapability {
  const contract = trustedBrowserUiContractSchema.parse(rawContract);
  const { contractHash: _hash, ...withoutHash } = contract;
  if (trustedBrowserUiContractHash(withoutHash) !== contract.contractHash) {
    throw new Error("The trusted browser UI contract hash does not match its contents.");
  }
  const steps: ExperimentalBrowserCapability["steps"] = [];
  if (contract.authentication.kind === "session-form") {
    steps.push(
      { kind: "navigate", path: contract.authentication.path },
      ...contract.authentication.assertions.map((assertion) => ({ kind: "assert-text" as const, ...assertion })),
      ...contract.authentication.fields.map(fillStep),
      {
        kind: "click",
        locator: contract.authentication.submit,
        effect: "session-auth",
        sessionSecretAliases: [...contract.authentication.secretAliases],
      },
    );
  }
  const confirmationStep = "expectedText" in contract.workPage.confirmation
    ? {
        kind: "assert-text" as const,
        locator: contract.workPage.confirmation.locator,
        expectedText: contract.workPage.confirmation.expectedText,
      }
    : {
        kind: "assert-input-text" as const,
        locator: contract.workPage.confirmation.locator,
        inputKey: contract.workPage.confirmation.expectedInputKey,
      };
  steps.push(
    { kind: "navigate", path: contract.workPage.path },
    ...contract.workPage.assertions.map((assertion) => ({ kind: "assert-text" as const, ...assertion })),
    ...contract.workPage.fields.map(fillStep),
    {
      kind: "click",
      locator: contract.workPage.submit,
      effect: "write",
      approvalKey: contract.workPage.approvalKey,
    },
    confirmationStep,
  );
  if (contract.workPage.confirmation.outputKey) {
    steps.push({
      kind: "read-text",
      locator: contract.workPage.confirmation.locator,
      outputKey: contract.workPage.confirmation.outputKey,
    });
  }
  return experimentalBrowserCapabilitySchema.parse({
    schemaVersion: "0.4",
    capabilityMode: "experimental-browser-actions",
    id: contract.capabilityId,
    needKey: contract.needKey,
    targetAlias: contract.targetAlias,
    outcomeVerifierKey: contract.outcomeVerifierKey,
    uiContractHash: contract.contractHash,
    steps,
  });
}

export interface BrowserCapabilityBuilder {
  readonly builderId: string;
  build(needKey: string, uiContractHash: string): Promise<ExperimentalBrowserCapability | null>;
}

/** Reference builder. It receives only the diagnosed need and trusted contract hash. */
export class TrustedUiContractBrowserCapabilityBuilder implements BrowserCapabilityBuilder {
  constructor(
    readonly builderId: string,
    private readonly contracts: TrustedBrowserUiContract[],
  ) {}

  async build(needKey: string, uiContractHash: string): Promise<ExperimentalBrowserCapability | null> {
    const contract = this.contracts.find((candidate) =>
      candidate.needKey === needKey && candidate.contractHash === uiContractHash,
    );
    return contract ? buildBrowserCapabilityFromUiContract(contract) : null;
  }
}

export function locatorKey(locator: ExperimentalBrowserLocator): string {
  return canonical(experimentalBrowserLocatorSchema.parse(locator));
}
