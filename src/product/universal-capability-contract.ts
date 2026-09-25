import { z } from "zod";

/**
 * The cross-mode contract is deliberately broader than the currently enabled
 * drivers. A family appearing here is an architectural slot, not a claim that
 * the product can execute it today.
 */
export const knownRuntimeFamilySchema = z.enum([
  "service-api",
  "browser-web",
  "native-ui",
  "file-object-edi",
  "message-event",
  "document-media",
  "database-query",
  "trusted-tool-code",
  "os-shell",
  "cloud-admin",
  "identity-account",
  "agent-service-delegation",
  "human-delegation",
  "device-iot",
  "physical-robotic",
]);
export type KnownRuntimeFamily = z.infer<typeof knownRuntimeFamilySchema>;

const extensionFamilySchema = z.string()
  .min(12)
  .max(120)
  .regex(/^extension\.[a-z0-9][a-z0-9.-]+$/);

/** Extension IDs let a new mechanism be added without weakening known modes. */
export const runtimeFamilySchema = z.union([
  knownRuntimeFamilySchema,
  extensionFamilySchema,
]);
export type RuntimeFamily = z.infer<typeof runtimeFamilySchema>;

export const runtimeFamilyMaturitySchema = z.enum([
  "working-local-pilot-mvp",
  "experimental-local",
  "planned",
  "future",
]);
export type RuntimeFamilyMaturity = z.infer<typeof runtimeFamilyMaturitySchema>;

export const executionRiskSchema = z.enum([
  "read-only",
  "reversible-write",
  "consequential-write",
  "privileged-control",
  "physical-action",
]);
export type ExecutionRisk = z.infer<typeof executionRiskSchema>;

