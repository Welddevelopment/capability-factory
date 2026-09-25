import { createHash } from "node:crypto";
import { estimateGpt56SolCost, type BudgetTracker, type UsageRecord } from "../budget.js";

export const ADAPTER_DISCOVERY_SCHEMA_VERSION = "1.0" as const;

export const ADAPTER_FACT_STATUSES = [
  "observed",
  "extracted",
  "inferred-proposal",
  "customer-confirmed",
  "independently-verified",
  "unknown",
] as const;

export type AdapterFactStatus = (typeof ADAPTER_FACT_STATUSES)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface AdapterEvidenceReference {
  materialId: string;
  materialKind: "openapi" | "mcp" | "sdk-reference" | "workflow" | "factory-policy";
  pointer: string;
  sha256: string;
}

/** Every discovered or proposed product fact is wrapped with its evidence state. */
export interface AdapterFact<T> {
  value: T;
  status: AdapterFactStatus;
  evidence: AdapterEvidenceReference[];
  explanation: string;
}

export interface ApprovedMaterialBase {
  materialId: string;
  localReference: string;
  approved: true;
  targetAlias?: string;
}

export interface ApprovedOpenApiMaterial extends ApprovedMaterialBase {
  kind: "openapi";
  document: JsonValue;
}

export interface McpToolDescription {
  name: string;
  description?: string;
  inputSchema?: JsonValue;
  outputSchema?: JsonValue;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
  credentialAliases?: string[];
}

export interface ApprovedMcpMaterial extends ApprovedMaterialBase {
  kind: "mcp";
  serverName: string;
  tools: McpToolDescription[];
}

export interface SdkReferenceOperation {
  name: string;
  description?: string;
  effect?: "read" | "write";
  requestShape?: JsonValue;
  responseShape?: JsonValue;
  idempotency?: "documented" | "not-documented";
  credentialAliases?: string[];
}

export interface ApprovedSdkReferenceMaterial extends ApprovedMaterialBase {
  kind: "sdk-reference";
  packageName: string;
  packageVersion?: string;
  operations: SdkReferenceOperation[];
}

export type ApprovedAdapterMaterial = ApprovedOpenApiMaterial | ApprovedMcpMaterial | ApprovedSdkReferenceMaterial;

export interface BoundedWorkflowDescription {
  workflowId: string;
  summary: string;
  requiredOutcome: string;
  approvedTargetAliases: string[];
  requestedOperationNames: string[];
  customerConfirmed: true;
}

export interface AdapterDiscoveryInput {
  schemaVersion: typeof ADAPTER_DISCOVERY_SCHEMA_VERSION;
  workflow: BoundedWorkflowDescription;
  materials: ApprovedAdapterMaterial[];
}

export interface ProposedSystem {
  systemId: AdapterFact<string>;
  label: AdapterFact<string>;
  materialKinds: AdapterFact<Array<ApprovedAdapterMaterial["kind"]>>;
}

export interface ProposedTarget {
  alias: AdapterFact<string>;
  systemId: AdapterFact<string>;
  approvedForWorkflow: AdapterFact<boolean>;
}

export interface ProposedCredentialAlias {
  alias: AdapterFact<string>;
  targetAlias: AdapterFact<string>;
  scheme: AdapterFact<string>;
  valuePresent: false;
}

export type OperationConsequence = "read" | "write" | "unknown";
export type RetryRequirement = "not-applicable" | "reconcile-before-retry" | "requires-engineer-confirmation";
export type IdempotencyAssessment = "documented" | "not-documented" | "unknown";

export interface ProposedOperation {
  operationId: AdapterFact<string>;
  /** Target-qualified identity; raw operation names may legitimately repeat across systems. */
  operationKey: AdapterFact<string>;
  sourceKind: AdapterFact<"http" | "mcp-tool" | "sdk-operation">;
  targetAlias: AdapterFact<string>;
  description: AdapterFact<string>;
  transportAction: AdapterFact<string>;
  consequence: AdapterFact<OperationConsequence>;
  requestShape: AdapterFact<JsonValue | null>;
  responseShape: AdapterFact<JsonValue | null>;
  credentialAliases: AdapterFact<string[]>;
  idempotency: AdapterFact<IdempotencyAssessment>;
  retryRequirement: AdapterFact<RetryRequirement>;
  reconciliationCandidates: AdapterFact<string[]>;
  requestedByWorkflow: AdapterFact<boolean>;
  writeAuthorized: AdapterFact<false>;
  executable: AdapterFact<false>;
}

export interface ProposedScopeWorkflowDescriptor {
  workflowId: AdapterFact<string>;
  summary: AdapterFact<string>;
  requiredOutcome: AdapterFact<string>;
  targetAliases: AdapterFact<string[]>;
  operationIds: AdapterFact<string[]>;
  authorityState: AdapterFact<"unconfigured">;
  verifierState: AdapterFact<"unconfigured">;
}

export interface AdapterDiscoveryBlocker {
  blockerId: string;
  category: "authority" | "credential" | "operation" | "reconciliation" | "verifier" | "scope" | "source";
  blocking: true;
  fact: AdapterFact<string>;
}

export interface AdapterDiscoveryProposal {
  schemaVersion: typeof ADAPTER_DISCOVERY_SCHEMA_VERSION;
  proposalState: "proposal-only";
  executable: false;
  writesAuthorized: false;
  systems: ProposedSystem[];
  targets: ProposedTarget[];
  credentialAliases: ProposedCredentialAlias[];
  operations: ProposedOperation[];
  scopeWorkflow: ProposedScopeWorkflowDescriptor;
  unknowns: Array<AdapterFact<string>>;
  engineeringBlockers: AdapterDiscoveryBlocker[];
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "trace"] as const;
const WRITE_METHODS = new Set(["post", "put", "patch", "delete"]);
const identifierPattern = /^[a-zA-Z][a-zA-Z0-9_.-]{1,159}$/;
const secretPatterns = [
  /\bbearer\s+[a-z0-9._~+\/-]{8,}/i,
  /\bsk-[a-z0-9_-]{12,}/i,
  /\b(?:api[_ -]?key|password|client[_ -]?secret|access[_ -]?token)\s*[:=]\s*["']?[^\s"']{6,}/i,
  /https?:\/\/[^\s/:]+:[^\s/@]+@/i,
] as const;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function assertNoCredentialValues(value: unknown, label: string): void {
  const serialized = stableJson(value);
  if (secretPatterns.some((pattern) => pattern.test(serialized))) {
    throw new Error(`${label} contains a credential-shaped value. Supply credential aliases only.`);
  }
}

function requireIdentifier(value: string, label: string): void {
  if (!identifierPattern.test(value)) throw new Error(`${label} must be a stable identifier.`);
}

function slug(value: string, fallback: string): string {
  const normalized = value.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-+|-+$/g, "").slice(0, 120);
  return normalized.length >= 2 && /^[a-z]/.test(normalized) ? normalized : fallback;
}

