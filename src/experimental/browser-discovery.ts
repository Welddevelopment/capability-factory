import { createHash } from "node:crypto";
import { z } from "zod";
import {
  experimentalBrowserCapabilitySchema,
  experimentalBrowserLocatorSchema,
  type ExperimentalBrowserCapability,
  type ExperimentalBrowserLocator,
  type ExperimentalBrowserTarget,
} from "./browser-driver.js";
import type { BrowserCapabilityBuilder } from "./browser-ui-contract.js";

const identifier = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_.-]+$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const browserDiscoveryBoundarySchema = z.object({
  schemaVersion: z.literal("1.0"),
  boundaryId: identifier,
  capabilityIdPrefix: z.string().min(3).max(120).regex(/^[a-zA-Z0-9_.-]+$/),
  needKey: identifier,
  targetAlias: identifier,
  outcomeVerifierKey: identifier,
  seedPaths: z.array(z.string().startsWith("/").max(500)).min(1).max(12),
  allowedPaths: z.array(z.string().startsWith("/").max(500)).min(1).max(24),
  inputs: z.array(z.object({
    key: identifier,
    description: z.string().min(1).max(500),
  }).strict()).max(24),
  secretAliases: z.array(identifier).max(8),
  writeApprovalKey: identifier,
  maxBusinessWrites: z.literal(1),
  completion: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("exact-text"),
      description: z.string().min(1).max(500),
      expectedText: z.string().min(1).max(1_000),
    }).strict(),
    z.object({
      kind: z.literal("input-contains"),
      description: z.string().min(1).max(500),
      inputKey: identifier,
    }).strict(),
  ]),
  authentication: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("none"),
      humanGatePolicy: z.literal("stop-and-handoff"),
    }).strict(),
    z.object({
      kind: z.literal("trusted-session-form"),
      path: z.string().startsWith("/").max(500),
      assertions: z.array(z.object({
        locator: experimentalBrowserLocatorSchema,
        expectedText: z.string().min(1).max(1_000),
      }).strict()).min(1).max(8),
      fields: z.array(z.object({
        locator: experimentalBrowserLocatorSchema,
        secretAlias: identifier,
      }).strict()).min(1).max(8),
      submit: experimentalBrowserLocatorSchema,
      secretAliases: z.array(identifier).min(1).max(8),
      humanGatePolicy: z.literal("stop-and-handoff"),
    }).strict(),
  ]),
}).strict().superRefine((boundary, context) => {
  if (new Set(boundary.seedPaths).size !== boundary.seedPaths.length) {
    context.addIssue({ code: "custom", message: "Browser discovery seed paths must be unique." });
  }
  if (new Set(boundary.allowedPaths).size !== boundary.allowedPaths.length) {
    context.addIssue({ code: "custom", message: "Browser discovery allowed paths must be unique." });
  }
  if (boundary.seedPaths.some((path) => !boundary.allowedPaths.includes(path))) {
    context.addIssue({ code: "custom", message: "Every browser discovery seed path must be allowed." });
  }
  if (new Set(boundary.inputs.map((input) => input.key)).size !== boundary.inputs.length) {
    context.addIssue({ code: "custom", message: "Browser discovery input keys must be unique." });
  }
  if (new Set(boundary.secretAliases).size !== boundary.secretAliases.length) {
    context.addIssue({ code: "custom", message: "Browser discovery secret aliases must be unique." });
  }
  if (boundary.completion.kind === "input-contains") {
    const completion = boundary.completion;
    if (!boundary.inputs.some((input) => input.key === completion.inputKey)) {
      context.addIssue({ code: "custom", message: "Browser discovery completion must reference an approved input key." });
    }
  }
  if (boundary.authentication.kind === "trusted-session-form") {
    const authentication = boundary.authentication;
    if (!boundary.allowedPaths.includes(authentication.path)) {
      context.addIssue({ code: "custom", message: "Trusted browser discovery authentication path must be allowed." });
    }
    if (authentication.secretAliases.some((alias) => !boundary.secretAliases.includes(alias))) {
      context.addIssue({ code: "custom", message: "Trusted authentication aliases must be inside the boundary secret aliases." });
    }
    if (authentication.fields.some((field) => !authentication.secretAliases.includes(field.secretAlias))) {
      context.addIssue({ code: "custom", message: "Trusted authentication fields must use declared authentication aliases." });
    }
  }
});

export type BrowserDiscoveryBoundary = z.infer<typeof browserDiscoveryBoundarySchema>;

