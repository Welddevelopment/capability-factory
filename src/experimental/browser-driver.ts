import { createHash } from "node:crypto";
import { z } from "zod";
import type { RuntimeActionControlContext, RuntimeOperationGuard } from "../runtime.js";
import type { LocalSecretProvider } from "../product/secrets.js";

export const EXPERIMENTAL_BROWSER_DRIVER_VERSION = "browser-driver-v0.4" as const;
export const EXPERIMENTAL_BROWSER_CAPABILITY_MODE = "experimental-browser-actions" as const;

export class ExperimentalBrowserPolicyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExperimentalBrowserPolicyViolationError";
  }
}

export class ExperimentalBrowserOperationalBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExperimentalBrowserOperationalBlockedError";
  }
}

const identifier = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_.-]+$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const experimentalBrowserLocatorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("test-id"), value: z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/) }).strict(),
  z.object({ kind: z.literal("label"), value: z.string().min(1).max(200), exact: z.literal(true) }).strict(),
  z.object({ kind: z.literal("placeholder"), value: z.string().min(1).max(200), exact: z.literal(true) }).strict(),
  z.object({
    kind: z.literal("role"),
    role: z.enum(["button", "link", "textbox", "checkbox", "heading", "status", "main"]),
    name: z.string().min(1).max(200).optional(),
    exact: z.literal(true).optional(),
  }).strict().superRefine((locator, context) => {
    if (locator.role !== "main" && (!locator.name || locator.exact !== true)) {
      context.addIssue({ code: "custom", message: "Named semantic roles require an exact accessible name." });
    }
    if (locator.role === "main" && (locator.name || locator.exact)) {
      context.addIssue({ code: "custom", message: "The unique main landmark locator does not accept a name." });
    }
  }),
]);

export type ExperimentalBrowserLocator = z.infer<typeof experimentalBrowserLocatorSchema>;

const browserStepSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), path: z.string().startsWith("/").max(500) }).strict(),
  z.object({ kind: z.literal("assert-text"), locator: experimentalBrowserLocatorSchema, expectedText: z.string().min(1).max(1_000) }).strict(),
  z.object({ kind: z.literal("assert-input-text"), locator: experimentalBrowserLocatorSchema, inputKey: identifier }).strict(),
  z.object({ kind: z.literal("read-text"), locator: experimentalBrowserLocatorSchema, outputKey: identifier }).strict(),
  z.object({ kind: z.literal("fill"), locator: experimentalBrowserLocatorSchema, inputKey: identifier }).strict(),
  z.object({ kind: z.literal("fill-secret"), locator: experimentalBrowserLocatorSchema, secretAlias: identifier }).strict(),
  z.object({
    kind: z.literal("click"),
    locator: experimentalBrowserLocatorSchema,
    effect: z.enum(["read", "session-auth", "write"]),
    approvalKey: identifier.optional(),
    sessionSecretAliases: z.array(identifier).min(1).max(4).optional(),
  }).strict().superRefine((step, context) => {
    if (step.effect === "write" && !step.approvalKey) {
      context.addIssue({ code: "custom", message: "A browser write click requires an explicit approval key." });
    }
    if (step.effect !== "write" && step.approvalKey) {
      context.addIssue({ code: "custom", message: "Only a business-write browser click can request write approval." });
    }
    if (step.effect === "session-auth" && !step.sessionSecretAliases) {
      context.addIssue({ code: "custom", message: "A session-auth click must name the customer-local secret aliases it depends on." });
    }
    if (step.effect !== "session-auth" && step.sessionSecretAliases) {
      context.addIssue({ code: "custom", message: "Only a session-auth click can declare session credential aliases." });
    }
  }),
]);