function fact<T>(value: T, status: AdapterFactStatus, evidence: AdapterEvidenceReference[], explanation: string): AdapterFact<T> {
  return { value: structuredClone(value), status, evidence: evidence.map((item) => ({ ...item })), explanation };
}

function source(material: ApprovedAdapterMaterial, pointer: string): AdapterEvidenceReference {
  return { materialId: material.materialId, materialKind: material.kind, pointer, sha256: digest(material) };
}

function workflowSource(workflow: BoundedWorkflowDescription, pointer: string): AdapterEvidenceReference {
  return { materialId: `workflow:${workflow.workflowId}`, materialKind: "workflow", pointer, sha256: digest(workflow) };
}

function policySource(pointer: string): AdapterEvidenceReference {
  return { materialId: "capability-factory:adapter-discovery-policy", materialKind: "factory-policy", pointer, sha256: digest(ADAPTER_DISCOVERY_SCHEMA_VERSION) };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function jsonValue(value: unknown): JsonValue | null {
  if (value === undefined) return null;
  return structuredClone(value) as JsonValue;
}

function targetAlias(material: ApprovedAdapterMaterial, label: string): string {
  const alias = material.targetAlias ?? slug(label, `target-${slug(material.materialId, "material")}`);
  requireIdentifier(alias, `Target alias for ${material.materialId}`);
  return alias;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

interface MutableExtraction {
  systems: ProposedSystem[];
  targets: ProposedTarget[];
  credentials: ProposedCredentialAlias[];
  operations: ProposedOperation[];
  unknowns: Array<AdapterFact<string>>;
}

function workflowMatch(workflow: BoundedWorkflowDescription, operationId: string, target: string): AdapterFact<boolean> {
  const evidence = [workflowSource(workflow, "/requestedOperationNames"), workflowSource(workflow, "/approvedTargetAliases")];
  if (workflow.requestedOperationNames.length === 0) {
    return fact(false, "unknown", evidence, "The approved workflow did not name an operation; an engineer must select it explicitly.");
  }
  return fact(
    workflow.approvedTargetAliases.includes(target)
      && (workflow.requestedOperationNames.includes(operationId) || workflow.requestedOperationNames.includes(`${target}.${operationId}`)),
    "customer-confirmed",
    evidence,
    "Compared only with the exact target aliases and operation names in the confirmed bounded workflow.",
  );
}

function policyFacts(consequence: OperationConsequence, evidence: AdapterEvidenceReference[]): Pick<ProposedOperation, "writeAuthorized" | "executable" | "retryRequirement"> {
  const policy = policySource("/proposal-only");
  return {
    writeAuthorized: fact(false, "independently-verified", [policy], "Discovery never grants write authority."),
    executable: fact(false, "independently-verified", [policy], "A discovery proposal cannot execute until separate review, implementation, verification, and activation gates pass."),
    retryRequirement: consequence === "read"
      ? fact("not-applicable", "inferred-proposal", evidence, "Read-only candidates do not need write reconciliation, subject to engineer confirmation of side effects.")
      : consequence === "write"
        ? fact("reconcile-before-retry", "independently-verified", [policy], "Every proposed write must inspect independent external state before retry.")
        : fact("requires-engineer-confirmation", "unknown", evidence, "Side effects are not established, so retry behavior cannot be selected."),
  };
}

function addCredentialAlias(extraction: MutableExtraction, alias: string, target: string, scheme: string, evidence: AdapterEvidenceReference[]): void {
  requireIdentifier(alias, "Credential alias");
  if (extraction.credentials.some((candidate) => candidate.alias.value === alias && candidate.targetAlias.value === target)) return;
  extraction.credentials.push({
    alias: fact(alias, "extracted", evidence, "Credential identifier extracted as an alias; no secret value is stored."),
    targetAlias: fact(target, "extracted", evidence, "Credential alias is associated with this proposed target."),
    scheme: fact(scheme, "extracted", evidence, "Authentication scheme extracted from approved metadata."),
    valuePresent: false,
  });
}

function openApiSchemaFromContent(content: unknown): JsonValue | null {
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  const media = Object.values(content as Record<string, unknown>).find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate));
  return media ? jsonValue((media as Record<string, unknown>).schema) : null;
}