export const discoveredBrowserControlSchema = z.object({
  controlId: sha256,
  pagePath: z.string().startsWith("/").max(500),
  locator: experimentalBrowserLocatorSchema,
  element: z.enum(["input", "textarea", "select", "button", "link", "heading", "status", "other"]),
  accessibleName: z.string().max(300),
  inputType: z.string().max(80).nullable(),
  hrefPath: z.string().startsWith("/").max(500).nullable(),
  canRead: z.boolean(),
  canFill: z.boolean(),
  canClick: z.boolean(),
  humanGateSignal: z.enum(["none", "mfa", "captcha", "security-key", "sso", "unknown-auth"]),
}).strict();

export type DiscoveredBrowserControl = z.infer<typeof discoveredBrowserControlSchema>;

export const browserDiscoveryPageSchema = z.object({
  requestedPath: z.string().startsWith("/").max(500),
  finalPath: z.string().startsWith("/").max(500),
  title: z.string().max(300),
  headings: z.array(z.string().max(300)).max(20),
  controls: z.array(discoveredBrowserControlSchema).max(120),
}).strict();

export type BrowserDiscoveryPage = z.infer<typeof browserDiscoveryPageSchema>;

export const browserDiscoverySnapshotSchema = z.object({
  schemaVersion: z.literal("1.0"),
  boundaryId: identifier,
  boundaryHash: sha256,
  targetAlias: identifier,
  pages: z.array(browserDiscoveryPageSchema).min(1).max(24),
  humanGates: z.array(z.object({
    pagePath: z.string().startsWith("/").max(500),
    signal: z.enum(["mfa", "captcha", "security-key", "sso", "unknown-auth"]),
    detail: z.string().min(1).max(500),
  }).strict()).max(24),
  snapshotHash: sha256,
  discoveredAt: z.string().datetime(),
}).strict();

export type BrowserDiscoverySnapshot = z.infer<typeof browserDiscoverySnapshotSchema>;

export interface BrowserUiDiscoverer {
  discover(target: ExperimentalBrowserTarget, boundary: BrowserDiscoveryBoundary): Promise<BrowserDiscoverySnapshot>;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "discoveredAt" && key !== "snapshotHash")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function browserDiscoveryBoundaryHash(raw: BrowserDiscoveryBoundary): string {
  const boundary = browserDiscoveryBoundarySchema.parse(raw);
  return createHash("sha256").update(canonical(boundary)).digest("hex");
}

export function browserDiscoverySnapshotHash(
  snapshot: Omit<BrowserDiscoverySnapshot, "snapshotHash" | "discoveredAt">,
): string {
  return createHash("sha256").update(canonical(snapshot)).digest("hex");
}

export function defineBrowserDiscoverySnapshot(
  snapshot: Omit<BrowserDiscoverySnapshot, "snapshotHash" | "discoveredAt">,
): BrowserDiscoverySnapshot {
  return browserDiscoverySnapshotSchema.parse({
    ...snapshot,
    snapshotHash: browserDiscoverySnapshotHash(snapshot),
    discoveredAt: new Date().toISOString(),
  });
}

export function discoveredControlId(
  pagePath: string,
  locator: ExperimentalBrowserLocator,
): string {
  return createHash("sha256").update(`${pagePath}\u001f${canonical(locator)}`).digest("hex");
}

const discoveryPlanStepSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), path: z.string().startsWith("/").max(500) }).strict(),
  z.object({ kind: z.literal("assert-text"), controlId: sha256, expectedText: z.string().min(1).max(1_000) }).strict(),
  z.object({ kind: z.literal("assert-input-text"), controlId: sha256, inputKey: identifier }).strict(),
  z.object({ kind: z.literal("read-text"), controlId: sha256, outputKey: identifier }).strict(),
  z.object({ kind: z.literal("fill"), controlId: sha256, inputKey: identifier }).strict(),
  z.object({ kind: z.literal("fill-secret"), controlId: sha256, secretAlias: identifier }).strict(),
  z.object({
    kind: z.literal("click"),
    controlId: sha256,
    effect: z.enum(["read", "session-auth", "write"]),
    approvalKey: identifier.nullable(),
    sessionSecretAliases: z.array(identifier).max(8),
  }).strict(),
]);

export const browserDiscoveryPlanSchema = z.object({
  schemaVersion: z.literal("1.0"),
  needKey: identifier,
  snapshotHash: sha256,
  steps: z.array(discoveryPlanStepSchema).min(1).max(24),
}).strict();

export type BrowserDiscoveryPlan = z.infer<typeof browserDiscoveryPlanSchema>;

export interface BrowserDiscoveryPlannerInput {
  boundary: BrowserDiscoveryBoundary;
  snapshot: BrowserDiscoverySnapshot;
  previousError?: string;
  previousPlan?: BrowserDiscoveryPlan;
}

