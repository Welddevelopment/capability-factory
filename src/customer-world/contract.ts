import type { CapabilityManifest, JsonValue } from "../manifest.js";
import type { RuntimeConfiguration } from "../runtime.js";

export type CustomerWorldCaseKind =
  | "already-satisfied"
  | "build"
  | "reuse"
  | "permission-denial"
  | "invalid-target"
  | "retry-idempotency";

export interface StartingCapability {
  id: string;
  description: string;
}

export interface DocumentationBundle {
  mediaType: "application/json";
  content: Record<string, JsonValue>;
  sha256: string;
}

export interface ExpectedExternalState {
  exact: Record<string, JsonValue>;
  forbidden: Array<Record<string, JsonValue>>;
  maxMatchingWrites: number;
  allowNoAction: boolean;
}

export interface CustomerWorldCase {
  id: string;
  kind: CustomerWorldCaseKind;
  ordinaryGoal: string;
  credentialProfile: string;
  expected: ExpectedExternalState;
}

export interface VerificationIssue {
  code:
    | "missing-write"
    | "wrong-record"
    | "wrong-field"
    | "duplicate-write"
    | "forbidden-write"
    | "collateral-write";
  message: string;
}

export interface DirectVerificationResult {
  caseId: string;
  passed: boolean;
  intendedWrites: number;
  incorrectSideEffects: number;
  stateHash: string;
  issues: VerificationIssue[];
}

export interface CustomerWorldHandle {
  readonly id: string;
  readonly adapterKind: string;
  readonly baseUrl: string;
  readonly documentation: DocumentationBundle;
  readonly startingCapabilities: StartingCapability[];
  readonly cases: readonly CustomerWorldCase[];
  reset(caseId: string): string;
  runtimeConfiguration(caseId: string): RuntimeConfiguration;
  verify(caseId: string): DirectVerificationResult;
  stateHash(): string;
  close(): Promise<void>;
}

export interface CustomerWorldModule {
  readonly id: string;
  readonly description: string;
  readonly developmentOnly: true;
  start(workDirectory: string): Promise<CustomerWorldHandle>;
  createReferenceCapability(documentation: DocumentationBundle, secretAlias: string): CapabilityManifest;
}
