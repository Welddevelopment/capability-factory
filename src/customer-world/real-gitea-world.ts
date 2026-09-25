import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CapabilityManifest, JsonValue } from "../manifest.js";
import { capabilityManifestSchema } from "../manifest.js";
import type { RuntimeConfiguration } from "../runtime.js";
import { CapabilityRuntime } from "../runtime.js";
import type { ActionReceipt } from "../product/contracts.js";
import type { DirectVerificationResult, DocumentationBundle, VerificationIssue } from "./contract.js";

const ADMIN_USERNAME = "cf-admin";
const ADMIN_PASSWORD = "local-fixture-only-change-before-any-nonlocal-use";
const REPOSITORY = "cf-incident-intake";
const FULL_ALIAS = "GITEA_ISSUES_WRITE_TOKEN";
const READ_ALIAS = "GITEA_ISSUES_READ_TOKEN";
const FULL_TOKEN_NAME = "cf-reliability-write";
const READ_TOKEN_NAME = "cf-reliability-read";

export const GITEA_ACCEPTANCE_CASE_IDS = [
  "already-satisfied",
  "approved-write",
  "fresh-process-reuse",
  "missing-credential",
  "missing-permission",
  "lost-response-reconciliation",
  "wrong-or-partial-outcome",
  "sidecar-restart",
  "duplicate-submission",
  "conflicting-parent-reuse",
] as const;

export type GiteaAcceptanceCaseId = (typeof GITEA_ACCEPTANCE_CASE_IDS)[number];
export type GiteaCredentialProfile = "full" | "read-only" | "missing";

interface GiteaCredentials {
  fullToken: string;
  readToken: string;
}

interface GiteaIssue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  labels: Array<{ id: number; name: string }>;
}

interface GiteaLabel {
  id: number;
  name: string;
}

export interface GiteaCaseState {
  caseId: GiteaAcceptanceCaseId;
  incidentId: string;
  title: string;
  body: string;
  labelId: number;
  credentialProfile: GiteaCredentialProfile;
  expectsIssue: boolean;
}

export interface GiteaResetOptions {
  seedInitialState?: boolean;
}

export interface GiteaWorldOptions {
  repositoryRoot: string;
  baseUrl?: string;
  composeDirectory?: string;
  dockerBinary?: string;
  dockerConfigDirectory?: string;
  artifactDirectory?: string;
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

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function property(type: "string" | "integer", description: string) {
  return { type, description } as const;
}

function documentationBundle(): DocumentationBundle {
  const content: Record<string, JsonValue> = {
    openapi: "3.0.0",
    info: {
      title: "Gitea issue intake API",
      version: "1.27.0",
      description: "Bounded issue-list and issue-create operations for one approved repository.",
    },
    servers: [{ url: "BASE_URL_ALIAS:customer_system" }],
    security: [{ tokenAuthentication: [] }],
    components: {
      securitySchemes: {
        tokenAuthentication: {
          type: "apiKey",
          in: "header",
          name: "Authorization",
          description: "Trusted runtime supplies Authorization: token <personal-access-token> by alias.",
        },
      },
    },
    paths: {
      "/api/v1/repos/{owner}/{repo}/issues": {
        get: {
          operationId: "listRepositoryIssues",
          parameters: [
            { name: "owner", in: "path", required: true, schema: { type: "string" } },
            { name: "repo", in: "path", required: true, schema: { type: "string" } },
            { name: "state", in: "query", schema: { type: "string", enum: ["all"] } },
            { name: "limit", in: "query", schema: { type: "integer", maximum: 50 } },
          ],
          responses: { "200": { description: "Repository issue list." } },
        },
        post: {
          operationId: "createRepositoryIssue",
          parameters: [
            { name: "owner", in: "path", required: true, schema: { type: "string" } },
            { name: "repo", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["title", "body", "labels"],
                  properties: {
                    title: { type: "string" },
                    body: { type: "string" },
                    labels: { type: "array", minItems: 1, maxItems: 1, items: { type: "integer" } },
                  },
                },
              },
            },
          },
          responses: {
            "201": { description: "Issue created." },
            "403": { description: "Token or repository permission denied." },
          },
        },
      },
    },
  };
  return { mediaType: "application/json", content, sha256: digest(content) };
}

