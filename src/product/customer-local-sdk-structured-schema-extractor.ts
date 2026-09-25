import { createHash } from "node:crypto";
import {
  assertApprovedStructuredSdkSchemaIndex,
  structuredSdkDigest,
  type ApprovedStructuredSdkSchemaIndex,
  type BoundedSdkValueSchema,
  type PinnedStructuredSdkParameter,
} from "./customer-local-sdk-structured-semantic-compiler.js";
import { sdkWorkPackDigest, type SdkImplementationWorkPack } from "./customer-local-sdk-work-pack.js";
import type { ConfirmedFact } from "./customer-local-sdk-semantic-compiler.js";

export const CUSTOMER_LOCAL_SDK_STRUCTURED_SCHEMA_EXTRACTOR_VERSION = "1.0" as const;
export const structuredSdkSourceBytesDigest = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

type Role = SdkImplementationWorkPack["roles"][number]["review"]["role"];
type JsonObject = Record<string, unknown>;

const identifier = /^[a-zA-Z][a-zA-Z0-9_.-]{1,119}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const authShaped = /(?:^|[_.-])(?:auth|authorization|credential|credentials|password|passwd|secret|token|apiKey|api_key|accessToken|access_token|bearerToken|bearer_token|clientSecret|client_secret)(?:$|[_.-])/i;
const methodKeys = new Set(["module", "className", "methodName", "overloadId", "sourcePointer", "parameters"]);
const parameterKeys = new Set(["name", "required", "declaredType", "sourcePointer", "schema"]);
const primitiveKeys = new Set(["type"]);
const objectKeys = new Set(["type", "additionalProperties", "required", "properties"]);
const arrayKeys = new Set(["type", "maximumItems", "items"]);

export interface StructuredSdkSchemaReview {
  role: Role;
  parameter: string;
  methodDigest: string;
  expectedSchemaPointer: string;
  reviewerAlias: string;
  reviewedAt: string;
  exactOneToOne: true;
}

interface ParsedParameter { name: string; required: true; declaredType: string; sourcePointer: string; schema: JsonObject }
interface ParsedMethod { module: string; className: string; methodName: string; overloadId: string; sourcePointer: string; parameters: ParsedParameter[] }
interface ParsedSource { schemaVersion: "1.0"; providerId: string; methods: ParsedMethod[] }

function object(value: unknown, message: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(message);
  return value as JsonObject;
}

function exactKeys(value: JsonObject, allowed: Set<string>, message: string): void {
  if (Object.keys(value).some((key) => !allowed.has(key) || key === "__proto__" || key === "constructor" || key === "prototype")) throw new Error(message);
}

function text(value: unknown, message: string): string {
  if (typeof value !== "string" || !value || value.length > 500) throw new Error(message);
  return value;
}

function parseSource(bytes: string | Uint8Array): ParsedSource {
  const serialized = typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8");
  if (Buffer.byteLength(serialized, "utf8") > 1_000_000) throw new Error("Structured SDK source metadata exceeds the bounded byte limit.");
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); } catch { throw new Error("Structured SDK source metadata is not valid JSON."); }
  const root = object(parsed, "Structured SDK source metadata root must be an object.");
  exactKeys(root, new Set(["schemaVersion", "providerId", "methods"]), "Structured SDK source metadata contains an unsupported root field.");
  if (root.schemaVersion !== "1.0" || !identifier.test(text(root.providerId, "Structured SDK provider identity is invalid.")) || !Array.isArray(root.methods) || root.methods.length === 0 || root.methods.length > 100) throw new Error("Structured SDK source metadata failed schema, provider or method bounds.");
  const methods = root.methods.map((candidate) => {
    const sourceMethod = object(candidate, "Structured SDK method metadata must be an object.");
    exactKeys(sourceMethod, methodKeys, "Structured SDK method metadata contains an unsupported field or executable transform.");
    const method: ParsedMethod = { module: text(sourceMethod.module, "Structured SDK method module is invalid."), className: text(sourceMethod.className, "Structured SDK class identity is invalid."), methodName: text(sourceMethod.methodName, "Structured SDK method identity is invalid."), overloadId: text(sourceMethod.overloadId, "Structured SDK overload identity is invalid."), sourcePointer: text(sourceMethod.sourcePointer, "Structured SDK method source pointer is invalid."), parameters: [] };
    for (const value of [method.module, method.className, method.methodName, method.overloadId]) if (!identifier.test(value)) throw new Error("Structured SDK method identity is outside the bounded identifier subset.");
    if (!Array.isArray(sourceMethod.parameters) || sourceMethod.parameters.length === 0 || sourceMethod.parameters.length > 50) throw new Error("Structured SDK source method requires a bounded parameter list.");
    method.parameters = sourceMethod.parameters.map((parameterCandidate) => {
      const sourceParameter = object(parameterCandidate, "Structured SDK parameter metadata must be an object.");
      exactKeys(sourceParameter, parameterKeys, "Structured SDK parameter contains an unsupported field, default, reference or transform.");
      const name = text(sourceParameter.name, "Structured SDK parameter name is invalid.");
      if (!identifier.test(name) || authShaped.test(name)) throw new Error("Structured SDK parameter name is invalid or authentication-shaped.");
      if (sourceParameter.required !== true) throw new Error("Optional SDK parameters remain unsupported because omission semantics are not proven.");
      return { name, required: true as const, declaredType: text(sourceParameter.declaredType, "Structured SDK declared parameter type is invalid."), sourcePointer: text(sourceParameter.sourcePointer, "Structured SDK parameter source pointer is invalid."), schema: object(sourceParameter.schema, "Structured SDK parameter schema must be an object.") };
    });
    return method;
  });
  return { schemaVersion: "1.0", providerId: root.providerId as string, methods };
}