function extractOpenApi(material: ApprovedOpenApiMaterial, workflow: BoundedWorkflowDescription, extraction: MutableExtraction): void {
  const document = asRecord(material.document, `OpenAPI material ${material.materialId}`);
  const openApiVersion = stringValue(document.openapi);
  if (!openApiVersion) {
    if (stringValue(document.swagger)) {
      throw new Error(`OpenAPI material ${material.materialId} uses Swagger 2.x, which this factory does not parse. Convert it to approved OpenAPI 3.x material first.`);
    }
    throw new Error(`OpenAPI material ${material.materialId} has no version marker.`);
  }
  if (!/^3\.\d+(?:\.\d+)?(?:[-+].*)?$/.test(openApiVersion)) {
    throw new Error(`OpenAPI material ${material.materialId} uses unsupported version ${openApiVersion}; only approved OpenAPI 3.x material is accepted.`);
  }
  const info = document.info && typeof document.info === "object" && !Array.isArray(document.info) ? document.info as Record<string, unknown> : {};
  const label = stringValue(info.title) ?? material.materialId;
  const systemId = slug(label, slug(material.materialId, "openapi-system"));
  const target = targetAlias(material, label);
  const rootEvidence = [source(material, "/")];
  extraction.systems.push({
    systemId: fact(systemId, "inferred-proposal", rootEvidence, "Stable system identifier proposed from approved OpenAPI metadata."),
    label: fact(label, "extracted", [source(material, "/info/title")], "System label extracted from the OpenAPI title or material identifier."),
    materialKinds: fact(["openapi"], "observed", rootEvidence, "Observed approved source kind."),
  });
  extraction.targets.push({
    alias: fact(target, material.targetAlias ? "customer-confirmed" : "inferred-proposal", rootEvidence, "Target alias is customer-supplied or proposed from the approved system label."),
    systemId: fact(systemId, "inferred-proposal", rootEvidence, "Target is provisionally attached to the extracted system."),
    approvedForWorkflow: fact(workflow.approvedTargetAliases.includes(target), "customer-confirmed", [workflowSource(workflow, "/approvedTargetAliases")], "Compared with the workflow's confirmed target allowlist."),
  });

  const components = document.components && typeof document.components === "object" && !Array.isArray(document.components) ? document.components as Record<string, unknown> : {};
  const securitySchemes = components.securitySchemes && typeof components.securitySchemes === "object" && !Array.isArray(components.securitySchemes)
    ? components.securitySchemes as Record<string, unknown>
    : {};
  for (const [name, candidate] of Object.entries(securitySchemes)) {
    const scheme = candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate as Record<string, unknown> : {};
    addCredentialAlias(extraction, name, target, stringValue(scheme.type) ?? "unknown", [source(material, `/components/securitySchemes/${name}`)]);
  }

  const paths = asRecord(document.paths ?? {}, `OpenAPI paths for ${material.materialId}`);
  const localOperations: ProposedOperation[] = [];
  for (const [route, pathCandidate] of Object.entries(paths)) {
    if (!route.startsWith("/")) throw new Error(`OpenAPI path ${route} must begin with /.`);
    const pathItem = asRecord(pathCandidate, `OpenAPI path item ${route}`);
    for (const method of HTTP_METHODS) {
      if (!(method in pathItem)) continue;
      const operation = asRecord(pathItem[method], `OpenAPI operation ${method.toUpperCase()} ${route}`);
      const operationId = stringValue(operation.operationId) ?? slug(`${method}-${route}`, `${method}-operation`);
      requireIdentifier(operationId, `OpenAPI operation ID ${method.toUpperCase()} ${route}`);
      const evidence = [source(material, `/paths/${route}/${method}`)];
      const consequence: OperationConsequence = WRITE_METHODS.has(method) ? "write" : "read";
      const parameters = Array.isArray(operation.parameters) ? operation.parameters : Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
      const requestBody = operation.requestBody && typeof operation.requestBody === "object" && !Array.isArray(operation.requestBody)
        ? operation.requestBody as Record<string, unknown>
        : {};
      const requestShape: JsonValue = {
        parameters: jsonValue(parameters) ?? [],
        body: openApiSchemaFromContent(requestBody.content),
      };
      const responses = operation.responses && typeof operation.responses === "object" && !Array.isArray(operation.responses)
        ? operation.responses as Record<string, unknown>
        : {};
      const successResponse = Object.entries(responses).find(([status]) => /^2\d\d$/.test(status))?.[1];
      const responseRecord = successResponse && typeof successResponse === "object" && !Array.isArray(successResponse) ? successResponse as Record<string, unknown> : {};
      const security = Array.isArray(operation.security) ? operation.security : Array.isArray(document.security) ? document.security : [];
      const aliases = unique(security.flatMap((item) => item && typeof item === "object" && !Array.isArray(item) ? Object.keys(item as Record<string, unknown>) : []));
      const idempotencyParameter = parameters.some((item) => item && typeof item === "object" && !Array.isArray(item)
        && /idempotency/i.test(String((item as Record<string, unknown>).name ?? "")));
      const idempotency: IdempotencyAssessment = consequence === "read" || idempotencyParameter || operation["x-idempotent"] === true
        ? "documented"
        : "not-documented";
      const policy = policyFacts(consequence, evidence);
      localOperations.push({
        operationId: fact(operationId, stringValue(operation.operationId) ? "extracted" : "inferred-proposal", evidence, "Operation identifier was extracted or proposed deterministically from method and path."),
        operationKey: fact(`${target}.${operationId}`, "independently-verified", evidence, "Operation identity is qualified by its target to remain unambiguous across systems."),
        sourceKind: fact("http", "observed", evidence, "Operation came from approved OpenAPI material."),
        targetAlias: fact(target, "extracted", evidence, "Operation belongs to this approved target source."),
        description: fact(stringValue(operation.summary) ?? stringValue(operation.description) ?? `${method.toUpperCase()} ${route}`, "extracted", evidence, "Human-readable operation description from approved metadata."),
        transportAction: fact(`${method.toUpperCase()} ${route}`, "extracted", evidence, "HTTP method and path extracted from OpenAPI."),
        consequence: fact(consequence, "extracted", evidence, "HTTP method is classified conservatively: POST, PUT, PATCH and DELETE are writes."),
        requestShape: fact(requestShape, "extracted", evidence, "Request parameters and body schema extracted without constructing an executable request."),
        responseShape: fact(openApiSchemaFromContent(responseRecord.content), "extracted", evidence, "First documented success response shape, if present."),
        credentialAliases: fact(aliases, "extracted", evidence, "Only security-scheme aliases are retained."),
        idempotency: fact(idempotency, "extracted", evidence, idempotency === "documented" ? "Read semantics or explicit idempotency metadata is present." : "No approved idempotency evidence was found."),
        retryRequirement: policy.retryRequirement,
        reconciliationCandidates: fact([], consequence === "write" ? "unknown" : "inferred-proposal", evidence, "Populated after the full operation inventory is available."),
        requestedByWorkflow: workflowMatch(workflow, operationId, target),
        writeAuthorized: policy.writeAuthorized,
        executable: policy.executable,
      });
    }
  }
  for (const operation of localOperations) {
    if (operation.consequence.value === "write") {
      const candidates = localOperations.filter((candidate) => candidate.consequence.value === "read" && candidate.targetAlias.value === operation.targetAlias.value).map((candidate) => candidate.operationId.value);
      operation.reconciliationCandidates = fact(candidates, candidates.length > 0 ? "inferred-proposal" : "unknown", operation.operationId.evidence, candidates.length > 0
        ? "Read operations on the same target are candidates only; an engineer must prove they independently observe the business result."
        : "No read operation was found that could observe external state after this write.");
    }
  }
  extraction.operations.push(...localOperations);
}