export function createGiteaReferenceCapability(
  documentation: DocumentationBundle,
  secretAlias = FULL_ALIAS,
): CapabilityManifest {
  return capabilityManifestSchema.parse({
    schemaVersion: "1",
    id: "gitea-issue-intake",
    version: "1.0.0",
    service: "Gitea 1.27 issue API",
    description: "List bounded repository issues, reconcile by incident marker, and create one labelled issue.",
    baseUrlAlias: "customer_system",
    auth: { kind: "apiKey", secretAlias, headerName: "Authorization" },
    actions: [
      {
        name: "list_issues",
        description: "List all issues in the exact approved repository before deciding whether to write.",
        inputSchema: {
          type: "object",
          properties: {
            owner: property("string", "Exact approved repository owner"),
            repo: property("string", "Exact approved repository name"),
          },
          required: ["owner", "repo"],
          additionalProperties: false,
        },
        request: {
          method: "GET",
          pathTemplate: "/api/v1/repos/{{input.owner}}/{{input.repo}}/issues",
          queryTemplate: { state: "all", type: "issues", limit: 50 },
          headerTemplate: {},
          bodyTemplate: null,
        },
        response: { acceptedStatuses: [200], outputPointers: { firstIssue: "/0" } },
        safety: { idempotency: "none", timeoutMs: 5_000, maxResponseBytes: 500_000 },
      },
      {
        name: "create_issue",
        description: "Create one exact incident issue after list-based reconciliation found no matching marker.",
        inputSchema: {
          type: "object",
          properties: {
            owner: property("string", "Exact approved repository owner"),
            repo: property("string", "Exact approved repository name"),
            title: property("string", "Exact trusted incident title"),
            body: property("string", "Exact trusted incident body containing its unique marker"),
            labelId: property("integer", "Exact trusted incident label ID"),
          },
          required: ["owner", "repo", "title", "body", "labelId"],
          additionalProperties: false,
        },
        request: {
          method: "POST",
          pathTemplate: "/api/v1/repos/{{input.owner}}/{{input.repo}}/issues",
          queryTemplate: {},
          headerTemplate: {},
          bodyTemplate: {
            title: "{{input.title}}",
            body: "{{input.body}}",
            labels: ["{{input.labelId}}"],
          },
        },
        response: { acceptedStatuses: [201], outputPointers: { issueNumber: "/number", issueId: "/id" } },
        safety: { idempotency: "required", timeoutMs: 5_000, maxResponseBytes: 500_000 },
      },
    ],
    provenance: {
      documentationHash: documentation.sha256,
      model: "trusted-local-reference",
      createdAt: "2026-07-27T00:00:00.000Z",
    },
  });
}