function sourceFact(review: StructuredSdkSchemaReview, sourcePointer: string): ConfirmedFact {
  return { provenance: "engineer-confirmed", confirmedBy: review.reviewerAlias, confirmedAt: review.reviewedAt, sourcePointer };
}

function schemaFromJson(source: JsonObject, pointer: string, review: StructuredSdkSchemaReview, depth = 1): BoundedSdkValueSchema {
  if (depth > 4) throw new Error("Structured SDK source schema exceeds the bounded nesting depth.");
  const type = source.type;
  if (Array.isArray(type) || typeof type !== "string") throw new Error("Structured SDK unions and missing types are unsupported.");
  if (type === "string" || type === "number" || type === "boolean") {
    exactKeys(source, primitiveKeys, "Structured SDK primitive schema contains an unsupported constraint or transform.");
    return { kind: type, fact: sourceFact(review, pointer) };
  }
  if (type === "array") {
    exactKeys(source, arrayKeys, "Structured SDK array schema contains a reference, union or unsupported field.");
    if (!Number.isInteger(source.maximumItems) || (source.maximumItems as number) < 1 || (source.maximumItems as number) > 100) throw new Error("Structured SDK arrays require an explicit maximumItems between 1 and 100.");
    const items = object(source.items, "Structured SDK arrays require one homogeneous item schema.");
    return { kind: "array", maximumItems: source.maximumItems as number, items: schemaFromJson(items, `${pointer}/items`, review, depth + 1), fact: sourceFact(review, pointer) };
  }
  if (type === "object") {
    exactKeys(source, objectKeys, "Structured SDK object schema contains a reference, union, default or unsupported transform.");
    if (source.additionalProperties !== false) throw new Error("Structured SDK objects require additionalProperties false.");
    const properties = object(source.properties, "Structured SDK object properties must be an exact object map.");
    const names = Object.keys(properties);
    if (names.length === 0 || names.length > 24 || names.some((name) => !identifier.test(name) || authShaped.test(name))) throw new Error("Structured SDK object properties are empty, excessive, invalid or authentication-shaped.");
    if (!Array.isArray(source.required)) throw new Error("Structured SDK object fields must all be explicitly required; optional fields are unsupported.");
    const required = source.required;
    if (required.some((name) => typeof name !== "string") || required.length !== names.length || new Set(required).size !== names.length || names.some((name) => !required.includes(name))) throw new Error("Structured SDK object fields must all be explicitly required; optional fields are unsupported.");
    return { kind: "object", additionalProperties: false, properties: names.sort().map((name) => ({ name, required: true as const, schema: schemaFromJson(object(properties[name], "Structured SDK property schema must be an object."), `${pointer}/properties/${name}`, review, depth + 1), fact: sourceFact(review, `${pointer}/properties/${name}`) })), fact: sourceFact(review, pointer) };
  }
  throw new Error(`Structured SDK source type ${String(type)} is unsupported.`);
}