function extractMcp(material: ApprovedMcpMaterial, workflow: BoundedWorkflowDescription, extraction: MutableExtraction): void {
  const target = targetAlias(material, material.serverName);
  const systemId = slug(material.serverName, slug(material.materialId, "mcp-system"));
  const rootEvidence = [source(material, "/")];
  extraction.systems.push({
    systemId: fact(systemId, "inferred-proposal", rootEvidence, "Stable system identifier proposed from approved MCP metadata."),
    label: fact(material.serverName, "extracted", [source(material, "/serverName")], "MCP server name from approved metadata."),
    materialKinds: fact(["mcp"], "observed", rootEvidence, "Observed approved source kind."),
  });
  extraction.targets.push({
    alias: fact(target, material.targetAlias ? "customer-confirmed" : "inferred-proposal", rootEvidence, "Target alias is customer-supplied or proposed from the server name."),
    systemId: fact(systemId, "inferred-proposal", rootEvidence, "Target is provisionally attached to the MCP server."),
    approvedForWorkflow: fact(workflow.approvedTargetAliases.includes(target), "customer-confirmed", [workflowSource(workflow, "/approvedTargetAliases")], "Compared with the confirmed target allowlist."),
  });
  for (const [index, tool] of material.tools.entries()) {
    requireIdentifier(tool.name, `MCP tool ${index}`);
    const evidence = [source(material, `/tools/${index}`)];
    const consequence: OperationConsequence = tool.annotations?.readOnlyHint === true
      ? "read"
      : tool.annotations?.readOnlyHint === false || tool.annotations?.destructiveHint === true
        ? "write"
        : "unknown";
    for (const alias of tool.credentialAliases ?? []) addCredentialAlias(extraction, alias, target, "mcp-declared", evidence);
    const policy = policyFacts(consequence, evidence);
    extraction.operations.push({
      operationId: fact(tool.name, "extracted", evidence, "Tool name extracted from approved MCP metadata."),
      operationKey: fact(`${target}.${tool.name}`, "independently-verified", evidence, "Operation identity is qualified by its target to remain unambiguous across systems."),
      sourceKind: fact("mcp-tool", "observed", evidence, "Operation came from an approved MCP description."),
      targetAlias: fact(target, "extracted", evidence, "Tool belongs to this approved MCP target."),
      description: fact(tool.description ?? tool.name, "extracted", evidence, "Tool description from approved metadata."),
      transportAction: fact(`tool:${tool.name}`, "extracted", evidence, "MCP tool invocation identifier; no call is constructed."),
      consequence: fact(consequence, consequence === "unknown" ? "unknown" : "extracted", evidence, consequence === "unknown" ? "No approved side-effect annotation exists." : "Classified only from approved MCP annotations."),
      requestShape: fact(jsonValue(tool.inputSchema), tool.inputSchema === undefined ? "unknown" : "extracted", evidence, "Tool input schema, if supplied."),
      responseShape: fact(jsonValue(tool.outputSchema), tool.outputSchema === undefined ? "unknown" : "extracted", evidence, "Tool output schema, if supplied."),
      credentialAliases: fact([...(tool.credentialAliases ?? [])], "extracted", evidence, "Credential aliases only; values are forbidden."),
      idempotency: fact(tool.annotations?.idempotentHint === true ? "documented" : "unknown", tool.annotations?.idempotentHint === true ? "extracted" : "unknown", evidence, "Idempotency is accepted only when explicitly annotated."),
      retryRequirement: policy.retryRequirement,
      reconciliationCandidates: fact([], consequence === "read" ? "inferred-proposal" : "unknown", evidence, "Independent reconciliation requires a separately confirmed observation path."),
      requestedByWorkflow: workflowMatch(workflow, tool.name, target),
      writeAuthorized: policy.writeAuthorized,
      executable: policy.executable,
    });
  }
}

