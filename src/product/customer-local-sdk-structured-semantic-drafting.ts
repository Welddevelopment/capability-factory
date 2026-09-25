import { DatabaseSync } from "node:sqlite";
import { compileSdkSemanticContract, type ConfirmedFact, type SdkSemanticContract } from "./customer-local-sdk-semantic-compiler.js";
import {
  assertApprovedStructuredSdkSchemaIndex,
  compileStructuredSdkSemanticContract,
  structuredSdkDigest,
  type ApprovedStructuredSdkSchemaIndex,
  type BoundedSdkValueSchema,
  type StructuredSdkSemanticContract,
  type StructuredValueExpression,
} from "./customer-local-sdk-structured-semantic-compiler.js";
import type { SdkImplementationWorkPack } from "./customer-local-sdk-work-pack.js";

export const CUSTOMER_LOCAL_SDK_STRUCTURED_SEMANTIC_DRAFTING_VERSION = "1.0" as const;

type Role = StructuredSdkSemanticContract["roles"][number]["role"];
type InputType = "string" | "number" | "boolean" | "array";
type QuestionKind = "confirm-object-shape" | "map-scalar" | "map-bounded-array";

const identifier = /^[a-zA-Z][a-zA-Z0-9_.-]{1,119}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const authShaped = /(?:^|[_.-])(?:auth|authorization|credential|credentials|password|passwd|secret|token|apiKey|api_key|accessToken|access_token|bearerToken|bearer_token|clientSecret|client_secret)(?:$|[_.-])/i;

export interface StructuredSdkDraftSource {
  schemaVersion: "1.0";
  sessionId: string;
  tenantId: string;
  workPack: SdkImplementationWorkPack;
  schemaIndex: ApprovedStructuredSdkSchemaIndex;
  baseContract: SdkSemanticContract;
  workflowSourceDigest: string;
  availableInputs: Array<{ source: "workflow-input" | "trusted-context"; key: string; type: InputType; sourcePointer: string }>;
  createdAt: string;
}

export interface StructuredSdkDraftQuestion {
  questionId: string;
  kind: QuestionKind;
  role: Role;
  parameter: string;
  path: string[];
  schemaDigest: string;
  maximumItems: number | null;
  dependencies: string[];
  state: "blocked" | "ready" | "answered";
  prompt: string;
}

export type StructuredSdkDraftAnswerValue =
  | { kind: "shape-confirmation"; confirmed: true; schemaDigest: string }
  | { kind: "scalar-source"; source: "workflow-input" | "trusted-context"; key: string; convert: "identity" | "string" | "number" | "boolean" }
  | { kind: "array-source"; source: "workflow-input" | "trusted-context"; key: string; maximumItems: number };

export interface StructuredSdkDraftAnswer {
  questionId: string;
  value: StructuredSdkDraftAnswerValue;
  reviewerAlias: string;
  reviewedAt: string;
  sourcePointer: string;
  sourceDigest: string;
  answerDigest: string;
}

export interface StructuredSdkDraftSnapshot {
  schemaVersion: "1.0";
  state: "review-in-progress" | "review-ready" | "reviewed-structured-contract-ready";
  sessionId: string;
  tenantId: string;
  providerId: string;
  inputDigest: string;
  workPackDigest: string;
  schemaIndexDigest: string;
  baseContractDigest: string;
  workflowSourceDigest: string;
  revision: number;
  questions: StructuredSdkDraftQuestion[];
  answers: StructuredSdkDraftAnswer[];
  blockers: string[];
  metrics: { questions: number; answered: number; ready: number; blocked: number; shapeConfirmations: number; scalarMappings: number; arrayMappings: number; manualContractObjects: 0 };
  reviewedContract: StructuredSdkSemanticContract | null;
  createdAt: string;
  updatedAt: string;
  executionAuthorityEffect: "none";
  activationEffect: "none";
  snapshotDigest: string;
}