export const experimentalBrowserCapabilitySchema = z.object({
  schemaVersion: z.literal("0.4"),
  capabilityMode: z.literal(EXPERIMENTAL_BROWSER_CAPABILITY_MODE),
  id: identifier,
  needKey: identifier,
  targetAlias: identifier,
  outcomeVerifierKey: identifier,
  uiContractHash: sha256,
  steps: z.array(browserStepSchema).min(1).max(24),
}).strict().superRefine((manifest, context) => {
  if (manifest.steps[0]?.kind !== "navigate") {
    context.addIssue({ code: "custom", message: "A browser capability must begin with an exact navigation step." });
  }
  const writes = manifest.steps.filter((step) => step.kind === "click" && step.effect === "write");
  if (writes.length > 1) {
    context.addIssue({ code: "custom", message: "The experimental driver permits at most one consequential click." });
  }
  if (writes.length === 1) {
    const writeIndex = manifest.steps.indexOf(writes[0]!);
    const afterWrite = manifest.steps.slice(writeIndex + 1);
    const evidenceAfterWrite = afterWrite.some((step) =>
      step.kind === "assert-text" || step.kind === "assert-input-text" || step.kind === "read-text",
    );
    if (!evidenceAfterWrite) {
      context.addIssue({ code: "custom", message: "A browser write requires a bounded post-action observation step." });
    }
    if (afterWrite.some((step) => step.kind !== "assert-text" && step.kind !== "assert-input-text" && step.kind !== "read-text")) {
      context.addIssue({ code: "custom", message: "Only bounded observations may follow a consequential browser click." });
    }
  }
  const outputKeys = manifest.steps.filter((step) => step.kind === "read-text").map((step) => step.outputKey);
  if (new Set(outputKeys).size !== outputKeys.length) {
    context.addIssue({ code: "custom", message: "Browser output keys must be unique." });
  }
  const secretTargets = new Set(
    manifest.steps.filter((step) => step.kind === "fill-secret").map((step) => canonical(step.locator)),
  );
  const suppliedSecretAliases = new Set(
    manifest.steps.filter((step) => step.kind === "fill-secret").map((step) => step.secretAlias),
  );
  for (const step of manifest.steps) {
    if (step.kind === "read-text" && secretTargets.has(canonical(step.locator))) {
      context.addIssue({ code: "custom", message: "A secret input target cannot also be declared as a readable output." });
    }
    if (step.kind === "click" && step.effect === "session-auth") {
      for (const alias of step.sessionSecretAliases ?? []) {
        if (!suppliedSecretAliases.has(alias)) {
          context.addIssue({ code: "custom", message: `Session authentication requires a declared secret fill for ${alias}.` });
        }
      }
    }
  }
});

export type ExperimentalBrowserCapability = z.infer<typeof experimentalBrowserCapabilitySchema>;

export interface ExperimentalBrowserTarget {
  origin: string;
  allowedNavigationPaths: string[];
  allowedRequests: Array<{
    path: string;
    query?: string;
    method: "GET" | "POST";
    purpose: "read" | "session-auth" | "business-write";
    maxPerSession: number;
  }>;
  allowedLocators: ExperimentalBrowserLocator[];
  /** Resources deliberately aborted before execution; blocking them is safer than loading them. */
  blockedResourceTypes?: Array<"stylesheet" | "image" | "font" | "media" | "script">;
  timeoutMs?: number;
}

export type BrowserControlKind = "read" | "fill" | "click";

export interface ExperimentalBrowserSession {
  navigate(url: string): Promise<void>;
  inspect(locator: ExperimentalBrowserLocator, kind: BrowserControlKind): Promise<void>;
  readText(locator: ExperimentalBrowserLocator): Promise<string>;
  fill(locator: ExperimentalBrowserLocator, value: string): Promise<void>;
  click(locator: ExperimentalBrowserLocator, purpose: "read" | "session-auth" | "business-write"): Promise<void>;
  close(): Promise<void>;
}

export interface ExperimentalBrowserSessionFactory {
  open(target: ExperimentalBrowserTarget, mode: "verify" | "execute"): Promise<ExperimentalBrowserSession>;
}

export type ExperimentalBrowserOutcome = "complete" | "not-started" | "partial" | "incorrect" | "unknown";