function extractSdk(material: ApprovedSdkReferenceMaterial, workflow: BoundedWorkflowDescription, extraction: MutableExtraction): void {
  const target = targetAlias(material, material.packageName);
  const systemId = slug(material.packageName, slug(material.materialId, "sdk-system"));
  const rootEvidence = [source(material, "/")];
  extraction.systems.push({
    systemId: fact(systemId, "inferred-proposal", rootEvidence, "Stable system identifier proposed from approved SDK metadata."),
    label: fact(material.packageVersion ? `${material.packageName}@${material.packageVersion}` : material.packageName, "extracted", rootEvidence, "SDK package identity from approved reference metadata."),
    materialKinds: fact(["sdk-reference"], "observed", rootEvidence, "Observed approved source kind."),
  });
  extraction.targets.push({
    alias: fact(target, material.targetAlias ? "customer-confirmed" : "inferred-proposal", rootEvidence, "Target alias is customer-supplied or proposed from the package name."),
    systemId: fact(systemId, "inferred-proposal", rootEvidence, "Target is provisionally attached to the SDK reference."),
    approvedForWorkflow: fact(workflow.approvedTargetAliases.includes(target), "customer-confirmed", [workflowSource(workflow, "/approvedTargetAliases")], "Compared with the confirmed target allowlist."),
  });
  for (const [index, operation] of material.operations.entries()) {
    requireIdentifier(operation.name, `SDK operation ${index}`);
    const evidence = [source(material, `/operations/${index}`)];
    const consequence: OperationConsequence = operation.effect ?? "unknown";
    for (const alias of operation.credentialAliases ?? []) addCredentialAlias(extraction, alias, target, "sdk-declared", evidence);
    const policy = policyFacts(consequence, evidence);
    extraction.operations.push({
      operationId: fact(operation.name, "extracted", evidence, "Operation name extracted from approved SDK reference metadata."),
      operationKey: fact(`${target}.${operation.name}`, "independently-verified", evidence, "Operation identity is qualified by its target to remain unambiguous across systems."),
      sourceKind: fact("sdk-operation", "observed", evidence, "Operation came from approved SDK reference metadata."),
      targetAlias: fact(target, "extracted", evidence, "Operation belongs to this approved SDK target."),
      description: fact(operation.description ?? operation.name, "extracted", evidence, "Operation description from approved metadata."),
      transportAction: fact(`sdk:${material.packageName}:${operation.name}`, "extracted", evidence, "SDK reference only; no executable call is generated."),
      consequence: fact(consequence, consequence === "unknown" ? "unknown" : "extracted", evidence, consequence === "unknown" ? "No approved side-effect classification exists." : "Side-effect classification from approved SDK metadata."),
      requestShape: fact(jsonValue(operation.requestShape), operation.requestShape === undefined ? "unknown" : "extracted", evidence, "Request shape from approved SDK metadata, if supplied."),
      responseShape: fact(jsonValue(operation.responseShape), operation.responseShape === undefined ? "unknown" : "extracted", evidence, "Response shape from approved SDK metadata, if supplied."),
      credentialAliases: fact([...(operation.credentialAliases ?? [])], "extracted", evidence, "Credential aliases only; values are forbidden."),
      idempotency: fact(operation.idempotency ?? "unknown", operation.idempotency ? "extracted" : "unknown", evidence, "Idempotency is accepted only when explicitly documented."),
      retryRequirement: policy.retryRequirement,
      reconciliationCandidates: fact([], consequence === "read" ? "inferred-proposal" : "unknown", evidence, "Independent reconciliation requires a separately confirmed observation path."),
      requestedByWorkflow: workflowMatch(workflow, operation.name, target),
      writeAuthorized: policy.writeAuthorized,
      executable: policy.executable,
    });
  }
}

function validateInput(input: AdapterDiscoveryInput): void {
  if (input.schemaVersion !== ADAPTER_DISCOVERY_SCHEMA_VERSION) throw new Error("Unsupported adapter-discovery schema version.");
  requireIdentifier(input.workflow.workflowId, "Workflow ID");
  if (!input.workflow.customerConfirmed) throw new Error("The bounded workflow must be explicitly customer-confirmed before discovery.");
  if (!input.workflow.summary.trim() || !input.workflow.requiredOutcome.trim()) throw new Error("Workflow summary and required outcome are required.");
  if (input.materials.length === 0) throw new Error("At least one approved local material is required.");
  const materialIds = new Set<string>();
  for (const material of input.materials) {
    requireIdentifier(material.materialId, "Material ID");
    if (materialIds.has(material.materialId)) throw new Error(`Duplicate material ID: ${material.materialId}.`);
    materialIds.add(material.materialId);
    if (material.approved !== true || !material.localReference.trim()) throw new Error(`Material ${material.materialId} is not approved local material.`);
  }
  for (const alias of input.workflow.approvedTargetAliases) requireIdentifier(alias, "Approved target alias");
  for (const name of input.workflow.requestedOperationNames) requireIdentifier(name, "Requested operation name");
  assertNoCredentialValues(input, "Adapter discovery input");
}

function buildBlockers(workflow: BoundedWorkflowDescription, extraction: MutableExtraction): AdapterDiscoveryBlocker[] {
  const blockers: AdapterDiscoveryBlocker[] = [];
  const requested = extraction.operations.filter((operation) => operation.requestedByWorkflow.value);
  if (requested.length === 0) blockers.push({ blockerId: "operation-selection", category: "operation", blocking: true, fact: fact("No extracted operation exactly matches the confirmed workflow request.", "unknown", [workflowSource(workflow, "/requestedOperationNames")], "An engineer must resolve the operation mapping.") });
  if (requested.some((operation) => operation.consequence.value === "unknown")) blockers.push({ blockerId: "unknown-side-effects", category: "operation", blocking: true, fact: fact("At least one requested operation has unknown side effects.", "unknown", requested.flatMap((item) => item.consequence.evidence), "Execution cannot proceed until side effects are explicitly classified.") });
  if (requested.some((operation) => operation.consequence.value === "write")) {
    blockers.push({ blockerId: "authority-unconfigured", category: "authority", blocking: true, fact: fact("Write authority has not been configured or confirmed.", "unknown", [policySource("/proposal-only")], "Discovery never grants authority.") });
  }
  const requestedCredentialAliases = unique(requested.flatMap((operation) => operation.credentialAliases.value));
  if (requestedCredentialAliases.length > 0) {
    blockers.push({
      blockerId: "credential-alias-unbound",
      category: "credential",
      blocking: true,
      fact: fact(
        `Customer-local values are not bound for aliases: ${requestedCredentialAliases.join(", ")}.`,
        "unknown",
        requested.flatMap((operation) => operation.credentialAliases.evidence),
        "Discovery may identify aliases but never receives or binds credential values.",
      ),
    });
  }
  const requestedWrites = requested.filter((operation) => operation.consequence.value === "write");
  if (requestedWrites.length > 0) {
    const missingCandidate = requestedWrites.some((operation) => operation.reconciliationCandidates.value.length === 0);
    blockers.push({
      blockerId: "reconciliation-unproven",
      category: "reconciliation",
      blocking: true,
      fact: fact(
        missingCandidate
          ? "A requested write lacks a candidate independent observation operation."
          : "Read operations were found on the same target, but none is yet proven to observe the requested write's external business effect independently.",
        "unknown",
        requestedWrites.flatMap((item) => item.operationId.evidence),
        "A candidate read operation is not a verifier. An engineer must bind and prove the independent observation path before retry can be safe.",
      ),
    });
  }
  blockers.push({ blockerId: "verifier-unconfigured", category: "verifier", blocking: true, fact: fact("No independent external-outcome verifier is configured.", "unknown", [workflowSource(workflow, "/requiredOutcome")], "The action response cannot serve as completion proof.") });
  blockers.push({ blockerId: "acceptance-not-run", category: "source", blocking: true, fact: fact("No executable acceptance campaign has run for this proposal.", "unknown", [policySource("/proposal-only")], "Declared or generated test cases are not passing evidence.") });
  return blockers;
}

