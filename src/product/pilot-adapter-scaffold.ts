import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  PILOT_ADAPTER_SCHEMA_VERSION,
  REQUIRED_PILOT_ADAPTER_CASES,
  validatePilotAdapterDescriptor,
  type PilotAdapterDescriptor,
  type PilotAdapterOperationDescriptor,
} from "./pilot-adapter.js";
import { CURRENT_CAPABILITY_MODE } from "./pilot-readiness.js";

export const PILOT_ADAPTER_INTAKE_SCHEMA_VERSION = "1.0" as const;

const identifier = z.string().min(3).max(160).regex(/^[a-z][a-z0-9_-]+$/);
const aliasIdentifier = z.string().min(3).max(160).regex(/^[a-zA-Z][a-zA-Z0-9_-]+$/);
const obviousSecret = /(bearer\s+[a-z0-9._~-]{8,}|token\s+[a-z0-9_-]{4,}:[a-z0-9_-]{4,}|sk-[a-z0-9_-]{12,}|password\s*[:=]\s*[^\s]{6,})/i;

const operationSchema: z.ZodType<PilotAdapterOperationDescriptor> = z.object({
  name: aliasIdentifier,
  targetAlias: aliasIdentifier,
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  consequence: z.enum(["read", "write"]),
  retrySafety: z.enum(["not-applicable", "reconcile-before-retry"]),
  outcomeVerifierKey: aliasIdentifier,
}).strict();

export const pilotAdapterIntakeSchema = z.object({
  schemaVersion: z.literal(PILOT_ADAPTER_INTAKE_SCHEMA_VERSION),
  adapterId: identifier,
  adapterVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  environmentId: identifier,
  scopeKeys: z.array(identifier).min(1).max(32),
  workflowKeys: z.array(identifier).min(1).max(32),
  targetAliases: z.array(aliasIdentifier).min(1).max(16),
  credentialAliases: z.array(aliasIdentifier).min(1).max(32),
  documentation: z.array(z.object({
    targetAlias: aliasIdentifier,
    sourcePath: z.string().min(1).max(500),
    mediaType: z.enum(["application/json", "application/yaml", "text/markdown", "text/html", "text/plain"]),
  }).strict()).min(1).max(32),
  operations: z.array(operationSchema).min(1).max(64),
}).strict().superRefine((intake, context) => {
  const unique = (values: readonly string[]) => new Set(values).size === values.length;
  if (!unique(intake.scopeKeys)) context.addIssue({ code: "custom", message: "Scope keys must be unique." });
  if (!unique(intake.workflowKeys)) context.addIssue({ code: "custom", message: "Workflow keys must be unique." });
  if (!unique(intake.targetAliases)) context.addIssue({ code: "custom", message: "Target aliases must be unique." });
  if (!unique(intake.credentialAliases)) context.addIssue({ code: "custom", message: "Credential aliases must be unique." });
  if (!unique(intake.operations.map((operation) => operation.name))) {
    context.addIssue({ code: "custom", message: "Operation names must be unique." });
  }
  if (intake.documentation.some((document) => !intake.targetAliases.includes(document.targetAlias))) {
    context.addIssue({ code: "custom", message: "Every documentation source must belong to a declared target alias." });
  }
  if (intake.operations.some((operation) => !intake.targetAliases.includes(operation.targetAlias))) {
    context.addIssue({ code: "custom", message: "Every operation must belong to a declared target alias." });
  }
  for (const operation of intake.operations.filter((candidate) => candidate.consequence === "write")) {
    if (operation.retrySafety !== "reconcile-before-retry") {
      context.addIssue({ code: "custom", message: `Write ${operation.name} must reconcile external state before retry.` });
    }
    if (!intake.operations.some((candidate) => candidate.targetAlias === operation.targetAlias && candidate.consequence === "read")) {
      context.addIssue({ code: "custom", message: `Write ${operation.name} requires at least one declared read on ${operation.targetAlias} for pre-action inspection and reconciliation.` });
    }
  }
  if (obviousSecret.test(JSON.stringify(intake))) {
    context.addIssue({ code: "custom", message: "Adapter intake must contain credential aliases, never credential values." });
  }
});

export type PilotAdapterIntake = z.infer<typeof pilotAdapterIntakeSchema>;