export interface BrowserDiscoveryPlanner {
  readonly plannerId: string;
  propose(input: BrowserDiscoveryPlannerInput): Promise<BrowserDiscoveryPlan>;
}

function controlMap(snapshot: BrowserDiscoverySnapshot): Map<string, DiscoveredBrowserControl> {
  return new Map(snapshot.pages.flatMap((page) => page.controls).map((control) => [control.controlId, control]));
}

function assertDiscoveryMatchesBoundary(
  target: ExperimentalBrowserTarget,
  boundary: BrowserDiscoveryBoundary,
  snapshot: BrowserDiscoverySnapshot,
): void {
  const parsedBoundary = browserDiscoveryBoundarySchema.parse(boundary);
  const parsedSnapshot = browserDiscoverySnapshotSchema.parse(snapshot);
  if (parsedBoundary.targetAlias !== parsedSnapshot.targetAlias || parsedBoundary.boundaryId !== parsedSnapshot.boundaryId) {
    throw new Error("Browser discovery snapshot identity does not match the trusted boundary.");
  }
  if (browserDiscoveryBoundaryHash(parsedBoundary) !== parsedSnapshot.boundaryHash) {
    throw new Error("Browser discovery snapshot was created under a different trusted boundary.");
  }
  const { snapshotHash: _hash, discoveredAt: _time, ...withoutGenerated } = parsedSnapshot;
  if (browserDiscoverySnapshotHash(withoutGenerated) !== parsedSnapshot.snapshotHash) {
    throw new Error("Browser discovery snapshot hash does not match its controls.");
  }
  if (parsedSnapshot.pages.some((page) => !parsedBoundary.allowedPaths.includes(page.requestedPath) || !parsedBoundary.allowedPaths.includes(page.finalPath))) {
    throw new Error("Browser discovery snapshot escaped the approved navigation paths.");
  }
  if (target.origin.length === 0 || parsedBoundary.allowedPaths.some((path) => !target.allowedNavigationPaths.includes(path))) {
    throw new Error("Browser discovery boundary is wider than the installed target policy.");
  }
}