/**
 * Deterministically discovers a fail-closed adapter proposal from approved local
 * metadata. The result is never executable and never carries write authority.
 */
export function discoverAdapterProposal(input: AdapterDiscoveryInput): AdapterDiscoveryProposal {
  validateInput(input);
  const extraction: MutableExtraction = { systems: [], targets: [], credentials: [], operations: [], unknowns: [] };
  for (const material of input.materials) {
    if (material.kind === "openapi") extractOpenApi(material, input.workflow, extraction);
    else if (material.kind === "mcp") extractMcp(material, input.workflow, extraction);
    else extractSdk(material, input.workflow, extraction);
  }
  const duplicateOperation = extraction.operations.find((operation, index, all) => all.findIndex((candidate) => candidate.operationKey.value === operation.operationKey.value) !== index);
  if (duplicateOperation) throw new Error(`Operation key ${duplicateOperation.operationKey.value} is ambiguous within one target across approved materials.`);
  const ambiguousUnqualifiedNames = input.workflow.requestedOperationNames
    .filter((name) => !name.includes("."))
    .filter((name) => extraction.operations.filter((operation) => operation.operationId.value === name).length > 1);
  for (const name of ambiguousUnqualifiedNames) {
    for (const operation of extraction.operations.filter((candidate) => candidate.operationId.value === name)) {
      operation.requestedByWorkflow = fact(
        false,
        "unknown",
        [workflowSource(input.workflow, "/requestedOperationNames"), ...operation.operationKey.evidence],
        `Unqualified operation name ${name} matches multiple targets; use target.operation identity.`,
      );
    }
    extraction.unknowns.push(fact(
      `Requested operation ${name} is ambiguous across targets and requires a target-qualified name.`,
      "unknown",
      [workflowSource(input.workflow, "/requestedOperationNames")],
      "The factory does not guess which system owns an unqualified duplicate operation name.",
    ));
  }
  const requested = extraction.operations.filter((operation) => operation.requestedByWorkflow.value);
  const unknowns: Array<AdapterFact<string>> = [
    ...extraction.unknowns,
    fact("Customer-local credential values and secret-provider bindings remain unset.", "unknown", [policySource("/credential-values")], "Discovery records aliases only."),
    fact("External outcome observation and verifier implementation remain unset.", "unknown", [workflowSource(input.workflow, "/requiredOutcome")], "A required outcome is not itself an independent verifier."),
    fact("Rate limits, pagination, errors, timeouts, and production drift require engineer confirmation unless explicitly covered by approved material.", "unknown", input.materials.map((material) => source(material, "/")), "Metadata extraction cannot prove live operational behavior."),
  ];
  const proposal: AdapterDiscoveryProposal = {
    schemaVersion: ADAPTER_DISCOVERY_SCHEMA_VERSION,
    proposalState: "proposal-only",
    executable: false,
    writesAuthorized: false,
    systems: extraction.systems,
    targets: extraction.targets,
    credentialAliases: extraction.credentials,
    operations: extraction.operations,
    scopeWorkflow: {
      workflowId: fact(input.workflow.workflowId, "customer-confirmed", [workflowSource(input.workflow, "/workflowId")], "Bounded workflow identity supplied and confirmed by the customer/domain owner."),
      summary: fact(input.workflow.summary, "customer-confirmed", [workflowSource(input.workflow, "/summary")], "Confirmed bounded workflow summary."),
      requiredOutcome: fact(input.workflow.requiredOutcome, "customer-confirmed", [workflowSource(input.workflow, "/requiredOutcome")], "Confirmed intended business outcome; not yet a verifier."),
      targetAliases: fact([...input.workflow.approvedTargetAliases], "customer-confirmed", [workflowSource(input.workflow, "/approvedTargetAliases")], "Exact confirmed target allowlist."),
      operationIds: fact(requested.map((operation) => operation.operationKey.value), requested.length > 0 ? "inferred-proposal" : "unknown", requested.flatMap((operation) => operation.operationKey.evidence), "Target-qualified exact-name matches proposed for the bounded workflow; review remains mandatory."),
      authorityState: fact("unconfigured", "independently-verified", [policySource("/proposal-only")], "Authority is always configured outside discovery."),
      verifierState: fact("unconfigured", "independently-verified", [policySource("/proposal-only")], "A verifier must be separately implemented and accepted."),
    },
    unknowns,
    engineeringBlockers: buildBlockers(input.workflow, extraction),
  };
  assertAdapterDiscoveryProposalSafe(proposal);
  return proposal;
}

/** Defense-in-depth validation for serialization, storage, or later review. */
export function assertAdapterDiscoveryProposalSafe(proposal: AdapterDiscoveryProposal): void {
  if (proposal.schemaVersion !== ADAPTER_DISCOVERY_SCHEMA_VERSION) {
    throw new Error("Adapter discovery output has an unsupported schema version.");
  }
  if (proposal.proposalState !== "proposal-only" || proposal.executable !== false || proposal.writesAuthorized !== false) {
    throw new Error("Adapter discovery output must remain proposal-only, non-executable, and non-authorizing.");
  }
  if (proposal.operations.some((operation) => operation.writeAuthorized.value !== false || operation.executable.value !== false)) {
    throw new Error("No discovered operation may be executable or write-authorized.");
  }
  if (proposal.credentialAliases.some((credential) => credential.valuePresent !== false)) {
    throw new Error("Adapter discovery output may contain credential aliases only.");
  }
  if (proposal.operations.some((operation) => operation.consequence.value === "write" && operation.retryRequirement.value !== "reconcile-before-retry")) {
    throw new Error("Every proposed write must require reconciliation before retry.");
  }
  if (proposal.scopeWorkflow.authorityState.value !== "unconfigured" || proposal.scopeWorkflow.verifierState.value !== "unconfigured") {
    throw new Error("Discovery cannot configure authority or a verifier.");
  }
  assertNoCredentialValues(proposal, "Adapter discovery proposal");
}