interface StoredSession { source_json: string; input_digest: string; snapshot_json: string; snapshot_digest: string }
interface StoredEvent { sequence: number; event_type: string; snapshot_digest: string; previous_event_digest: string | null; event_digest: string; recorded_at: string }

function sourcePayload(source: StructuredSdkDraftSource): unknown {
  return source;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function questionId(role: Role, parameter: string, kind: QuestionKind, path: string[]): string {
  return `${role}:${parameter}:${kind}:${path.length ? path.join(".") : "$"}`;
}

function assertSource(source: StructuredSdkDraftSource, now: string): void {
  if (source.schemaVersion !== "1.0" || !identifier.test(source.sessionId) || !identifier.test(source.tenantId) || !digestPattern.test(source.workflowSourceDigest) || !Number.isFinite(Date.parse(source.createdAt)) || Date.parse(source.createdAt) > Date.parse(now)) throw new Error("Structured SDK draft source failed identity, digest or time validation.");
  assertApprovedStructuredSdkSchemaIndex(source.schemaIndex, source.workPack);
  compileSdkSemanticContract({ contract: source.baseContract, workPack: source.workPack, now });
  if (source.baseContract.providerId !== source.workPack.providerId || source.baseContract.sdkSourceDigest !== source.schemaIndex.sdkSourceDigest || source.baseContract.workPackDigest !== source.workPack.workPackDigest) throw new Error("Structured SDK draft source crosses provider, work-pack or source identities.");
  if (source.baseContract.pagination.roles.length !== 2 || source.baseContract.pagination.roles.some((role) => role.mode !== "not-paginated" || role.maximumPages !== 1)) throw new Error("Structured SDK assisted review cannot silently narrow a paginated base contract; pagination remains unsupported.");
  if (source.availableInputs.length === 0 || new Set(source.availableInputs.map((input) => `${input.source}:${input.key}`)).size !== source.availableInputs.length) throw new Error("Structured SDK draft requires a unique reviewed input inventory.");
  for (const input of source.availableInputs) if (!identifier.test(input.key) || authShaped.test(input.key) || !input.sourcePointer) throw new Error("Structured SDK input inventory contains invalid or authentication-shaped data.");
}

function generateQuestions(source: StructuredSdkDraftSource): StructuredSdkDraftQuestion[] {
  const questions: StructuredSdkDraftQuestion[] = [];
  const walk = (role: Role, parameter: string, schema: BoundedSdkValueSchema, path: string[], parentDependency: string | null): void => {
    const schemaDigest = structuredSdkDigest(schema);
    if (schema.kind === "object") {
      const id = questionId(role, parameter, "confirm-object-shape", path);
      questions.push({ questionId: id, kind: "confirm-object-shape", role, parameter, path, schemaDigest, maximumItems: null, dependencies: parentDependency ? [parentDependency] : [], state: "blocked", prompt: `Confirm that ${role}.${parameter}${path.length ? `.${path.join(".")}` : ""} uses exactly the pinned fixed object shape and no additional fields.` });
      for (const property of schema.properties) walk(role, parameter, property.schema, [...path, property.name], id);
      return;
    }
    if (schema.kind === "array") {
      const id = questionId(role, parameter, "map-bounded-array", path);
      questions.push({ questionId: id, kind: "map-bounded-array", role, parameter, path, schemaDigest, maximumItems: schema.maximumItems, dependencies: parentDependency ? [parentDependency] : [], state: "blocked", prompt: `Choose the reviewed array input for ${role}.${parameter}${path.length ? `.${path.join(".")}` : ""}; at most ${schema.maximumItems} homogeneous items are allowed and no transform is permitted.` });
      return;
    }
    const id = questionId(role, parameter, "map-scalar", path);
    questions.push({ questionId: id, kind: "map-scalar", role, parameter, path, schemaDigest, maximumItems: null, dependencies: parentDependency ? [parentDependency] : [], state: "blocked", prompt: `Choose the reviewed ${schema.kind} source for ${role}.${parameter}${path.length ? `.${path.join(".")}` : ""}.` });
  };
  for (const pinned of source.schemaIndex.parameters) walk(pinned.role, pinned.parameter, pinned.schema, [], null);
  return questions;
}

function snapshotPayload(snapshot: Omit<StructuredSdkDraftSnapshot, "snapshotDigest"> | StructuredSdkDraftSnapshot): Omit<StructuredSdkDraftSnapshot, "snapshotDigest"> {
  const { snapshotDigest: _digest, ...payload } = snapshot as StructuredSdkDraftSnapshot;
  return payload;
}

function projectQuestions(questions: StructuredSdkDraftQuestion[], answers: StructuredSdkDraftAnswer[]): StructuredSdkDraftQuestion[] {
  const answered = new Set(answers.map((answer) => answer.questionId));
  return questions.map((question) => ({ ...question, state: answered.has(question.questionId) ? "answered" : question.dependencies.every((dependency) => answered.has(dependency)) ? "ready" : "blocked" }));
}

function makeSnapshot(input: { source: StructuredSdkDraftSource; inputDigest: string; questions: StructuredSdkDraftQuestion[]; answers: StructuredSdkDraftAnswer[]; revision: number; reviewedContract: StructuredSdkSemanticContract | null; updatedAt: string }): StructuredSdkDraftSnapshot {
  const questions = projectQuestions(input.questions, input.answers);
  const blockers = questions.filter((question) => question.state !== "answered").map((question) => `${question.questionId} requires explicit review.`);
  const payload = {
    schemaVersion: "1.0" as const,
    state: input.reviewedContract ? "reviewed-structured-contract-ready" as const : blockers.length === 0 ? "review-ready" as const : "review-in-progress" as const,
    sessionId: input.source.sessionId,
    tenantId: input.source.tenantId,
    providerId: input.source.workPack.providerId,
    inputDigest: input.inputDigest,
    workPackDigest: input.source.workPack.workPackDigest,
    schemaIndexDigest: input.source.schemaIndex.indexDigest,
    baseContractDigest: input.source.baseContract.contractDigest,
    workflowSourceDigest: input.source.workflowSourceDigest,
    revision: input.revision,
    questions,
    answers: clone(input.answers),
    blockers,
    metrics: { questions: questions.length, answered: input.answers.length, ready: questions.filter((question) => question.state === "ready").length, blocked: questions.filter((question) => question.state === "blocked").length, shapeConfirmations: questions.filter((question) => question.kind === "confirm-object-shape").length, scalarMappings: questions.filter((question) => question.kind === "map-scalar").length, arrayMappings: questions.filter((question) => question.kind === "map-bounded-array").length, manualContractObjects: 0 as const },
    reviewedContract: input.reviewedContract ? clone(input.reviewedContract) : null,
    createdAt: input.source.createdAt,
    updatedAt: input.updatedAt,
    executionAuthorityEffect: "none" as const,
    activationEffect: "none" as const,
  };
  return { ...payload, snapshotDigest: structuredSdkDigest(payload) };
}

function answerFact(answer: StructuredSdkDraftAnswer): ConfirmedFact {
  return { provenance: "engineer-confirmed", confirmedBy: answer.reviewerAlias, confirmedAt: answer.reviewedAt, sourcePointer: answer.sourcePointer };
}

function findSchema(schema: BoundedSdkValueSchema, path: string[]): BoundedSdkValueSchema {
  let current = schema;
  for (const segment of path) {
    if (current.kind !== "object") throw new Error("Structured SDK question path crossed a non-object schema.");
    const property = current.properties.find((candidate) => candidate.name === segment);
    if (!property) throw new Error("Structured SDK question path is absent from pinned schema.");
    current = property.schema;
  }
  return current;
}

function assertAnswer(source: StructuredSdkDraftSource, question: StructuredSdkDraftQuestion, input: Omit<StructuredSdkDraftAnswer, "answerDigest">): void {
  if (!identifier.test(input.reviewerAlias) || !input.sourcePointer || !Number.isFinite(Date.parse(input.reviewedAt)) || Date.parse(input.reviewedAt) < Date.parse(source.createdAt) || Date.parse(input.reviewedAt) >= Date.parse(source.baseContract.expiresAt)) throw new Error("Structured SDK answer has invalid reviewer, provenance or time.");
  const pinned = source.schemaIndex.parameters.find((parameter) => parameter.role === question.role && parameter.parameter === question.parameter)!;
  const schema = findSchema(pinned.schema, question.path);
  if (question.kind === "confirm-object-shape") {
    if (input.sourceDigest !== source.schemaIndex.indexDigest || input.value.kind !== "shape-confirmation" || !input.value.confirmed || input.value.schemaDigest !== question.schemaDigest || schema.kind !== "object") throw new Error("Structured object shape confirmation is stale, incomplete or source-substituted.");
    return;
  }
  if (input.sourceDigest !== source.workflowSourceDigest) throw new Error("Structured SDK mapping answer must cite the exact reviewed workflow source.");
  if (question.kind === "map-bounded-array") {
    if (input.value.kind !== "array-source") throw new Error("Structured array answer changed or omitted the pinned collection bound.");
    const value = input.value;
    if (schema.kind !== "array" || value.maximumItems !== schema.maximumItems) throw new Error("Structured array answer changed or omitted the pinned collection bound.");
    const candidate = source.availableInputs.find((available) => available.source === value.source && available.key === value.key);
    if (!candidate || candidate.type !== "array" || candidate.sourcePointer !== input.sourcePointer || authShaped.test(value.key)) throw new Error("Structured array answer uses an unknown, non-array or authentication-shaped source.");
    return;
  }
  if (input.value.kind !== "scalar-source") throw new Error("Structured scalar answer does not match the pinned scalar schema.");
  const value = input.value;
  if (schema.kind === "array" || schema.kind === "object") throw new Error("Structured scalar answer does not match the pinned scalar schema.");
  const candidate = source.availableInputs.find((available) => available.source === value.source && available.key === value.key);
  if (!candidate || candidate.type === "array" || candidate.sourcePointer !== input.sourcePointer || authShaped.test(value.key)) throw new Error("Structured scalar answer uses an unknown, incompatible or authentication-shaped source.");
  if (value.convert === "identity" ? candidate.type !== schema.kind : value.convert !== schema.kind) throw new Error("Structured scalar conversion does not match the pinned destination type.");
}

function expressionFor(source: StructuredSdkDraftSource, answers: StructuredSdkDraftAnswer[], role: Role, parameter: string, schema: BoundedSdkValueSchema, path: string[]): StructuredValueExpression {
  if (schema.kind === "object") {
    const shapeAnswer = answers.find((answer) => answer.questionId === questionId(role, parameter, "confirm-object-shape", path))!;
    return { kind: "object", fields: schema.properties.map((property) => { const expression = expressionFor(source, answers, role, parameter, property.schema, [...path, property.name]); return { name: property.name, expression, fact: answerFact(answers.find((answer) => answer.questionId === questionId(role, parameter, property.schema.kind === "object" ? "confirm-object-shape" : property.schema.kind === "array" ? "map-bounded-array" : "map-scalar", [...path, property.name]))!) }; }), fact: answerFact(shapeAnswer) };
  }
  const answer = answers.find((candidate) => candidate.questionId === questionId(role, parameter, schema.kind === "array" ? "map-bounded-array" : "map-scalar", path))!;
  if (answer.value.kind === "array-source") return { kind: "bounded-array", source: answer.value.source, key: answer.value.key, maximumItems: answer.value.maximumItems, fact: answerFact(answer) };
  if (answer.value.kind !== "scalar-source") throw new Error("Structured SDK scalar answer was not available at contract construction.");
  return { kind: "scalar", source: answer.value.source, key: answer.value.key, convert: answer.value.convert, fact: answerFact(answer) };
}

function buildContract(source: StructuredSdkDraftSource, snapshot: StructuredSdkDraftSnapshot, reviewFact: ConfirmedFact, expiresAt: string): StructuredSdkSemanticContract {
  const base = source.baseContract;
  const parameters = source.schemaIndex.parameters.map((pinned) => ({ role: pinned.role, parameter: pinned.parameter, pinnedSchemaDigest: pinned.schemaDigest, expression: expressionFor(source, snapshot.answers, pinned.role, pinned.parameter, pinned.schema, []), fact: reviewFact }));
  const payload = {
    schemaVersion: "1.0" as const,
    contractId: `${base.contractId}-structured-v1`,
    providerId: base.providerId,
    sdkSourceDigest: base.sdkSourceDigest,
    workPackDigest: base.workPackDigest,
    schemaIndexDigest: source.schemaIndex.indexDigest,
    roles: clone(base.roles),
    parameters,
    credentials: clone(base.credentials),
    stableIdentity: clone(base.stableIdentity),
    idempotency: clone(base.idempotency),
    reconciliation: clone(base.reconciliation),
    observer: clone(base.observer),
    outcome: clone(base.outcome),
    pagination: clone(base.pagination) as StructuredSdkSemanticContract["pagination"],
    policy: clone(base.policy),
    pinnedParameters: clone(source.schemaIndex.parameters),
    sourceDigest: structuredSdkDigest({ draftingVersion: CUSTOMER_LOCAL_SDK_STRUCTURED_SEMANTIC_DRAFTING_VERSION, inputDigest: snapshot.inputDigest, snapshotDigest: snapshot.snapshotDigest, baseContractDigest: base.contractDigest, reviewFact }),
    expiresAt,
    executionAuthorityEffect: "none" as const,
    activationEffect: "none" as const,
  };
  const contract: StructuredSdkSemanticContract = { ...payload, contractDigest: structuredSdkDigest(payload) };
  compileStructuredSdkSemanticContract({ contract, workPack: source.workPack, schemaIndex: source.schemaIndex, now: reviewFact.confirmedAt });
  return contract;
}

export class DurableStructuredSdkSemanticDraftWorkflow {
  private readonly database: DatabaseSync;
  constructor(path: string, private readonly clock: { now(): string }) {
    this.database = new DatabaseSync(path);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS structured_sdk_draft_sessions (session_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, source_json TEXT NOT NULL, input_digest TEXT NOT NULL, snapshot_json TEXT NOT NULL, snapshot_digest TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS structured_sdk_draft_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tenant_id TEXT NOT NULL, event_type TEXT NOT NULL, snapshot_digest TEXT NOT NULL, previous_event_digest TEXT, event_digest TEXT NOT NULL, recorded_at TEXT NOT NULL);
    `);
  }

  start(sourceInput: StructuredSdkDraftSource): StructuredSdkDraftSnapshot {
    const source = clone(sourceInput);
    const now = this.clock.now();
    assertSource(source, now);
    if (this.database.prepare("SELECT 1 FROM structured_sdk_draft_sessions WHERE session_id = ?").get(source.sessionId)) throw new Error("Structured SDK draft session already exists.");
    const inputDigest = structuredSdkDigest(sourcePayload(source));
    const snapshot = makeSnapshot({ source, inputDigest, questions: generateQuestions(source), answers: [], revision: 0, reviewedContract: null, updatedAt: now });
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("INSERT INTO structured_sdk_draft_sessions (session_id, tenant_id, source_json, input_digest, snapshot_json, snapshot_digest, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(source.sessionId, source.tenantId, JSON.stringify(source), inputDigest, JSON.stringify(snapshot), snapshot.snapshotDigest, now);
      this.appendEvent(source.sessionId, source.tenantId, "draft-started", snapshot.snapshotDigest, now);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    return clone(snapshot);
  }

  read(sessionId: string): StructuredSdkDraftSnapshot {
    const stored = this.stored(sessionId);
    const source = JSON.parse(stored.source_json) as StructuredSdkDraftSource;
    const snapshot = JSON.parse(stored.snapshot_json) as StructuredSdkDraftSnapshot;
    if (stored.input_digest !== structuredSdkDigest(sourcePayload(source)) || stored.snapshot_digest !== structuredSdkDigest(snapshotPayload(snapshot)) || snapshot.snapshotDigest !== stored.snapshot_digest || snapshot.inputDigest !== stored.input_digest) throw new Error("Structured SDK draft durable state failed integrity validation.");
    assertSource(source, this.clock.now());
    this.assertEventChain(sessionId, snapshot.snapshotDigest);
    return clone(snapshot);
  }

  answer(input: { sessionId: string; expectedSnapshotDigest: string; expectedRevision: number; questionId: string; value: StructuredSdkDraftAnswerValue; reviewerAlias: string; reviewedAt: string; sourcePointer: string; sourceDigest: string }): StructuredSdkDraftSnapshot {
    const current = this.read(input.sessionId);
    if (current.snapshotDigest !== input.expectedSnapshotDigest || current.revision !== input.expectedRevision) throw new Error("Structured SDK draft answer is stale.");
    if (current.reviewedContract) throw new Error("Reviewed structured contract is immutable.");
    const existing = current.answers.find((answer) => answer.questionId === input.questionId);
    if (existing) {
      const proposed = { questionId: input.questionId, value: input.value, reviewerAlias: input.reviewerAlias, reviewedAt: input.reviewedAt, sourcePointer: input.sourcePointer, sourceDigest: input.sourceDigest };
      if (existing.answerDigest !== structuredSdkDigest(proposed)) throw new Error("Structured SDK question already has a different immutable answer.");
      return current;
    }
    const question = current.questions.find((candidate) => candidate.questionId === input.questionId);
    if (!question || question.state !== "ready") throw new Error("Structured SDK question is unknown or its dependencies are incomplete.");
    const source = this.source(input.sessionId);
    const payload = { questionId: input.questionId, value: clone(input.value), reviewerAlias: input.reviewerAlias, reviewedAt: input.reviewedAt, sourcePointer: input.sourcePointer, sourceDigest: input.sourceDigest };
    assertAnswer(source, question, payload);
    const answer: StructuredSdkDraftAnswer = { ...payload, answerDigest: structuredSdkDigest(payload) };
    const next = makeSnapshot({ source, inputDigest: current.inputDigest, questions: current.questions, answers: [...current.answers, answer], revision: current.revision + 1, reviewedContract: null, updatedAt: this.clock.now() });
    this.save(current, next, "question-answered");
    return clone(next);
  }

  review(input: { sessionId: string; expectedSnapshotDigest: string; expectedRevision: number; reviewerAlias: string; reviewedAt: string; expiresAt: string; dryRun?: boolean }): StructuredSdkDraftSnapshot {
    const current = this.read(input.sessionId);
    if (current.snapshotDigest !== input.expectedSnapshotDigest || current.revision !== input.expectedRevision) throw new Error("Structured SDK final review is stale.");
    if (current.reviewedContract) return current;
    if (current.blockers.length > 0 || current.answers.length !== current.questions.length) throw new Error("Structured SDK contract cannot be reviewed while decisions remain.");
    if (!identifier.test(input.reviewerAlias) || !Number.isFinite(Date.parse(input.reviewedAt)) || !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.parse(input.reviewedAt)) throw new Error("Structured SDK final review time, expiry or reviewer is invalid.");
    const source = this.source(input.sessionId);
    if (Date.parse(input.expiresAt) > Date.parse(source.baseContract.expiresAt)) throw new Error("Structured SDK contract cannot outlive its reviewed base contract.");
    const reviewFact: ConfirmedFact = { provenance: "engineer-confirmed", confirmedBy: input.reviewerAlias, confirmedAt: input.reviewedAt, sourcePointer: `draft://${input.sessionId}/final-review` };
    const contract = buildContract(source, current, reviewFact, input.expiresAt);
    const next = makeSnapshot({ source, inputDigest: current.inputDigest, questions: current.questions, answers: current.answers, revision: current.revision + 1, reviewedContract: contract, updatedAt: this.clock.now() });
    if (!input.dryRun) this.save(current, next, "contract-reviewed");
    return clone(next);
  }

  close(): void { this.database.close(); }

  private stored(sessionId: string): StoredSession {
    const row = this.database.prepare("SELECT source_json, input_digest, snapshot_json, snapshot_digest FROM structured_sdk_draft_sessions WHERE session_id = ?").get(sessionId) as StoredSession | undefined;
    if (!row) throw new Error("Structured SDK draft session was not found.");
    return row;
  }

  private source(sessionId: string): StructuredSdkDraftSource {
    return JSON.parse(this.stored(sessionId).source_json) as StructuredSdkDraftSource;
  }

  private save(previous: StructuredSdkDraftSnapshot, next: StructuredSdkDraftSnapshot, eventType: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare("UPDATE structured_sdk_draft_sessions SET snapshot_json = ?, snapshot_digest = ?, updated_at = ? WHERE session_id = ? AND snapshot_digest = ?").run(JSON.stringify(next), next.snapshotDigest, next.updatedAt, next.sessionId, previous.snapshotDigest);
      if (result.changes !== 1) throw new Error("Structured SDK draft lost a concurrent compare-and-swap.");
      this.appendEvent(next.sessionId, next.tenantId, eventType, next.snapshotDigest, next.updatedAt);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  private appendEvent(sessionId: string, tenantId: string, eventType: string, snapshotDigest: string, recordedAt: string): void {
    const previous = this.database.prepare("SELECT event_digest FROM structured_sdk_draft_events WHERE session_id = ? ORDER BY sequence DESC LIMIT 1").get(sessionId) as { event_digest: string } | undefined;
    const payload = { sessionId, tenantId, eventType, snapshotDigest, previousEventDigest: previous?.event_digest ?? null, recordedAt };
    this.database.prepare("INSERT INTO structured_sdk_draft_events (session_id, tenant_id, event_type, snapshot_digest, previous_event_digest, event_digest, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(sessionId, tenantId, eventType, snapshotDigest, payload.previousEventDigest, structuredSdkDigest(payload), recordedAt);
  }

  private assertEventChain(sessionId: string, expectedSnapshotDigest: string): void {
    const events = this.database.prepare("SELECT sequence, event_type, snapshot_digest, previous_event_digest, event_digest, recorded_at FROM structured_sdk_draft_events WHERE session_id = ? ORDER BY sequence").all(sessionId) as unknown as StoredEvent[];
    if (events.length === 0 || events.at(-1)!.snapshot_digest !== expectedSnapshotDigest) throw new Error("Structured SDK draft event history is missing or stale.");
    const source = this.source(sessionId);
    let previous: string | null = null;
    for (const event of events) {
      const payload = { sessionId, tenantId: source.tenantId, eventType: event.event_type, snapshotDigest: event.snapshot_digest, previousEventDigest: event.previous_event_digest, recordedAt: event.recorded_at };
      if (event.previous_event_digest !== previous || event.event_digest !== structuredSdkDigest(payload)) throw new Error("Structured SDK draft event chain failed integrity validation.");
      previous = event.event_digest;
    }
  }
}