export interface ExperimentalBrowserOutcomeVerifier {
  readonly key: string;
  verify(operationKey: string): Promise<{
    outcome: ExperimentalBrowserOutcome;
    detail: string;
    stateDigest?: string;
  }>;
}

export interface ExperimentalBrowserCapabilityVerification {
  driverVersion: typeof EXPERIMENTAL_BROWSER_DRIVER_VERSION;
  capabilityId: string;
  manifestDigest: string;
  uiContractHash: string;
  passed: boolean;
  checks: Array<{ id: string; passed: boolean; detail: string }>;
  verifiedAt: string;
}

export interface BrowserOperationalControl extends RuntimeOperationGuard {
  setCapabilityStatus?(capabilityId: string, status: "active" | "quarantined" | "revoked", reason: string): void;
  raiseIncident?(severity: "low" | "medium" | "high" | "critical", summary: Record<string, unknown>): string;
}

export interface ExperimentalBrowserExecutionOptions {
  operationKey: string;
  runId: string;
  input: Record<string, string>;
  approvals: string[];
  verification: ExperimentalBrowserCapabilityVerification;
  secretProvider?: LocalSecretProvider;
  operationalControl?: BrowserOperationalControl;
  testMode?: boolean;
}

export type ExperimentalBrowserRunResult =
  | {
      status: "completed";
      driverVersion: typeof EXPERIMENTAL_BROWSER_DRIVER_VERSION;
      capabilityId: string;
      operationKey: string;
      reconciledBeforeAction: true;
      writePerformed: boolean;
      outputs: Record<string, string>;
      verification: { outcome: "complete"; detail: string; stateDigest?: string };
    }
  | {
      status: "blocked" | "unknown";
      driverVersion: typeof EXPERIMENTAL_BROWSER_DRIVER_VERSION;
      capabilityId: string;
      operationKey: string;
      writesAttempted: 0 | 1;
      quarantined: boolean;
      reason: string;
      verification: { outcome: ExperimentalBrowserOutcome; detail: string; stateDigest?: string };
    };

function allowedPath(pathname: string, patterns: string[]): boolean {
  return patterns.some((pattern) => pathname === pattern);
}