export interface AdapterDiscoveryProvider {
  providerId: string;
  providerKind: "deterministic" | "model-backed";
  propose(
    input: AdapterDiscoveryInput,
    limits: { maximumSpendUsd: number },
  ): Promise<{
    proposal: AdapterDiscoveryProposal;
    billedSpendUsd: number;
    usage?: UsageRecord;
    providerResponseId?: string;
    usageEvidenceDigest?: string;
  }>;
}

export function adapterDiscoveryUsageEvidenceDigest(providerResponseId: string, usage: UsageRecord): string {
  return digest({ providerResponseId, usage });
}

export const DETERMINISTIC_ADAPTER_DISCOVERY_PROVIDER: AdapterDiscoveryProvider = {
  providerId: "deterministic-local-metadata-v1",
  providerKind: "deterministic",
  propose: async (input) => ({ proposal: discoverAdapterProposal(input), billedSpendUsd: 0 }),
};

interface FactAtPath { path: string; fact: AdapterFact<unknown> }

function proposalFacts(proposal: AdapterDiscoveryProposal): FactAtPath[] {
  if (!proposal || typeof proposal !== "object") throw new Error("Adapter discovery provider returned a non-object proposal.");
  for (const [key, value] of Object.entries({
    systems: proposal.systems,
    targets: proposal.targets,
    credentialAliases: proposal.credentialAliases,
    operations: proposal.operations,
    unknowns: proposal.unknowns,
    engineeringBlockers: proposal.engineeringBlockers,
  })) {
    if (!Array.isArray(value)) throw new Error(`Adapter discovery proposal field ${key} must be an array.`);
  }
  if (!proposal.scopeWorkflow || typeof proposal.scopeWorkflow !== "object") throw new Error("Adapter discovery proposal requires a scope/workflow descriptor.");
  const facts: FactAtPath[] = [];
  const add = (path: string, candidate: AdapterFact<unknown>) => facts.push({ path, fact: candidate });
  proposal.systems.forEach((item, index) => {
    add(`systems.${index}.systemId`, item.systemId); add(`systems.${index}.label`, item.label); add(`systems.${index}.materialKinds`, item.materialKinds);
  });
  proposal.targets.forEach((item, index) => {
    add(`targets.${index}.alias`, item.alias); add(`targets.${index}.systemId`, item.systemId); add(`targets.${index}.approvedForWorkflow`, item.approvedForWorkflow);
  });
  proposal.credentialAliases.forEach((item, index) => {
    add(`credentialAliases.${index}.alias`, item.alias); add(`credentialAliases.${index}.targetAlias`, item.targetAlias); add(`credentialAliases.${index}.scheme`, item.scheme);
  });
  proposal.operations.forEach((item, index) => {
    for (const key of [
      "operationId", "operationKey", "sourceKind", "targetAlias", "description", "transportAction", "consequence",
      "requestShape", "responseShape", "credentialAliases", "idempotency", "retryRequirement", "reconciliationCandidates",
      "requestedByWorkflow", "writeAuthorized", "executable",
    ] as const) add(`operations.${index}.${key}`, item[key]);
  });
  for (const key of ["workflowId", "summary", "requiredOutcome", "targetAliases", "operationIds", "authorityState", "verifierState"] as const) {
    add(`scopeWorkflow.${key}`, proposal.scopeWorkflow[key]);
  }
  proposal.unknowns.forEach((item, index) => add(`unknowns.${index}`, item));
  proposal.engineeringBlockers.forEach((item, index) => add(`engineeringBlockers.${index}.fact`, item.fact));
  return facts;
}

function assertFactShape(item: FactAtPath): void {
  const fact = item.fact;
  if (!fact || typeof fact !== "object") throw new Error(`Adapter proposal fact ${item.path} is missing.`);
  if (!ADAPTER_FACT_STATUSES.includes(fact.status)) throw new Error(`Adapter proposal fact ${item.path} has an invalid provenance status.`);
  if (typeof fact.explanation !== "string" || fact.explanation.trim().length === 0) throw new Error(`Adapter proposal fact ${item.path} requires an explanation.`);
  if (!Array.isArray(fact.evidence) || fact.evidence.length === 0) throw new Error(`Adapter proposal fact ${item.path} requires evidence.`);
  for (const evidence of fact.evidence) {
    if (!evidence || typeof evidence !== "object" || typeof evidence.materialId !== "string" || typeof evidence.pointer !== "string"
      || !/^[a-f0-9]{64}$/.test(evidence.sha256)) {
      throw new Error(`Adapter proposal fact ${item.path} has malformed evidence.`);
    }
  }
}

function assertProviderEpistemicBoundary(candidate: AdapterDiscoveryProposal, baseline: AdapterDiscoveryProposal): void {
  const trustedStatuses = new Set<AdapterFactStatus>(["observed", "extracted", "customer-confirmed", "independently-verified"]);
  const baselineFacts = new Map(proposalFacts(baseline).map((item) => [item.path, stableJson(item.fact)]));
  const candidateFacts = new Map(proposalFacts(candidate).map((item) => [item.path, stableJson(item.fact)]));
  for (const [path, serialized] of baselineFacts) {
    const status = proposalFacts(baseline).find((item) => item.path === path)?.fact.status;
    if (status && trustedStatuses.has(status) && candidateFacts.get(path) !== serialized) {
      throw new Error(`Adapter discovery provider cannot remove or alter trusted baseline fact ${path}.`);
    }
  }
  for (const item of proposalFacts(candidate)) {
    if (trustedStatuses.has(item.fact.status) && baselineFacts.get(item.path) !== stableJson(item.fact)) {
      throw new Error(`Adapter discovery provider cannot create or alter trusted fact ${item.path}; only inferred-proposal or unknown facts may differ.`);
    }
  }
  const candidateBlockers = new Map(candidate.engineeringBlockers.map((item) => [item.blockerId, stableJson(item)]));
  for (const blocker of baseline.engineeringBlockers) {
    if (candidateBlockers.get(blocker.blockerId) !== stableJson(blocker)) {
      throw new Error(`Adapter discovery provider cannot remove or alter mandatory baseline blocker ${blocker.blockerId}.`);
    }
  }
}

