import { createHash } from "node:crypto";
import ts from "typescript";
import { structuredSdkDigest } from "./customer-local-sdk-structured-semantic-compiler.js";
import { structuredSdkSourceBytesDigest } from "./customer-local-sdk-structured-schema-extractor.js";

export const CUSTOMER_LOCAL_SDK_TYPESCRIPT_DECLARATION_NORMALIZER_VERSION = "1.0" as const;

const identifier = /^[a-zA-Z][a-zA-Z0-9_.-]{1,119}$/;
const authShaped = /(?:^|[_.-])(?:auth|authorization|credential|credentials|password|passwd|secret|token|apiKey|api_key|accessToken|access_token|bearerToken|bearer_token|clientSecret|client_secret)(?:$|[_.-])/i;
const recognizedSecret = /(?:bearer\s+[a-z0-9._~+/=-]+|(?:password|secret|token|api[_ -]?key)\s*[:=]\s*[^\s,;}]+|CF_CANARY_[A-Z0-9_-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|github_pat)-?[a-z0-9_-]{16,}|\bAKIA[A-Z0-9]{16}\b)/i;

export interface TypeScriptSdkMethodReview {
  className: string;
  methodName: string;
  overloadId: "v1";
  reviewerAlias: string;
  reviewedAt: string;
  exactOneToOne: true;
}

export interface TypeScriptSdkNormalizationReceipt {
  schemaVersion: "1.0";
  normalizerVersion: typeof CUSTOMER_LOCAL_SDK_TYPESCRIPT_DECLARATION_NORMALIZER_VERSION;
  providerId: string;
  moduleName: string;
  localReference: string;
  originSourceDigest: string;
  normalizedSourceDigest: string;
  normalizerImplementationDigest: string;
  reviewedMethodIdentities: string[];
  normalizedMethods: number;
  normalizedParameters: number;
  customerExecutable: false;
  executionAuthorityEffect: "none";
  activationEffect: "none";
  receiptDigest: string;
}

export interface TypeScriptSdkNormalizationResult {
  normalizedSourceBytes: string;
  normalizedSourceDigest: string;
  receipt: TypeScriptSdkNormalizationReceipt;
}

function nodePointer(className: string, methodName: string, parameter?: string): string {
  return `#/declarations/${className}/methods/${methodName}/v1${parameter ? `/parameters/${parameter}` : ""}`;
}

function maximumItems(node: ts.Node): number {
  const tag = ts.getJSDocTags(node).find((candidate) => candidate.tagName.text === "maximumItems");
  const value = typeof tag?.comment === "string" ? Number(tag.comment.trim()) : Number.NaN;
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error("TypeScript array declarations require one explicit @maximumItems value between 1 and 100.");
  return value;
}

function propertyName(node: ts.PropertyName | ts.BindingName): string {
  if (!ts.isIdentifier(node)) throw new Error("TypeScript structured SDK fields and parameters require plain identifiers.");
  const value = node.text;
  if (!identifier.test(value) || authShaped.test(value)) throw new Error("TypeScript structured SDK field is invalid or authentication-shaped.");
  return value;
}

function schema(type: ts.TypeNode, owner: ts.Node, depth = 1): Record<string, unknown> {
  if (depth > 4) throw new Error("TypeScript structured SDK declaration exceeds the bounded nesting depth.");
  if (type.kind === ts.SyntaxKind.StringKeyword) return { type: "string" };
  if (type.kind === ts.SyntaxKind.NumberKeyword) return { type: "number" };
  if (type.kind === ts.SyntaxKind.BooleanKeyword) return { type: "boolean" };
  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) throw new Error("TypeScript union and intersection SDK fields are unsupported.");
  if (ts.isArrayTypeNode(type)) return { type: "array", maximumItems: maximumItems(owner), items: schema(type.elementType, owner, depth + 1) };
  if (ts.isTypeReferenceNode(type)) {
    if (!ts.isIdentifier(type.typeName) || type.typeName.text !== "Array" || !type.typeArguments || type.typeArguments.length !== 1) throw new Error("TypeScript SDK references, named types and generics beyond Array<T> are unsupported.");
    return { type: "array", maximumItems: maximumItems(owner), items: schema(type.typeArguments[0]!, owner, depth + 1) };
  }
  if (ts.isTypeLiteralNode(type)) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    if (type.members.length === 0 || type.members.length > 24) throw new Error("TypeScript SDK type literals require a non-empty bounded property set.");
    for (const member of type.members) {
      if (!ts.isPropertySignature(member) || !member.type || member.questionToken || member.name === undefined) throw new Error("TypeScript SDK type literals permit only required property signatures; optional, index, method and unknown fields are unsupported.");
      const name = propertyName(member.name);
      if (properties[name] !== undefined) throw new Error("TypeScript SDK type literal contains a duplicate property.");
      properties[name] = schema(member.type, member, depth + 1);
      required.push(name);
    }
    return { type: "object", additionalProperties: false, required, properties };
  }
  throw new Error("TypeScript SDK type is outside the strict primitive, inline-object and bounded-array subset.");
}

function declaredType(value: Record<string, unknown>): "string" | "number" | "boolean" | "Record<string, unknown>" | "Array<string>" {
  if (value.type === "string" || value.type === "number" || value.type === "boolean") return value.type;
  if (value.type === "object") return "Record<string, unknown>";
  if (value.type === "array" && (value.items as Record<string, unknown>)?.type === "string") return "Array<string>";
  throw new Error("A top-level TypeScript SDK array must contain strings; richer arrays must be nested inside a fixed object.");
}