export interface TrustedDocumentationLock {
  schemaVersion: "1.0";
  documents: Array<{
    targetAlias: string;
    sourcePath: string;
    copiedPath: string;
    mediaType: PilotAdapterIntake["documentation"][number]["mediaType"];
    bytes: number;
    sha256: string;
  }>;
  aggregateSha256: string;
  createdAt: string;
}

export interface PilotAdapterScaffoldResult {
  adapterId: string;
  outputDirectory: string;
  descriptor: PilotAdapterDescriptor;
  documentationLock: TrustedDocumentationLock;
  files: string[];
  checks: Array<{ id: string; passed: boolean; detail: string }>;
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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeFileAtomic(filename: string, contents: string): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, contents, { mode: 0o600 });
  fs.renameSync(temporary, filename);
  fs.chmodSync(filename, 0o600);
}

function writeJson(filename: string, value: unknown): void {
  writeFileAtomic(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function safeDocumentationFile(documentationRoot: string, sourcePath: string): string {
  if (path.isAbsolute(sourcePath) || sourcePath.split(/[\\/]/).includes("..")) {
    throw new Error(`Documentation path must be relative and cannot traverse directories: ${sourcePath}`);
  }
  const root = path.resolve(documentationRoot);
  const filename = path.resolve(root, sourcePath);
  if (filename === root || !filename.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Documentation path escaped its trusted root: ${sourcePath}`);
  }
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Documentation source must be a regular non-symlink file: ${sourcePath}`);
  if (stat.size === 0 || stat.size > 10_000_000) throw new Error(`Documentation source must contain 1 to 10,000,000 bytes: ${sourcePath}`);
  return filename;
}

function sourceFilename(index: number, sourcePath: string): string {
  const basename = path.basename(sourcePath).replaceAll(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120) || "documentation";
  return `${String(index + 1).padStart(2, "0")}-${basename}`;
}

function intakeChecklist(intake: PilotAdapterIntake, lock: TrustedDocumentationLock): string {
  const writeNames = intake.operations.filter((operation) => operation.consequence === "write").map((operation) => operation.name);
  return `# Customer input checklist — ${intake.adapterId}

Status: **incomplete until every item is confirmed with the customer**

## Workflow and ownership

- [ ] Name the business workflow, its owner, and the person authorized to approve the pilot.
- [ ] Supply one ordinary goal and the exact records/entities that are in scope.
- [ ] Define externally observable completion for every required item and for the parent goal.
- [ ] Identify the human owner for credential, permission, policy, and unknown-outcome handoffs.

## Systems and documentation

- [ ] Confirm the approved sandbox or disposable target URL for: ${intake.targetAliases.join(", ")}.
- [ ] Confirm the documentation lock below matches the intended target version.
${lock.documents.map((document) => `  - ${document.targetAlias}: ${document.sha256} (${document.sourcePath})`).join("\n")}
- [ ] List known rate limits, idempotency behavior, pagination, redirects, timeouts, and error formats.
- [ ] Confirm whether documentation or API behavior can change during the pilot.

## Credentials and authority

- [ ] Provide customer-local values for these aliases without copying values into the adapter: ${intake.credentialAliases.join(", ")}.
- [ ] Confirm least-privilege access for every read and write.
- [ ] Confirm the exact approved write actions: ${writeNames.length > 0 ? writeNames.join(", ") : "none (read-only pilot)"}.
- [ ] Confirm who can revoke or rotate credentials and how Capability Factory is notified.

## Verification and recovery

- [ ] Supply an independent source of truth for each verifier key: ${[...new Set(intake.operations.map((operation) => operation.outcomeVerifierKey))].join(", ")}.
- [ ] Define complete, not-started, partial, incorrect, and unknown external states.
- [ ] Confirm how a disposable write is reset during capability verification.
- [ ] Confirm reconciliation happens before every write retry.
- [ ] Confirm cleanup and escalation procedures if a test detects an incorrect side effect.

## Installation and agent connection

- [ ] Record operating system/container constraints and whether a repository checkout is acceptable.
- [ ] Record the customer's agent language/framework and desired completion/handoff callback.
- [ ] Agree where customer-local state, logs, backups, credentials, and evidence exports are stored.
- [ ] Agree runtime limits, stop controls, maintenance window, retention, and uninstall procedure.

## Acceptance gate

- [ ] Run and preserve all ten generated acceptance cases.
- [ ] Review every artifact and verify that no incorrect side effect survives cleanup.
- [ ] Obtain explicit customer approval before activating the controlled pilot.
`;
}

function adapterModule(intake: PilotAdapterIntake, productImport: string): string {
  return `import descriptorJson from "./adapter.descriptor.json" with { type: "json" };
import {
  REQUIRED_PILOT_ADAPTER_CASES,
  type ControlledPilotAdapter,
  type PilotAdapterDescriptor,
} from ${JSON.stringify(productImport)};

const descriptor = descriptorJson as PilotAdapterDescriptor;

/**
 * Fail-closed generated scaffold. Replace the unavailable resolvers and failed
 * preflight checks only after the matching customer input is reviewed.
 */
export const pilotAdapter: ControlledPilotAdapter = {
  descriptor,
  scopes: { resolve: async () => undefined },
  runtimes: { open: async () => undefined },
  preflight: async () => [
    { id: "customer-scope-wiring", passed: false, detail: "Trusted customer scope resolver is not wired." },
    { id: "customer-runtime-wiring", passed: false, detail: "Customer-local runtime and credential aliases are not wired." },
    { id: "customer-verifier-wiring", passed: false, detail: "Independent external-state verifiers are not wired." },
  ],
  acceptance: {
    caseIds: [...REQUIRED_PILOT_ADAPTER_CASES],
    run: async (caseId) => ({
      caseId,
      passed: false,
      intendedWrites: 0,
      incorrectSideEffects: 0,
      checks: [{ id: "not-implemented", passed: false, detail: "Acceptance case " + caseId + " has not been implemented or run." }],
      artifactReferences: [],
      completedAt: new Date().toISOString(),
    }),
  },
};

export default pilotAdapter;
`;
}

function readme(intake: PilotAdapterIntake): string {
  return `# ${intake.adapterId}

This directory was generated as a **fail-closed controlled-pilot adapter scaffold**. Generation does not mean the adapter works or that any acceptance case passed.

## Generated evidence

- \`adapter.descriptor.json\`: alias-only trusted boundary and documentation hashes.
- \`documentation-lock.json\`: copied source files and their exact hashes.
- \`operation-boundaries.json\`: read-before-write, reconciliation, and verifier requirements.
- \`verifier-patterns.json\`: external outcome states every verifier must distinguish.
- \`acceptance-cases.json\`: all ten mandatory cases, initially marked \`not-run\`.
- \`customer-input-checklist.md\`: information and authority required before activation.
- \`adapter.ts\`: a compiling-shaped but intentionally unavailable adapter module.

## Required order

1. Review the documentation hashes with the customer.
2. Complete the customer-input checklist.
3. Implement trusted scope, local runtime, credential aliases, and independent verifiers.
4. Make every read-only preflight check pass.
5. Implement all ten acceptance cases and preserve their artifacts.
6. Run adapter preflight and acceptance before any model-backed confirmation.
7. Obtain explicit customer activation approval.

Never replace a failed check with a hard-coded pass. The scaffold is designed to make missing work visible.
`;
}

export function createPilotAdapterScaffold(options: {
  intake: PilotAdapterIntake;
  documentationRoot: string;
  outputDirectory: string;
  productImport: string;
}): PilotAdapterScaffoldResult {
  const intake = pilotAdapterIntakeSchema.parse(options.intake);
  const outputDirectory = path.resolve(options.outputDirectory);
  if (fs.existsSync(outputDirectory)) throw new Error("Adapter scaffold output already exists; choose a new directory to preserve the current candidate.");
  const documents = intake.documentation.map((document, index) => {
    const source = safeDocumentationFile(options.documentationRoot, document.sourcePath);
    const contents = fs.readFileSync(source);
    const copiedName = sourceFilename(index, document.sourcePath);
    return {
      targetAlias: document.targetAlias,
      sourcePath: document.sourcePath,
      copiedPath: `documentation/${copiedName}`,
      mediaType: document.mediaType,
      bytes: contents.byteLength,
      sha256: sha256(contents),
      contents,
    };
  });
  const lockWithoutAggregate = {
    schemaVersion: "1.0" as const,
    documents: documents.map(({ contents: _contents, ...document }) => document),
    createdAt: new Date().toISOString(),
  };
  const documentationLock: TrustedDocumentationLock = {
    ...lockWithoutAggregate,
    aggregateSha256: sha256(canonical(lockWithoutAggregate.documents)),
  };
  const descriptor: PilotAdapterDescriptor = {
    schemaVersion: PILOT_ADAPTER_SCHEMA_VERSION,
    adapterId: intake.adapterId,
    adapterVersion: intake.adapterVersion,
    capabilityMode: CURRENT_CAPABILITY_MODE,
    environmentId: intake.environmentId,
    scopeKeys: [...intake.scopeKeys],
    workflowKeys: [...intake.workflowKeys],
    targetAliases: [...intake.targetAliases],
    credentialAliases: [...intake.credentialAliases],
    documentation: documentationLock.documents.map((document) => ({ targetAlias: document.targetAlias, sha256: document.sha256 })),
    operations: structuredClone(intake.operations),
    acceptanceCases: [...REQUIRED_PILOT_ADAPTER_CASES],
    dataBoundary: {
      execution: "customer-local",
      credentials: "customer-local-alias-only",
      externalVerification: "customer-local-independent",
    },
  };
  const checks = validatePilotAdapterDescriptor(descriptor);
  const failures = checks.filter((check) => !check.passed);
  if (failures.length > 0) throw new Error(`Generated descriptor failed trusted validation: ${failures.map((check) => check.id).join(", ")}`);

  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  for (const document of documents) {
    writeFileAtomic(path.join(outputDirectory, document.copiedPath), document.contents.toString("utf8"));
  }
  const readsByTarget = new Map(intake.targetAliases.map((targetAlias) => [
    targetAlias,
    intake.operations.filter((operation) => operation.targetAlias === targetAlias && operation.consequence === "read").map((operation) => operation.name),
  ]));
  const operationBoundaries = intake.operations.map((operation) => ({
    operation: operation.name,
    targetAlias: operation.targetAlias,
    method: operation.method,
    consequence: operation.consequence,
    preActionReads: operation.consequence === "write" ? readsByTarget.get(operation.targetAlias) ?? [] : [],
    retryRule: operation.retrySafety,
    outcomeVerifierKey: operation.outcomeVerifierKey,
    apiResponseAloneIsCompletionEvidence: false,
  }));
  const verifierPatterns = [...new Set(intake.operations.map((operation) => operation.outcomeVerifierKey))].map((verifierKey) => ({
    verifierKey,
    customerLocalIndependentSourceRequired: true,
    requiredOutcomes: ["complete", "not-started", "partial", "incorrect", "unknown"],
    reconcileBeforeRetryForOperations: intake.operations
      .filter((operation) => operation.outcomeVerifierKey === verifierKey && operation.consequence === "write")
      .map((operation) => operation.name),
  }));
  const acceptanceCases = REQUIRED_PILOT_ADAPTER_CASES.map((caseId, index) => ({
    sequence: index + 1,
    caseId,
    status: "not-run",
    evidenceArtifact: null,
    intendedWrites: null,
    incorrectSideEffects: null,
  }));

  writeJson(path.join(outputDirectory, "adapter.descriptor.json"), descriptor);
  writeJson(path.join(outputDirectory, "documentation-lock.json"), documentationLock);
  writeJson(path.join(outputDirectory, "operation-boundaries.json"), operationBoundaries);
  writeJson(path.join(outputDirectory, "verifier-patterns.json"), verifierPatterns);
  writeJson(path.join(outputDirectory, "acceptance-cases.json"), acceptanceCases);
  writeFileAtomic(path.join(outputDirectory, "customer-input-checklist.md"), intakeChecklist(intake, documentationLock));
  writeFileAtomic(path.join(outputDirectory, "adapter.ts"), adapterModule(intake, options.productImport));
  writeFileAtomic(path.join(outputDirectory, "README.md"), readme(intake));
  const files = fs.readdirSync(outputDirectory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(outputDirectory, path.join(entry.parentPath, entry.name)))
    .sort();
  return { adapterId: intake.adapterId, outputDirectory, descriptor, documentationLock, files, checks };
}