const identifier = z.string().min(1).max(180).regex(/^[a-zA-Z0-9_.-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const boundedText = z.string().trim().min(1).max(2_000);

export const runtimeFamilyDescriptorSchema = z.object({
  family: runtimeFamilySchema,
  label: z.string().min(1).max(120),
  description: z.string().min(1).max(600),
  maturity: runtimeFamilyMaturitySchema,
  enabled: z.boolean(),
  currentMode: z.string().min(1).max(120).optional(),
  highestPermittedRisk: executionRiskSchema,
  claimBoundary: z.string().min(1).max(800),
}).strict();
export type RuntimeFamilyDescriptor = z.infer<typeof runtimeFamilyDescriptorSchema>;

/**
 * Canonical architectural registry. Enabled and maturity are evidence labels,
 * not a product marketing claim.
 */
export const DEFAULT_RUNTIME_FAMILY_REGISTRY: readonly RuntimeFamilyDescriptor[] = [
  {
    family: "service-api",
    label: "Service APIs and RPC",
    description: "Documented service interfaces such as constrained HTTP APIs, GraphQL, SOAP, RPC and related remote operations.",
    maturity: "working-local-pilot-mvp",
    enabled: true,
    currentMode: "constrained-http-api",
    highestPermittedRisk: "consequential-write",
    claimBoundary: "Only the constrained HTTP route currently has local pilot-MVP evidence; the wider service-protocol family is architectural scope.",
  },
  {
    family: "browser-web",
    label: "Authenticated browser and web UI",
    description: "Constrained interaction with approved web pages and semantic controls.",
    maturity: "experimental-local",
    enabled: true,
    currentMode: "experimental-browser-actions",
    highestPermittedRisk: "consequential-write",
    claimBoundary: "Bounded local browser experiments only; not arbitrary-site or production browser operation.",
  },
  {
    family: "native-ui",
    label: "Native desktop and mobile UI",
    description: "Constrained operation of approved native graphical interfaces on desktop or mobile systems.",
    maturity: "planned",
    enabled: false,
    highestPermittedRisk: "consequential-write",
    claimBoundary: "Architectural family only; no native-UI driver or evidence exists yet.",
  },
  {
    family: "file-object-edi",
    label: "Files, object storage and EDI",
    description: "Bounded file exchange, object-store operations and structured business-document interchange.",
    maturity: "experimental-local",
    enabled: true,
    currentMode: "experimental-file-transfer-actions",
    highestPermittedRisk: "consequential-write",
    claimBoundary: "Local bounded X12 and EDIFACT experiments only; not general EDI or production transport support.",
  },
  {
    family: "message-event",
    label: "Messaging, inboxes and event streams",
    description: "Authenticated messages, inboxes, queues, event streams, chat, voice and related communication channels.",
    maturity: "experimental-local",
    enabled: true,
    currentMode: "experimental-inbox-message-actions",
    highestPermittedRisk: "consequential-write",
    claimBoundary: "Only a bounded signed local message-ingress experiment exists; general messaging, email and voice are not implemented.",
  },
  {
    family: "document-media",
    label: "Documents, spreadsheets and media",
    description: "Bounded interpretation or transformation of documents, tables, images, audio and video artifacts.",
    maturity: "experimental-local",
    enabled: true,
    currentMode: "experimental-document-actions",
    highestPermittedRisk: "consequential-write",
    claimBoundary: "Only two pinned machine-readable PDF layouts have local evidence; OCR and arbitrary media understanding are not implemented.",
  },
  {
    family: "database-query",
    label: "Databases, search and data warehouses",
    description: "Scoped reads and writes through reviewed views, queries, procedures, search indexes and warehouse interfaces.",
    maturity: "experimental-local",
    enabled: true,
    currentMode: "experimental-database-actions",
    highestPermittedRisk: "consequential-write",
    claimBoundary: "Only a bounded local reviewed-operation experiment is enabled; arbitrary SQL and production database access are not implemented.",
  },
  {
    family: "trusted-tool-code",
    label: "Trusted tools, packages and isolated code",
    description: "Pinned tools, packages, agent protocols and tightly isolated residual code execution.",
    maturity: "experimental-local",
    enabled: true,
    currentMode: "experimental-trusted-tool-actions",
    highestPermittedRisk: "consequential-write",
    claimBoundary: "Only import-free pinned WebAssembly compute in a killable local worker is enabled; no general package installer, host access or arbitrary code execution is implemented.",
  },
  {
    family: "os-shell",
    label: "Operating systems, command line and remote shell",
    description: "Bounded filesystem, process, command-line and reviewed remote-shell operations.",
    maturity: "planned",
    enabled: false,
    highestPermittedRisk: "privileged-control",
    claimBoundary: "Architectural family only; arbitrary shell execution is explicitly absent from the current product.",
  },
  {
    family: "cloud-admin",
    label: "Cloud, infrastructure and administrative control planes",
    description: "Permissioned operation of infrastructure, deployment, network and SaaS administration control planes.",
    maturity: "planned",
    enabled: false,
    highestPermittedRisk: "privileged-control",
    claimBoundary: "Architectural family only; no cloud or infrastructure administration driver is enabled.",
  },
  {
    family: "identity-account",
    label: "Identity, accounts, credentials and permissions",
    description: "Identity lifecycle, account access, credential issuance or rotation and permission workflows.",
    maturity: "planned",
    enabled: false,
    highestPermittedRisk: "privileged-control",
    claimBoundary: "Architectural family only; the current product can request authority but cannot autonomously create identity or authority.",
  },
  {
    family: "agent-service-delegation",
    label: "Agent and digital-service delegation",
    description: "Delegation to another approved agent or specialist digital service with an explicit result contract.",
    maturity: "experimental-local",
    enabled: true,
    currentMode: "experimental-agent-delegation-actions",
    highestPermittedRisk: "consequential-write",
    claimBoundary: "Only one pinned signed local delegate shape with separate external-state verification is enabled; no general discovery or production delegation exists.",
  },
  {
    family: "human-delegation",
    label: "Human delegation",
    description: "Precise, auditable delegation of work or authority decisions to an identified human owner.",
    maturity: "future",
    enabled: false,
    highestPermittedRisk: "privileged-control",
    claimBoundary: "Future acquisition route; current handoffs request help but do not operate a human-work marketplace or workforce.",
  },
  {
    family: "device-iot",
    label: "Mobile, device and IoT control",
    description: "Bounded interaction with approved mobile devices, sensors, equipment and networked control surfaces.",
    maturity: "future",
    enabled: false,
    highestPermittedRisk: "physical-action",
    claimBoundary: "Future architectural family only; no device-control capability exists.",
  },
  {
    family: "physical-robotic",
    label: "Physical and robotic action",
    description: "Actions that directly change the physical world through approved robotic or operational systems.",
    maturity: "future",
    enabled: false,
    highestPermittedRisk: "physical-action",
    claimBoundary: "Future architectural family only; no physical-action capability exists.",
  },
] as const;

export const capabilityBundleSourceSchema = z.enum([
  "retained",
  "trusted-existing",
  "composed",
  "built-manifest",
  "sandboxed-residual",
  "delegated",
]);
export type CapabilityBundleSource = z.infer<typeof capabilityBundleSourceSchema>;

/**
 * A complete capability is more than executable instructions. It also carries
 * authority, independent verification, recovery, provenance and retention.
 * Credential values and customer payloads are intentionally absent.
 */
export const capabilityBundleSchema = z.object({
  schemaVersion: z.literal("1.0"),
  capabilityId: identifier,
  tenantId: identifier,
  needKey: identifier,
  summary: boundedText,
  source: capabilityBundleSourceSchema,
  runtime: z.object({
    family: runtimeFamilySchema,
    driverId: identifier,
    driverVersion: identifier,
    executionBoundary: z.enum(["customer-local", "isolated-sandbox", "delegated"]),
  }).strict(),
  manifest: z.object({
    mediaType: z.string().min(1).max(160),
    digest,
    reference: identifier,
    generated: z.boolean(),
  }).strict(),
  authority: z.object({
    targetAliases: z.array(identifier).min(1).max(32),
    secretAliases: z.array(identifier).max(32),
    approvalKeys: z.array(identifier).max(32),
    risk: executionRiskSchema,
    expiresAt: z.string().datetime().optional(),
  }).strict(),
  verification: z.object({
    preUseVerifierKey: identifier,
    outcomeVerifierKey: identifier,
    observationSource: identifier,
    independentFromExecution: z.literal(true),
    contractHash: digest,
  }).strict(),
  recovery: z.object({
    operationKey: identifier,
    idempotency: z.enum(["required", "not-applicable", "unavailable"]),
    reconcileBeforeRetry: z.literal(true),
    blindRetryAllowed: z.literal(false),
    quarantineOn: z.array(z.enum([
      "verification-failure",
      "policy-escape",
      "partial-outcome",
      "incorrect-outcome",
      "unknown-outcome",
      "drift",
    ])).min(1),
  }).strict(),
  provenance: z.object({
    trustedSourceIds: z.array(identifier).max(32),
    sourceHashes: z.array(digest).min(1).max(64),
    builderVersion: identifier,
    builtAt: z.string().datetime(),
  }).strict(),
  retention: z.object({
    version: z.number().int().positive(),
    reusable: z.boolean(),
    scopeDigest: digest,
    expiresAt: z.string().datetime().optional(),
  }).strict(),
}).strict();
export type CapabilityBundle = z.infer<typeof capabilityBundleSchema>;

export const capabilityGapSchema = z.object({
  key: identifier,
  summary: boundedText,
  requiredActions: z.array(identifier).min(1).max(32),
  targetAliases: z.array(identifier).min(1).max(32),
  requiredObservationKeys: z.array(identifier).min(1).max(32),
  maximumRisk: executionRiskSchema,
}).strict();
export type CapabilityGap = z.infer<typeof capabilityGapSchema>;

export const universalAuthoritySchema = z.object({
  allowedTargetAliases: z.array(identifier).max(64),
  allowedSecretAliases: z.array(identifier).max(64),
  allowedActions: z.array(identifier).max(64),
  grantedApprovals: z.array(identifier).max(64),
  maximumRisk: executionRiskSchema,
}).strict();
export type UniversalAuthority = z.infer<typeof universalAuthoritySchema>;

export const universalGoalSchema = z.object({
  schemaVersion: z.literal("1.0"),
  tenantId: identifier,
  requestId: identifier,
  parentGoalId: identifier,
  ordinaryGoal: z.string().trim().min(1).max(4_000),
  gap: capabilityGapSchema,
  authority: universalAuthoritySchema,
}).strict();
export type UniversalGoal = z.infer<typeof universalGoalSchema>;

/**
 * Public/customer-agent entrance. It deliberately contains neither a runtime
 * family nor a capability mode; trusted customer-local preparation supplies
 * the diagnosed gap, authority and bounded route candidates.
 */
export const universalGoalSubmissionSchema = z.object({
  schemaVersion: z.literal("1.0"),
  tenantId: identifier,
  requestId: identifier,
  parentGoalId: identifier,
  ordinaryGoal: z.string().trim().min(1).max(4_000),
  scopeKey: identifier,
  visibility: z.enum(["exceptions-only", "summary", "full"]),
}).strict();
export type UniversalGoalSubmission = z.infer<typeof universalGoalSubmissionSchema>;

export const universalResolutionStatusSchema = z.enum([
  "autonomous-completion",
  "precise-handoff",
  "unresolved-safe",
]);
export type UniversalResolutionStatus = z.infer<typeof universalResolutionStatusSchema>;

export const universalResolutionMetricsSchema = z.object({
  correctlyResolved: z.boolean(),
  autonomouslyCompleted: z.boolean(),
  preciseHandoff: z.boolean(),
  silentFalseCompletion: z.literal(false),
}).strict();
export type UniversalResolutionMetrics = z.infer<typeof universalResolutionMetricsSchema>;