export function compileBrowserDiscoveryPlan(options: {
  target: ExperimentalBrowserTarget;
  boundary: BrowserDiscoveryBoundary;
  snapshot: BrowserDiscoverySnapshot;
  plan: BrowserDiscoveryPlan;
}): ExperimentalBrowserCapability {
  const boundary = browserDiscoveryBoundarySchema.parse(options.boundary);
  const snapshot = browserDiscoverySnapshotSchema.parse(options.snapshot);
  const plan = browserDiscoveryPlanSchema.parse(options.plan);
  assertDiscoveryMatchesBoundary(options.target, boundary, snapshot);
  if (snapshot.humanGates.length > 0) {
    throw new Error(`Browser discovery stopped at a human-required authentication gate: ${snapshot.humanGates.map((gate) => gate.signal).join(", ")}`);
  }
  if (plan.needKey !== boundary.needKey || plan.snapshotHash !== snapshot.snapshotHash) {
    throw new Error("Browser discovery plan identity does not match the diagnosed need and current snapshot.");
  }
  const controls = controlMap(snapshot);
  const inputKeys = new Set(boundary.inputs.map((input) => input.key));
  const secretAliases = new Set(boundary.secretAliases);
  let currentPath: string | undefined;
  const manifestSteps: ExperimentalBrowserCapability["steps"] = plan.steps.map((step) => {
    if (step.kind === "navigate") {
      if (!boundary.allowedPaths.includes(step.path)) throw new Error(`Discovery plan invented an unapproved path: ${step.path}`);
      currentPath = step.path;
      return step;
    }
    const control = controls.get(step.controlId);
    if (!control) throw new Error(`Discovery plan invented an unobserved control: ${step.controlId}`);
    if (control.pagePath !== currentPath) {
      throw new Error(`Discovery plan used a control from ${control.pagePath} while the active page was ${currentPath ?? "unset"}.`);
    }
    if (step.kind === "assert-text") {
      if (!control.canRead) throw new Error("Discovery plan attempted to read an unreadable control.");
      return { kind: step.kind, locator: control.locator, expectedText: step.expectedText };
    }
    if (step.kind === "assert-input-text") {
      if (!control.canRead || !inputKeys.has(step.inputKey)) throw new Error("Discovery confirmation used an unapproved input or unreadable control.");
      return { kind: step.kind, locator: control.locator, inputKey: step.inputKey };
    }
    if (step.kind === "read-text") {
      if (!control.canRead) throw new Error("Discovery plan attempted to read an unreadable control.");
      return { kind: step.kind, locator: control.locator, outputKey: step.outputKey };
    }
    if (step.kind === "fill") {
      if (!control.canFill || !inputKeys.has(step.inputKey)) throw new Error("Discovery plan attempted an unapproved ordinary field mapping.");
      return { kind: step.kind, locator: control.locator, inputKey: step.inputKey };
    }
    if (step.kind === "fill-secret") {
      if (!control.canFill || !secretAliases.has(step.secretAlias)) throw new Error("Discovery plan attempted an unapproved customer-local credential mapping.");
      return { kind: step.kind, locator: control.locator, secretAlias: step.secretAlias };
    }
    if (!control.canClick) throw new Error("Discovery plan attempted to click a non-clickable control.");
    if (step.effect === "write") {
      if (step.approvalKey !== boundary.writeApprovalKey || step.sessionSecretAliases.length > 0) {
        throw new Error("Discovery plan changed the trusted write authority.");
      }
      return { kind: step.kind, locator: control.locator, effect: step.effect, approvalKey: step.approvalKey };
    }
    if (step.effect === "session-auth") {
      if (step.approvalKey !== null || step.sessionSecretAliases.length === 0 || step.sessionSecretAliases.some((alias) => !secretAliases.has(alias))) {
        throw new Error("Discovery plan changed the trusted session-auth credential boundary.");
      }
      return { kind: step.kind, locator: control.locator, effect: step.effect, sessionSecretAliases: step.sessionSecretAliases };
    }
    if (step.approvalKey !== null || step.sessionSecretAliases.length > 0) {
      throw new Error("Read-only discovery clicks cannot carry authority or credentials.");
    }
    return { kind: step.kind, locator: control.locator, effect: step.effect };
  });
  const writes = manifestSteps.filter((step) => step.kind === "click" && step.effect === "write");
  if (writes.length !== boundary.maxBusinessWrites) {
    throw new Error("Discovery plan must contain exactly one trusted consequential browser write.");
  }
  const authenticationSteps: ExperimentalBrowserCapability["steps"] = boundary.authentication.kind === "trusted-session-form"
    ? [
        { kind: "navigate", path: boundary.authentication.path },
        ...boundary.authentication.assertions.map((assertion) => ({
          kind: "assert-text" as const,
          locator: assertion.locator,
          expectedText: assertion.expectedText,
        })),
        ...boundary.authentication.fields.map((field) => ({
          kind: "fill-secret" as const,
          locator: field.locator,
          secretAlias: field.secretAlias,
        })),
        {
          kind: "click" as const,
          locator: boundary.authentication.submit,
          effect: "session-auth" as const,
          sessionSecretAliases: boundary.authentication.secretAliases,
        },
      ]
    : [];
  return experimentalBrowserCapabilitySchema.parse({
    schemaVersion: "0.4",
    capabilityMode: "experimental-browser-actions",
    id: `${boundary.capabilityIdPrefix}-${snapshot.snapshotHash.slice(0, 12)}`,
    needKey: boundary.needKey,
    targetAlias: boundary.targetAlias,
    outcomeVerifierKey: boundary.outcomeVerifierKey,
    uiContractHash: snapshot.snapshotHash,
    steps: [...authenticationSteps, ...manifestSteps],
  });
}

export class DiscoveredBrowserCapabilityBuilder implements BrowserCapabilityBuilder {
  readonly builderId: string;

  constructor(
    private readonly target: ExperimentalBrowserTarget,
    private readonly boundary: BrowserDiscoveryBoundary,
    private readonly snapshot: BrowserDiscoverySnapshot,
    private readonly planner: BrowserDiscoveryPlanner,
    private readonly maxAttempts = 2,
  ) {
    this.builderId = `discovery-${planner.plannerId}`.replaceAll(/[^a-zA-Z0-9_.-]/g, "-");
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
      throw new Error("Browser discovery planning attempts must be between one and three.");
    }
  }

  async build(needKey: string, uiContractHash: string): Promise<ExperimentalBrowserCapability | null> {
    if (needKey !== this.boundary.needKey || uiContractHash !== this.snapshot.snapshotHash) return null;
    let previousError: string | undefined;
    let previousPlan: BrowserDiscoveryPlan | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const plan = await this.planner.propose({
          boundary: this.boundary,
          snapshot: this.snapshot,
          ...(previousError && previousPlan ? { previousError, previousPlan } : {}),
        });
        previousPlan = plan;
        return compileBrowserDiscoveryPlan({
          target: this.target,
          boundary: this.boundary,
          snapshot: this.snapshot,
          plan,
        });
      } catch (error) {
        previousError = error instanceof Error ? error.message : String(error);
      }
    }
    throw new Error(`Browser discovery construction failed after ${this.maxAttempts} bounded attempts: ${previousError ?? "unknown error"}`);
  }
}