function basicAuthorization(): string {
  return `Basic ${Buffer.from(`${ADMIN_USERNAME}:${ADMIN_PASSWORD}`).toString("base64")}`;
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function api(
  baseUrl: string,
  route: string,
  options: { method?: string; body?: unknown; authorization?: string; accepted?: number[] } = {},
): Promise<unknown> {
  const response = await fetch(new URL(route, baseUrl), {
    method: options.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(options.authorization ? { authorization: options.authorization } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const body = await responseJson(response);
  const accepted = options.accepted ?? [200];
  if (!accepted.includes(response.status)) {
    throw new Error(`Gitea ${options.method ?? "GET"} ${route} returned HTTP ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
  }
  return body;
}

function incidentFor(caseId: GiteaAcceptanceCaseId): Omit<GiteaCaseState, "labelId"> {
  const ordinal = String(GITEA_ACCEPTANCE_CASE_IDS.indexOf(caseId) + 1).padStart(2, "0");
  const incidentId = `INC-CF-${ordinal}`;
  const credentialProfile: GiteaCredentialProfile = caseId === "missing-credential"
    ? "missing"
    : caseId === "missing-permission"
      ? "read-only"
      : "full";
  return {
    caseId,
    incidentId,
    title: `[${incidentId}] Checkout failures exceed threshold`,
    body: `[CF-INCIDENT:${incidentId}]\n\nSynthetic checkout failures require investigation in the disposable local system.`,
    credentialProfile,
    expectsIssue: !["missing-credential", "missing-permission", "wrong-or-partial-outcome"].includes(caseId),
  };
}

export class RealGiteaWorld {
  readonly id = "gitea-real-issue-development-world";
  readonly adapterKind = "Genuine local Gitea 1.27.0 disposable application";
  readonly documentation = documentationBundle();
  readonly baseUrl: string;
  readonly owner = ADMIN_USERNAME;
  readonly repository = REPOSITORY;
  private activeCase: GiteaCaseState | null = null;

  constructor(
    private readonly credentials: GiteaCredentials,
    options: GiteaWorldOptions,
  ) {
    this.baseUrl = options.baseUrl ?? "http://127.0.0.1:3100";
  }

  secretAlias(profile: GiteaCredentialProfile): string {
    if (profile === "full") return FULL_ALIAS;
    if (profile === "read-only") return READ_ALIAS;
    return "GITEA_MISSING_TOKEN";
  }

  /** Disposable localhost-only credentials for the genuine browser experiment. */
  browserSessionCredentials(): { username: string; password: string } {
    return { username: ADMIN_USERNAME, password: ADMIN_PASSWORD };
  }

  async verifyBrowserIssue(expected: { marker: string; title: string; body: string }): Promise<{
    passed: boolean;
    intendedWrites: number;
    incorrectSideEffects: number;
    stateHash: string;
    detail: string;
  }> {
    const issues = await this.listIssuesDirect();
    const normalizeBrowserText = (value: string) => value.replaceAll("\r\n", "\n");
    const matching = issues.filter((issue) => normalizeBrowserText(issue.body).includes(expected.marker));
    const exact = matching.filter(
      (issue) => issue.title === expected.title && normalizeBrowserText(issue.body) === normalizeBrowserText(expected.body),
    );
    const baseline = issues.filter(
      (issue) => issue.title === "Unrelated baseline issue" && issue.body === "Must remain unchanged by every case.",
    );
    const incorrectSideEffects = Math.max(0, matching.length - exact.length)
      + Math.max(0, exact.length - 1)
      + (baseline.length === 1 ? 0 : 1);
    const passed = exact.length === 1 && matching.length === 1 && baseline.length === 1 && incorrectSideEffects === 0;
    return {
      passed,
      intendedWrites: exact.length,
      incorrectSideEffects,
      stateHash: await this.stateHash(),
      detail: passed
        ? "The genuine Gitea API independently confirmed exactly one matching issue and an unchanged baseline."
        : `Gitea browser verification found ${exact.length} exact, ${matching.length} marker-matching, and ${baseline.length} baseline issues.`,
    };
  }

  currentCaseState(): GiteaCaseState {
    if (!this.activeCase) throw new Error("No Gitea acceptance case is active.");
    return structuredClone(this.activeCase);
  }

  runtimeConfiguration(profile: GiteaCredentialProfile): RuntimeConfiguration {
    const alias = this.secretAlias(profile);
    const secrets = profile === "full"
      ? { [alias]: `token ${this.credentials.fullToken}` }
      : profile === "read-only"
        ? { [alias]: `token ${this.credentials.readToken}` }
        : {};
    return {
      targets: {
        customer_system: {
          baseUrl: this.baseUrl,
          allowedPaths: ["/api/v1/repos/:owner/:repo/issues"],
          allowedMethods: {
            GET: ["/api/v1/repos/:owner/:repo/issues"],
            POST: ["/api/v1/repos/:owner/:repo/issues"],
          },
        },
      },
      secrets,
    };
  }

  async reset(caseId: GiteaAcceptanceCaseId, options: GiteaResetOptions = {}): Promise<GiteaCaseState> {
    if (!GITEA_ACCEPTANCE_CASE_IDS.includes(caseId)) throw new Error(`Unknown Gitea case: ${caseId}`);
    const auth = basicAuthorization();
    await api(this.baseUrl, `/api/v1/repos/${ADMIN_USERNAME}/${REPOSITORY}`, {
      method: "DELETE",
      authorization: auth,
      accepted: [204, 404],
    });
    await api(this.baseUrl, "/api/v1/user/repos", {
      method: "POST",
      authorization: auth,
      accepted: [201],
      body: { name: REPOSITORY, private: true, auto_init: true, description: "Disposable fictional incident intake." },
    });
    const label = await api(this.baseUrl, `/api/v1/repos/${ADMIN_USERNAME}/${REPOSITORY}/labels`, {
      method: "POST",
      authorization: auth,
      accepted: [201],
      body: { name: "cf-incident", color: "D73A4A", description: "Synthetic reliability incident." },
    }) as GiteaLabel;
    await api(this.baseUrl, `/api/v1/repos/${ADMIN_USERNAME}/${REPOSITORY}/issues`, {
      method: "POST",
      authorization: auth,
      accepted: [201],
      body: { title: "Unrelated baseline issue", body: "Must remain unchanged by every case.", labels: [] },
    });
    const state = { ...incidentFor(caseId), labelId: label.id };
    const seedInitialState = options.seedInitialState ?? true;
    if (caseId === "already-satisfied" && seedInitialState) {
      await this.createIssueDirect(state.title, state.body, state.labelId);
    } else if (caseId === "wrong-or-partial-outcome" && seedInitialState) {
      await this.createIssueDirect(`${state.title} WRONG`, state.body, state.labelId);
    }
    this.activeCase = state;
    return structuredClone(state);
  }

  async listIssuesDirect(): Promise<GiteaIssue[]> {
    return api(
      this.baseUrl,
      `/api/v1/repos/${ADMIN_USERNAME}/${REPOSITORY}/issues?state=all&type=issues&limit=50`,
      { authorization: basicAuthorization() },
    ) as Promise<GiteaIssue[]>;
  }

  async createIssueDirect(title: string, body: string, labelId: number): Promise<GiteaIssue> {
    return api(this.baseUrl, `/api/v1/repos/${ADMIN_USERNAME}/${REPOSITORY}/issues`, {
      method: "POST",
      authorization: basicAuthorization(),
      accepted: [201],
      body: { title, body, labels: [labelId] },
    }) as Promise<GiteaIssue>;
  }

  async verify(caseId: GiteaAcceptanceCaseId): Promise<DirectVerificationResult> {
    if (!this.activeCase || this.activeCase.caseId !== caseId) {
      throw new Error(`Gitea case ${caseId} is not active; reset it first.`);
    }
    const state = this.activeCase;
    const issues = await this.listIssuesDirect();
    const marker = `[CF-INCIDENT:${state.incidentId}]`;
    const matchingMarker = issues.filter((issue) => issue.body.includes(marker));
    const exact = matchingMarker.filter(
      (issue) => issue.title === state.title
        && issue.body === state.body
        && issue.labels.some((label) => label.id === state.labelId),
    );
    const baseline = issues.filter(
      (issue) => issue.title === "Unrelated baseline issue" && issue.body === "Must remain unchanged by every case.",
    );
    const issuesFound: VerificationIssue[] = [];
    if (state.expectsIssue && exact.length === 0) {
      issuesFound.push({ code: "missing-write", message: "The exact required incident issue is missing." });
    }
    if (!state.expectsIssue && exact.length > 0) {
      issuesFound.push({ code: "forbidden-write", message: "An incident issue was created when the case required no action." });
    }
    if (matchingMarker.length > Math.max(state.expectsIssue ? 1 : 0, exact.length)) {
      issuesFound.push({ code: "wrong-record", message: "The incident marker exists on an incorrect issue." });
    }
    if (exact.length > 1) {
      issuesFound.push({ code: "duplicate-write", message: "More than one exact incident issue exists." });
    }
    if (baseline.length !== 1) {
      issuesFound.push({ code: "collateral-write", message: "The unrelated baseline issue changed or disappeared." });
    }
    const intendedWrites = exact.length;
    const incorrectSideEffects = issuesFound.filter((issue) => issue.code !== "missing-write").length;
    const normalized = issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((label) => label.name).sort(),
    })).sort((left, right) => left.number - right.number);
    return {
      caseId,
      passed: issuesFound.length === 0,
      intendedWrites,
      incorrectSideEffects,
      stateHash: digest(normalized),
      issues: issuesFound,
    };
  }

  async stateHash(): Promise<string> {
    const issues = await this.listIssuesDirect();
    return digest(issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((label) => label.name).sort(),
    })));
  }
}

function action(manifest: CapabilityManifest, name: string) {
  const found = manifest.actions.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Gitea capability is missing ${name}.`);
  return found;
}

function exactInputReference(value: JsonValue | undefined, location: string): string {
  if (typeof value !== "string") {
    throw new Error(`Gitea capability ${location} must reference one runtime input.`);
  }
  const match = value.match(/^\{\{input\.([a-zA-Z][a-zA-Z0-9_]*)\}\}$/);
  if (!match?.[1]) {
    throw new Error(`Gitea capability ${location} must be an exact runtime input reference.`);
  }
  return match[1];
}

function bindInput(inputs: Record<string, JsonValue>, name: string, value: JsonValue): void {
  if (name in inputs && inputs[name] !== value) {
    throw new Error(`Gitea capability input ${name} is ambiguously mapped to multiple values.`);
  }
  inputs[name] = value;
}

/**
 * Bind trusted workflow values through the candidate's declared translation.
 * The workflow owns the meaning (owner, repository, title, body, label), while
 * the generated manifest is free to choose internal input names such as
 * `label` or `labelId`. The genuine-system probe must test the translation, not
 * accidentally require the reference manifest's private naming convention.
 */
function giteaActionInputs(
  candidate: CapabilityManifest["actions"][number],
  state?: GiteaCaseState,
): Record<string, JsonValue> {
  const inputs: Record<string, JsonValue> = {};
  const pathReferences = [...candidate.request.pathTemplate.matchAll(/\{\{input\.([a-zA-Z][a-zA-Z0-9_]*)\}\}/g)]
    .map((match) => match[1]!)
    .filter((name, index, all) => all.indexOf(name) === index);
  if (pathReferences.length !== 2) {
    throw new Error("Gitea capability path must expose exactly the repository owner and repository name as inputs.");
  }
  bindInput(inputs, pathReferences[0]!, ADMIN_USERNAME);
  bindInput(inputs, pathReferences[1]!, REPOSITORY);

  if (state) {
    const body = candidate.request.bodyTemplate;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("Gitea create action must declare an object request body.");
    }
    bindInput(inputs, exactInputReference(body.title, "body.title"), state.title);
    bindInput(inputs, exactInputReference(body.body, "body.body"), state.body);
    if (!Array.isArray(body.labels) || body.labels.length !== 1) {
      throw new Error("Gitea create action must declare exactly one label input.");
    }
    bindInput(inputs, exactInputReference(body.labels[0], "body.labels[0]"), state.labelId);
  }

  return inputs;
}

export async function executeReconciledGiteaIssue(
  manifest: CapabilityManifest,
  runtime: CapabilityRuntime,
  state: GiteaCaseState,
  runId: string,
): Promise<ActionReceipt[]> {
  const listAction = action(manifest, "list_issues");
  const listed = await runtime.execute(
    manifest,
    listAction.name,
    giteaActionInputs(listAction),
    { runId },
  );
  const receipts: ActionReceipt[] = [{ action: listAction.name, status: listed.status, output: listed.output }];
  if (!Array.isArray(listed.raw)) throw new Error("Gitea issue list did not return an array.");
  const marker = `[CF-INCIDENT:${state.incidentId}]`;
  const matches = (listed.raw as GiteaIssue[]).filter((issue) => issue.body.includes(marker));
  if (matches.length > 1) throw new Error(`Gitea reconciliation found duplicate incident markers for ${state.incidentId}.`);
  if (matches.length === 1) {
    const existing = matches[0]!;
    if (
      existing.title !== state.title
      || existing.body !== state.body
      || !existing.labels.some((label) => label.id === state.labelId)
    ) {
      throw new Error(`Gitea reconciliation found an incorrect partial issue for ${state.incidentId}.`);
    }
    return receipts;
  }
  const createAction = action(manifest, "create_issue");
  const created = await runtime.execute(
    manifest,
    createAction.name,
    giteaActionInputs(createAction, state),
    { runId },
  );
  receipts.push({ action: createAction.name, status: created.status, output: created.output });
  return receipts;
}

function dockerEnvironment(options: GiteaWorldOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DOCKER_CONFIG: options.dockerConfigDirectory
      ?? process.env.CF_DOCKER_CONFIG
      ?? path.join(options.repositoryRoot, ".local-tools", "docker-config"),
  };
}

function ensureAdmin(options: GiteaWorldOptions): void {
  const docker = options.dockerBinary
    ?? process.env.CF_DOCKER_BIN
    ?? path.join(options.repositoryRoot, ".local-tools", "bin", "docker");
  const composeDirectory = options.composeDirectory
    ?? process.env.CF_GITEA_COMPOSE_DIR
    ?? path.join(options.repositoryRoot, "fixtures", "gitea");
  const common = ["compose", "-p", "capability-factory-gitea", "-f", "compose.yml", "exec", "-T", "-u", "git", "server", "gitea", "admin", "user"];
  try {
    execFileSync(docker, [
      ...common,
      "create",
      "--username", ADMIN_USERNAME,
      "--password", ADMIN_PASSWORD,
      "--email", "cf-admin@invalid.local",
      "--admin",
      "--must-change-password=false",
    ], { cwd: composeDirectory, env: dockerEnvironment(options), stdio: "pipe" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists|already taken|exists/i.test(message)) throw error;
  }
  execFileSync(docker, [
    ...common,
    "change-password",
    "--username", ADMIN_USERNAME,
    "--password", ADMIN_PASSWORD,
  ], { cwd: composeDirectory, env: dockerEnvironment(options), stdio: "pipe" });
  execFileSync(docker, [
    ...common,
    "must-change-password",
    "--all",
    "--unset",
  ], { cwd: composeDirectory, env: dockerEnvironment(options), stdio: "pipe" });
}

async function createToken(baseUrl: string, name: string, scopes: string[]): Promise<string> {
  const encodedName = encodeURIComponent(name);
  await api(baseUrl, `/api/v1/users/${ADMIN_USERNAME}/tokens/${encodedName}`, {
    method: "DELETE",
    authorization: basicAuthorization(),
    accepted: [204, 404],
  });
  const created = await api(baseUrl, `/api/v1/users/${ADMIN_USERNAME}/tokens`, {
    method: "POST",
    authorization: basicAuthorization(),
    accepted: [201],
    body: { name, scopes },
  }) as { sha1?: string };
  if (!created.sha1) throw new Error(`Gitea did not return token material for ${name}.`);
  return created.sha1;
}

export async function startRealGiteaWorld(options: GiteaWorldOptions): Promise<RealGiteaWorld> {
  const baseUrl = options.baseUrl ?? "http://127.0.0.1:3100";
  const version = await api(baseUrl, "/api/v1/version") as { version?: string };
  if (version.version !== "1.27.0") throw new Error(`Expected Gitea 1.27.0, received ${version.version ?? "unknown"}.`);
  ensureAdmin(options);
  const credentials: GiteaCredentials = {
    fullToken: await createToken(baseUrl, FULL_TOKEN_NAME, ["write:issue", "read:repository"]),
    readToken: await createToken(baseUrl, READ_TOKEN_NAME, ["read:issue", "read:repository"]),
  };
  const artifactDirectory = path.resolve(
    options.artifactDirectory ?? path.join(options.repositoryRoot, "artifacts", "gitea-local"),
  );
  fs.mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(artifactDirectory, "credentials.json"), `${JSON.stringify(credentials, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return new RealGiteaWorld(credentials, { ...options, baseUrl });
}