function assertReview(review: TypeScriptSdkMethodReview): void {
  if (!identifier.test(review.className) || !identifier.test(review.methodName) || !identifier.test(review.reviewerAlias) || review.overloadId !== "v1" || !review.exactOneToOne || !Number.isFinite(Date.parse(review.reviewedAt))) throw new Error("TypeScript SDK method review is incomplete or invalid.");
}

export function normalizePinnedTypeScriptSdkDeclarations(input: { providerId: string; moduleName: string; localReference: string; sourceBytes: string | Uint8Array; reviews: TypeScriptSdkMethodReview[] }): TypeScriptSdkNormalizationResult {
  if (!identifier.test(input.providerId) || !identifier.test(input.moduleName) || !/^(?:fixture:\/\/[a-zA-Z0-9_.\/-]+|file:\/\/[a-zA-Z0-9_.\/-]+|[a-zA-Z0-9_.\/-]+)$/.test(input.localReference) || input.localReference.includes("..") || input.reviews.length === 0 || new Set(input.reviews.map((review) => `${review.className}:${review.methodName}:${review.overloadId}`)).size !== input.reviews.length) throw new Error("TypeScript SDK normalization input failed identity, path or review cardinality validation.");
  input.reviews.forEach(assertReview);
  const sourceText = typeof input.sourceBytes === "string" ? input.sourceBytes : Buffer.from(input.sourceBytes).toString("utf8");
  if (Buffer.byteLength(sourceText, "utf8") > 1_000_000 || recognizedSecret.test(sourceText)) throw new Error("TypeScript SDK declaration source exceeds bounds or contains recognized secret-shaped material.");
  const sourceFile = ts.createSourceFile("provider.d.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) throw new Error("TypeScript SDK declaration source contains parse diagnostics.");
  if (sourceFile.statements.some((statement) => !ts.isClassDeclaration(statement))) throw new Error("TypeScript SDK strict subset permits only declared classes; imports, exports, variables, functions, namespaces and executable statements are unsupported.");
  const classes = sourceFile.statements.filter(ts.isClassDeclaration);
  const normalizedMethods: Array<Record<string, unknown>> = [];
  let normalizedParameters = 0;
  for (const review of input.reviews) {
    const classMatches = classes.filter((candidate) => candidate.name?.text === review.className);
    if (classMatches.length !== 1) throw new Error("Reviewed TypeScript SDK class is missing or ambiguous.");
    const declaration = classMatches[0]!;
    if (!declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) || declaration.modifiers.some((modifier) => modifier.kind !== ts.SyntaxKind.DeclareKeyword) || declaration.typeParameters?.length || declaration.heritageClauses?.length || declaration.members.some((member) => !ts.isMethodDeclaration(member))) throw new Error("TypeScript SDK class must be a non-generic standalone declared class containing methods only.");
    const methodMatches = declaration.members.filter(ts.isMethodDeclaration).filter((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === review.methodName);
    if (methodMatches.length !== 1) throw new Error("Reviewed TypeScript SDK method is missing, overloaded or ambiguous.");
    const method = methodMatches[0]!;
    if (method.body || method.questionToken || method.typeParameters?.length || method.modifiers?.length || !method.type || !ts.isTypeReferenceNode(method.type) || !ts.isIdentifier(method.type.typeName) || method.type.typeName.text !== "Promise") throw new Error("TypeScript SDK methods must be unmodified, required, non-generic declarations returning Promise<...> with no implementation body.");
    if (method.parameters.length === 0 || method.parameters.length > 50) throw new Error("TypeScript SDK method requires a bounded parameter list.");
    const parameters = method.parameters.map((parameter) => {
      if (!parameter.type || parameter.questionToken || parameter.initializer || parameter.dotDotDotToken) throw new Error("TypeScript SDK parameters must be required, non-rest and default-free.");
      const name = propertyName(parameter.name);
      const extractedSchema = schema(parameter.type, parameter);
      normalizedParameters += 1;
      return { name, required: true, declaredType: declaredType(extractedSchema), sourcePointer: nodePointer(review.className, review.methodName, name), schema: extractedSchema };
    });
    normalizedMethods.push({ module: input.moduleName, className: review.className, methodName: review.methodName, overloadId: "v1", sourcePointer: nodePointer(review.className, review.methodName), parameters });
  }
  const normalized = { schemaVersion: "1.0", providerId: input.providerId, methods: normalizedMethods };
  const normalizedSourceBytes = `${JSON.stringify(normalized, null, 2)}\n`;
  const originSourceDigest = structuredSdkSourceBytesDigest(sourceText);
  const normalizedSourceDigest = structuredSdkSourceBytesDigest(normalizedSourceBytes);
  const normalizerImplementationDigest = structuredSdkDigest({ version: CUSTOMER_LOCAL_SDK_TYPESCRIPT_DECLARATION_NORMALIZER_VERSION, allowed: ["declare-class", "required-method", "primitive", "inline-type-literal", "bounded-homogeneous-array"] });
  const payload = { schemaVersion: "1.0" as const, normalizerVersion: CUSTOMER_LOCAL_SDK_TYPESCRIPT_DECLARATION_NORMALIZER_VERSION, providerId: input.providerId, moduleName: input.moduleName, localReference: input.localReference, originSourceDigest, normalizedSourceDigest, normalizerImplementationDigest, reviewedMethodIdentities: input.reviews.map((review) => `${review.className}:${review.methodName}:${review.overloadId}`), normalizedMethods: normalizedMethods.length, normalizedParameters, customerExecutable: false as const, executionAuthorityEffect: "none" as const, activationEffect: "none" as const };
  return { normalizedSourceBytes, normalizedSourceDigest, receipt: { ...payload, receiptDigest: structuredSdkDigest(payload) } };
}