export function browserRequestPathMatches(pathname: string, pattern: string): boolean {
  if (pathname === pattern) return true;
  if (!pattern.includes(":integer") && !pattern.includes(":asset")) return false;
  const escaped = pattern
    .split(/(:integer|:asset)/)
    .map((part) => part === ":integer"
      ? "[1-9][0-9]*"
      : part === ":asset"
        ? "[a-zA-Z0-9._~-]+"
        : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("");
  return new RegExp(`^${escaped}$`).test(pathname);
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function assertSessionText(
  session: ExperimentalBrowserSession,
  locator: ExperimentalBrowserLocator,
  expectedText: string,
): Promise<string> {
  const actual = await session.readText(locator);
  if (normalizedText(actual) !== normalizedText(expectedText)) {
    throw new Error(`Browser text did not match the verified contract for ${canonical(locator)}.`);
  }
  return actual;
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

export function experimentalBrowserManifestDigest(manifest: ExperimentalBrowserCapability): string {
  return createHash("sha256").update(canonical(experimentalBrowserCapabilitySchema.parse(manifest))).digest("hex");
}

function localhostTarget(target: ExperimentalBrowserTarget): URL {
  const origin = new URL(target.origin);
  if (
    origin.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1"].includes(origin.hostname) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/"
  ) {
    throw new Error("The experimental browser driver is restricted to plain-HTTP disposable localhost origins.");
  }
  if (target.allowedNavigationPaths.length === 0 || target.allowedRequests.length === 0) {
    throw new Error("Browser targets require explicit navigation and request allowlists.");
  }
  const requestPolicies = new Set<string>();
  for (const request of target.allowedRequests) {
    if (
      !request.path.startsWith("/") ||
      (request.path !== "/" && !/^\/(?:[a-zA-Z0-9._~-]+|:integer|:asset)(?:\/(?:[a-zA-Z0-9._~-]+|:integer|:asset))*$/.test(request.path)) ||
      (request.query !== undefined && (!request.query.startsWith("?") || request.query.length > 1_000 || request.method !== "GET")) ||
      !Number.isInteger(request.maxPerSession) ||
      request.maxPerSession < 1
    ) {
      throw new Error("Browser request policies require an exact path, method, purpose, and positive session limit.");
    }
    if (request.method === "GET" && request.purpose !== "read") {
      throw new Error("GET browser requests must be classified as read-only.");
    }
    if (request.method === "POST" && request.purpose === "read") {
      throw new Error("POST browser requests must be classified as session-auth or business-write.");
    }
    const key = `${request.method} ${request.path}${request.query ?? ""}`;
    if (requestPolicies.has(key)) throw new Error(`Duplicate browser request policy: ${key}`);
    requestPolicies.add(key);
  }
  for (const path of target.allowedNavigationPaths) {
    if (!requestPolicies.has(`GET ${path}`)) throw new Error(`Browser navigation lacks an exact GET request policy: ${path}`);
  }
  const locatorKeys = target.allowedLocators.map((locator) => canonical(experimentalBrowserLocatorSchema.parse(locator)));
  if (new Set(locatorKeys).size !== locatorKeys.length) {
    throw new Error("Browser target locators must be unique.");
  }
  return origin;
}

function operationContext(
  manifest: ExperimentalBrowserCapability,
  options: ExperimentalBrowserExecutionOptions,
  write: boolean,
): RuntimeActionControlContext {
  return {
    runId: options.runId,
    capabilityId: manifest.id,
    actionName: write ? "browser-write" : "browser-session",
    targetAlias: manifest.targetAlias,
    method: "BROWSER",
    write,
    testMode: options.testMode ?? false,
  };
}

/**
 * Experimental and deliberately separate from `constrained-http-api`.
 * It accepts only bounded declarative semantic actions; arbitrary selectors, scripts,
 * generated JavaScript, downloads, uploads, new origins, and multi-write flows
 * are not part of this driver.
 */
export class ExperimentalBrowserDriver {
  private readonly quarantined = new Set<string>();

  constructor(
    private readonly targets: Record<string, ExperimentalBrowserTarget>,
    private readonly sessions: ExperimentalBrowserSessionFactory,
  ) {}

  isQuarantined(capabilityId: string): boolean {
    return this.quarantined.has(capabilityId);
  }

  clearQuarantine(capabilityId: string): void {
    this.quarantined.delete(capabilityId);
  }

  async verifyCapability(
    rawManifest: ExperimentalBrowserCapability,
    options: {
      runId: string;
      operationalControl?: BrowserOperationalControl;
      input?: Record<string, string>;
      secretProvider?: LocalSecretProvider;
    } | undefined = undefined,
  ): Promise<ExperimentalBrowserCapabilityVerification> {
    const manifest = experimentalBrowserCapabilitySchema.parse(rawManifest);
    const target = this.target(manifest);
    this.assertTargetContract(manifest, target);
    const controlContext: RuntimeActionControlContext = {
      runId: options?.runId ?? `verify-${manifest.id}`,
      capabilityId: manifest.id,
      actionName: "browser-capability-verification",
      targetAlias: manifest.targetAlias,
      method: "BROWSER",
      write: false,
      testMode: true,
    };
    try {
      options?.operationalControl?.beforeAction(controlContext);
    } catch (error) {
      throw new ExperimentalBrowserOperationalBlockedError(
        error instanceof Error ? error.message : String(error),
      );
    }
    const checks: ExperimentalBrowserCapabilityVerification["checks"] = [];
    let session: ExperimentalBrowserSession;
    try {
      session = await this.sessions.open(target, "verify");
    } catch (error) {
      options?.operationalControl?.afterAction(controlContext, "failed", { category: "browser-verification-runtime" });
      throw error;
    }
    let writeBoundaryReached = false;
    const resolvedSecrets = new Map<string, string>();
    const sessionVerificationAliases = new Set<string>();
    for (const step of manifest.steps) {
      if (step.kind === "click" && step.effect === "session-auth") {
        for (const alias of step.sessionSecretAliases ?? []) sessionVerificationAliases.add(alias);
      }
    }
    try {
      for (const [index, step] of manifest.steps.entries()) {
        try {
          if (step.kind === "navigate") await session.navigate(new URL(step.path, target.origin).toString());
          else if (step.kind === "assert-text" && !writeBoundaryReached) await assertSessionText(session, step.locator, step.expectedText);
          else if (step.kind === "assert-text") await session.inspect(step.locator, "read");
          else if (step.kind === "assert-input-text") await session.inspect(step.locator, "read");
          else if (step.kind === "read-text") await session.inspect(step.locator, "read");
          else if (step.kind === "fill") {
            if (options?.input && step.inputKey in options.input) {
              await session.fill(step.locator, options.input[step.inputKey]!);
            } else {
              await session.inspect(step.locator, "fill");
            }
          }
          else if (step.kind === "fill-secret") {
            if (sessionVerificationAliases.has(step.secretAlias) && options?.secretProvider?.has(step.secretAlias)) {
              const resolved = await options.secretProvider.resolve({
                alias: step.secretAlias,
                targetAlias: manifest.targetAlias,
                actionName: "browser-capability-verification",
                method: "BROWSER",
                runId: options.runId,
                testMode: true,
              });
              resolvedSecrets.set(step.secretAlias, resolved.value);
              await session.fill(step.locator, resolved.value);
            } else {
              await session.inspect(step.locator, "fill");
            }
          }
          else {
            await session.inspect(step.locator, "click");
            if (step.effect === "write") {
              writeBoundaryReached = true;
            } else if (step.effect === "session-auth") {
              if ((step.sessionSecretAliases ?? []).some((alias) => !resolvedSecrets.has(alias))) {
                throw new Error("Session-auth verification requires every declared customer-local credential.");
              }
              await session.click(step.locator, "session-auth");
            } else {
              await session.click(step.locator, "read");
            }
          }
          checks.push({ id: `step-${index + 1}`, passed: true, detail: `${step.kind} is present and bounded.` });
        } catch (error) {
          checks.push({
            id: `step-${index + 1}`,
            passed: false,
            detail: error instanceof Error ? error.message : String(error),
          });
          break;
        }
      }
    } finally {
      resolvedSecrets.clear();
      await session.close().catch(() => undefined);
    }
    options?.operationalControl?.afterAction(
      controlContext,
      checks.length === manifest.steps.length && checks.every((check) => check.passed) ? "succeeded" : "failed",
      { category: "browser-capability-verification" },
    );
    return {
      driverVersion: EXPERIMENTAL_BROWSER_DRIVER_VERSION,
      capabilityId: manifest.id,
      manifestDigest: experimentalBrowserManifestDigest(manifest),
      uiContractHash: manifest.uiContractHash,
      passed: checks.length === manifest.steps.length && checks.every((check) => check.passed),
      checks,
      verifiedAt: new Date().toISOString(),
    };
  }

  async execute(
    rawManifest: ExperimentalBrowserCapability,
    options: ExperimentalBrowserExecutionOptions,
    verifier: ExperimentalBrowserOutcomeVerifier,
  ): Promise<ExperimentalBrowserRunResult> {
    const manifest = experimentalBrowserCapabilitySchema.parse(rawManifest);
    if (!options.operationKey) throw new Error("Browser execution requires a stable operation key.");
    if (this.quarantined.has(manifest.id)) throw new Error(`Experimental browser capability ${manifest.id} is quarantined.`);
    if (verifier.key !== manifest.outcomeVerifierKey) throw new Error("Independent browser outcome verifier does not match the manifest.");
    const target = this.target(manifest);
    this.assertTargetContract(manifest, target);
    this.assertVerification(manifest, options.verification);

    for (const step of manifest.steps) {
      if (step.kind === "fill" && !(step.inputKey in options.input)) {
        throw new Error(`Missing browser input: ${step.inputKey}`);
      }
      if (step.kind === "assert-input-text" && !(step.inputKey in options.input)) {
        throw new Error(`Missing browser confirmation input: ${step.inputKey}`);
      }
    }

    const before = await verifier.verify(options.operationKey);
    if (before.outcome === "complete") {
      return {
        status: "completed",
        driverVersion: EXPERIMENTAL_BROWSER_DRIVER_VERSION,
        capabilityId: manifest.id,
        operationKey: options.operationKey,
        reconciledBeforeAction: true,
        writePerformed: false,
        outputs: {},
        verification: before as { outcome: "complete"; detail: string; stateDigest?: string },
      };
    }
    if (before.outcome !== "not-started") {
      return this.quarantine(
        manifest,
        options,
        before,
        0,
        "Independent reconciliation did not prove a clean not-started state.",
      );
    }

    for (const step of manifest.steps) {
      if (step.kind === "fill-secret" && !options.secretProvider?.has(step.secretAlias)) {
        return this.blocked(manifest, options.operationKey, `Missing customer-local browser credential: ${step.secretAlias}`);
      }
      if (step.kind === "click" && step.effect === "write" && !options.approvals.includes(step.approvalKey!)) {
        return this.blocked(manifest, options.operationKey, `Missing exact browser write approval: ${step.approvalKey}`);
      }
    }

    const readContext = operationContext(manifest, options, false);
    const writeStep = manifest.steps.find((step) => step.kind === "click" && step.effect === "write");
    const writeContext = operationContext(manifest, options, true);
    let readAuthorized = false;
    let writeAuthorized = false;
    try {
      options.operationalControl?.beforeAction(readContext);
      readAuthorized = true;
      if (writeStep) {
        options.operationalControl?.beforeAction(writeContext);
        writeAuthorized = true;
      }
    } catch (error) {
      if (readAuthorized) {
        options.operationalControl?.afterAction(readContext, "failed", { category: "browser-write-authority-blocked" });
      }
      return this.blocked(
        manifest,
        options.operationKey,
        error instanceof Error ? error.message : String(error),
      );
    }

    const resolvedSecrets = new Map<string, string>();
    try {
      for (const step of manifest.steps) {
        if (step.kind !== "fill-secret") continue;
        const resolved = await options.secretProvider!.resolve({
          alias: step.secretAlias,
          targetAlias: manifest.targetAlias,
          actionName: "browser-write",
          method: "BROWSER",
          runId: options.runId,
          testMode: options.testMode ?? false,
        });
        resolvedSecrets.set(step.secretAlias, resolved.value);
      }
    } catch (error) {
      resolvedSecrets.clear();
      if (readAuthorized) {
        options.operationalControl?.afterAction(readContext, "failed", { category: "browser-credential-resolution" });
      }
      if (writeAuthorized) {
        options.operationalControl?.afterAction(writeContext, "failed", { category: "browser-credential-resolution" });
      }
      return this.blocked(
        manifest,
        options.operationKey,
        `Customer-local browser credential resolution failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let session: ExperimentalBrowserSession;
    try {
      session = await this.sessions.open(target, "execute");
    } catch (error) {
      resolvedSecrets.clear();
      if (readAuthorized) {
        options.operationalControl?.afterAction(readContext, "failed", { category: "browser-runtime-unavailable" });
      }
      if (writeAuthorized) {
        options.operationalControl?.afterAction(writeContext, "failed", { category: "browser-runtime-unavailable" });
      }
      return this.blocked(
        manifest,
        options.operationKey,
        `The customer-local browser runtime was unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const outputs: Record<string, string> = {};
    let writesAttempted: 0 | 1 = 0;
    try {
      for (const step of manifest.steps) {
        if (step.kind === "navigate") await session.navigate(new URL(step.path, target.origin).toString());
        else if (step.kind === "assert-text") {
          const value = await session.readText(step.locator);
          if ([...resolvedSecrets.values()].some((secret) => secret.length > 0 && value.includes(secret))) {
            throw new ExperimentalBrowserPolicyViolationError("Browser output attempted to expose a customer-local credential.");
          }
          if (normalizedText(value) !== normalizedText(step.expectedText)) {
            throw new Error(`Browser text did not match the verified contract for ${canonical(step.locator)}.`);
          }
        }
        else if (step.kind === "assert-input-text") {
          const value = await session.readText(step.locator);
          if ([...resolvedSecrets.values()].some((secret) => secret.length > 0 && value.includes(secret))) {
            throw new ExperimentalBrowserPolicyViolationError("Browser output attempted to expose a customer-local credential.");
          }
          if (!normalizedText(value).includes(normalizedText(options.input[step.inputKey]!))) {
            throw new Error(`Browser text did not contain the trusted confirmation input for ${canonical(step.locator)}.`);
          }
        }
        else if (step.kind === "read-text") {
          const value = await session.readText(step.locator);
          if ([...resolvedSecrets.values()].some((secret) => secret.length > 0 && value.includes(secret))) {
            throw new ExperimentalBrowserPolicyViolationError("Browser output attempted to expose a customer-local credential.");
          }
          outputs[step.outputKey] = value;
        }
        else if (step.kind === "fill") await session.fill(step.locator, options.input[step.inputKey]!);
        else if (step.kind === "fill-secret") await session.fill(step.locator, resolvedSecrets.get(step.secretAlias)!);
        else {
          if (step.effect === "write") writesAttempted = 1;
          await session.click(
            step.locator,
            step.effect === "write" ? "business-write" : step.effect,
          );
        }
      }
    } catch (error) {
      const afterFailure = writesAttempted === 1 ? await verifier.verify(options.operationKey) : before;
      const policyViolation = error instanceof ExperimentalBrowserPolicyViolationError;
      if (afterFailure.outcome === "complete" && !policyViolation) {
        if (readAuthorized) {
          options.operationalControl?.afterAction(readContext, "succeeded", { category: "reconciled-after-browser-error" });
        }
        if (writeAuthorized) {
          options.operationalControl?.afterAction(writeContext, "succeeded", { category: "reconciled-after-browser-error" });
        }
        return {
          status: "completed",
          driverVersion: EXPERIMENTAL_BROWSER_DRIVER_VERSION,
          capabilityId: manifest.id,
          operationKey: options.operationKey,
          reconciledBeforeAction: true,
          writePerformed: true,
          outputs,
          verification: afterFailure as { outcome: "complete"; detail: string; stateDigest?: string },
        };
      }
      const controlOutcome = afterFailure.outcome === "unknown" ? "unknown" : "failed";
      const category = policyViolation ? "browser-policy-violation" : `browser-${afterFailure.outcome}`;
      if (readAuthorized) {
        options.operationalControl?.afterAction(readContext, controlOutcome, { category });
      }
      if (writeAuthorized) {
        options.operationalControl?.afterAction(writeContext, controlOutcome, {
          category: writesAttempted === 0 ? `${category}-before-write` : category,
        });
      }
      return this.quarantine(
        manifest,
        options,
        afterFailure,
        writesAttempted,
        `${policyViolation ? "Browser policy violation" : "Browser action failed"}; blind retry is blocked: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      resolvedSecrets.clear();
      await session.close().catch(() => undefined);
    }

    const after = await verifier.verify(options.operationKey);
    if (after.outcome !== "complete") {
      const controlOutcome = after.outcome === "unknown" ? "unknown" : "failed";
      if (readAuthorized) {
        options.operationalControl?.afterAction(readContext, controlOutcome, { category: `browser-${after.outcome}` });
      }
      if (writeAuthorized) {
        options.operationalControl?.afterAction(writeContext, controlOutcome, { category: `browser-${after.outcome}` });
      }
      return this.quarantine(
        manifest,
        options,
        after,
        writesAttempted,
        "The independent external outcome check did not confirm completion.",
      );
    }
    if (readAuthorized) {
      options.operationalControl?.afterAction(readContext, "succeeded", { category: "browser-complete" });
    }
    if (writeAuthorized) {
      options.operationalControl?.afterAction(writeContext, "succeeded", { category: "browser-complete" });
    }
    return {
      status: "completed",
      driverVersion: EXPERIMENTAL_BROWSER_DRIVER_VERSION,
      capabilityId: manifest.id,
      operationKey: options.operationKey,
      reconciledBeforeAction: true,
      writePerformed: writesAttempted === 1,
      outputs,
      verification: after as { outcome: "complete"; detail: string; stateDigest?: string },
    };
  }

  private target(manifest: ExperimentalBrowserCapability): ExperimentalBrowserTarget {
    const target = this.targets[manifest.targetAlias];
    if (!target) throw new Error(`Unknown experimental browser target alias: ${manifest.targetAlias}`);
    localhostTarget(target);
    return target;
  }

  private assertTargetContract(
    manifest: ExperimentalBrowserCapability,
    target: ExperimentalBrowserTarget,
  ): void {
    const allowedLocators = new Set(target.allowedLocators.map((locator) => canonical(locator)));
    for (const step of manifest.steps) {
      if ("locator" in step && !allowedLocators.has(canonical(step.locator))) {
        throw new Error(`Browser locator is not allowlisted: ${canonical(step.locator)}`);
      }
      if (step.kind === "navigate" && !allowedPath(step.path, target.allowedNavigationPaths)) {
        throw new Error(`Browser path is not allowlisted: ${step.path}`);
      }
    }
  }

  private assertVerification(
    manifest: ExperimentalBrowserCapability,
    verification: ExperimentalBrowserCapabilityVerification,
  ): void {
    if (
      !verification.passed ||
      verification.driverVersion !== EXPERIMENTAL_BROWSER_DRIVER_VERSION ||
      verification.capabilityId !== manifest.id ||
      verification.manifestDigest !== experimentalBrowserManifestDigest(manifest) ||
      verification.uiContractHash !== manifest.uiContractHash
    ) {
      throw new Error("Browser capability does not have a matching passing pre-use verification receipt.");
    }
  }

  private blocked(
    manifest: ExperimentalBrowserCapability,
    operationKey: string,
    reason: string,
  ): Extract<ExperimentalBrowserRunResult, { writesAttempted: 0 | 1 }> {
    return {
      status: "blocked",
      driverVersion: EXPERIMENTAL_BROWSER_DRIVER_VERSION,
      capabilityId: manifest.id,
      operationKey,
      writesAttempted: 0,
      quarantined: false,
      reason,
      verification: { outcome: "not-started", detail: "The blocker was detected before opening a browser session." },
    };
  }

  private quarantine(
    manifest: ExperimentalBrowserCapability,
    options: ExperimentalBrowserExecutionOptions,
    verification: { outcome: ExperimentalBrowserOutcome; detail: string; stateDigest?: string },
    writesAttempted: 0 | 1,
    reason: string,
  ): Extract<ExperimentalBrowserRunResult, { writesAttempted: 0 | 1 }> {
    this.quarantined.add(manifest.id);
    options.operationalControl?.setCapabilityStatus?.(manifest.id, "quarantined", reason);
    options.operationalControl?.raiseIncident?.("high", {
      summary: reason,
      capabilityId: manifest.id,
      operationKey: options.operationKey,
      outcome: verification.outcome,
      writesAttempted,
    });
    return {
      status: verification.outcome === "unknown" ? "unknown" : "blocked",
      driverVersion: EXPERIMENTAL_BROWSER_DRIVER_VERSION,
      capabilityId: manifest.id,
      operationKey: options.operationKey,
      writesAttempted,
      quarantined: true,
      reason,
      verification,
    };
  }
}