function assertReview(review: StructuredSdkSchemaReview, sourceDigest: string): void {
  if (!identifier.test(review.reviewerAlias) || !digestPattern.test(review.methodDigest) || !review.expectedSchemaPointer || !Number.isFinite(Date.parse(review.reviewedAt)) || !review.exactOneToOne || review.expectedSchemaPointer.includes(sourceDigest)) throw new Error("Structured SDK schema review is incomplete or invalid.");
}

export function extractApprovedStructuredSdkSchemaIndex(input: { sourceBytes: string | Uint8Array; expectedSourceDigest: string; localReference: string; workPack: SdkImplementationWorkPack; reviews: StructuredSdkSchemaReview[] }): ApprovedStructuredSdkSchemaIndex {
  const sourceDigest = structuredSdkSourceBytesDigest(input.sourceBytes);
  const { workPackDigest, ...workPackPayload } = input.workPack;
  if (workPackDigest !== sdkWorkPackDigest(workPackPayload) || sourceDigest !== input.expectedSourceDigest || sourceDigest !== input.workPack.sdkSourceDigest || !/^(?:fixture:\/\/[a-zA-Z0-9_.\/-]+|file:\/\/[a-zA-Z0-9_.\/-]+|[a-zA-Z0-9_.\/-]+)$/.test(input.localReference) || input.localReference.includes("..") || input.workPack.roles.some((role) => role.provenance.localReference !== input.localReference || role.provenance.sdkSourceDigest !== sourceDigest)) throw new Error("Structured SDK source bytes, reviewed work pack and local source identity do not match.");
  const source = parseSource(input.sourceBytes);
  if (source.providerId !== input.workPack.providerId) throw new Error("Structured SDK source provider does not match the reviewed work pack.");
  const expected = input.workPack.roles.flatMap((role) => role.method.parameters.map((parameter) => `${role.review.role}:${parameter.name}`));
  if (input.reviews.length !== expected.length || new Set(input.reviews.map((review) => `${review.role}:${review.parameter}`)).size !== input.reviews.length || expected.some((identity) => !input.reviews.some((review) => `${review.role}:${review.parameter}` === identity))) throw new Error("Exactly one structured schema review is required for every reviewed SDK parameter.");
  const parameters: PinnedStructuredSdkParameter[] = [];
  for (const role of input.workPack.roles) {
    const methods = source.methods.filter((method) => method.module === role.method.module && method.className === role.method.className && method.methodName === role.method.methodName && method.overloadId === role.method.overloadId && method.sourcePointer === role.method.sourcePointer);
    if (methods.length !== 1 || role.methodDigest !== sdkWorkPackDigest(role.method)) throw new Error("Structured SDK source method is missing, ambiguous or stale against the reviewed work pack.");
    const method = methods[0]!;
    if (method.parameters.length !== role.method.parameters.length) throw new Error("Structured SDK source parameter cardinality differs from the reviewed work pack.");
    for (const reviewedParameter of role.method.parameters) {
      const matches = method.parameters.filter((parameter) => parameter.name === reviewedParameter.name && parameter.declaredType === reviewedParameter.type && parameter.sourcePointer === reviewedParameter.sourcePointer && parameter.required === reviewedParameter.required);
      const review = input.reviews.find((candidate) => candidate.role === role.review.role && candidate.parameter === reviewedParameter.name)!;
      assertReview(review, sourceDigest);
      if (matches.length !== 1 || review.methodDigest !== role.methodDigest || review.expectedSchemaPointer !== `${reviewedParameter.sourcePointer}/schema`) throw new Error("Structured SDK parameter review is stale, ambiguous or source-pointer mismatched.");
      const extractedSchema = schemaFromJson(matches[0]!.schema, review.expectedSchemaPointer, review);
      const pinned: PinnedStructuredSdkParameter = { role: role.review.role, parameter: reviewedParameter.name, declaredType: reviewedParameter.type as PinnedStructuredSdkParameter["declaredType"], methodDigest: role.methodDigest, sdkSourceDigest: sourceDigest, sourcePointer: reviewedParameter.sourcePointer, schema: extractedSchema, schemaDigest: structuredSdkDigest(extractedSchema), fact: sourceFact(review, review.expectedSchemaPointer) };
      parameters.push(pinned);
    }
  }
  const payload = { schemaVersion: "1.0" as const, providerId: input.workPack.providerId, sdkSourceDigest: sourceDigest, localReference: input.localReference, approved: true as const, parameters };
  const index: ApprovedStructuredSdkSchemaIndex = { ...payload, indexDigest: structuredSdkDigest(payload) };
  assertApprovedStructuredSdkSchemaIndex(index, input.workPack);
  return index;
}