function assertEvidenceAnchoredToInput(proposal: AdapterDiscoveryProposal, input: AdapterDiscoveryInput): void {
  const allowedDigests = new Map<string, string>();
  for (const material of input.materials) {
    allowedDigests.set(`${material.kind}\u0000${material.materialId}`, digest(material));
  }
  allowedDigests.set(`workflow\u0000workflow:${input.workflow.workflowId}`, digest(input.workflow));
  allowedDigests.set(
    "factory-policy\u0000capability-factory:adapter-discovery-policy",
    digest(ADAPTER_DISCOVERY_SCHEMA_VERSION),
  );

  for (const item of proposalFacts(proposal)) {
    for (const evidence of item.fact.evidence) {
      const expectedDigest = allowedDigests.get(`${evidence.materialKind}\u0000${evidence.materialId}`);
      if (!expectedDigest) {
        throw new Error(`Adapter proposal fact ${item.path} cites evidence outside the approved discovery input.`);
      }
      if (evidence.sha256 !== expectedDigest) {
        throw new Error(`Adapter proposal fact ${item.path} cites an evidence digest that does not match the approved discovery input.`);
      }
    }
  }
}

export interface AdapterDiscoveryProviderRunOptions {
  /** Model-backed execution is disabled unless a caller makes this explicit. */
  allowModelBacked?: boolean;
  /** Accounting ceiling passed by the caller; this seam itself performs no paid calls. */
  maximumProviderSpendUsd?: number;
  /** Required durable ledger for every model-backed provider invocation. */
  accounting?: BudgetTracker;
  /** Stable reviewed attempt identity; retries must use a distinct identity. */
  accountingAttemptKey?: string;
}

/**
 * Single fail-closed seam for deterministic or future model-backed providers.
 * The provider can propose only; trusted code revalidates the non-executable,
 * non-authorizing boundary before any caller may store or display the result.
 */
export async function runAdapterDiscoveryProvider(
  provider: AdapterDiscoveryProvider,
  input: AdapterDiscoveryInput,
  options: AdapterDiscoveryProviderRunOptions = {},
): Promise<AdapterDiscoveryProposal> {
  validateInput(input);
  if (provider.providerKind === "model-backed" && options.allowModelBacked !== true) {
    throw new Error("Model-backed adapter discovery is disabled until explicitly authorized.");
  }
  if (provider.providerKind === "model-backed"
    && (!Number.isFinite(options.maximumProviderSpendUsd) || Number(options.maximumProviderSpendUsd) <= 0)) {
    throw new Error("Model-backed adapter discovery requires an explicit positive spend ceiling.");
  }
  if (provider.providerKind === "model-backed" && (!options.accounting || !options.accountingAttemptKey)) {
    throw new Error("Model-backed adapter discovery requires durable pre-call accounting and a stable attempt key.");
  }
  const baseline = discoverAdapterProposal(input);
  const maximumSpendUsd = provider.providerKind === "model-backed" ? Number(options.maximumProviderSpendUsd) : 0;
  const requestDigest = digest({ providerId: provider.providerId, input, maximumSpendUsd });
  const reservation = provider.providerKind === "model-backed"
    ? options.accounting!.reserveModelCall({ seamId: `adapter.discovery.${provider.providerId}`, attemptKey: options.accountingAttemptKey!, requestDigest, projectedUsd: maximumSpendUsd, runSpentUsd: 0 })
    : undefined;
  let result: Awaited<ReturnType<AdapterDiscoveryProvider["propose"]>>;
  try {
    if (reservation) options.accounting!.markModelCallDispatched(reservation.reservationId);
    result = await provider.propose(structuredClone(input), { maximumSpendUsd });
  } catch (error) {
    if (reservation) {
      try { options.accounting!.markModelCallAmbiguous(reservation.reservationId, "Adapter-discovery provider failed without trusted usage settlement."); } catch { /* dispatched remains unresolved */ }
    }
    throw error;
  }
  if (!result || typeof result !== "object" || !Number.isFinite(result.billedSpendUsd) || result.billedSpendUsd < 0) {
    if (reservation) options.accounting!.markModelCallAmbiguous(reservation.reservationId, "Adapter-discovery provider returned invalid spend accounting.");
    throw new Error("Adapter discovery provider returned invalid spend accounting.");
  }
  if (result.billedSpendUsd > maximumSpendUsd) {
    if (reservation) options.accounting!.markModelCallAmbiguous(reservation.reservationId, "Adapter-discovery provider reported spend beyond the reserved ceiling.");
    throw new Error("Adapter discovery provider exceeded the caller's hard spend ceiling.");
  }
  if (reservation) {
    if (!result.usage || !result.providerResponseId || !result.usageEvidenceDigest || result.usageEvidenceDigest !== adapterDiscoveryUsageEvidenceDigest(result.providerResponseId, result.usage)) {
      options.accounting!.markModelCallAmbiguous(reservation.reservationId, "Adapter-discovery provider did not return integrity-bound usage evidence.");
      throw new Error("Model-backed adapter discovery returned no integrity-bound usage evidence; the call is ambiguous and cannot retry.");
    }
    const calculatedSpendUsd = estimateGpt56SolCost(result.usage);
    if (Math.abs(calculatedSpendUsd - result.billedSpendUsd) > 1e-12) {
      options.accounting!.markModelCallAmbiguous(reservation.reservationId, "Adapter-discovery billed spend disagrees with trusted token accounting.");
      throw new Error("Model-backed adapter discovery billed spend does not match its token usage.");
    }
    const settled = options.accounting!.settleModelCall(reservation.reservationId, result.usage, result.providerResponseId, result.usageEvidenceDigest);
    if (settled.overrun) throw new Error("Model-backed adapter discovery settled beyond a frozen budget ceiling.");
  }
  const proposal = result.proposal;
  for (const item of proposalFacts(proposal)) assertFactShape(item);
  assertAdapterDiscoveryProposalSafe(proposal);
  assertEvidenceAnchoredToInput(proposal, input);
  // Every provider is proposal-only. A locally labelled deterministic provider
  // must not be able to delete the same trusted facts or mandatory blockers that
  // a model-backed provider is forbidden to delete.
  assertProviderEpistemicBoundary(proposal, baseline);
  return structuredClone(proposal);
}
